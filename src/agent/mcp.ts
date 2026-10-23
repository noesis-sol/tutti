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
// is the scope, as § 4.1 has it. Its mcp_servers are decoded with a Schema, not trusted to the
// SDK's types: a CLI of another version may send none, and a session whose servers tutti can't read
// is a setup problem, as one with a server it wasn't given is.
// checkStatus makes the same check, of servers not given, on mcpServerStatus() before the first
// turn, leaving the rest to checkInit.
//
// Claude in Chrome, claude-in-chrome, is built into Claude Code rather than defined in a config
// file: choosing it gives sessions --chrome, and leaving it out --no-chrome (chromeArgs), as
// orchestra does. Claude Code turns Chrome on by itself, past strict MCP config, once it is set up
// on the machine. With --chrome, system/init lists it with source dynamic. tutti init offers it, as
// orchestra does, once the user's .claude.json records it set up (chromeSetUp).
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk"
import { Config, Effect, FileSystem, Option, Result, Schema } from "effect"
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
  /** Whether workers.mcp_servers chose Claude in Chrome (chromeServer); not when left out. */
  readonly chrome?: boolean
  /** A note for the START block when workers get no servers; null when they get some. */
  readonly note: string | null
}

/** The START block's note when workers.mcp_servers is empty (§ 15, Q5). */
export const noServersNote = "workers get no MCP servers: workers.mcp_servers is empty"

/** No servers at all, nor Chrome: the environment probe's (§ 4.9). */
export const noServers: ChosenServers = { servers: [], chrome: false, note: null }

/**
 * One in-process server of tutti's own, `name`, made by createSdkMcpServer, and Chrome when the
 * project chose it: the interview's (§ 4.10).
 */
export const inProcess = (
  name: string,
  definition: McpServerConfig,
  chrome: boolean,
): ChosenServers => ({
  servers: [{ name, scope: "sdk", definition }],
  chrome,
  note: null,
})

/**
 * The workers' servers, `chosen`, with tutti's own in-process server, `name`, made by
 * createSdkMcpServer: a worker's requires tools (§ 4.11). It takes the place of a chosen server of
 * the same name.
 */
export const withOwn = (
  chosen: ChosenServers,
  name: string,
  definition: McpServerConfig,
): ChosenServers => ({
  ...chosen,
  servers: [
    ...chosen.servers.filter((server) => server.name !== name),
    { name, scope: "sdk", definition },
  ],
})

/** Whether `chosen` has tutti's own in-process server `name` (withOwn). */
export const hasOwn = (chosen: Pick<ChosenServers, "servers">, name: string): boolean =>
  chosen.servers.some((server) => server.name === name && server.scope === "sdk")

/** Claude in Chrome's name, in workers.mcp_servers and system/init. */
export const chromeServer = "claude-in-chrome"

/**
 * The SDK's extraArgs giving a session Chrome as `chosen` says: --chrome when chosen, --no-chrome
 * otherwise.
 */
export const chromeArgs = (chosen: Pick<ChosenServers, "chrome">): Record<string, null> =>
  chosen.chrome === true ? { chrome: null } : { "no-chrome": null }

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
 * Claude in Chrome (chromeServer) isn't resolved: choosing it sets `chrome`.
 */
export const resolveServers = (repo: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const chrome = names.includes(chromeServer)
    const chosen = [...new Set(names)].filter((name) => name !== chromeServer)
    if (chosen.length === 0) {
      return chrome
        ? ({ servers: [], chrome, note: null } satisfies ChosenServers)
        : ({ servers: [], note: noServersNote } satisfies ChosenServers)
    }
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
    return { servers, ...(chrome ? { chrome } : {}), note: null } satisfies ChosenServers
  })

/**
 * The keys of the user's .claude.json, Claude Code's own records, in any of which it records that
 * Claude in Chrome is set up on this machine.
 */
const chromeKeys: ReadonlyArray<string> = [
  "claudeInChromeDefaultEnabled",
  "cachedChromeExtensionInstalled",
  "hasCompletedClaudeInChromeOnboarding",
]

/**
 * Whether the user's .claude.json, `user`, records Claude in Chrome set up on this machine: read
 * leniently, it isn't ours, so a value other than true is taken as not set.
 */
const chromeSetUp = (user: Json | null): boolean =>
  user !== null && chromeKeys.some((key) => user[key] === true)

