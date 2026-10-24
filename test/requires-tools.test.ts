// A worker's own requires tools (§ 4.11, src/agent/requiresTools.ts): requires_check checks and
// installs the list in the worker's worktree, requires_readme writes that README's section, both
// on tutti's in-process MCP server, which each worker's session gets beside workers.mcp_servers
// (the live AgentHost's ownServer), and which the requires note names in place of the shell command.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, query } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { type ChosenServers, checkInit, hasOwn, noServersNote, withOwn } from "../src/agent/mcp.ts"
import { allowRequiresReadme, type WorkerCallbacks, workerOptions } from "../src/agent/options.ts"
import {
  checkIn,
  makeRequiresTools,
  qualifiedRequiresTool,
  readmeIn,
  requiresServerFor,
  requiresServerName,
} from "../src/agent/requiresTools.ts"
import { SessionKind } from "../src/agent/sessionKind.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { builtInWorkerPrompt, requiresNote } from "../src/project/prompt.ts"
import { requiresEnd, requiresStart } from "../src/project/requires.ts"
import type { Requirement } from "../src/project/settings.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { openFibers } from "./fibers.ts"

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-requires-tools-")))

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

/** A worktree at a temp folder with `requires` in its settings, and `readme` as its README.md. */
const worktree = (requires: ReadonlyArray<Requirement>, readme?: string) => {
  const dir = folder()
  mkdirSync(join(dir, ".tutti"))
  writeFileSync(join(dir, ".tutti", "settings.json"), JSON.stringify({ requires }))
  if (readme !== undefined) writeFileSync(join(dir, "README.md"), readme)
  return dir
}

/** A requirement met once its install has made the file `name` in the worktree. */
const marker = (name: string): Requirement => ({
  name,
  check: `test -f ${name}`,
  install: `touch ${name}`,
})

/** The text of a tool's answer, and whether it is an error. */
const said = (answer: { content: ReadonlyArray<unknown>; isError?: boolean | undefined }) => ({
  text: answer.content.map((c) => (c as { text: string }).text).join("\n"),
  error: answer.isError === true,
})

describe("requires_check", () => {
  test("installs what is missing in the worktree, each entry's state a line", async () => {
    const dir = worktree([{ name: "met", check: "true", install: "false" }, marker("made")])
    const answer = said(await run(checkIn(dir, dir, {})))
    expect(answer).toEqual({ text: "met: met\nmade: installed with 'touch made'", error: false })
    expect(existsSync(join(dir, "made"))).toBe(true)
    expect(existsSync(join(dir, ".tutti", "run", "requires-made.log"))).toBe(true)
  })

  test("checks only the entries named, and only checks with no_install", async () => {
    const dir = worktree([marker("one"), marker("two")])
    const answer = said(await run(checkIn(dir, dir, { names: ["two"], no_install: true })))
    expect(answer.text).toBe(
      "two: missing: 'test -f two' fails; install it with 'touch two'\n" +
        "Still missing: two. Fix its entry in .tutti/settings.json and call requires_check again, or ask the maintainer for a manual step.",
    )
    expect(answer.error).toBe(false)
    expect(existsSync(join(dir, "one"))).toBe(false)
    expect(existsSync(join(dir, "two"))).toBe(false)
  })

  test("a name not in the list is refused, nothing checked", async () => {
    const dir = worktree([marker("one")])
    expect(said(await run(checkIn(dir, dir, { names: ["one", "jq"] })))).toEqual({
      text: "Not in the requires list in .tutti/settings.json: jq; it has one. Add an entry for it there first.",
      error: true,
    })
    expect(existsSync(join(dir, "one"))).toBe(false)
    const empty = worktree([])
    expect(said(await run(checkIn(empty, empty, { names: ["jq"] }))).text).toContain(
      "it has no entries",
    )
    expect(said(await run(checkIn(empty, empty, {})))).toEqual({
      text: "No requirements: .tutti/settings.json has no 'requires' list.",
      error: false,
    })
  })

  test("a list the settings refuse is refused, saying why", async () => {
    const dir = worktree([{ name: "a", check: "x" } as Requirement])
    expect(said(await run(checkIn(dir, dir, {})))).toEqual({
      text: ".tutti/settings.json: requires[0]: needs an install (a command that meets it) or manual (what a person must do)",
      error: true,
    })
  })
})

