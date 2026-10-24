import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKPermissionDeniedMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { lexer, type Token } from "marked"
import { Attention, type Policy } from "../src/agent/Attention.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { section } from "../src/organs/evidence.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { OrganHold, Organs } from "../src/organs/Organs.ts"
import { reviewer } from "../src/organs/reviewer.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { Ending } from "../src/print/summary.ts"
import { Ledger } from "../src/run/ledger.ts"
import { reportName } from "../src/run/localTime.ts"
import * as log from "../src/run/log.ts"
import { Log } from "../src/run/log.ts"
import { Move } from "../src/run/phase.ts"
import {
  compose,
  type ReportRun,
  reportsDir,
  runReport,
  steeredInRun,
  type talliesLine,
} from "../src/run/report.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { type Seed as BeadsSeed, layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { type Answers, layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { openFibers } from "./fibers.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const body = "The run ended with nothing left to do.\n\n## Finished\n- t-1: the parser, abc123\n"

const seeds: ReadonlyArray<BeadsSeed> = [
  { id: "t-1", title: "Parse the config", status: "closed", closeReason: "Parser added, tested" },
  { id: "t-2", title: "Fix the flaky test", status: "open", notes: "TRIAGE: environment" },
  { id: "t-3", title: "Write the docs", status: "in_progress" },
  { id: "t-4", title: "Ready for later", status: "open" },
]

/** Answers a question with its first option, denies a Write and allows any other call. */
const policy: Policy = (request) => {
  switch (request.kind._tag) {
    case "Question":
      return {
        _tag: "Choose",
        answers: request.kind.questions.map((q) => q.options[0]?.label ?? ""),
      }
    case "Permission":
      return request.kind.tool === "Write" ? { _tag: "Deny" } : { _tag: "Allow" }
    case "Elicitation":
      return { _tag: "Accept" }
  }
}

/** A call Claude Code denied `ticket`'s worker without asking, by `by`. */
const denial = (by: string): SDKPermissionDeniedMessage => ({
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "toolu_1",
  decision_reason_type: by,
  decision_reason: "held",
  message: "Permission to use Bash has been denied.",
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "s-1",
})

interface Setup {
  readonly answers?: Answers
  readonly config?: Partial<AppConfigValue>
  readonly held?: boolean
  readonly run?: Partial<ReportRun>
  /** Ctrl+C: the report is interrupted once its reviewer is asked. */
  readonly interrupt?: boolean
}

/**
 * Runs the report at the end of a run that took up t-1 (merged), t-2 (deferred) and t-3 (still
 * working), with tallies and steering, under TestClock; gives the reviewer's calls, the log, what
 * was printed and the repository's folder.
 */
