// The tickets table beside Current, the compact Current list's columns and the square for a ticket
// to merge (§ 5.1 "How the phases are shown", § 7.2, § 7.11; orchestra-60xg, orchestra-lx4d.4,
// orchestra-1dvh, orchestra-7dpo): beside Current the table leaves out every ticket Current shows,
// whatever its phase, so that a ticket is shown once a frame, and its row comes in under the others
// as it leaves Current; the end-of-run box in Current's place leaves every row in. The compact list
// lines up its numbers, IDs, statuses and times as columns, so that the titles start at one column.
// A ticket to merge is `◼`, and `◷` stays for one waiting on another.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, type Scope } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type Entry, emptyTallies, Ledger, type State } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Cause, Outcome, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, rowStatus, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { Root } from "../src/ui/App.tsx"
import { compactLines } from "../src/ui/Card.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { rowsBesideCurrent } from "../src/ui/TicketsTable.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + 67_000

type Env = Ledger | Log | EventStream | Captured | Scope.Scope

/** Runs `effect` with the ledger over captured logs and events, under TestClock, in a scope. */
const run = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
    ),
  )

/** The ticket's title: one that doesn't hold its ID, so a frame's count of the ID is its own. */
const titles: Readonly<Record<string, string>> = {
  "tut-a1": "Open the property model",
  "tut-b2": "Add an undo stack",
  "tut-c3": "Remove the build cache",
  "tut-d4": "Tidy the log",
}

/** Moves `ticket` by each of `causes` in turn, failing the test on an invalid one. */
const go = (ticket: string, ...causes: ReadonlyArray<Cause>) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    for (const [i, cause] of causes.entries()) {
      const options = i === 0 ? { title: titles[ticket] ?? ticket } : {}
      const next = yield* ledger.transition(ticket, cause, options)
      if (Result.isFailure(next)) throw new Error(next.failure.phaseBug(ticket))
    }
  })

const dispatched = [Cause.Ready(), Cause.Dispatched()] as const

const statusOf = (over: Partial<Status> = {}): Status => ({
  ...emptyStatus,
  version: "0.1.0",
  branch: "main",
  began,
  concurrency: 3,
  ...over,
})

const viewOf = (
  ledger: State,
  over: {
    readonly status?: Partial<Status>
    readonly requests?: ReadonlyArray<AttentionRequest>
    readonly workers?: ReadonlyMap<string, WorkerState>
  } = {},
): RunView =>
  project({
    ledger,
    workers: over.workers ?? new Map(),
    requests: over.requests ?? [],
    status: statusOf(over.status),
  })

const value = (view: RunView): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => now,
})

const draw = (view: RunView): Promise<Frame> =>
  renderFrame(<Root value={value(view)} />, { width: 100, height: 40 })

/** How many times `text` is in the frame. */
const countIn = (frame: Frame, text: string): number => frame.chars.split(text).length - 1

/** The table's rows in the frame, its blank ones left out: from the `Tickets` label to its foot. */
const tableOf = (frame: Frame): ReadonlyArray<string> => {
  const lines = frame.chars.split("\n").map((line) => line.trimEnd())
  const from = lines.findIndex((line) => line.trim() === "Tickets")
  const to = lines.findIndex((line, i) => i > from && line.startsWith("╰"))
  return lines.slice(from + 2, to).filter((line) => /[a-z]/.test(line))
}

const permission = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
    summary: "rm -rf build",
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