/**
 * The names of the servers defined for the repository at `repo` that workers can be given, in
 * Claude Code's order of scopes, each once, for tutti init to offer: no claude.ai connector. A
 * config file that can't be read offers none of its servers. Claude in Chrome (chromeServer) comes
 * last, when the user's .claude.json records it set up (chromeSetUp) and no config file defines
 * the name.
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
    return [...new Set([...names, ...(chromeSetUp(user) ? [chromeServer] : [])])]
  })

/** The problem when a session's system/init lists servers tutti didn't give it (§ 4.6). */
export const notGivenProblem = (names: ReadonlyArray<string>): string =>
  `workers got MCP servers they weren't given: ${names.map((name) => JSON.stringify(name)).join(", ")}`

/** The problem when a session's system/init lacks servers tutti gave it. */
export const missingProblem = (names: ReadonlyArray<string>): string =>
  `workers didn't get MCP servers they were given: ${names.map((name) => JSON.stringify(name)).join(", ")}`

/** The problem when a session's system/init lists its MCP servers in no shape tutti can read. */
export const unlistedProblem =
  "Claude Code's system/init doesn't list workers' MCP servers in a shape tutti reads (mcp_servers), so it can't check they got only the ones they were given"

// The fields checkInit reads of system/init: each server's name, and its source where it has one.
const InitServers = Schema.Struct({
  mcp_servers: Schema.Array(
    Schema.Struct({ name: Schema.String, source: Schema.optional(Schema.String) }),
  ),
})

const decodeInitServers = Schema.decodeUnknownResult(InitServers)

/** The names of `servers`, as a session lists them, that workers weren't given: not `chosen`. */
const notGivenIn = (
  servers: ReadonlyArray<{ readonly name: string; readonly source?: string | undefined }>,
  chosen: ChosenServers,
): ReadonlyArray<string> => {
  const scopes = new Map(chosen.servers.map((server) => [server.name, server.scope]))
  return servers
    .filter((server) => {
      const scope = scopes.get(server.name)
      const source = server.source
      if (chosen.chrome === true && server.name === chromeServer && source === "dynamic")
        return false
      return (
        scope === undefined ||
        source === undefined ||
        !(passedSources.includes(source) || source === scope)
      )
    })
    .map((server) => server.name)
}

/**
 * Checks a session's first system/init: its mcp_servers must be exactly the chosen servers, each
 * with source sdk, dynamic or the scope it was resolved from. Statuses aren't compared: a server
 * can still be pending. A server listed but not chosen, or chosen but listed with another source,
 * is one workers weren't given; a chosen server not listed is missing. Either is a setup problem.
 * Chrome, when chosen, may be listed with source dynamic, and needn't be: --chrome on a machine
 * where it isn't set up gives none. A system/init without mcp_servers, or with a server without a
 * name, is a setup problem too: tutti can't tell what workers got.
 */
export const checkInit = (
  init: unknown,
  chosen: ChosenServers,
): Effect.Effect<void, SetupProblem> => {
  const read = decodeInitServers(init)
  if (Result.isFailure(read)) return Effect.fail(new SetupProblem({ problems: [unlistedProblem] }))
  const servers = read.success.mcp_servers
  const listed = new Set(servers.map((server) => server.name))
  const notGiven = notGivenIn(servers, chosen)
  const missing = chosen.servers.map((server) => server.name).filter((name) => !listed.has(name))
  const problems = [
    ...(notGiven.length > 0 ? [notGivenProblem([...new Set(notGiven)])] : []),
    ...(missing.length > 0 ? [missingProblem(missing)] : []),
  ]
  return problems.length > 0 ? Effect.fail(new SetupProblem({ problems })) : Effect.void
}

// The fields checkStatus reads of mcpServerStatus()'s answer: each server's name and source.
const decodeStatusServers = Schema.decodeUnknownResult(
  Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String })),
)

/**
 * Checks a session's MCP servers as mcpServerStatus() lists them before its first turn, so a worker
 * given a server it shouldn't have ends before it does anything (§ 4.1): one listed that isn't
 * chosen, or with another source, is a setup problem, as in checkInit. A chosen server not listed
 * isn't (an in-process server can be listed only a moment later), nor is an answer tutti can't
 * read, or a server without a source (a CLI that predates the field): the first system/init's
 * check, checkInit, is left to find those.
 */
export const checkStatus = (
  status: unknown,
  chosen: ChosenServers,
): Effect.Effect<void, SetupProblem> => {
  const read = decodeStatusServers(status)
  if (Result.isFailure(read)) return Effect.void
  const notGiven = notGivenIn(read.success, chosen)
  return notGiven.length > 0
    ? Effect.fail(new SetupProblem({ problems: [notGivenProblem([...new Set(notGiven)])] }))
    : Effect.void
}
