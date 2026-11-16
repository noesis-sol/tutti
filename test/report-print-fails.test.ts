import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { OrganHold, Organs } from "../src/organs/Organs.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { Ledger } from "../src/run/ledger.ts"
import { type ReportRun, reportsDir, runReport } from "../src/run/report.ts"
import { Ending } from "../src/run/summary.ts"
import { OrganCost } from "../src/services/OrganCost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"
import { makeTheme } from "../src/ui/theme.ts"

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: true })

describe("a report whose printing fails", () => {
  test("is still saved under .tutti/reports, and the log says so", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tutti-report-print-fails-"))
    // A printer that fails on the report itself, after the organ line is drawn.
    const out: Out = {
      write: (text) => {
        if (text.includes("the reviewer's words")) throw new Error("the terminal broke")
      },
      columns: () => 100,
      tty: false,
    }
    const deps = Layer.mergeAll(
      cannedLayer({ reviewer: { report: "# Report\n\nthe reviewer's words" } }),
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
    const { exit, log } = await Effect.runPromise(
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
        const exit = yield* Effect.exit(
          runReport(run, Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 })),
        )
        return { exit, log: yield* texts }
      }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const dir = join(repo, reportsDir)
    const files = existsSync(dir) ? readdirSync(dir) : []
    expect(files).toHaveLength(1)
    expect(readFileSync(join(dir, files[0] ?? ""), "utf8")).toContain("the reviewer's words")
    expect(log.some((line) => line.startsWith("REPORT: written to"))).toBe(true)
  })
})