describe("the tickets table beside Current", () => {
  test("a ticket is shown once a frame as it goes through Current and comes to an end", async () => {
    const tickets = Object.keys(titles)
    const steps: ReadonlyArray<readonly [string, ReadonlyArray<Cause>]> = [
      ["tut-a1", dispatched],
      ["tut-b2", dispatched],
      ["tut-c3", dispatched],
      ["tut-a1", [Cause.Verified({ place: 1 })]],
      ["tut-b2", [Cause.Defer({ why: "BAD_TICKET_ID" })]],
      ["tut-a1", [Cause.ItsTurn()]],
      ["tut-c3", [Cause.Verified({ place: 1 })]],
      ["tut-a1", [Cause.FastForwarded({ commit: "abc1234def" })]],
      ["tut-d4", dispatched],
      ["tut-c3", [Cause.ItsTurn()]],
      ["tut-c3", [Cause.Block({ why: "MERGE_CONFLICT" })]],
      ["tut-d4", [Cause.Aside({ why: "OFF_BRANCH" })]],
    ]
    const views = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const out: Array<RunView> = []
        for (const [ticket, causes] of steps) {
          yield* go(ticket, ...causes)
          out.push(viewOf(yield* ledger.current))
        }
        return out
      }),
    )
    for (const [i, view] of views.entries()) {
      const frame = await draw(view)
      for (const ticket of tickets) {
        const shown = view.rows.some((row) => row.ticket === ticket) ? 1 : 0
        expect({ step: i, ticket, times: countIn(frame, ticket) }).toEqual({
          step: i,
          ticket,
          times: shown,
        })
      }
    }
    // At the end, the tickets in the order they came to an end: b deferred, a merged, c blocked, d
    // set aside.
    const last = views.at(-1)
    if (last === undefined) throw new Error("no view")
    expect(tableOf(await draw(last))).toEqual([
      expect.stringContaining("↷ deferred  │ tut-b2"),
      expect.stringContaining("✓ done      │ tut-a1"),
      expect.stringContaining("■ blocked   │ tut-c3"),
      expect.stringContaining("! review    │ tut-d4"),
    ])
  })

  test("a row comes in under the others as its ticket leaves Current, whatever its phase", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* go("tut-a1", ...dispatched)
        yield* go("tut-b2", ...dispatched)
        yield* go("tut-c3", ...dispatched)
        yield* go("tut-b2", Cause.Defer({ why: "BAD_TICKET_ID" }))
        yield* go("tut-a1", Cause.WaitsForMerge({ for: "tut-c3" }))
        return viewOf(yield* (yield* Ledger).current)
      }),
    )
    // c, still working, keeps the place it was picked up in; b and a follow as they left Current.
    expect(view.rows.map((row) => row.ticket)).toEqual(["tut-c3", "tut-b2", "tut-a1"])
    expect(rowsBesideCurrent(view.rows, view.cards).map((row) => row.ticket)).toEqual([
      "tut-b2",
      "tut-a1",
    ])
  })

  test("leaves out every ticket with a card, and keeps every other, whatever the phases", () => {
    const phases: ReadonlyArray<TicketPhase> = [
      TicketPhase.Working({ activity: "working" }),
      TicketPhase.Working({ activity: "allow" }),
      TicketPhase.ToMerge({ place: 1 }),
      TicketPhase.Merging({ step: "check" }),
      TicketPhase.Resolving({ attempt: 1 }),
      TicketPhase.Fixing({ attempt: 1, afterResolution: false }),
      TicketPhase.Done({ outcome: Outcome.Merged({ commit: "abc1234" }) }),
      TicketPhase.Waiting({ for: "x" }),
      TicketPhase.Deferred({ why: "BAD_TICKET_ID" }),
      TicketPhase.Review({ why: "CHECKS_FAILED" }),
      TicketPhase.Blocked({ why: "MERGE_CONFLICT" }),
      TicketPhase.Stopped({ why: "PAUSED" }),
    ]
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            phase: fc.constantFrom(...phases),
            worker: fc.boolean(),
            handBack: fc.boolean(),
          }),
          { maxLength: 12 },
        ),
        (tickets) => {
          const entries = tickets.map(
            (t, i): Entry => ({
              ticket: `t-${i}`,
              title: `title ${i}`,
              phase: t.phase,
              since: began,
              worker: t.worker ? i + 1 : null,
              row: i,
              rechecking: false,
              steered: false,
              handBack: t.handBack,
              lastMessage: null,
              tallies: emptyTallies,
            }),
          )
          const view = viewOf({
            tickets: new Map(entries.map((entry) => [entry.ticket, entry])),
            rows: entries.length,
            windDown: null,
            bugs: [],
          })
          const beside = rowsBesideCurrent(view.rows, view.cards).map((row) => row.ticket)
          const carded = new Set(view.cards.map((card) => card.ticket))
          expect(beside.filter((ticket) => carded.has(ticket))).toEqual([])
          expect(beside).toEqual(
            view.rows.map((row) => row.ticket).filter((ticket) => !carded.has(ticket)),
          )
        },
      ),
    )
  })

  test("with the end-of-run box in Current's place, the running tickets keep their rows", async () => {
    const ledger = await run(
      Effect.gen(function* () {
        yield* go("tut-a1", ...dispatched)
        yield* go("tut-b2", ...dispatched, Cause.Defer({ why: "BAD_TICKET_ID" }))
        return yield* (yield* Ledger).current
      }),
    )
    const requests = [permission("r1", "tut-a1")]
    const beside = await draw(viewOf(ledger, { requests }))
    expect(tableOf(beside)).toEqual([expect.stringContaining("tut-b2")])
    const ending = await draw(viewOf(ledger, { requests, status: { endOfRun: ["tut-a1"] } }))
    expect(tableOf(ending)).toEqual([
      expect.stringContaining("■ allow?    │ tut-a1"),
      expect.stringContaining("↷ deferred  │ tut-b2"),
    ])
  })
})

