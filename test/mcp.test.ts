import { describe, expect, test } from "bun:test"
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import fc from "fast-check"
import {
  type ChosenServers,
  checkInit,
  claudeConfigFile,
  mcpServers,
  missingProblem,
  noServersNote,
  notGivenProblem,
  resolveServers,
} from "../src/agent/mcp.ts"
import type { SetupProblem } from "../src/cli/AppConfig.ts"

const fixtures = join(import.meta.dir, "fixtures", "mcp")

/**
 * A copy of the fixture config folders, `home`, `config-dir` and `repo`, with `<repo>` in each
 * .claude.json replaced by the copy's repository.
 */
const machine = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-mcp-")))
  cpSync(fixtures, dir, { recursive: true })
  const repo = join(dir, "repo")
  for (const folder of ["home", "config-dir"]) {
    const file = join(dir, folder, ".claude.json")
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("<repo>", repo))
  }
  return { dir, repo, home: join(dir, "home"), configDir: join(dir, "config-dir") }
}

const resolveIn = (
  env: Record<string, string>,
  repo: string,
  names: ReadonlyArray<string>,
): Promise<Exit.Exit<ChosenServers, SetupProblem>> =>
  Effect.runPromise(
    Effect.exit(
      resolveServers(repo, names).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        Effect.provide(BunServices.layer),
      ),
    ),
  )

const chosen = async (exit: Promise<Exit.Exit<ChosenServers, SetupProblem>>) => {
  const result = await exit
  if (Exit.isFailure(result)) throw new Error(`${result.cause}`)
  return result.value
}

const problems = async (exit: Promise<Exit.Exit<ChosenServers, SetupProblem>>) => {
  const result = await exit
  if (Exit.isSuccess(result)) throw new Error("resolved, want a setup problem")
  const reason = result.cause.reasons[0]
  if (reason?._tag !== "Fail") throw new Error(`${result.cause}`)
  return reason.error.problems
}

