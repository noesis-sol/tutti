// --auto-answer's flag and where it is seen (§ 8.2, § 7.2, § 7.11, § 10): its forms (bare, a time,
// off, a bad one), the START line's ` · auto-answer`, the title line's pill in its own role, the
// summary's list of what it answered, and the run's end waiting for a question it will answer.
import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Option, Result, Schema } from "effect"
import { Command } from "effect/cli"
import fc from "fast-check"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings, defaultUserConfig, resolve } from "../src/cli/AppConfig.ts"
import { autoAnswerAfter, cliFlags, type RunFlags } from "../src/cli/flags.ts"
import { autoAnsweredHint, type Summary, summary } from "../src/print/summary.ts"
import { autoAnswerName, leftWhy } from "../src/run/autoAnswer.ts"
import { summaryLines } from "../src/run/endOfRun.ts"
import { EventRecord } from "../src/run/events.ts"
import { decide, End, type Snapshot } from "../src/run/runEnd.ts"
import { emptyView, type TitleView } from "../src/run/runView.ts"
import { type Started, startBlock } from "../src/run/startup.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import * as TestAccount from "../src/testing/Account.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/** Parses `args` as `tutti` would, giving the flags' texts. */
const parse = async (args: ReadonlyArray<string>): Promise<RunFlags> => {
  let parsed: RunFlags | undefined
  const command = Command.make("tutti", cliFlags, (flags) =>
    Effect.sync(() => {
      parsed = flags
    }),
  )
  const exit = await Effect.runPromiseExit(
    Command.runWith(command, { version: "test", renderErrors: false })(args).pipe(
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit) || parsed === undefined) throw new Error(`didn't parse: ${exit}`)
  return parsed
}

/** The configuration `args` and `env` give, or its problems. */
const resolved = async (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  resolve({
    repo: "/work/project",
    flags: await parse(args),
    env: (name) => env[name],
    user: defaultUserConfig,
    settings: defaultSettings,
  })

const autoAnswerOf = async (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const config = await resolved(args, env)
  if (Result.isFailure(config)) throw new Error(`expected a config, got ${config.failure}`)
  return config.success.autoAnswer
}

describe("the --auto-answer flag", () => {
  test("is off by default", async () => {
    expect(await autoAnswerOf([])).toBeNull()
    expect((await parse([])).autoAnswer).toEqual(Option.none())
  })

  test("given alone answers at once", async () => {
    expect(await autoAnswerOf(["--auto-answer"])).toEqual(Duration.zero)
    expect(await autoAnswerOf(["--auto-answer=on"])).toEqual(Duration.zero)
  })

  test("with a time answers what has waited that long", async () => {
    expect(await autoAnswerOf(["--auto-answer=10m"])).toEqual(Duration.minutes(10))
    expect(await autoAnswerOf(["--auto-answer=1h30m"])).toEqual(Duration.minutes(90))
  })

  test("=false, or 0, turns it off, over its variable", async () => {
    expect(await autoAnswerOf(["--auto-answer=false"])).toBeNull()
    expect(await autoAnswerOf(["--auto-answer=0"])).toBeNull()
    expect(await autoAnswerOf([], { TUTTI_AUTO_ANSWER: "5m" })).toEqual(Duration.minutes(5))
    expect(await autoAnswerOf(["--auto-answer=off"], { TUTTI_AUTO_ANSWER: "5m" })).toBeNull()
  })

  test("a bad value is a usage error, with the others", async () => {
    expect(await resolved(["--auto-answer=soon"])).toEqual(
      Result.fail(["--auto-answer must be on or off, or a time such as 10m (got 'soon')."]),
    )
    expect(await resolved([], { TUTTI_AUTO_ANSWER: "-3m" })).toEqual(
      Result.fail(["TUTTI_AUTO_ANSWER must be on or off, or a time such as 10m (got '-3m')."]),
    )
  })

  test("reads any text as on, off, a time or a problem, and never throws", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const read = autoAnswerAfter(text)
        if (Result.isFailure(read)) expect(read.failure).toContain("(got '")
        else if (read.success !== null) {
          expect(Duration.isGreaterThanOrEqualTo(read.success, Duration.zero)).toBe(true)
        }
      }),
    )
  })
})

describe("the START line", () => {
  const started = (autoAnswer: Duration.Duration | null): Started => ({
    config: appConfig({ autoAnswer }, "/work/project"),
    base: "main",
    prompt: { text: "Work on TICKET_ID.", file: null },
    mcp: { servers: [], note: noServersNote },
    account: TestAccount.accountProbe(),
    organs: { _tag: "AgentSdk" },
    warnings: [],
  })

  test("ends · auto-answer, or · auto-answer after its time", () => {
    expect(startBlock(started(Duration.zero), "0.1.0")[0]).toEndWith(") · auto-answer")
    expect(startBlock(started(Duration.minutes(10)), "0.1.0")[0]).toEndWith(
      ") · auto-answer after 10m",
    )
    expect(startBlock(started(null), "0.1.0")[0]).not.toContain("auto-answer")
  })

  test("the start record has auto_answer, its time in ms", () => {
    const record = {
      v: 1 as const,
      time: "2026-10-25T10:00:00Z",
      run: "2026-10-25T10:00:00Z",
      kind: "start" as const,
      version: "0.1.0",
      repo: "/r",
      branch: "main",
      concurrency: 1,
      billing: "subscription" as const,
      permission_mode: "auto",
      auto_answer: 600000,
    }
    expect(Schema.decodeUnknownSync(EventRecord)(record)).toEqual(record)
  })
})