describe("the compact Current list's columns", () => {
  test("numbers, IDs, statuses and times line up, the times right-aligned", () => {
    const entry = (ticket: string, worker: number, phase: TicketPhase, ago: number): Entry => ({
      ticket,
      title: `Title of ${ticket}`,
      phase,
      since: now - ago,
      worker,
      row: worker,
      rechecking: false,
      steered: worker === 12,
      lastMessage: null,
      tallies: emptyTallies,
    })
    const entries = [
      entry("tut-kco", 1, TicketPhase.Merging({ step: "check" }), 42_000),
      entry("tut-zq4b", 2, TicketPhase.Working({ activity: "working" }), 391_000),
      entry("tut-9a1", 3, TicketPhase.ToMerge({ place: 2 }), 3_900_000),
      entry("t-1", 12, TicketPhase.Working({ activity: "working" }), 5_000),
    ]
    const view = viewOf(
      { tickets: new Map(entries.map((e) => [e.ticket, e])), rows: 13, windDown: null, bugs: [] },
      {
        workers: new Map<string, WorkerState>([
          ["tut-zq4b", WS.Working({ doing: "testing" })],
          ["t-1", WS.Idle({ at: now })],
        ]),
      },
    )
    const lines = compactLines(view.cards, theme, { now, spin: "⣾", width: 100, highlighted: null })
    const text = lines.map((line) =>
      line
        .map((s) => s.text)
        .join("")
        .trimEnd(),
    )
    expect(`\n${text.join("\n")}\n`).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
      │  1 ◆  tut-kco   merging           42s  Title of tut-kco                                          │
      │  2 ⣾  tut-zq4b  testing         6m31s  Title of tut-zq4b                                         │
      │  3 ◼  tut-9a1   to merge (2nd)  1h05m  Title of tut-9a1                                          │
      │ 12 •  t-1       done  steered      5s  Title of t-1                                              │
      ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
      "
    `)
  })

  test("the titles start at one column, whatever the IDs, statuses and times", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 16 }),
            worker: fc.integer({ min: 1, max: 16 }),
            ago: fc.integer({ min: 0, max: 20 * 3_600_000 }),
            phase: fc.constantFrom(
              TicketPhase.Working({ activity: "working" }),
              TicketPhase.ToMerge({ place: 3 }),
              TicketPhase.Merging({ step: "rebase" }),
              TicketPhase.Fixing({ attempt: 1, afterResolution: false }),
            ),
            asks: fc.boolean(),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (cards) => {
          const entries = cards.map(
            (c, i): Entry => ({
              ticket: `id-${i}-${c.id}`,
              title: `title-${i}`,
              phase: c.phase,
              since: now - c.ago,
              worker: c.worker + i * 16,
              row: i,
              rechecking: false,
              steered: false,
              lastMessage: null,
              tallies: emptyTallies,
            }),
          )
          const requests = entries.flatMap((e, i) =>
            cards[i]?.asks === true ? [permission(`r${i}`, e.ticket)] : [],
          )
          const view = viewOf(
            {
              tickets: new Map(entries.map((e) => [e.ticket, e])),
              rows: entries.length,
              windDown: null,
              bugs: [],
            },
            { requests },
          )
          const lines = compactLines(view.cards, theme, {
            now,
            spin: "⣾",
            width: 400,
            highlighted: null,
          })
          const columns = view.cards.map((card, i) => {
            const line = lines[i + 1] ?? []
            const title = line.findIndex((s) => s.text === card.title)
            return widthOf(line.slice(0, title))
          })
          expect(new Set(columns).size).toBe(1)
        },
      ),
    )
  })
})

describe("the square for a ticket to merge", () => {
  test("◼ to merge, and ◷ for a ticket waiting on another", () => {
    const join = (status: { readonly mark: string; readonly word: string }) =>
      `${status.mark} ${status.word}`
    expect(join(rowStatus(TicketPhase.ToMerge({ place: 1 })))).toBe("◼ to merge")
    expect(join(rowStatus(TicketPhase.Waiting({ for: "tut-a1" })))).toBe("◷ waiting")
    const entry: Entry = {
      ticket: "tut-a1",
      title: "Open the property model",
      phase: TicketPhase.ToMerge({ place: 1 }),
      since: began,
      worker: 1,
      row: 0,
      rechecking: false,
      steered: false,
      lastMessage: null,
      tallies: emptyTallies,
    }
    const view = viewOf({
      tickets: new Map([["tut-a1", entry]]),
      rows: 1,
      windDown: null,
      bugs: [],
    })
    expect(view.cards[0]?.motion).toBe("◼")
  })
})