const report = async (setup: Setup = {}) => {
  const repo = mkdtempSync(join(tmpdir(), "tutti-report-"))
  const calls: Array<OrganCallRecord> = []
  const printed: Array<string> = []
  const out: Out = { write: (text) => printed.push(text), columns: () => 100, tty: false }
  const shared = Layer.mergeAll(logLayer(), eventsLayer())
  const deps = Layer.mergeAll(
    cannedLayer(setup.answers ?? { reviewer: { report: body } }, calls),
    configLayer(appConfig({ ...setup.config }, repo)),
    beadsLayer(seeds),
    gitLayer({ dir: repo }),
    BunFileSystem.layer,
    Layer.succeed(OrganHold, { held: Effect.succeed(setup.held ?? false) }),
  ).pipe(Layer.provideMerge(shared))
  const services = Layer.mergeAll(
    Organs.layer,
    OrganCost.layer,
    Ledger.layer,
    attentionLayer(policy),
  ).pipe(Layer.provideMerge(deps))
  const lines = await Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Repository
      const startHead = yield* git.head("main")
      yield* git.commit(repo, "Parse the config (t-1)", { "src/config.ts": "parse" })
      const ledger = yield* Ledger
      for (const [id, title] of [
        ["t-1", "Parse the config"],
        ["t-2", "Fix the flaky test"],
        ["t-3", "Write the docs"],
      ] as const) {
        yield* ledger.transition(id, Move.Ready(), { title })
        yield* ledger.transition(id, Move.Dispatched())
      }
      yield* ledger.transition("t-1", Move.Verified({ place: 1 }))
      yield* ledger.transition("t-1", Move.ItsTurn())
      yield* ledger.transition("t-1", Move.FastForwarded({ commit: "abc123" }))
      yield* ledger.transition("t-2", Move.Defer({ why: "deferred by its worker" }))
      // t-1's worker asks twice and is denied once, and Claude Code denies it three calls.
      const attention = yield* Attention
      const ask = yield* attention.request("t-1", openFibers())
      const sdk = { signal: new AbortController().signal, toolUseID: "toolu_1", requestId: "req" }
      const question = {
        questions: [{ question: "Which?", options: [{ label: "This" }], multiSelect: false }],
      }
      yield* Effect.promise(() => ask("Bash", { command: "ffprobe in.mp4" }, sdk))
      yield* Effect.promise(() => ask("Write", { file_path: "/work/a.ts" }, sdk))
      yield* Effect.promise(() => ask("AskUserQuestion", question, sdk))
      for (const by of ["safetyCheck", "classifier", "safetyCheck"]) {
        yield* attention.denial("t-1", denial(by))
      }
      yield* ledger.count("t-2", "messages", 2)
      yield* ledger.count("t-2", "compactions")
      yield* ledger.steer("t-2", "message")
      // t-3's worker was interrupted and handed back: steered once, not now.
      yield* ledger.steer("t-3", "interrupt")
      yield* ledger.release("t-3")
      const logs = yield* Log
      yield* logs.write(
        log.steered("t-3"),
        log.released("t-3"),
        log.permission({
          id: "t-1",
          requestId: "r1",
          what: "Bash(ffprobe in.mp4)",
          defaultToNo: false,
          answers: ["allow", "allow-run", "deny"],
        }),
        log.denied({ id: "t-1", what: "Bash(rm -rf $T/*)", by: "safetyCheck", reason: "held" }),
      )
      const costs = yield* OrganCost
      yield* costs.record({
        organ: "triage",
        costUsd: 0.01,
        turns: 1,
        durationMs: 4200,
        sessionId: "s1",
      })
      yield* costs.record({
        organ: "predictor",
        costUsd: 0.02,
        turns: 2,
        durationMs: 2000,
        sessionId: "s2",
      })
      const run: ReportRun = {
        started: 0,
        base: "main",
        startHead,
        ending: Ending.Done({
          text: "READY_EMPTY: nothing left",
          tickets: 3,
          limit: null,
          took: 0,
        }),
        exitCode: 0,
        quit: false,
        ...setup.run,
      }
      const fiber = yield* Effect.forkChild(
        runReport(run, Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 })),
      )
      if (setup.interrupt) {
        yield* TestClock.adjust("1 second")
        yield* Fiber.interrupt(fiber)
      } else {
        yield* Fiber.join(fiber)
      }
      return yield* texts
    }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
  )
  const dir = join(repo, reportsDir)
  const files = existsSync(dir) ? readdirSync(dir) : []
  return { calls, log: lines, printed: printed.join(""), repo, files }
}

describe("the report's evidence", () => {
  test("has each ticket's tallies and whether you steered it", async () => {
    const { calls } = await report()
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.call.organ).toBe("reviewer")
    expect(call?.system).toBe(`\n\n${reviewer.system}`)
    const input = call?.input ?? ""
    expect(input).toContain(
      "t-1 (Done (merged in abc123)): 3 attention requests (2 permissions, 1 question), " +
        "1 allowed, 1 answered, 1 denied by you, 3 calls Claude Code denied without asking " +
        "(1 by the classifier, 2 by the safety check); not steered.",
    )
    expect(input).toContain(
      "t-2 (Deferred (deferred by its worker)): 2 of your messages, compacted once; steered by you.",
    )
    expect(input).toContain(
      "t-3 (Working): no attention requests, denials or messages; steered by you.",
    )
  })

  test("has the run's commits, closed and set-aside tickets, requests and denials, and costs", async () => {
    const { calls } = await report()
    const input = calls[0]?.input ?? ""
    expect(input).toContain("READY_EMPTY: nothing left")
    expect(input).toMatch(/[0-9a-f]+ Parse the config \(t-1\)/)
    expect(input).toContain("Close reason: Parser added, tested")
    expect(input).toContain("TRIAGE: environment")
    expect(input).toContain("t-3: Write the docs\nWorking")
    expect(input).toContain("PERMISSION: t-1's worker asks: Bash(ffprobe in.mp4)")
    expect(input).toContain("DENIED: t-1's worker: Bash(rm -rf $T/*), by the safety check: held")
    expect(input).toContain("$0.0300 in 2 organ calls, 3 turns in all, before this report.")
    expect(input.trimEnd()).toEndWith(
      "Exit code 0 (nothing was left to start or merge, or the limit was reached; a run of one ticket says in its final line whether all of it is merged). Write its report.",
    )
  })

  test("tags every section as evidence, the run's own sections included", async () => {
    const { calls } = await report({
      run: { sections: [section("The full check", "SUITE: bun test failed")] },
    })
    const input = calls[0]?.input ?? ""
    const id = /<evidence id="([0-9a-f]{16})">/.exec(input)?.[1]
    expect(id).toBeDefined()
    expect(input).toContain(
      `## The full check\n\n<evidence id="${id}">\nSUITE: bun test failed\n</evidence id="${id}">`,
    )
  })
})

