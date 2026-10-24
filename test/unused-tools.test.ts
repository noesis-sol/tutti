import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Schedule } from "effect"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { probeOptions, type WorkerCallbacks, workerOptions } from "../src/agent/options.ts"
import {
  deniedTools,
  enablesPlugins,
  projectHasSkills,
  skillTool,
  unusedTools,
} from "../src/agent/unusedTools.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

// The live host's test starts the fake Claude Code as a process.
setDefaultTimeout(30_000)

const callbacks: WorkerCallbacks = {
  canUseTool: async () => ({ behavior: "allow" }),
  onElicitation: async () => ({ action: "decline" }),
  hooks: {},
  stderr: () => {},
}

const noServers = { servers: [], note: noServersNote }

const optionsWith = (skills: boolean, askUserQuestion = true) => {
  const base = appConfig()
  return workerOptions({
    config: {
      ...base,
      settings: {
        ...base.settings,
        workers: { ...base.settings.workers, ask_user_question: askUserQuestion },
      },
    },
    ticket: "tutti-abc.1",
    worktree: "/work/project-tutti/tutti-abc.1",
    prompt: { text: "You work on TICKET_ID.", file: null },
    servers: noServers,
    skills,
    callbacks,
    session: { _tag: "New", sessionId: "s" },
  })
}

/** A fresh folder for a project, with `files` (relative path to content) written in it. */
const project = (files: Readonly<Record<string, string>> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-unused-tools-"))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}

const hasSkills = (dir: string) =>
  Effect.runPromise(projectHasSkills(dir).pipe(Effect.provide(BunServices.layer)))

describe("the tools workers never use", () => {
  test("are Artifact, ListAgents, ReportFindings, ScheduleWakeup, SendFeedback and Workflow", () => {
    expect(unusedTools).toEqual([
      "Artifact",
      "ListAgents",
      "ReportFindings",
      "ScheduleWakeup",
      "SendFeedback",
      "Workflow",
    ])
    expect(skillTool).toBe("Skill")
  })

  test("Skill is denied with them only when the project has no skills", () => {
    expect(deniedTools(false)).toEqual([...unusedTools, "Skill"])
    expect(deniedTools(true)).toEqual(unusedTools)
  })

  test("a worker keeps Agent, Bash, Read, Edit, Write, ToolSearch and the task tools", () => {
    for (const skills of [false, true]) {
      for (const ask of [false, true]) {
        const denied = optionsWith(skills, ask).disallowedTools ?? []
        for (const kept of [
          "Agent",
          "Bash",
          "Read",
          "Edit",
          "Write",
          "ToolSearch",
          "TaskCreate",
          "TaskUpdate",
          "TaskList",
          "TaskGet",
          "Monitor",
        ]) {
          expect(denied).not.toContain(kept)
        }
      }
    }
  })

  test("a worker's session denies them, and AskUserQuestion when workers.ask_user_question is off", () => {
    expect(optionsWith(false).disallowedTools).toEqual([...unusedTools, "Skill"])
    expect(optionsWith(true).disallowedTools).toEqual([...unusedTools])
    expect(optionsWith(true, false).disallowedTools).toEqual([...unusedTools, "AskUserQuestion"])
    expect(optionsWith(false, false).disallowedTools).toEqual([
      ...unusedTools,
      "Skill",
      "AskUserQuestion",
    ])
  })

  test("the login probe's session denies them and Skill", () => {
    const options = probeOptions({
      config: appConfig(),
    })
    expect(options.disallowedTools).toEqual([...unusedTools, "Skill"])
  })
})

describe("projectHasSkills", () => {
  test("a project with nothing of Claude Code's has none", async () => {
    expect(await hasSkills(project())).toBe(false)
    expect(await hasSkills(join(project(), "missing"))).toBe(false)
  })

  test("anything in .claude/skills or .claude/commands is a skill", async () => {
    expect(await hasSkills(project({ ".claude/skills/review/SKILL.md": "# Review\n" }))).toBe(true)
    expect(await hasSkills(project({ ".claude/commands/ship.md": "Ship it.\n" }))).toBe(true)
  })

  test("empty skill folders, or agents alone, have none", async () => {
    const dir = project({ ".claude/agents/verifier.md": "---\nname: verifier\n---\n" })
    mkdirSync(join(dir, ".claude", "skills"))
    mkdirSync(join(dir, ".claude", "commands"))
    expect(await hasSkills(dir)).toBe(false)
  })

  test("a plugin enabled in the project's settings or its local settings counts", async () => {
    const enabled = JSON.stringify({ enabledPlugins: { "docs@market": true } })
    expect(await hasSkills(project({ ".claude/settings.json": enabled }))).toBe(true)
    expect(await hasSkills(project({ ".claude/settings.local.json": enabled }))).toBe(true)
  })

  test("plugins all set to false, or settings that aren't JSON, count for nothing", async () => {
    const disabled = JSON.stringify({ enabledPlugins: { "docs@market": false } })
    expect(await hasSkills(project({ ".claude/settings.json": disabled }))).toBe(false)
    expect(await hasSkills(project({ ".claude/settings.local.json": "{ not json" }))).toBe(false)
  })
})

describe("enablesPlugins", () => {
  test("an entry not set to false enables a plugin", () => {
    expect(enablesPlugins('{"enabledPlugins":{"a@m":true}}')).toBe(true)
    expect(enablesPlugins('{"enabledPlugins":{"a@m":["x"]}}')).toBe(true)
    expect(enablesPlugins('{"enabledPlugins":{"a@m":false,"b@m":true}}')).toBe(true)
    expect(enablesPlugins('{"enabledPlugins":{"a@m":false}}')).toBe(false)
    expect(enablesPlugins('{"enabledPlugins":{}}')).toBe(false)
    expect(enablesPlugins('{"enabledPlugins":["a@m"]}')).toBe(false)
    expect(enablesPlugins('{"permissions":{}}')).toBe(false)
    expect(enablesPlugins("[]")).toBe(false)
    expect(enablesPlugins("null")).toBe(false)
    expect(enablesPlugins("")).toBe(false)
  })

  test("any text gives an answer, never an exception", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        expect(typeof enablesPlugins(text)).toBe("boolean")
      }),
    )
  })

  test("settings enable a plugin exactly when one of their entries isn't false", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.boolean(), fc.jsonValue())), (plugins) => {
        const text = JSON.stringify({ enabledPlugins: plugins })
        const parsed = JSON.parse(text).enabledPlugins as Record<string, unknown>
        expect(enablesPlugins(text)).toBe(Object.values(parsed).some((v) => v !== false))
      }),
    )
  })
})

