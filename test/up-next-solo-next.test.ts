// The solo ticket next, in Up next (§ 7.2, tutti-7f8z): held back with the tickets behind it, it
// waits for no solo ticket but the running ones, those past their work too, and says so,
// `next, alone: after a, b finish`, while the tickets behind it wait `after <solo> (solo)`. In a
// run that won't start it, winding down, stopping, past its last look or at --limit, it says
// `alone, in the next run`.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { Log } from "../src/core/log.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { afterParts, soloNextAfter, soloNextRun } from "../src/run/after.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { emptyTallies, type Ledger, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type Solo, type Status } from "../src/run/runView.ts"
import { make, type QueueShown } from "../src/run/schedule.ts"
import type { Beads, Issue, TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { upNextLines } from "../src/ui/SidePanel.tsx"
import { makeTheme } from "../src/ui/theme.ts"

const entry = (ticket: string, phase: TicketPhase): LedgerEntry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since: 0,
  worker: null,
  row: null,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const soloNext: Solo = { ticket: "jsw-sxo", running: false }

/** Up next's reasons by ticket, for `running` tickets beside the solo ticket next and one behind. */
const heldOf = (
  running: ReadonlyArray<LedgerEntry>,
  options: { readonly status?: Partial<Status>; readonly windingDown?: boolean } = {},
): Readonly<Record<string, string | null>> => {
  const list = [
    ...running,
    entry("jsw-sxo", TicketPhase.HeldBack({ why: "solo" })),
    entry("jsw-axh", TicketPhase.HeldBack({ why: "solo" })),
  ]
  const view = project({
    ledger: {
      tickets: new Map(list.map((each) => [each.ticket, each])),
      rows: 0,
      windDown:
        options.windingDown === true ? { since: 0, tickets: running.map((e) => e.ticket) } : null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, concurrency: 4, solo: soloNext, ...options.status },
    actions: new Map(),
  })
  return Object.fromEntries(view.queue.map((row) => [row.ticket, row.held]))
}

describe("the solo ticket next's reason", () => {
  test("names the running tickets and those past their work; the tickets behind name it", () => {
    expect(heldOf([entry("jsw-8f7", TicketPhase.Working())])).toEqual({
      "jsw-sxo": "next, alone: after jsw-8f7 finishes",
      "jsw-axh": "after jsw-sxo (solo)",
    })
    expect(
      heldOf([
        entry("jsw-8f7", TicketPhase.Working()),
        entry("jsw-m1", TicketPhase.ToMerge({ place: 1 })),
        entry("jsw-q", TicketPhase.Queued()),
        entry("jsw-d", TicketPhase.Deferred({ why: "x" })),
      ])["jsw-sxo"],
    ).toBe("next, alone: after jsw-8f7, jsw-m1 finish")
  })

  test("names three, then +N", () => {
    expect(soloNextAfter([])).toBe("next, alone")
    expect(soloNextAfter(["a"])).toBe("next, alone: after a finishes")
    expect(soloNextAfter(["a", "b", "c"])).toBe("next, alone: after a, b, c finish")
    expect(soloNextAfter(["a", "b", "c", "d", "e"])).toBe(
      "next, alone: after a, b, c, then +2 finish",
    )
  })

  test("says the next run in a run that won't start it", () => {
    const running = [entry("jsw-8f7", TicketPhase.Working())]
    for (const [why, held] of [
      ["winding down", heldOf(running, { windingDown: true })],
      ["stopping", heldOf(running, { status: { stopping: true } })],
      ["quitting", heldOf(running, { status: { quitting: "Quitting…" } })],
      ["past its looks", heldOf(running, { status: { looksOver: true } })],
      ["at --limit", heldOf(running, { status: { solo: { ...soloNext, pastLimit: true } } })],
    ] as const) {
      expect([why, held]).toEqual([
        why,
        { "jsw-sxo": soloNextRun, "jsw-axh": "after jsw-sxo (solo)" },
      ])
    }
    expect(soloNextRun).toBe("alone, in the next run")
  })

  const named = (reason: string) =>
    afterParts(reason).flatMap((part) => (part.id ? [part.text] : []))

  test("afterParts finds the tickets it names, so they are drawn live", () => {
    const id = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,15}$/)
    fc.assert(
      fc.property(fc.array(id, { minLength: 1, maxLength: 6 }), (ids) => {
        const reason = soloNextAfter(ids)
        expect(named(reason)).toEqual(ids.slice(0, 3))
        expect(
          afterParts(reason)
            .map((part) => part.text)
            .join(""),
        ).toBe(reason)
      }),
    )
    expect(named(soloNextRun)).toEqual([])
    expect(named("next, alone")).toEqual([])
    const shown = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: false })
    const queue = [
      { ticket: "jsw-sxo" as TicketId, label: "jsw-sxo", title: "t", held: soloNextAfter(["a"]) },
    ]
    const lines = upNextLines(queue, { ...emptyTotals(), heldBack: 1 }, shown, 62, 6)
    const segments = lines.flat()
    expect(segments.find((s) => s.text === "a")?.look).toEqual(shown.look("live"))
    expect(segments.find((s) => s.text === " finishes")?.look).toEqual(shown.styles.quiet)
  })
})

const emptyTotals = () =>
  project({
    ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
    workers: new Map(),
    requests: [],
    status: emptyStatus,
    actions: new Map(),
  }).totals

type Env = Beads | Ledger | Log | EventStream | RunFibers | Scope.Scope

const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** The solo ticket as the scheduler last showed it, with a running and s solo next, at `limit`. */
const shownSolo = (limit: number | null) =>
  run(
    [
      { id: "a", priority: 1 },
      { id: "s", priority: 2, labels: ["solo"] },
    ],
    Effect.gen(function* () {
      let last: QueueShown | undefined
      const schedule = yield* make({
        concurrent: 2,
        limit,
        scope: null,
        excludeTypes: ["epic"],
        start: { start: (_: Issue) => Effect.never },
        show: (queue) =>
          Effect.sync(() => {
            last = queue
          }),
      })
      yield* schedule.fillTrying
      return last?.solo
    }),
  )

describe("the scheduler's solo ticket next", () => {
  test("is past the limit once --limit is reached, so it won't start in this run", async () => {
    expect(await shownSolo(1)).toEqual({ ticket: "s", running: false, pastLimit: true })
    expect(await shownSolo(2)).toEqual({ ticket: "s", running: false })
    expect(await shownSolo(null)).toEqual({ ticket: "s", running: false })
  })
})
