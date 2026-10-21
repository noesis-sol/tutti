// tutti init offers Claude in Chrome (§ 4.6) as orchestra's Discover does: once the user's
// .claude.json records it set up, in claudeInChromeDefaultEnabled, cachedChromeExtensionInstalled
// or hasCompletedClaudeInChromeOnboarding (read leniently), labelled as built into Claude Code;
// chosen where it isn't set up, the question notes it and the summary cautions. Init runs in a
// temp repository with a scripted form and machine, as test/init-skill-copy.test.ts has them.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import fc from "fast-check"
import { chromeServer, definedServers } from "../src/agent/mcp.ts"
import { type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import {
  chromeBuiltIn,
  chromeNotSetUp,
  mcpSteps,
  notDefinedHere,
  serverLabel,
  serverNotes,
  type WorkersQuestions,
} from "../src/init/workers.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const chromeKeys = [
  "claudeInChromeDefaultEnabled",
  "cachedChromeExtensionInstalled",
  "hasCompletedClaudeInChromeOnboarding",
] as const

/** A temp repository and a home folder whose .claude.json is `user`, if given. */
const newProject = (user?: unknown) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-chrome-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  if (user !== undefined) writeFileSync(join(home, ".claude.json"), JSON.stringify(user))
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** The servers definedServers offers for `project`. */
const offered = (project: Project) =>
  Effect.runPromise(
    definedServers(project.repo).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )

describe("Claude in Chrome among the servers tutti init offers", () => {
  test("offered, last, once any of Claude Code's records has it set up", async () => {
    for (const key of chromeKeys) {
      const project = newProject({
        [key]: true,
        mcpServers: { exa: { type: "http", url: "https://exa" } },
      })
      expect(await offered(project)).toEqual(["exa", chromeServer])
    }
  })

  test("not offered where nothing records it, or no .claude.json is there", async () => {
    expect(await offered(newProject({ [chromeKeys[0]]: false }))).toEqual([])
    expect(await offered(newProject())).toEqual([])
  })

  test("a record of another shape is taken as not set, and fails nothing", async () => {
    const shape = fc.jsonValue().filter((value) => value !== true)
    await fc.assert(
      fc.asyncProperty(fc.tuple(shape, shape, shape), async (values) => {
        const user = Object.fromEntries(chromeKeys.map((key, at) => [key, values[at]]))
        expect(await offered(newProject({ ...user, mcpServers: { a: {} } }))).toEqual(["a"])
      }),
      { numRuns: 25 },
    )
  })

  test("offered once where a config file defines the name too", async () => {
    const project = newProject({
      hasCompletedClaudeInChromeOnboarding: true,
      mcpServers: { [chromeServer]: { command: "chrome-mcp" } },
    })
    expect(await offered(project)).toEqual([chromeServer])
  })
})

describe("the MCP servers question's notes", () => {
  test("Chrome built in where set up, not set up where chosen only; a chosen server undefined", () => {
    expect(serverNotes(["exa", chromeServer], ["exa", chromeServer])).toEqual({
      [chromeServer]: chromeBuiltIn,
    })
    expect(serverNotes(["exa", chromeServer, "gone"], ["exa"])).toEqual({
      [chromeServer]: chromeNotSetUp,
      gone: notDefinedHere,
    })
  })

  test("labels a server with its note, as orchestra's form does", () => {
    const notes = { [chromeServer]: chromeBuiltIn }
    expect(serverLabel(chromeServer, notes)).toBe(
      "claude-in-chrome  · built into Claude Code, drives Chrome on this machine",
    )
    expect(serverLabel("exa", notes)).toBe("exa")
  })

  test("the line form lists them with their notes, and takes Chrome's name", async () => {
    const questions: WorkersQuestions = {
      installBeads: null,
      concurrent: null,
      mcp: {
        available: ["exa", chromeServer],
        chosen: [],
        notes: { [chromeServer]: chromeBuiltIn },
      },
      changelogUnion: false,
    }
    const stream = new PassThrough()
    stream.end(`${chromeServer}\n`)
    let output = ""
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const form = lineForm({
            input: yield* streamInput(stream),
            write: (text) => {
              output += text
            },
            theme: makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true }),
          })
          return yield* form.workers(questions)
        }),
      ),
    )
    expect(output).toContain(`Defined here: exa, ${chromeServer} (${chromeBuiltIn}).`)
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ mcp: [chromeServer] })
  })
})