// The live host decides once, from the main checkout, as its layer is built.
const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** The arguments the fake Claude Code was started with, for one worker in the project `dir`. */
const workerArgs = (dir: string): Promise<ReadonlyArray<string>> => {
  const log = join(dir, "fake.jsonl")
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: noServers,
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify({ log }) },
  })
  const started = Effect.gen(function* () {
    const agents = yield* AgentHost
    yield* agents.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
    return yield* Effect.sync(() =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as { args?: ReadonlyArray<string> })
            .find((entry) => entry.args !== undefined)?.args
        : undefined,
    ).pipe(
      Effect.repeat({
        until: (args) => args !== undefined,
        schedule: Schedule.spaced(Duration.millis(20)),
      }),
      Effect.timeout(Duration.seconds(10)),
    )
  })
  return Effect.runPromise(
    started.pipe(
      Effect.map((args) => args ?? []),
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              logLayer(),
              eventsLayer(),
              configLayer(appConfig({ claude: fake }, dir)),
              BunServices.layer,
            ),
          ),
        ),
      ),
    ),
  )
}

describe("the live host", () => {
  test("starts a worker without Skill in a project with no skills", async () => {
    const args = (await workerArgs(project())).join(" ")
    for (const tool of [...unusedTools, "Skill"]) expect(args).toContain(tool)
  })

  test("starts a worker with Skill in a project with skills of its own", async () => {
    const args = (await workerArgs(project({ ".claude/commands/ship.md": "Ship it.\n" }))).join(" ")
    for (const tool of unusedTools) expect(args).toContain(tool)
    expect(args).not.toContain("Skill")
  })
})
