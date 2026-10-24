// A happening's line in .tutti/tutti.log and its record in events.jsonl are written together
// (Log's writeWith, and the lines a ledger transition is given), so the two files give
// happenings in one order however many fibers write at once. Written as two calls, a line then a
// record in one fiber and a record then a line in another, they came out in two orders.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result } from "effect"
import { EventStream, eventsFile } from "../src/run/eventstream.ts"
import { Ledger, make as makeLedger } from "../src/run/ledger.ts"
import { detail, Log, line, logFile } from "../src/run/log.ts"
import { Move } from "../src/run/phase.ts"
import { Captured, layer as capturedEvents } from "../src/testing/EventStream.ts"
import { layer as capturedLog, texts } from "../src/testing/Log.ts"

const run = "2026-10-02T09:12:03.98+02:00"

/** A repository with the live log and event stream in it, for `effect`; its log's and stream's texts. */
const live = async (effect: Effect.Effect<void, never, Log | EventStream | Ledger>) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-order-")))
  mkdirSync(join(repo, ".tutti"))
  const files = Layer.merge(Log.layer({ repo }), EventStream.layer({ repo, run }))
  const ledger = Layer.effect(Ledger, makeLedger)
  await Effect.runPromise(effect.pipe(Effect.provide(ledger.pipe(Layer.provideMerge(files)))))
  const logged = readFileSync(join(repo, logFile), "utf8")
    .split("\n")
    .slice(0, -1)
    .map((each) => each.replace(/^\S+ \S+ \S+ /, ""))
  const recorded = readFileSync(join(repo, eventsFile), "utf8")
    .split("\n")
    .slice(0, -1)
    .map((each) => JSON.parse(each) as { readonly kind: string; readonly text?: string })
  return { logged, recorded }
}

const many = Array.from({ length: 60 }, (_, i) => i)

describe("a happening's line and record", () => {
  test("come out in one order from fibers writing at once", async () => {
    const { logged, recorded } = await live(
      Effect.gen(function* () {
        const logs = yield* Log
        const events = yield* EventStream
        // Lines and records alone, between the happenings, as the run writes them too.
        const alone = (i: number) =>
          i % 3 === 0
            ? logs.write(line`only a line ${i}`)
            : i % 3 === 1
              ? events.emit({ kind: "queue", queued: i })
              : Effect.void
        yield* Effect.forEach(
          many,
          (i) =>
            Effect.andThen(
              alone(i),
              logs.writeWith([detail`n${i}`], events.emit({ kind: "info", text: detail`n${i}` })),
            ),
          { concurrency: "unbounded", discard: true },
        )
      }),
    )
    const said = logged.filter((each) => each.startsWith("  n"))
    expect(said).toHaveLength(many.length)
    expect(recorded.filter((each) => each.kind === "info").map((each) => each.text)).toEqual(said)
  })

  test("a transition's lines come out in the order of its records", async () => {
    const { logged, recorded } = await live(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const logs = yield* Log
        const events = yield* EventStream
        yield* Effect.forEach(
          many,
          (i) => {
            const text = detail`n${i}`
            return i % 2 === 0
              ? Effect.asVoid(
                  ledger.transition(`t-${i}`, Move.Ready(), {
                    beside: [{ kind: "info", ticket: `t-${i}`, text }],
                    lines: [text],
                  }),
                )
              : logs.writeWith([text], events.emit({ kind: "info", text }))
          },
          { concurrency: "unbounded", discard: true },
        )
      }),
    )
    const said = logged.filter((each) => each.startsWith("  n"))
    expect(said).toHaveLength(many.length)
    expect(recorded.filter((each) => each.kind === "info").map((each) => each.text)).toEqual(said)
  })

  test("a transition the machine doesn't have logs neither its lines nor its records", async () => {
    const program = Effect.gen(function* () {
      const ledger = yield* Ledger
      yield* ledger.transition("t-1", Move.Ready())
      const again = yield* ledger.transition("t-1", Move.Ready(), {
        beside: [{ kind: "info", ticket: "t-1", text: detail`t-1 queued again` }],
        lines: [detail`t-1 queued again`],
      })
      expect(Result.isFailure(again)).toBe(true)
      expect((yield* texts).filter((each) => each.includes("queued again"))).toEqual([])
      const records = yield* (yield* Captured).records
      expect(records.filter((each) => each.kind === "info")).toEqual([])
    })
    const layers = Layer.effect(Ledger, makeLedger).pipe(
      Layer.provideMerge(Layer.merge(capturedLog(), capturedEvents())),
    )
    await Effect.runPromise(program.pipe(Effect.provide(layers)))
  })

  test("the test layer's log keeps the line before the record it was written with", async () => {
    const program = Effect.gen(function* () {
      const logs = yield* Log
      const events = yield* EventStream
      const order: Array<string> = []
      yield* logs.writeWith(
        [line`one`],
        Effect.andThen(
          events.emit({ kind: "info", text: line`one` }),
          Effect.flatMap(logs.lines, (now) =>
            Effect.sync(() => {
              order.push(...now.map((each) => each.text))
            }),
          ),
        ),
      )
      expect(order).toEqual(["one"])
      expect((yield* (yield* Captured).records).map((each) => each.kind)).toEqual(["info"])
    })
    await Effect.runPromise(
      program.pipe(Effect.provide(Layer.merge(capturedLog(), capturedEvents()))),
    )
  })
})
