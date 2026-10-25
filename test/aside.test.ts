import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { leaveForReview, putAside } from "../src/run/aside.ts"
import { Ledger } from "../src/run/ledger.ts"
import { type Log, Tag, ticketLine } from "../src/run/log.ts"
import { Move } from "../src/run/phase.ts"
import type { Beads, TicketId } from "../src/services/Beads.ts"
import { Store } from "../src/services/Store.ts"
import { Backlog, layer as beadsLayer } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as storeLayer } from "../src/testing/Store.ts"

/** Runs `body` on ticket t-1, Working, and gives back its notes, records, log and phase. */
const aside = (body: Effect.Effect<unknown, never, Ledger | Beads | Log | Store>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger
      yield* ledger.transition("t-1" as TicketId, Move.Ready(), { title: "One ticket" })
      yield* ledger.transition("t-1" as TicketId, Move.Dispatched())
      yield* body
      const issues = yield* (yield* Backlog).issues
      return {
        notes: issues.find((issue) => issue.id === "t-1")?.notes,
        status: issues.find((issue) => issue.id === "t-1")?.status,
        records: (yield* (yield* Captured).records).filter(
          (record) => record.kind !== "phase" && record.kind !== "ticket_end",
        ),
        log: yield* texts,
        phase: (yield* ledger.current).tickets.get("t-1" as TicketId)?.phase,
        saved: yield* (yield* Store).ticket("t-1" as TicketId),
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ledgerLayer(),
          beadsLayer([{ id: "t-1" }]),
          storeLayer({
            version: 1,
            tickets: { "t-1": { session: "session-t-1", resumes: 0, metadata: {} } },
          }),
        ),
      ),
    ),
  )

describe("setting a ticket aside", () => {
  test("for review: its note, Review{why}, and its warn record with aside", async () => {
    const text = ticketLine(Tag.closedWithoutCommit)`no commit on tutti/t-1 names t-1`
    const left = await aside(
      leaveForReview("t-1" as TicketId, {
        why: Tag.closedWithoutCommit,
        detail: "closed without a commit",
        text,
      }),
    )
    expect(left.notes).toBe("tutti: CLOSED_WITHOUT_COMMIT: no commit on tutti/t-1 names t-1")
    expect(left.phase).toMatchObject({ _tag: "Review", why: "CLOSED_WITHOUT_COMMIT" })
    expect(left.records).toEqual([
      expect.objectContaining({
        kind: "warn",
        ticket: "t-1",
        aside: true,
        detail: "closed without a commit",
        text,
      }),
    ])
    expect(left.log).toContain(text)
    // Saved at once, so a crash after it doesn't have the next run take it up (carry.ts).
    expect(left.saved).toEqual(expect.objectContaining({ session: "session-t-1", phase: "Review" }))
  })

  test("deferred: its note, bd's deferral, Deferred and its deferred record", async () => {
    const deferred = ticketLine("t-1")`set aside`
    const left = await aside(
      putAside(
        { id: "t-1" as TicketId, title: "One ticket" },
        {
          note: "tutti: set aside.",
          reason: "set aside",
          detail: "set aside",
          deferred,
          failed: "t-1 set aside",
          instead: "look at it",
        },
      ),
    )
    expect(left.notes).toMatch(/^tutti: set aside\.$/m)
    expect(left.status).toBe("deferred")
    expect(left.phase).toMatchObject({ _tag: "Deferred", why: "set aside" })
    expect(left.records).toEqual([
      expect.objectContaining({ kind: "deferred", ticket: "t-1", detail: "set aside" }),
    ])
  })
})