describe("requires_readme", () => {
  test("writes the worktree's README section from its list, once", async () => {
    const dir = worktree([marker("made")], "# P\n")
    expect(said(await run(readmeIn(dir)))).toEqual({
      text: `Wrote the requires list into README.md, between ${requiresStart} and ${requiresEnd}: commit it with the list.`,
      error: false,
    })
    const readme = readFileSync(join(dir, "README.md"), "utf8")
    expect(readme).toContain(requiresStart)
    expect(readme).toContain("touch made")
    expect(said(await run(readmeIn(dir))).text).toBe(
      "README.md's section is the requires list's already.",
    )
  })

  test("a README whose markers don't pair is refused", async () => {
    const dir = worktree([marker("made")], `# P\n${requiresStart}\n`)
    expect(said(await run(readmeIn(dir))).error).toBe(true)
  })
})

describe("the worker's server", () => {
  test("is tutti's in-process server, its tools called through it", async () => {
    const dir = worktree([marker("made")], "# P\n")
    const tools = await run(makeRequiresTools(dir, dir, openFibers()))
    expect(tools.server.type).toBe("sdk")
    expect(tools.server.name).toBe(requiresServerName)
    expect(tools.tools.map((t) => t.name)).toEqual(["requires_check", "requires_readme"])
    const [check, readme] = tools.tools
    if (check === undefined || readme === undefined) throw new Error("no tools")
    expect(said(await check.handler({}, {})).text).toBe("made: installed with 'touch made'")
    expect(said(await readme.handler({}, {})).text).toContain("Wrote the requires list")
  })

  test("a call aborted stops its install", async () => {
    const dir = worktree([{ name: "slow", check: "test -f done", install: "sleep 30; touch done" }])
    const tools = await run(makeRequiresTools(dir, dir, openFibers()))
    const abort = new AbortController()
    const call = tools.tools[0]?.handler({}, { signal: abort.signal })
    setTimeout(() => abort.abort(), 200)
    const started = Date.now()
    await call?.catch(() => undefined)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(existsSync(join(dir, "done"))).toBe(false)
  })

  test("main's maker gives each session a server of its own", async () => {
    const dir = worktree([])
    const make = await run(requiresServerFor(dir))
    const first = await Effect.runPromise(make(dir, openFibers()))
    const second = await Effect.runPromise(make(dir, openFibers()))
    expect(first.name).toBe(requiresServerName)
    expect(first.instance).not.toBe(second.instance)
  })
})

const callbacks: WorkerCallbacks = {
  canUseTool: async () => ({ behavior: "allow" }),
  onElicitation: async () => ({ action: "decline" }),
  hooks: { PreToolUse: [{ hooks: [async () => ({})] }] },
  stderr: () => {},
}

const chosen: ChosenServers = {
  servers: [{ name: "docs", scope: "project", definition: { command: "docs-server" } }],
  note: null,
}

/** A worker's options with `servers`, its prompt the built-in one. */
const optionsWith = (servers: ChosenServers) =>
  workerOptions({
    config: TestAppConfig.appConfig({}, "/work/project"),
    ticket: "t-1",
    worktree: "/work/project-tutti/t-1",
    prompt: { text: builtInWorkerPrompt, file: null },
    servers,
    skills: false,
    readme: true,
    callbacks,
    session: { _tag: "New", sessionId: "11111111-1111-4111-8111-111111111111" },
  })

/** The text appended to the preset in `options`. */
const appended = (options: Options): string => {
  const prompt = options.systemPrompt
  return typeof prompt === "object" && "append" in prompt ? (prompt.append ?? "") : ""
}

