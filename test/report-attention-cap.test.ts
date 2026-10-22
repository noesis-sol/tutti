import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { Section } from "../src/organs/evidence.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { Ending } from "../src/print/summary.ts"
import { Ledger } from "../src/run/ledger.ts"
import { stamp } from "../src/run/localTime.ts"
import { denied, detail, Log, line, start, undated } from "../src/run/log.ts"
import { attentionCap, cappedAttention, gather } from "../src/run/report.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"

const at = new Date(2026, 9, 17, 9, 5, 3).getTime()
const dated = (text: string) => `${stamp(at)} ${text}`

const denials = (n: number) =>
  Array.from({ length: n }, (_, i) => dated(`  DENIED: t-${i + 1} Bash rm -rf build`))

const attentionTitle =
  "The attention requests, answers and denials of this run, as the log has them"

describe("the reviewer's attention section", () => {
  test("attention lines that fit are given whole", () => {
    const lines = denials(10)
    expect(cappedAttention(lines)).toBe(lines.join("\n"))
  })

  test("many attention lines keep the last, saying how many earlier ones were cut", () => {
    const lines = denials(2000)
    const capped = cappedAttention(lines).split("\n")
    expect(capped[0]).toBe(
      `[${2000 - attentionCap.lines} earlier attention lines cut here, still counted in each ` +
        `ticket's tallies; the last ${attentionCap.lines} follow]`,
    )
    expect(capped.slice(1)).toEqual(lines.slice(-attentionCap.lines))
  })

  test("the last lines stop at the character cap", () => {
    const lines = denials(100)
    const width = (lines.at(-1)?.length ?? 0) + 1
    const capped = cappedAttention(lines, { lines: 1000, characters: width * 10 }).split("\n")
    expect(capped[0]).toBe(
      "[90 earlier attention lines cut here, still counted in each ticket's tallies; the last 10 follow]",
    )
    expect(capped.slice(1)).toEqual(lines.slice(-10))
  })

  test("every attention line is either given or counted as cut, whatever the lines say", () => {
    const text = fc.string({ maxLength: 40 }).map((each) => each.replaceAll("\n", " "))
    fc.assert(
      fc.property(
        fc.array(text, { maxLength: 60 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 600 }),
        (texts, lines, characters) => {
          const all = texts.map((each) => dated(`  PERMISSION: ${each}`))
          const given = cappedAttention(all, { lines, characters }).split("\n")
          const cut = /^\[(\d+) earlier attention lines? cut here/.exec(given[0] ?? "")
          if (cut === null) return expect(given.join("\n")).toBe(all.join("\n"))
          const tail = given.slice(1)
          expect(tail.length).toBeLessThanOrEqual(lines)
          expect(tail.reduce((sum, each) => sum + each.length + 1, 0)).toBeLessThanOrEqual(
            characters,
          )
          expect(Number(cut[1]) + tail.length).toBe(all.length)
          expect(tail).toEqual(all.slice(all.length - tail.length))
        },
      ),
    )
  })

  test("the reviewer's input has the capped attention lines", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tutti-report-attention-cap-"))
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
    const total = attentionCap.lines + 30
    const parts = await Effect.runPromise(
      Effect.gen(function* () {
        const logs = yield* Log
        yield* logs.write(...start({ version: "0.1.0", repo, base: "main", settings: [] }))
        for (let i = 0; i < total; i++) {
          yield* logs.write(
            denied({ id: `t-${i}`, what: "Bash(rm -rf build)", by: "rule", reason: "no" }),
          )
          yield* logs.write(detail`CHECKS_PASSED: t-${i}`)
        }
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
    const section = parts.find(
      (part): part is Section => typeof part !== "string" && part.title === attentionTitle,
    )
    const given = (section?.body ?? "").split("\n")
    expect(given[0]).toBe(
      `[30 earlier attention lines cut here, still counted in each ticket's tallies; the last ` +
        `${attentionCap.lines} follow]`,
    )
    expect(given).toHaveLength(1 + attentionCap.lines)
    expect(undated(given.at(-1) ?? "")).toBe(
      `  DENIED: t-${total - 1}'s worker: Bash(rm -rf build), by a rule: no`,
    )
  })
})
