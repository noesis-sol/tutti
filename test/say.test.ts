// say (say.ts): a happening's log line and its event record, written in one call from the one
// record, so the line is the record's text; and the ledger's `said`, each record a transition is
// given with its text logged beside it.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { EventStream } from "../src/run/eventstream.ts"
import { Ledger } from "../src/run/ledger.ts"
import { detail, type Log, line } from "../src/run/log.ts"
import { Move } from "../src/run/phase.ts"
import { info, say, sayer, warn } from "../src/run/say.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

const run = (effect: Effect.Effect<void, never, Ledger | Log | EventStream | Captured>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ledgerLayer())))

/** The captured records without their head, as the run gave them. */
const given = Effect.gen(function* () {
  const records = yield* (yield* Captured).records
  return records.map(({ v: _v, time: _time, run: _run, ...rest }) => rest)
})

describe("say", () => {
  test("logs the record's text and writes the record", async () => {
    await run(
      Effect.gen(function* () {
        const text = detail`t-1 resumed its session`
        yield* say({ kind: "drain", text })
        expect(yield* texts).toEqual([text])
        expect(yield* given).toEqual([{ kind: "drain", text }])
      }),
    )
  })

  test("warn and info write their kind, with the ticket where it is given", async () => {
    await run(
      Effect.gen(function* () {
        yield* warn(line`no ticket`)
        yield* warn(line`about t-1`, "t-1" as TicketId)
        yield* info(line`noted`)
        yield* info(line`about t-2`, "t-2" as TicketId)
        expect(yield* texts).toEqual(["no ticket", "about t-1", "noted", "about t-2"])
        expect(yield* given).toEqual([
          { kind: "warn", text: "no ticket" },
          { kind: "warn", ticket: "t-1", text: "about t-1" },
          { kind: "info", text: "noted" },
          { kind: "info", ticket: "t-2", text: "about t-2" },
        ])
      }),
    )
  })

  test("a sayer says the same over the Log and EventStream it holds", async () => {
    await run(
      Effect.gen(function* () {
        const said = yield* sayer
        yield* said.say({ kind: "hold", text: line`HOLD: one` })
        yield* said.warn(line`careful`, "t-3" as TicketId)
        yield* said.info(line`fine`)
        expect(yield* texts).toEqual(["HOLD: one", "careful", "fine"])
        expect((yield* given).map((each) => each.kind)).toEqual(["hold", "warn", "info"])
      }),
    )
  })
})

describe("a transition's said records", () => {
  test("are written after its phase record, each text logged, then its lines", async () => {
    await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const first = detail`t-1 queued`
        const second = detail`t-1 noted`
        yield* ledger.transition("t-1" as TicketId, Move.Ready(), {
          said: [
            { kind: "info", ticket: "t-1", text: first },
            { kind: "warn", ticket: "t-1", text: second },
          ],
          beside: [{ kind: "queue", queued: 1 }],
          lines: [line`a line without a record`],
        })
        expect(yield* texts).toEqual([first, second, "a line without a record"])
        expect((yield* given).map((each) => each.kind)).toEqual(["phase", "info", "warn", "queue"])
      }),
    )
  })

  test("one that ends the ticket's part in the run gets what it spent", async () => {
    await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition("t-1" as TicketId, Move.Ready(), { title: "One" })
        yield* ledger.transition("t-1" as TicketId, Move.Dispatched())
        const text = detail`t-1 closed with no change`
        yield* ledger.transition("t-1" as TicketId, Move.NoChange(), {
          said: [{ kind: "closed", ticket: "t-1", title: "One", detail: "no change", text }],
        })
        expect((yield* texts).at(-1)).toBe(text)
        const records = yield* given
        const closed = records.find((each) => each.kind === "closed")
        expect(closed).toMatchObject({ ticket: "t-1", text, hand_backs: { resolve: 0, fix: 0 } })
        expect(records.at(-1)?.kind).toBe("ticket_end")
      }),
    )
  })
})
