// MCP servers (§ 4.6). The project's settings keep only names, in workers.mcp_servers; each is
// resolved on this machine in Claude Code's order: local scope (the user's .claude.json, under the
// repository's project entry), project scope (the repository's .mcp.json), then user scope (the
// user's .claude.json), which is in CLAUDE_CONFIG_DIR when that is set. The definitions, which may
// hold secrets, are passed to the SDK's mcpServers in memory, never written to disk. A name defined
// nowhere, or naming a claude.ai connector, is a setup problem. No names means no servers (§ 15, Q5).
//
// checkInit checks a session's first system/init: with strictMcpConfig, it lists exactly the chosen
// servers. A passed definition shows source "dynamic" there, not the scope it was resolved from
// (docs/spikes/03-sdk-mcp-subagents.md), and an in-process server "sdk"; both are accepted, and so
// is the scope, as § 4.1 has it.
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { McpServerConfig, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk"
import { Config, Effect, FileSystem, Option } from "effect"
import { SetupProblem } from "../cli/AppConfig.ts"

/** The config scopes a name is resolved from, in Claude Code's order. */
export type Scope = "local" | "project" | "user"

/**
 * A server workers get: its name, the scope its definition came from (`sdk` for an in-process
 * server of tutti's own, the interview's), and the definition.
 */
export interface ChosenServer {
  readonly name: string
  readonly scope: Scope | "sdk"
  readonly definition: McpServerConfig
}

/** The servers workers get, in workers.mcp_servers' order, and what the START block says of them. */
export interface ChosenServers {
  readonly servers: ReadonlyArray<ChosenServer>
  /** A note for the START block when workers get no servers; null when they get some. */
  readonly note: string | null
}

/** The START block's note when workers.mcp_servers is empty (§ 15, Q5). */
export const noServersNote = "workers get no MCP servers: workers.mcp_servers is empty"

/** No servers at all: the environment probe's (§ 4.9). */
export const noServers: ChosenServers = { servers: [], note: null }

/** One in-process server of tutti's own, `name`, made by createSdkMcpServer: the interview's (§ 4.10). */
export const inProcess = (name: string, definition: McpServerConfig): ChosenServers => ({
  servers: [{ name, scope: "sdk", definition }],
  note: null,
})

/** A claude.ai connector's name starts with this, in system/init and the user's .claude.json. */
export const connectorPrefix = "claude.ai "

/** The sources system/init gives a server tutti passed, besides the scope it came from. */
const passedSources: ReadonlyArray<string> = ["sdk", "dynamic"]

/** The transports a definition passed in mcpServers can have; no type is stdio. */
const transports: ReadonlyArray<string> = ["stdio", "sse", "http"]

/**
 * Where Claude Code keeps its user config: `.claude.json` in CLAUDE_CONFIG_DIR, or in the home
 * directory when that is unset or empty.
 */
export const claudeConfigFile = Effect.gen(function* () {
  const dir = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR"))
  const home = yield* Config.String("HOME").pipe(Config.withDefault(homedir()))
  return join(
    Option.getOrElse(
      Option.filter(dir, (d) => d !== ""),
      () => home,
    ),
    ".claude.json",
  )
}).pipe(Effect.orDie)

/** The SDK's mcpServers option for `chosen`. */
export const mcpServers = (chosen: ChosenServers): Record<string, McpServerConfig> =>
  Object.fromEntries(chosen.servers.map((server) => [server.name, server.definition]))

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A config file's parsed JSON; a missing file is null. */
const readJson = (fs: FileSystem.FileSystem, file: string, problems: Array<string>) =>
  fs.readFileString(file).pipe(
    Effect.map((text): Json | null => {
      try {
        const json: unknown = JSON.parse(text)
        if (isObject(json)) return json
        problems.push(`MCP config isn't a JSON object: ${file}.`)
      } catch (error) {
        problems.push(
          `MCP config isn't valid JSON: ${file}: ${error instanceof Error ? error.message : error}`,
        )
      }
      return null
    }),
    Effect.catchTag("PlatformError", (error) => {
      if (error.reason._tag !== "NotFound") {
        problems.push(`MCP config can't be read: ${file}: ${error.message}`)
      }
      return Effect.succeed(null)
    }),
  )

/** The `mcpServers` map of `holder`, at `where` in `file`; none, or a problem, when it isn't one. */
const serversIn = (holder: Json | null, file: string, where: string, problems: Array<string>) => {
  const servers = holder?.mcpServers
  if (servers === undefined) return {}
  if (isObject(servers)) return servers
  problems.push(`MCP config has a ${where} that isn't an object: ${file}.`)
  return {}
}

/** The path `path` names, following symbolic links when it exists. */
const real = (fs: FileSystem.FileSystem, path: string) =>
  fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)))

/**
 * The repository's entry in the user's .claude.json `projects`: the key naming `repo`, directly or
 * through a symbolic link, the first in sorted order when several do.
 */
const projectEntry = (fs: FileSystem.FileSystem, projects: Json, repo: string) =>
  Effect.gen(function* () {
    const target = yield* real(fs, repo)
    for (const key of Object.keys(projects).sort()) {
      if (resolve(key) === resolve(repo) || (yield* real(fs, key)) === target) {
        return Option.some(projects[key])
      }
    }
    return Option.none<unknown>()
  })

/**
 * Resolves workers.mcp_servers, `names`, for the repository at `repo`, the main checkout. Every
 * problem is reported at once: a name defined nowhere, a claude.ai connector, a definition workers
 * can't be given, a config file that can't be read. No names reads no file and gives no servers.
 */