describe("resolveServers", () => {
  test("a name resolves from local, then project, then user scope", async () => {
    const { repo, home } = machine()
    const servers = await chosen(resolveIn({ HOME: home }, repo, ["postgres", "exa", "firecrawl"]))
    expect(servers.note).toBeNull()
    expect(servers.servers.map(({ name, scope }) => `${name} ${scope}`)).toEqual([
      "postgres local",
      "exa project",
      "firecrawl user",
    ])
    expect(mcpServers(servers)).toEqual({
      postgres: { type: "stdio", command: "pg-mcp", args: ["--local"] },
      exa: { type: "sse", url: "https://project.example/exa" },
      firecrawl: {
        command: "npx",
        args: ["-y", "firecrawl-mcp"],
        env: { FIRECRAWL_API_KEY: "user-secret" },
      },
    })
  })

  test("CLAUDE_CONFIG_DIR holds the user's .claude.json in place of the home directory", async () => {
    const { repo, home, configDir } = machine()
    const env = { HOME: home, CLAUDE_CONFIG_DIR: configDir }
    const servers = await chosen(resolveIn(env, repo, ["sentry", "browserbase", "exa"]))
    expect(servers.servers.map(({ name, scope }) => `${name} ${scope}`)).toEqual([
      "sentry local",
      "browserbase user",
      "exa project",
    ])
    // The home directory's file isn't read: its servers aren't defined.
    const [problem] = await problems(resolveIn(env, repo, ["firecrawl"]))
    expect(problem).toContain(join(configDir, ".claude.json"))
    expect(problem).not.toContain(join(home, ".claude.json"))
  })

  test("the user's .claude.json is in CLAUDE_CONFIG_DIR, else the home directory", async () => {
    const file = async (env: Record<string, string>) => {
      const exit = await Effect.runPromise(
        Effect.exit(
          claudeConfigFile.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
          ),
        ),
      )
      if (Exit.isFailure(exit)) throw new Error(`${exit.cause}`)
      return exit.value
    }
    expect(await file({ HOME: "/home/me" })).toBe("/home/me/.claude.json")
    expect(await file({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "/etc/claude" })).toBe(
      "/etc/claude/.claude.json",
    )
    expect(await file({ HOME: "/home/me", CLAUDE_CONFIG_DIR: "" })).toBe("/home/me/.claude.json")
  })

  test("a name defined nowhere is a setup problem naming the files looked in", async () => {
    const { repo, home } = machine()
    // digitalocean is another project's local server, not this repository's.
    const found = await problems(resolveIn({ HOME: home }, repo, ["digitalocean"]))
    const userFile = join(home, ".claude.json")
    expect(found).toEqual([
      `MCP server "digitalocean" in workers.mcp_servers isn't defined here: not in ${userFile} for ${repo}, in ${join(repo, ".mcp.json")} or in ${userFile}.`,
    ])
  })

  test("a claude.ai connector is a setup problem", async () => {
    const { repo, home } = machine()
    const found = await problems(
      resolveIn({ HOME: home }, repo, ["claude.ai Gmail", "claude.ai Never Connected", "exa"]),
    )
    expect(found).toEqual([
      `MCP server "claude.ai Gmail" in workers.mcp_servers is a claude.ai connector, which workers can't be given.`,
      `MCP server "claude.ai Never Connected" in workers.mcp_servers is a claude.ai connector, which workers can't be given.`,
    ])
  })

  test("every problem is reported at once", async () => {
    const { repo, home } = machine()
    const found = await problems(
      resolveIn({ HOME: home }, repo, ["nope", "claude.ai Gmail", "websocket", "postgres"]),
    )
    expect(found).toHaveLength(3)
    expect(found[0]).toStartWith(`MCP server "nope" in workers.mcp_servers isn't defined here`)
    expect(found[1]).toContain("claude.ai connector")
    expect(found[2]).toStartWith(
      `MCP server "websocket" in ${join(home, ".claude.json")} (user scope) isn't a definition`,
    )
  })

  test("no names gives no servers and a note, without reading any file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-mcp-"))
    writeFileSync(join(dir, ".claude.json"), "{ not json")
    const servers = await chosen(resolveIn({ HOME: dir }, dir, []))
    expect(servers).toEqual({ servers: [], note: noServersNote })
  })

  test("a config file that isn't JSON is a setup problem naming it", async () => {
    const { repo, home } = machine()
    writeFileSync(join(repo, ".mcp.json"), `{ "mcpServers": { "exa": `)
    const found = await problems(resolveIn({ HOME: home }, repo, ["firecrawl"]))
    expect(found).toHaveLength(1)
    expect(found[0]).toStartWith(`MCP config isn't valid JSON: ${join(repo, ".mcp.json")}: `)
  })

  test("mcpServers that isn't an object is a setup problem; Claude Code's own records aren't", async () => {
    const { repo, home } = machine()
    writeFileSync(join(repo, ".mcp.json"), `{ "mcpServers": ["exa"] }`)
    const found = await problems(resolveIn({ HOME: home }, repo, ["firecrawl"]))
    expect(found).toEqual([
      `MCP config has a mcpServers that isn't an object: ${join(repo, ".mcp.json")}.`,
    ])
    // The home fixture's claudeInChromeDefaultEnabled is a string, not the boolean Claude Code
    // writes; it changes nothing.
    writeFileSync(join(repo, ".mcp.json"), "{}")
    expect((await chosen(resolveIn({ HOME: home }, repo, ["firecrawl"]))).servers).toHaveLength(1)
  })

  test("missing config files define nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-mcp-"))
    const found = await problems(resolveIn({ HOME: dir }, dir, ["exa"]))
    expect(found[0]).toStartWith(`MCP server "exa" in workers.mcp_servers isn't defined here`)
  })

  test("the repository's project entry matches through a symbolic link", async () => {
    const { dir, repo, home } = machine()
    const link = join(dir, "link")
    symlinkSync(repo, link)
    const servers = await chosen(resolveIn({ HOME: home }, link, ["postgres"]))
    expect(servers.servers.map(({ scope }) => scope)).toEqual(["local"])
    // And the other way: the entry's key is a link to the repository.
    const userFile = join(home, ".claude.json")
    writeFileSync(
      userFile,
      JSON.stringify({ projects: { [link]: { mcpServers: { pg: { command: "pg" } } } } }),
    )
    const viaLink = join(dir, "link2")
    symlinkSync(repo, viaLink)
    expect((await chosen(resolveIn({ HOME: home }, viaLink, ["pg"]))).servers).toHaveLength(1)
  })

  test("a name listed twice is chosen once", async () => {
    const { repo, home } = machine()
    const servers = await chosen(resolveIn({ HOME: home }, repo, ["exa", "exa"]))
    expect(servers.servers.map(({ name }) => name)).toEqual(["exa"])
  })
})