describe("the report", () => {
  test("is written to .tutti/reports/<start time>.md with the organs' cost total, and printed", async () => {
    const { files, repo, printed, log: lines } = await report()
    expect(files).toEqual([reportName(0)])
    const written = readFileSync(join(repo, reportsDir, reportName(0)), "utf8")
    expect(written).toStartWith("# tutti run · ")
    expect(written.split("\n")[0]).toEndWith(" · main")
    expect(written).toContain("## Finished\n- t-1: the parser, abc123")
    // The reviewer's own call is counted: the total is taken once it has answered.
    expect(written.trimEnd()).toEndWith("Organs: $0.0300 in 3 organ calls, 4 turns in all.")
    expect(printed).toContain("Run report written")
    expect(printed).toContain("t-1: the parser, abc123")
    expect(printed).toContain("Organs: $0.0300 in 3 organ calls, 4 turns in all.")
    expect(printed).toContain(`Report saved to ${reportsDir}/${reportName(0)}`)
    expect(lines).toContain(`REPORT: written to ${reportsDir}/${reportName(0)}`)
  })

  test("names the scope in its title", async () => {
    const { files, repo } = await report({ config: { ticket: "t-9" } })
    const written = readFileSync(join(repo, reportsDir, files[0] ?? ""), "utf8")
    expect(written.split("\n")[0]).toEndWith(" · main · t-9")
  })

  test("is skipped with --review=false", async () => {
    const config = appConfig()
    const { calls, files, printed } = await report({
      config: {
        settings: { ...config.settings, organs: { ...config.settings.organs, review: false } },
      },
    })
    expect(calls).toHaveLength(0)
    expect(files).toHaveLength(0)
    expect(printed).toBe("")
  })

  test("is skipped when the run was quit", async () => {
    const { calls, files, printed } = await report({ run: { quit: true, exitCode: 130 } })
    expect(calls).toHaveLength(0)
    expect(files).toHaveLength(0)
    expect(printed).toBe("")
  })

  test("is skipped when the usage limit held the run to its end", async () => {
    const { calls, files, printed, log: lines } = await report({ held: true })
    expect(calls).toHaveLength(0)
    expect(files).toHaveLength(0)
    expect(printed).toContain("Run report skipped: the usage limit held the run to its end")
    expect(lines).toContain("ORGAN reviewer: skipped, the usage limit holds the run")
  })

  test("an empty report is REVIEW_FAILED, and nothing is written", async () => {
    const {
      files,
      printed,
      log: lines,
    } = await report({
      answers: { reviewer: { report: "  \n" } },
    })
    expect(files).toHaveLength(0)
    expect(lines).toContain("REVIEW_FAILED: the reviewer wrote an empty report")
    expect(printed).toContain("REVIEW_FAILED: the reviewer wrote an empty report")
  })
})

describe("Ctrl+C", () => {
  test("skips the report while the reviewer writes it", async () => {
    const { calls, files, printed } = await report({
      answers: { reviewer: Effect.never },
      interrupt: true,
    })
    expect(calls).toHaveLength(1)
    expect(files).toHaveLength(0)
    expect(printed).toContain("Run report skipped")
    expect(printed).not.toContain("Run report written")
  })
})

describe("steering and tallies", () => {
  const entry = {
    ticket: "t-1",
    title: "x",
    phase: { _tag: "Working" },
    since: 0,
    worker: 1,
    row: 0,
    rechecking: false,
    steered: false,
    lastMessage: null,
    tallies: { messages: 0, compactions: 0 },
  } as unknown as Parameters<typeof talliesLine>[0]

  test("a ticket is steered by a message, a steer now, or a STEERED line, but not another's", () => {
    expect(steeredInRun(entry, [])).toBe(false)
    expect(steeredInRun({ ...entry, steered: true }, [])).toBe(true)
    expect(steeredInRun({ ...entry, tallies: { ...entry.tallies, messages: 1 } }, [])).toBe(true)
    const kept = (written: log.Written) => Effect.runSync(log.keep([written]))
    expect(steeredInRun(entry, kept(log.steered("t-1")))).toBe(true)
    expect(steeredInRun(entry, kept(log.steered("xt-1")))).toBe(false)
    expect(steeredInRun(entry, kept(log.steered("t-10")))).toBe(false)
  })
})

/** Whether a heading's inline tokens are only text: no emphasis, code, link or HTML. */
const plainInline = (tokens: ReadonlyArray<Token>): boolean =>
  tokens.every((token) => token.type === "text" || token.type === "escape")

describe("the report's title", () => {
  test("reads the base and the scope as text, whatever they hold", () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.string(), { nil: null }), (base, scope) => {
        const written = compose({
          started: 0,
          ended: 0,
          base,
          scope,
          body: "Done.",
          cost: { calls: 0, costUsd: 0, turns: 0, unknown: 0 },
        })
        const [title, ...rest] = written.split("\n")
        expect(rest.join("\n")).toBe("\nDone.\n")
        const tokens = lexer(title ?? "")
        expect(tokens).toHaveLength(1)
        const [heading] = tokens
        expect(heading?.type).toBe("heading")
        expect(plainInline((heading as { tokens: ReadonlyArray<Token> }).tokens)).toBe(true)
      }),
    )
  })
})