export const resolveServers = (repo: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const chosen = [...new Set(names)]
    if (chosen.length === 0) return { servers: [], note: noServersNote } satisfies ChosenServers
    const fs = yield* FileSystem.FileSystem
    const problems: Array<string> = []
    const userFile = yield* claudeConfigFile
    const projectFile = join(repo, ".mcp.json")
    const user = yield* readJson(fs, userFile, problems)
    const project = yield* readJson(fs, projectFile, problems)

    let localServers: Json = {}
    const projects = user?.projects
    if (isObject(projects)) {
      const entry = yield* projectEntry(fs, projects, repo)
      if (Option.isSome(entry) && isObject(entry.value)) {
        localServers = serversIn(entry.value, userFile, `projects["${repo}"].mcpServers`, problems)
      }
    }
    const scopes: ReadonlyArray<readonly [Scope, Json]> = [
      ["local", localServers],
      ["project", serversIn(project, projectFile, "mcpServers", problems)],
      ["user", serversIn(user, userFile, "mcpServers", problems)],
    ]
    // Claude Code's record of the connectors this machine has used: read leniently, it isn't ours.
    const everConnected = user?.claudeAiMcpEverConnected
    const connectors = new Set(
      Array.isArray(everConnected) ? everConnected.filter((c) => typeof c === "string") : [],
    )

    const servers: Array<ChosenServer> = []
    for (const name of chosen) {
      const shown = JSON.stringify(name)
      const found = scopes.find(([, defined]) => Object.hasOwn(defined, name))
      if (name.startsWith(connectorPrefix) || (found === undefined && connectors.has(name))) {
        problems.push(
          `MCP server ${shown} in workers.mcp_servers is a claude.ai connector, which workers can't be given.`,
        )
        continue
      }
      if (found === undefined) {
        problems.push(
          `MCP server ${shown} in workers.mcp_servers isn't defined here: not in ${userFile} for ${repo}, in ${projectFile} or in ${userFile}.`,
        )
        continue
      }
      const [scope, defined] = found
      const definition = defined[name]
      const file = scope === "project" ? projectFile : userFile
      const type = isObject(definition) ? (definition.type ?? "stdio") : undefined
      if (type === "claudeai-proxy") {
        problems.push(
          `MCP server ${shown} in workers.mcp_servers is a claude.ai connector, which workers can't be given.`,
        )
      } else if (!isObject(definition) || typeof type !== "string" || !transports.includes(type)) {
        problems.push(
          `MCP server ${shown} in ${file} (${scope} scope) isn't a definition workers can be given: it needs a type of ${transports.join(", ")}, or none.`,
        )
      } else {
        servers.push({ name, scope, definition: definition as McpServerConfig })
      }
    }
    if (problems.length > 0) return yield* new SetupProblem({ problems })
    return { servers, note: null } satisfies ChosenServers
  })

/**
 * The names of the servers defined for the repository at `repo` that workers can be given, in
 * Claude Code's order of scopes, each once, for tutti init to offer: no claude.ai connector. A
 * config file that can't be read offers none of its servers.
 */
export const definedServers = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const ignored: Array<string> = []
    const userFile = yield* claudeConfigFile
    const user = yield* readJson(fs, userFile, ignored)
    const project = yield* readJson(fs, join(repo, ".mcp.json"), ignored)
    const projects = user?.projects
    const entry = isObject(projects)
      ? yield* projectEntry(fs, projects, repo)
      : Option.none<unknown>()
    const local = Option.isSome(entry) && isObject(entry.value) ? entry.value : null
    const names = [local, project, user].flatMap((holder) =>
      Object.entries(serversIn(holder, "", "", ignored)).flatMap(([name, definition]) => {
        const type = isObject(definition) ? (definition.type ?? "stdio") : undefined
        return name.startsWith(connectorPrefix) ||
          typeof type !== "string" ||
          !transports.includes(type)
          ? []
          : [name]
      }),
    )
    return [...new Set(names)]
  })

/** The problem when a session's system/init lists servers tutti didn't give it (§ 4.6). */
export const notGivenProblem = (names: ReadonlyArray<string>): string =>
  `workers got MCP servers they weren't given: ${names.map((name) => JSON.stringify(name)).join(", ")}`

/** The problem when a session's system/init lacks servers tutti gave it. */
export const missingProblem = (names: ReadonlyArray<string>): string =>
  `workers didn't get MCP servers they were given: ${names.map((name) => JSON.stringify(name)).join(", ")}`

/**
 * Checks a session's first system/init: its mcp_servers must be exactly the chosen servers, each
 * with source sdk, dynamic or the scope it was resolved from. Statuses aren't compared: a server
 * can still be pending. A server listed but not chosen, or chosen but listed with another source,
 * is one workers weren't given; a chosen server not listed is missing. Either is a setup problem.
 */
export const checkInit = (
  init: Pick<SDKSystemMessage, "mcp_servers">,
  chosen: ChosenServers,
): Effect.Effect<void, SetupProblem> => {
  const scopes = new Map(chosen.servers.map((server) => [server.name, server.scope]))
  const listed = new Set(init.mcp_servers.map((server) => server.name))
  const notGiven = init.mcp_servers
    .filter((server) => {
      const scope = scopes.get(server.name)
      const source = server.source
      return (
        scope === undefined ||
        source === undefined ||
        !(passedSources.includes(source) || source === scope)
      )
    })
    .map((server) => server.name)
  const missing = chosen.servers.map((server) => server.name).filter((name) => !listed.has(name))
  const problems = [
    ...(notGiven.length > 0 ? [notGivenProblem([...new Set(notGiven)])] : []),
    ...(missing.length > 0 ? [missingProblem(missing)] : []),
  ]
  return problems.length > 0 ? Effect.fail(new SetupProblem({ problems })) : Effect.void
}