const given: ChosenServers = {
  servers: [
    { name: "postgres", scope: "local", definition: { command: "pg-mcp" } },
    { name: "exa", scope: "project", definition: { type: "sse", url: "https://exa.example" } },
  ],
  note: null,
}

const check = async (
  servers: ReadonlyArray<{ name: string; status: string; source?: string }>,
  chosenServers: ChosenServers = given,
) => {
  const exit = await Effect.runPromise(
    Effect.exit(checkInit({ mcp_servers: [...servers] }, chosenServers)),
  )
  if (Exit.isSuccess(exit)) return []
  const reason = exit.cause.reasons[0]
  if (reason?._tag !== "Fail") throw new Error(`${exit.cause}`)
  return reason.error.problems
}

describe("checkInit", () => {
  test("accepts exactly the chosen servers, with source dynamic, sdk or their scope", async () => {
    expect(
      await check([
        { name: "exa", status: "pending", source: "dynamic" },
        { name: "postgres", status: "connected", source: "dynamic" },
      ]),
    ).toEqual([])
    expect(
      await check([
        { name: "postgres", status: "failed", source: "local" },
        { name: "exa", status: "connected", source: "sdk" },
      ]),
    ).toEqual([])
    expect(await check([], { servers: [], note: noServersNote })).toEqual([])
  })

  test("rejects a server that wasn't chosen", async () => {
    expect(
      await check([
        { name: "postgres", status: "connected", source: "dynamic" },
        { name: "exa", status: "connected", source: "dynamic" },
        { name: "claude.ai Gmail", status: "pending", source: "claudeai" },
        { name: "firecrawl", status: "connected", source: "user" },
      ]),
    ).toEqual([`workers got MCP servers they weren't given: "claude.ai Gmail", "firecrawl"`])
    expect(
      await check([{ name: "browserbase", status: "connected", source: "user" }], {
        servers: [],
        note: noServersNote,
      }),
    ).toEqual([notGivenProblem(["browserbase"])])
  })

  test("rejects a chosen name with another source", async () => {
    expect(
      await check([
        { name: "postgres", status: "connected", source: "user" },
        { name: "exa", status: "connected", source: "claudeai" },
      ]),
    ).toEqual([notGivenProblem(["postgres", "exa"])])
  })

  test("rejects a chosen server that isn't listed", async () => {
    expect(await check([{ name: "exa", status: "connected", source: "dynamic" }])).toEqual([
      missingProblem(["postgres"]),
    ])
  })

  const name = fc.string({ minLength: 1, maxLength: 12 })
  const source = fc.constantFrom("dynamic", "sdk")

  test("accepts any order of the chosen servers, and names every server added", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(name, { maxLength: 6 }),
        fc.uniqueArray(name, { maxLength: 4 }),
        fc.array(source, { minLength: 6, maxLength: 6 }),
        async (names, extras, sources) => {
          const added = extras.filter((extra) => !names.includes(extra))
          const servers: ChosenServers = {
            servers: names.map((n) => ({ name: n, scope: "user", definition: { command: n } })),
            note: null,
          }
          const listed = [...names]
            .reverse()
            .map((n, i) => ({ name: n, status: "pending", source: sources[i] ?? "dynamic" }))
          expect(await check(listed, servers)).toEqual([])
          const withExtras = [
            ...listed,
            ...added.map((n) => ({ name: n, status: "connected", source: "claudeai" })),
          ]
          expect(await check(withExtras, servers)).toEqual(
            added.length === 0 ? [] : [notGivenProblem(added)],
          )
        },
      ),
    )
  })
})
