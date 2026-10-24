import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Console, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { OrganHold, Organs } from "../src/organs/Organs.ts"
import { eraseLine, makePrinter, type Out } from "../src/print/organLine.ts"
import { Ending } from "../src/print/summary.ts"
import { Ledger } from "../src/run/ledger.ts"
import { type ReportRun, runReport } from "../src/run/report.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { type Answers, layer as cannedLayer } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const body = "The run ended with nothing left to do.\n"

interface Setup {
  readonly answers?: Answers
  /** The usage limit's hold: from the start, or from the reviewer's call on. */
  readonly held?: "start" | "reviewer"
  /** `.tutti` is a file, so the report can't be saved below it. */
  readonly unsaved?: boolean
}

/**
 * A plain run's end: the report on a printer, the log printing to the same stdout (sink "stdout"),
 * as in plain mode. Gives what stdout got, without the log lines' time.
 */
const plainEnd = async (setup: Setup = {}): Promise<string> => {
  const repo = mkdtempSync(join(tmpdir(), "tutti-report-plain-"))
  if (setup.unsaved) writeFileSync(join(repo, ".tutti"), "")
  const stdout: Array<string> = []
  const out: Out = { write: (text) => stdout.push(text), columns: () => 100, tty: false }
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...args: ReadonlyArray<unknown>) => stdout.push(`${args.join(" ")}\n`),
  })
  const asked = await Effect.runPromise(Ref.make(0))
  const held = Effect.map(
    Ref.getAndUpdate(asked, (n) => n + 1),
    (n) => (setup.held === "start" ? true : setup.held === "reviewer" ? n > 0 : false),
  )
  const deps = Layer.mergeAll(
    cannedLayer(setup.answers ?? { reviewer: { report: body } }),
    configLayer(appConfig({}, repo)),
    beadsLayer([]),
    gitLayer({ dir: repo }),
    BunFileSystem.layer,
    Layer.succeed(OrganHold, { held }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(logLayer({ sink: "stdout" }), eventsLayer())))
  const services = Layer.mergeAll(
    Organs.layer,
    OrganCost.layer,
    Ledger.layer,
    attentionLayer(() => ({ _tag: "Allow" })),
  ).pipe(Layer.provideMerge(deps))
  await Effect.runPromise(
    Effect.gen(function* () {
      const startHead = yield* (yield* Repository).head("main")
      const run: ReportRun = {
        started: 0,
        base: "main",
        startHead,
        ending: Ending.Done({
          text: "READY_EMPTY: nothing left",
          tickets: 0,
          limit: null,
          took: 0,
        }),
        exitCode: 0,
        quit: false,
      }
      yield* runReport(
        run,
        Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100, logged: true }),
      )
    }).pipe(
      Effect.provide(services),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Console.Console, console),
    ),
  )
  return Bun.stripANSI(stdout.join("")).replace(
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d /gm,
    "",
  )
}

/** How many of stdout's lines hold `text`. */
const times = (printed: string, text: string | RegExp): number =>
  printed.split("\n").filter((l) => (typeof text === "string" ? l.includes(text) : text.test(l)))
    .length

describe("a plain run's report says each outcome once, in the log's line", () => {
  test("REPORT: the report is written, and its path said once", async () => {
    const printed = await plainEnd()
    expect(times(printed, /^REPORT: written to \.tutti\/reports\/.*\.md$/)).toBe(1)
    expect(times(printed, /report/i)).toBe(2)
    expect(printed).toContain("◆ Run report written")
    expect(printed).not.toContain("Report saved")
  })

  test("REVIEW_FAILED is said once", async () => {
    const printed = await plainEnd({ answers: { reviewer: { report: "  \n" } } })
    expect(times(printed, "REVIEW_FAILED")).toBe(1)
    // The reviewer's call's cost line comes first, as the run's log has it.
    expect(printed).toStartWith(
      "ORGAN reviewer: $0.0000 in 1 turn, 0.0s\nREVIEW_FAILED: the reviewer wrote an empty report",
    )
    expect(printed).not.toContain("◆")
  })

  test("'report not saved' is said once", async () => {
    const printed = await plainEnd({ unsaved: true })
    expect(times(printed, /^report not saved: /)).toBe(1)
    expect(printed).not.toMatch(/Report not saved/)
  })

  test("the reviewer's skipped line is said once, when the run was held to its end", async () => {
    const printed = await plainEnd({ held: "start" })
    expect(printed).toBe("ORGAN reviewer: skipped, the usage limit holds the run\n")
  })

  test("the reviewer's skipped line is said once, when the hold began as it was asked", async () => {
    const printed = await plainEnd({ held: "reviewer" })
    expect(printed).toBe("ORGAN reviewer: skipped, the usage limit holds the run\n")
  })
})

describe("an organ line dropped", () => {
  test("erases its spinner and prints no final line", async () => {
    const written: Array<string> = []
    const out: Out = { write: (text) => written.push(text), columns: () => 100, tty: true }
    await Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* makePrinter(out, theme).organ("Writing the run report with Claude…")
        const waiting = yield* Effect.forkChild(Effect.sleep("300 millis"))
        yield* TestClock.adjust("300 millis")
        yield* Fiber.join(waiting)
        yield* step.drop
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(written.some((w) => w.includes("Writing the run report"))).toBe(true)
    expect(written.at(-1)).toBe(eraseLine)
    expect(written.join("")).not.toContain("◆")
  })
})
