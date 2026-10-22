import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { Section } from "../src/organs/evidence.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { Ending } from "../src/print/summary.ts"
import { Ledger } from "../src/run/ledger.ts"
import { stamp } from "../src/run/localTime.ts"
import { detail, Log, line, start, undated } from "../src/run/log.ts"
import { cappedLog, gather, logCap } from "../src/run/report.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"

const at = new Date(2026, 9, 17, 9, 5, 3).getTime()
const dated = (text: string) => `${stamp(at)} ${text}`

const startBlock = [
  dated("START tutti 0.1.0 in /repo on main (limit: none, concurrent: 4)"),
  dated("  billing: subscription"),
  dated("  permission mode: auto"),
]

const ticketLines = (n: number) =>
  Array.from({ length: n }, (_, i) => dated(`  CHECKS_PASSED: t-${i + 1}`))

describe("the reviewer's log section", () => {
  test("a log that fits is given whole", () => {
    const lines = [...startBlock, ...ticketLines(10)]
    expect(cappedLog(lines, 3)).toBe(lines.join("\n"))
  })

  test("a long log keeps the START block and its last lines, saying how many were cut", () => {
    const lines = [...startBlock, ...ticketLines(5000)]
    const capped = cappedLog(lines, 3).split("\n")
    expect(capped.slice(0, 3)).toEqual(startBlock)
    expect(capped[3]).toBe(
      `[${5000 - logCap.lines} lines of the log cut here, after the START block; the last ${logCap.lines} follow]`,
    )
    expect(capped.slice(4)).toEqual(lines.slice(-logCap.lines))
  })

  test("the last lines stop at the character cap", () => {
    const lines = [...startBlock, ...ticketLines(100)]
    const width = (lines.at(-1)?.length ?? 0) + 1
    const capped = cappedLog(lines, 3, { lines: 1000, characters: width * 10 }).split("\n")
    expect(capped[3]).toBe(
      "[90 lines of the log cut here, after the START block; the last 10 follow]",
    )
    expect(capped.slice(4)).toEqual(lines.slice(-10))
  })

  test("without a START block, the cut is at the start", () => {
    const lines = ticketLines(5)
    expect(cappedLog(lines, 0, { lines: 1, characters: 1000 })).toBe(
      [`[4 lines of the log cut here; the last line follows]`, lines[4]].join("\n"),
    )
  })

  test("a last line too long to give is said so", () => {
    const lines = [...startBlock, dated(`  REVIEW: ${"x".repeat(200)}`)]
    expect(cappedLog(lines, 3, { lines: 10, characters: 100 }).split("\n").at(-1)).toBe(
      "[1 line of the log cut here, after the START block; its last line is too long to give]",
    )
  })

  test("every line is either given or counted as cut, whatever the lines say", () => {
    // Lines as the log has them, one line each.
    const text = fc.string({ maxLength: 40 }).map((each) => each.replaceAll("\n", " "))
    fc.assert(
      fc.property(
        fc.array(text, { maxLength: 60 }),
        fc.integer({ min: 0, max: 70 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 600 }),
        (texts, kept, lines, characters) => {
          const all = texts.map(dated)
          const given = cappedLog(all, kept, { lines, characters }).split("\n")
          const said = given.findIndex((each) => /^\[\d+ lines? of the log cut here/.test(each))
          if (said < 0) return expect(given.join("\n")).toBe(all.join("\n"))
          const cut = Number(given[said]?.slice(1).split(" ")[0])
          const tail = given.slice(said + 1)
          expect(tail.length).toBeLessThanOrEqual(lines)
          expect(tail.reduce((sum, each) => sum + each.length + 1, 0)).toBeLessThanOrEqual(
            characters,
          )
          expect(said).toBe(Math.min(kept, all.length))
          expect(said + cut + tail.length).toBe(all.length)
          expect(given.slice(0, said)).toEqual(all.slice(0, said))
          expect(tail).toEqual(all.slice(all.length - tail.length))
        },
      ),
    )
  })

  test("the reviewer's input has the capped log", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tutti-report-log-cap-"))
    const deps = Layer.mergeAll(
      configLayer(appConfig({}, repo)),
      beadsLayer([]),
      gitLayer({ dir: repo }),
      logLayer(),
      eventsLayer(),
    )
    const services = Layer.mergeAll(OrganCost.layer, Ledger.layer, attentionLayer()).pipe(
      Layer.provideMerge(deps),
    )
    const parts = await Effect.runPromise(
      Effect.gen(function* () {
        const logs = yield* Log
        yield* logs.write(line`PROBE: the account`)
        yield* logs.write(
          ...start({ version: "0.1.0", repo, base: "main", settings: [], notes: ["a note"] }),
        )
        for (let i = 0; i < logCap.lines + 20; i++) yield* logs.write(detail`CHECKS_PASSED: t-${i}`)
        yield* logs.write(line`DONE`)
        return yield* gather({
          started: 0,
          base: "main",
          startHead: yield* (yield* Repository).head("main"),
          ending: Ending.Done({ text: "DONE", tickets: 0, limit: null, took: 0 }),
          exitCode: 0,
          quit: false,
        })
      }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
    )
    const logSection = parts.find(
      (part): part is Section =>
        typeof part !== "string" && part.title === "tutti's log for this run",
    )
    const given = (logSection?.body ?? "").split("\n").map(undated)
    expect(given.slice(0, 4)).toEqual([
      "PROBE: the account",
      `START tutti 0.1.0 in ${repo} on main ()`,
      "  a note",
      "[21 lines of the log cut here, after the START block; the last 1500 follow]",
    ])
    expect(given.at(-1)).toBe("DONE")
    expect(given).toHaveLength(4 + logCap.lines)
  })
})

describe("the run's log as kept for the reviewer", () => {
  test("keeps every line in order, and a read isn't changed by later writes", async () => {
    const [before, after] = await Effect.runPromise(
      Effect.gen(function* () {
        const logs = yield* Log
        yield* logs.write(line`one`)
        const before = yield* logs.lines
        for (let i = 0; i < 20_000; i++) yield* logs.write(detail`line ${i}`)
        return [before, yield* logs.lines] as const
      }).pipe(Effect.provide(logLayer()), Effect.provide(TestClock.layer())),
    )
    expect(before.map(undated)).toEqual(["one"])
    expect(after).toHaveLength(20_001)
    expect(undated(after[20_000] ?? "")).toBe("  line 19999")
  })

  const startEnds = Effect.gen(function* () {
    const logs = yield* Log
    const block = start({
      version: "0.1.0",
      repo: "/repo",
      base: "main",
      settings: [],
      notes: ["a"],
    })
    yield* logs.write(line`PROBE: the account`)
    const before = yield* logs.startBlockEnd
    yield* logs.write(...block)
    yield* logs.write(detail`t-1: CHECKS_PASSED`)
    yield* logs.write(...block)
    return [before, yield* logs.startBlockEnd] as const
  })

  test("knows where its START block ends, in the test layer", async () => {
    const ends = await Effect.runPromise(
      startEnds.pipe(Effect.provide(logLayer()), Effect.provide(TestClock.layer())),
    )
    expect(ends).toEqual([0, 3])
  })

  test("knows where its START block ends, in the live layer", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tutti-log-cap-")), "tutti.log")
    const ends = await Effect.runPromise(
      startEnds.pipe(
        Effect.provide(Log.layer({ file }).pipe(Layer.provide(BunServices.layer))),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(ends).toEqual([0, 3])
  })
})
