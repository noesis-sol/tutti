// Filing a finished worker's message as a ticket, the run's side (§ 7.5, tutti-g0wd): FileTicket is
// resolved whatever the ledger holds, and fileTicket files the text with bd create, discovered from
// the finished ticket, and puts how it went in the screen's filings under the view's uuid.

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, SubscriptionRef } from "effect"
import fc from "fast-check"
import { resolve, UiCommand } from "../src/run/commands.ts"
import {
  descriptionOf,
  FileOutcome,
  fileTicket,
  filingsKept,
  type TicketFiling,
  titleLimit,
  titleOf,
} from "../src/run/fileTicket.ts"
import { line } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Backlog, layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"

const filingsRef = (start: ReadonlyArray<TicketFiling> = []) =>
  SubscriptionRef.make<ReadonlyArray<TicketFiling>>(start)

const world = () =>
  Layer.mergeAll(beadsLayer([{ id: "t-1", title: "Title of t-1", status: "closed" }]), logLayer())

describe("titleOf", () => {
  test("the first line that isn't blank, its spaces folded", () => {
    expect(titleOf("\n  \nAlso cover   the empty case\nand the long one")).toBe(
      "Also cover the empty case",
    )
  })

  test("cut to the limit with …", () => {
    const long = "word ".repeat(30)
    const title = titleOf(long)
    expect([...title].length).toBeLessThanOrEqual(titleLimit)
    expect(title.endsWith("…")).toBe(true)
  })

  test("any text: one line, at most the limit, not blank when the text isn't", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const title = titleOf(text)
        expect([...title].length).toBeLessThanOrEqual(titleLimit)
        expect(title).not.toMatch(/[\n\r]/)
        if (/[a-zA-Z0-9]/.test(text)) expect(title.trim()).not.toBe("")
      }),
    )
  })
})

describe("fileTicket", () => {
  test("files the text, discovered from the finished ticket: Filed, and the FILED line", async () => {
    const text = "Also cover the empty case\n\nIt fails on an empty list."
    const { filings, issues, logged } = await Effect.runPromise(
      Effect.gen(function* () {
        const filings = yield* filingsRef()
        yield* fileTicket({ from: "t-1" as TicketId, text, uuid: "u-1" }, filings)
        return {
          filings: yield* SubscriptionRef.get(filings),
          issues: yield* (yield* Backlog).issues,
          logged: yield* texts,
        }
      }).pipe(Effect.provide(world())),
    )
    const made = issues.find((issue) => issue.id !== "t-1")
    expect(made?.title).toBe("Also cover the empty case")
    expect(made?.description).toBe(descriptionOf(text, "t-1"))
    expect(made?.description.startsWith(text)).toBe(true)
    expect(made?.dependencies.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "t-1" as TicketId, type: "discovered-from" },
    ])
    expect(filings).toEqual([
      {
        uuid: "u-1",
        from: "t-1" as TicketId,
        outcome: FileOutcome.Filed({
          id: made?.id ?? ("" as TicketId),
          title: "Also cover the empty case",
        }),
      },
    ])
    // The line names the new ticket, never the text.
    expect(logged).toEqual([
      line`  FILED: ${made?.id ?? ""}, written for t-1's worker after it had finished`,
    ])
  })

  test("bd refuses it: NotFiled with bd's why, and nothing logged", async () => {
    const { filings, logged } = await Effect.runPromise(
      Effect.gen(function* () {
        const filings = yield* filingsRef()
        yield* fileTicket({ from: "gone-1" as TicketId, text: "a follow-up", uuid: "u-2" }, filings)
        return { filings: yield* SubscriptionRef.get(filings), logged: yield* texts }
      }).pipe(Effect.provide(world())),
    )
    expect(filings.map((filing) => [filing.uuid, filing.outcome._tag])).toEqual([
      ["u-2", "NotFiled"],
    ])
    const outcome = filings[0]?.outcome
    expect(outcome?._tag === "NotFiled" ? outcome.why : "").toContain("gone-1")
    expect(logged).toEqual([])
  })

  test("keeps the latest filings only", async () => {
    const old: ReadonlyArray<TicketFiling> = Array.from({ length: filingsKept }, (_, i) => ({
      uuid: `old-${i}`,
      from: "t-1" as TicketId,
      outcome: FileOutcome.NotFiled({ why: "bd is gone" }),
    }))
    const filings = await Effect.runPromise(
      Effect.gen(function* () {
        const filings = yield* filingsRef(old)
        yield* fileTicket({ from: "t-1" as TicketId, text: "one more", uuid: "new" }, filings)
        return yield* SubscriptionRef.get(filings)
      }).pipe(Effect.provide(world())),
    )
    expect(filings.length).toBe(filingsKept)
    expect(filings[0]?.uuid).toBe("old-1")
    expect(filings.at(-1)?.uuid).toBe("new")
  })
})

describe("FileTicket", () => {
  test("is resolved though its ticket has no worker", () => {
    const command = UiCommand.FileTicket({
      from: "t-1" as TicketId,
      text: "a follow-up",
      uuid: "u-1",
    })
    const resolved = resolve(command, {
      ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
      requests: [],
    })
    expect(Result.isSuccess(resolved)).toBe(true)
  })
})
