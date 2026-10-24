import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Cause, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { PathRefused } from "../src/native/libc.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { OrganHold, Organs } from "../src/organs/Organs.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { Ending } from "../src/print/summary.ts"
import { Ledger } from "../src/run/ledger.ts"
import { notSavedWhy, type ReportRun, reportsDir, runReport } from "../src/run/report.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { type Answers, layer as cannedLayer } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

/**
 * Runs the report at the end of an empty run with the reviewer's `answers`: gives its log, what was
 * printed and the reports saved.
 */
const report = async (answers: Answers) => {
  const repo = mkdtempSync(join(tmpdir(), "tutti-report-defect-"))
  const printed: Array<string> = []
  const out: Out = { write: (text) => printed.push(text), columns: () => 100, tty: false }
  const deps = Layer.mergeAll(
    cannedLayer(answers),
    configLayer(appConfig({}, repo)),
    beadsLayer([]),
    gitLayer({ dir: repo }),
    BunFileSystem.layer,
    Layer.succeed(OrganHold, { held: Effect.succeed(false) }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())))
  const services = Layer.mergeAll(
    Organs.layer,
    OrganCost.layer,
    Ledger.layer,
    attentionLayer(() => ({ _tag: "Allow" })),
  ).pipe(Layer.provideMerge(deps))
  const lines = await Effect.runPromise(
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
      yield* runReport(run, Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }))
      return yield* texts
    }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
  )
  const dir = join(repo, reportsDir)
  return { log: lines, printed: printed.join(""), files: existsSync(dir) ? readdirSync(dir) : [] }
}

describe("a defect while the report is written", () => {
  test("is REVIEW_FAILED with the defect's message, not skipped like a Ctrl+C", async () => {
    const { log, printed, files } = await report({
      reviewer: Effect.die(new Error("the reviewer broke\nat its second line")),
    })
    expect(files).toHaveLength(0)
    expect(log).toContain("REVIEW_FAILED: the reviewer broke")
    expect(printed).toContain("REVIEW_FAILED: the reviewer broke")
    expect(printed).not.toContain("Run report skipped")
    expect(printed).not.toContain("at its second line")
  })
})

describe("why the report wasn't saved", () => {
  test("is the refusal's first line", () => {
    const refused = new PathRefused({ directory: "/repo", path: ".tutti/reports/x.md" })
    expect(notSavedWhy(Cause.fail(refused))).toBe(refused.message.split("\n")[0] ?? "")
  })

  test("is a defect's message, not 'interrupted'", () => {
    expect(notSavedWhy(Cause.die(new Error("no space left on device")))).toBe(
      "no space left on device",
    )
  })

  test("is 'interrupted' for a Ctrl+C alone", () => {
    expect(notSavedWhy(Cause.interrupt())).toBe("interrupted")
  })
})