describe("a worker given tutti's server", () => {
  const own = { type: "sdk", name: requiresServerName, instance: {} } as never

  test("gets it beside the chosen servers, in place of one of its name", () => {
    const servers = withOwn(chosen, requiresServerName, own)
    expect(servers.servers.map((s) => [s.name, s.scope])).toEqual([
      ["docs", "project"],
      ["tutti", "sdk"],
    ])
    expect(hasOwn(servers, requiresServerName)).toBe(true)
    expect(hasOwn(chosen, requiresServerName)).toBe(false)
    const clash: ChosenServers = {
      servers: [{ name: "tutti", scope: "user", definition: { command: "x" } }],
      note: null,
    }
    expect(withOwn(clash, requiresServerName, own).servers).toEqual([
      { name: "tutti", scope: "sdk", definition: own },
    ])
    const init = {
      mcp_servers: [
        { name: "docs", status: "connected", source: "dynamic" },
        { name: "tutti", status: "connected", source: "sdk" },
      ],
    }
    expect(Effect.runSync(Effect.exit(checkInit(init, servers)))._tag).toBe("Success")
  })

  test("is told of the tools, and allowed requires_readme without asking", async () => {
    const options = optionsWith(withOwn(chosen, requiresServerName, own))
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["docs", "tutti"])
    expect(options.mcpServers?.tutti).toBe(own)
    expect(appended(options)).toContain(requiresNote([], builtInWorkerPrompt, true, true))
    expect(appended(options)).not.toContain("tutti requires --readme")
    expect(options.hooks?.PreToolUse).toEqual([
      ...(callbacks.hooks.PreToolUse ?? []),
      allowRequiresReadme,
    ])
    expect(allowRequiresReadme.matcher).toBe("mcp__tutti__requires_readme")
    const decision = await allowRequiresReadme.hooks[0]?.({} as never, undefined, {
      signal: new AbortController().signal,
    })
    expect(decision).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "tutti's own requires tool",
      },
    })
  })

  test("without it, is told the shell command, and no hook is added", () => {
    const options = optionsWith(chosen)
    expect(appended(options)).toContain(requiresNote([], builtInWorkerPrompt, true, false))
    expect(appended(options)).toContain("tutti requires --readme")
    expect(appended(options)).not.toContain("requires_check")
    expect(options.hooks).toBe(callbacks.hooks)
  })
})

describe("the requires note with the tools", () => {
  test("names requires_check, and requires_readme where there is a README", () => {
    const short = requiresNote(["jq"], builtInWorkerPrompt, true, true)
    expect(short).toBe(
      `\n\nThe project's requires list is "requires" in .tutti/settings.json, which has jq now. tutti's requires_check tool checks the list in your worktree, and installs what is missing with each entry's own install command; an entry your branch adds or changes, it gives you to run with Bash. A ticket that changes the list calls tutti's requires_readme tool, which writes README.md's section on what to install from it, and commits that with the list.\n`,
    )
    const own = requiresNote([], "You work on TICKET_ID.", false, true)
    expect(own).toContain("requires_check")
    expect(own).not.toContain("requires_readme")
    expect(qualifiedRequiresTool("requires_check")).toBe("mcp__tutti__requires_check")
  })
})

describe("the live AgentHost with ownServer", () => {
  /** A start with `ownServer` given, its query() recording the options it was called with. */
  const started = async (probe: boolean) => {
    const dir = folder()
    const config = TestAppConfig.appConfig({ claude: null, settings: defaultSettings }, dir)
    const calls: Array<{ readonly worktree: string }> = []
    let options: Options | undefined
    const recording: typeof query = (params) => {
      options = params.options
      throw new Error("stop here")
    }
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: { servers: [], note: noServersNote },
      ownServer: (worktree) =>
        Effect.sync(() => {
          calls.push({ worktree })
          return { type: "sdk", name: requiresServerName, instance: {} } as never
        }),
      account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
      env: testEnv,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* AgentHost
        yield* Effect.exit(
          agents.start("t-1", {
            sessionId: "11111111-1111-4111-8111-111111111111",
            cwd: dir,
            ...(probe ? { kind: SessionKind.Probe() } : {}),
          }),
        )
      }).pipe(
        Effect.provide(
          host.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                attentionLayer(waitForTest),
                transcriptsLayer(),
                ClaudeCode.layerWith(recording),
              ),
            ),
            Layer.provideMerge(
              Layer.mergeAll(
                logLayer(),
                eventsLayer(),
                TestAppConfig.layer(config),
                BunServices.layer,
              ),
            ),
          ),
        ),
      ),
    )
    return { dir, calls, options }
  }

  test("gives a worker tutti's server, made for its worktree", async () => {
    const { dir, calls, options } = await started(false)
    expect(calls).toEqual([{ worktree: dir }])
    expect(Object.keys(options?.mcpServers ?? {})).toEqual([requiresServerName])
    expect(appended(options ?? {})).toContain("requires_check")
  })

  test("gives the environment probe none", async () => {
    const { calls, options } = await started(true)
    expect(calls).toEqual([])
    expect(options?.mcpServers).toEqual({})
  })
})
