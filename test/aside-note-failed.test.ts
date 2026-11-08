import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { putAside } from "../src/run/aside.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Tag, ticketLine } from "../src/run/log.ts"
import { Move } from "../src/run/phase.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Backlog, layer as beadsLayer, type Fault } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

/** Sets ticket t-1 aside, Working, with bd failing the commands given; its bd status, phase, log. */
const setAside = (faults: ReadonlyArray<readonly [string, Fault]>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const backlog = yield* Backlog
      yield* ledger.transition("t-1" as TicketId, Move.Ready(), { title: "One ticket" })
      yield* ledger.transition("t-1" as TicketId, Move.Dispatched())
      for (const [op, fault] of faults) yield* backlog.fail(op, fault)
      const deferred = yield* putAside(
        { id: "t-1" as TicketId, title: "One ticket" },
        {
          note: "tutti: set aside.",
          reason: "set aside",
          detail: "set aside",
          deferred: ticketLine("t-1")`set aside`,
          failed: "t-1 set aside",
          instead: "look at it",
        },
      )
      const issue = yield* backlog.get("t-1")
      return {
        deferred,
        status: issue?.status,
        notes: issue?.notes,
        phase: (yield* ledger.current).tickets.get("t-1" as TicketId)?.phase,
        records: (yield* (yield* Captured).records).filter(
          (record) =>
            record.kind !== "phase" && record.kind !== "ticket_end" && record.kind !== "score",
        ),
        log: yield* texts,
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ledgerLayer(), beadsLayer([{ id: "t-1", status: "in_progress" }])),
      ),
    ),
  )

const locked: Fault = { id: "t-1", stderr: "Error: database is locked\n" }

describe("setting a ticket aside when bd can't add its note", () => {
  test("bd still defers it, and the log says its note is missing", async () => {
    const left = await setAside([["update", locked]])
    expect(left.deferred).toBe(true)
    expect(left.status).toBe("deferred")
    expect(left.notes ?? "").not.toContain("tutti: set aside.")
    expect(left.phase).toMatchObject({ _tag: "Deferred", why: "set aside" })
    expect(left.records).toEqual([
      expect.objectContaining({ kind: "deferred", ticket: "t-1", detail: "set aside" }),
    ])
    const at = left.log.indexOf(ticketLine("t-1")`set aside`)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(left.log[at + 1]).toMatch(/^ {2}bd could not add t-1's note: .*database is locked/)
  })

  test("neither note nor deferral: DEFER_FAILED, with the note's failure under it", async () => {
    const left = await setAside([
      ["update", locked],
      ["defer", locked],
    ])
    expect(left.deferred).toBe(false)
    expect(left.status).toBe("in_progress")
    expect(left.phase).toMatchObject({ _tag: "Deferred", why: "set aside" })
    const at = left.log.findIndex((line) => line.startsWith(`  ${Tag.deferFailed}: `))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(left.log[at + 1]).toMatch(/^ {2}bd could not add t-1's note: /)
  })
})