describe("the title line's auto-answer pill", () => {
  const title: TitleView = {
    version: "0.1.0",
    branch: "main",
    scope: null,
    began: 0,
    stopping: false,
    quitting: null,
    solo: null,
    shared: 0,
    keepAwake: false,
    autoAnswer: null,
  }
  const auto: TitleView = { ...title, autoAnswer: autoAnswerName(Duration.minutes(10), "10m") }
  const segments = (view: TitleView, width = 120) => titleSegments(view, [], 0, theme, width)
  const text = (view: TitleView, width = 120) =>
    segments(view, width)
      .map((segment) => segment.text)
      .join("")

  test("follows the version, in its own role", () => {
    expect(text(auto)).toStartWith(" Tutti  0.1.0  auto-answer after 10m    main · 0s")
    const pill = segments(auto).find((segment) => segment.text === " auto-answer after 10m ")
    expect(pill?.look).toBe(theme.styles.autoAnswer)
    expect(theme.styles.autoAnswer.bg?.toInts()).toEqual(theme.rgba("autoAnswer").toInts())
    expect(text(title)).not.toContain("auto-answer")
  })

  test("follows the keep-awake badge, and outlasts it in a narrow pane", () => {
    const both = { ...auto, keepAwake: true }
    expect(text(both)).toStartWith(" Tutti  0.1.0  keep awake   auto-answer after 10m ")
    let width = 120
    while (text(both, width - 1).includes("keep awake")) width--
    const narrower = text(both, width - 1)
    expect(narrower).toContain(" auto-answer after 10m ")
    expect(narrower).not.toContain("keep awake")
  })
})

describe("the summary's list of what --auto-answer answered", () => {
  const ended: Summary = {
    version: "0.1.0",
    branch: "main",
    scope: null,
    took: 1000,
    totals: { ...emptyView.totals, slots: 1 },
    figures: [],
    rows: [],
    autoAnswered: [
      { ticket: "t-1", question: "t-2", title: "Which store?", choice: "SQLite" },
      { ticket: "t-3", title: "Which name?", choice: "Foo (Recommended)" },
    ],
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is stripped
  const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")

  test("names each question and its choice, and how to find them later", () => {
    const lines = strip(summary(ended, theme, 80)).split("\n")
    expect(lines.slice(-4)).toEqual([
      "Answered by --auto-answer, not by you",
      "  t-2 (Which store?), for t-1 → SQLite",
      "  t-3's worker: Which name? → Foo (Recommended)",
      `  find them later with: ${autoAnsweredHint}`,
    ])
    expect(summaryLines({ ...ended, base: "main" }).slice(-4)).toEqual<ReadonlyArray<string>>([
      "  Answered by --auto-answer, not by you:",
      "    t-2 (Which store?), for t-1 → SQLite",
      "    t-3's worker: Which name? → Foo (Recommended)",
      `    find them later with: ${autoAnsweredHint}`,
    ])
  })

  test("is absent when it answered nothing, and the hint without a question ticket", () => {
    expect(strip(summary({ ...ended, autoAnswered: [] }, theme, 80))).not.toContain("--auto-answer")
    const session = { ...ended, autoAnswered: ended.autoAnswered?.slice(1) ?? [] }
    expect(strip(summary(session, theme, 80))).not.toContain(autoAnsweredHint)
  })
})

describe("the run's end", () => {
  const look: Snapshot = {
    mergedBefore: true,
    running: new Set(),
    tickets: new Map(),
    overLimit: new Set(),
    asking: [],
    canTake: true,
    resuming: false,
    answering: false,
    settled: true,
    triagePending: 0,
    dashboard: false,
    held: false,
    usageHeld: false,
    endAsked: false,
  }

  test("waits for a question --auto-answer will answer once its time is up", () => {
    expect(decide({ ...look, answering: true })).toEqual(End.Busy())
    expect(decide(look)).toEqual(End.Done({ asked: false }))
  })
})

describe("which questions --auto-answer leaves to you", () => {
  const since = Date.parse("2026-10-25T10:00:00Z")
  const question = (over: Partial<Issue>): Issue => ({
    id: "q-1" as TicketId,
    title: "Which way?",
    description: "",
    design: "",
    acceptance: "",
    notes: "",
    status: "open",
    type: "task",
    assignee: "",
    labels: ["human"],
    dependencies: [],
    metadata: {
      options: [{ label: "A" }, { label: "B" }],
      recommended: 0,
    },
    files: [],
    predictedFiles: [],
    createdAt: "2026-10-25T10:05:00Z",
    closeReason: "",
    ...over,
  })

  test("one open before the run, maintainer_only, or without options; else none", () => {
    expect(leftWhy(question({}), since)).toBeUndefined()
    expect(leftWhy(question({ createdAt: "2026-10-25T09:59:59Z" }), since)).toBe(
      "it was open before the run",
    )
    expect(leftWhy(question({ createdAt: "" }), since)).toBe("it was open before the run")
    expect(
      leftWhy(question({ metadata: { ...question({}).metadata, maintainer_only: true } }), since),
    ).toBe("it asks you to do something only you can")
    expect(leftWhy(question({ metadata: {} }), since)).toBe("it gives no options")
  })
})
