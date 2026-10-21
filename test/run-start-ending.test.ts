// How a run ends at its start question (§ 5 item 3, § 7.1, § 7.11 "Nothing to run"), as main's
// runFrom does it: a cancelled question exits 130 with its message and begins nothing, so no start
// record is written; the current tickets chosen with nothing to run print the box, then end.
import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Console, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { askLines, askThenBegin, cancelled, cancelledMessage } from "../src/run/choose.ts"
import { EventStream } from "../src/run/eventstream.ts"
import { exitCodes } from "../src/run/holds.ts"
import { check, endWith, noHolds, noStyles, type Options } from "../src/run/nothing.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { FormCancelled, TicketCount, type Work } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const repo = "/repo"

const options: Options = {
  scope: null,
  filter: { excludeTypes: [] },
  repo,
  base: "main",
  carried: new Set(),
  unmerged: new Set(),
  held: noHolds,
}

/** The run's start record on `work`, as main's begin writes it. */
const begin = (work: Work) =>
  Effect.flatMap(EventStream, (events) =>
    events.emit({
      kind: "start",
      version: "0.1.0",
      repo,
      branch: "main",
      ...(work._tag === "Feature" ? { feature: work.description } : {}),
      concurrency: 2,
      billing: "subscription",
      permission_mode: "default",
    }),
  )

/**
 * The start of a run in the renderer, from runFrom: the question `ask` asked and the run begun on
 * its answer; cancelled, it exits 130; the current tickets with nothing to run end with the box.
 * Its exit code (null when the run would go on), what it printed and logged, and its records.
 */
const start = (seeds: ReadonlyArray<Seed>, ask: Effect.Effect<Work, FormCancelled>) => {
  const out: Array<string> = []
  const err: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...said: ReadonlyArray<unknown>) => out.push(said.join(" ")),
    error: (...said: ReadonlyArray<unknown>) => err.push(said.join(" ")),
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const code = yield* Effect.gen(function* () {
        const work = yield* askThenBegin(ask, begin)
        if (work === null) return yield* cancelled
        const nothing = yield* Effect.orElseSucceed(check(options), () => null)
        if (nothing === null) return null
        return yield* endWith(nothing, { _tag: "Box", width: 80, styles: noStyles })
      })
      const records = yield* (yield* Captured).records
      return { code, out, err, log: yield* texts, kinds: records.map((record) => record.kind) }
    }).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), gitLayer({ dir: repo }), logLayer(), eventsLayer()).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )
}

/** The start question as lines, over stdin that has had `typed` and ended. */
const askedAsLines = (typed: string) => {
  const stdin = new PassThrough()
  stdin.end(typed)
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
  return askLines(stdin, () => {}, theme, TicketCount.AllDone())
}

describe("a cancelled start question", () => {
  test("exits 130 with its message, and writes no start record", async () => {
    const ended = await start([{ id: "k-1" }], Effect.fail(new FormCancelled()))
    expect(ended.code).toBe(exitCodes.interrupted)
    expect(ended.code).toBe(130)
    expect(ended.err).toEqual([cancelledMessage])
    expect(ended.out).toEqual([])
    expect(ended.kinds).toEqual([])
    expect(ended.log).toEqual([])
  })

  test("as lines, by the end of input: the same", async () => {
    const ended = await start([{ id: "k-1" }], askedAsLines(""))
    expect(ended.code).toBe(130)
    expect(ended.err).toEqual([cancelledMessage])
    expect(ended.kinds).toEqual([])
  })
})

describe("the current tickets chosen", () => {
  test("with nothing to run: the box printed after the start record, then the end", async () => {
    const ended = await start([{ id: "k-1", status: "closed" }], askedAsLines("1\n"))
    expect(ended.code).toBe(exitCodes.ok)
    expect(ended.out).toEqual(["╭────────────╮\n│ ✓ All done │\n╰────────────╯"])
    expect(ended.err).toEqual([])
    expect(ended.log).toEqual(["READY_EMPTY after 0 tickets: everything is done"])
    expect(ended.kinds).toEqual(["start", "done", "end"])
  })

  test("with something to run: begun, nothing printed, and the run goes on", async () => {
    const ended = await start([{ id: "k-1" }], askedAsLines("1\n"))
    expect(ended.code).toBeNull()
    expect(ended.out).toEqual([])
    expect(ended.kinds).toEqual(["start"])
  })
})