describe("the summary's MCP servers", () => {
  test("cautions when Chrome is chosen but not set up here", () => {
    const steps = mcpSteps([chromeServer], [chromeServer], false)
    expect(steps.map(stepLine)).toEqual([
      "✓ MCP servers  workers get claude-in-chrome",
      "! MCP servers  claude-in-chrome is chosen, but Claude in Chrome isn't set up on this machine: workers get no Chrome until it is (/chrome in Claude Code)",
    ])
    expect(mcpSteps([chromeServer], [chromeServer], true).map((s) => s.kind)).toEqual(["done"])
    expect(mcpSteps(["exa"], ["exa"], false).map((s) => s.kind)).toEqual(["done"])
  })
})

/** bd on the PATH, every command answered with "". */
const machineOf = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

/** A form answering the MCP servers with `mcp`, if given; the Workers questions it was asked. */
const serversForm = (mcp?: ReadonlyArray<string>) => {
  const asked: Array<WorkersQuestions["mcp"]> = []
  const form: InitForm = {
    workers: (questions) =>
      Effect.sync(() => {
        asked.push(questions.mcp)
        return mcp === undefined ? {} : { mcp }
      }),
    checks: () => Effect.succeed({ checks: { kind: "scratch" }, verifier: false }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  }
  return { form, asked }
}

const runInit = async (project: Project, form: InitForm) => {
  const exit = await Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags: { force: false },
        form,
        scout: Effect.succeed({ suites: [], stack: [], note: "" }),
        machine: machineOf(project),
        configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
        account: TestAccount.layer(),
        claudeConfig: join(project.home, ".claude.json"),
      }).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer([])),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
        ),
        Effect.provide(BunServices.layer),
      ),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

/** The summary's MCP servers lines. */
const serverLines = (summary: InitSummary) =>
  summary.steps.map(stepLine).filter((line) => line.slice(2).startsWith("MCP servers  "))

const chosenServers = (project: Project): unknown =>
  JSON.parse(readFileSync(join(project.repo, ".tutti/settings.json"), "utf8")).workers.mcp_servers

describe("tutti init with Claude in Chrome", () => {
  test("set up and no server defined: asks, labelled built in, and gives it when chosen", async () => {
    const project = newProject({ cachedChromeExtensionInstalled: true })
    const { form, asked } = serversForm([chromeServer])
    const summary = await runInit(project, form)
    expect(asked).toEqual([
      { available: [chromeServer], chosen: [], notes: { [chromeServer]: chromeBuiltIn } },
    ])
    expect(chosenServers(project)).toEqual([chromeServer])
    expect(serverLines(summary)).toEqual(["✓ MCP servers  workers get claude-in-chrome"])
  })

  test("chosen but not set up: the question and the summary say so", async () => {
    const project = newProject({ claudeInChromeDefaultEnabled: "yes" })
    mkdirSync(join(project.repo, ".tutti"))
    writeFileSync(
      join(project.repo, ".tutti/settings.json"),
      JSON.stringify({ workers: { mcp_servers: [chromeServer] } }),
    )
    const { form, asked } = serversForm()
    const summary = await runInit(project, form)
    expect(asked).toEqual([
      {
        available: [chromeServer],
        chosen: [chromeServer],
        notes: { [chromeServer]: chromeNotSetUp },
      },
    ])
    expect(chosenServers(project)).toEqual([chromeServer])
    expect(serverLines(summary)).toEqual([
      "✓ MCP servers  workers get claude-in-chrome",
      "! MCP servers  claude-in-chrome is chosen, but Claude in Chrome isn't set up on this machine: workers get no Chrome until it is (/chrome in Claude Code)",
    ])
  })
})
