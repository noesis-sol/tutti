// What the dashboard, the summary, the log and the report show of the Linear sync (the epic
// tutti-qatu's "Shown and recorded"; tutti-qatu.9): a linked ticket's row, card and dispatch line
// have its Linear key beside its ID, an unlinked one's are as before; the summary's Linear line
// counts the pulls and pushes and lists what failed, and a run without the sync has none; the
// report's evidence names the Linear issue of each ticket the run closed.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { renderInput } from "../src/organs/evidence.ts"
import { summary } from "../src/print/summary.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { summaryLines } from "../src/run/endOfRun.ts"
import { type Entry, emptyTallies, Ledger } from "../src/run/ledger.ts"
import { Finished, Move, TicketPhase } from "../src/run/phase.ts"
import { gather } from "../src/run/report.ts"
import { emptyStatus, emptyView, project, type RunView } from "../src/run/runView.ts"
import { dispatchLine } from "../src/run/schedule.ts"
import { Ending, type Summary } from "../src/run/summary.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import type { Event } from "../src/services/events.ts"
import {
  addRecord,
  type Figures,
  figuresLines,
  figuresText,
  noFigures,
} from "../src/services/figures.ts"
import type { LinearKey } from "../src/services/linearSync.ts"
import { OrganCost } from "../src/services/OrganCost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer, linearUrl } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { headOf } from "../src/ui/Card.tsx"
import { type Segments, seg } from "../src/ui/line.tsx"
import { ticketsLines } from "../src/ui/TicketsTable.tsx"
import { makeTheme } from "../src/ui/theme.ts"

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: false })

const text = (segments: Segments) => segments.map((each) => each.text).join("")

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is stripped
const sgr = /\x1b\[[0-9;]*m/g

/** An issue as bd gives it, linked to the Linear issue `key` where given. */
const issueOf = (id: string, key?: string): Issue => ({
  id: id as TicketId,
  title: `Title of ${id}`,
  description: "",
  design: "",
  acceptance: "",
  notes: "",
  status: "open",
  type: "task",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "2026-11-17T09:00:00Z",
  closeReason: "",
  ...(key === undefined ? {} : { externalRef: linearUrl(key), linearKey: key as LinearKey }),
})

const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "c0ffee0abcdef" }) })

/** The ledger's entry for `issue`, in `phase`, at `row`, with a worker where `worker` is given. */
const entryOf = (issue: Issue, phase: TicketPhase, row: number, worker: number | null): Entry => ({
  ticket: issue.id,
  title: issue.title,
  issue,
  phase,
  since: 0,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView of `entries`. */
const viewOf = (entries: ReadonlyArray<Entry>): RunView =>
  project({
    ledger: {
      tickets: new Map(entries.map((entry) => [entry.ticket, entry])),
      rows: entries.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "main", began: 0, concurrency: 3 },
    actions: new Map(),
  })

/** The table's lines as text, `width` wide, every row of it. */
const drawn = (view: RunView, width = 80) =>
  ticketsLines(view.rows, theme, width, { fill: false }).map(text)

describe("a ticket's row", () => {
  const linked = entryOf(issueOf("t-1", "NOE-12"), merged, 0, null)
  const unlinked = entryOf(issueOf("t-2"), merged, 1, null)

  test("has its Linear key beside its ID where it links one, faint", () => {
    const view = viewOf([linked, unlinked])
    expect(view.rows.map((row) => row.linear)).toEqual(["NOE-12", undefined])
    const lines = drawn(view)
    expect(lines.find((each) => each.includes("t-1"))).toContain("│ t-1 NOE-12 │")
    expect(lines.find((each) => each.includes("t-2"))).toContain("│ t-2        │")
    const cell = ticketsLines(view.rows, theme, 80, { fill: false }).flat()
    const key = cell.find((each) => each.text === " NOE-12")
    expect(key?.look).toBe(theme.styles.dim)
  })

  test("an unlinked one is drawn as before, beside no linked one", () => {
    const view = viewOf([{ ...unlinked, row: 0 }])
    expect(view.rows[0]?.linear).toBeUndefined()
    expect(drawn(view)).toEqual(drawn(viewOf([{ ...unlinked, row: 0, issue: undefined } as Entry])))
    expect(drawn(view).find((each) => each.includes("t-2"))).toContain("│ t-2     │")
  })

  test("a narrow table cuts the key before the ID, and leaves it out where the ID takes the room", () => {
    // At 40 columns the ID column is 11 wide.
    const long = entryOf(issueOf("t-1", "NOE-1234567"), merged, 0, null)
    expect(drawn(viewOf([long]), 40).find((each) => each.includes("t-1"))).toContain(
      "│ t-1 NOE-12… │",
    )
    const wide = entryOf(issueOf("tutti-abcdefgh", "NOE-12"), merged, 0, null)
    expect(drawn(viewOf([wide]), 40).find((each) => each.includes("tutti"))).toContain(
      "│ tutti-abcd… │",
    )
  })
})

describe("a ticket's card", () => {
  const working = TicketPhase.Working()
  const head = (view: RunView, ticket: string) => {
    const card = view.cards.find((each) => each.ticket === ticket)
    if (card === undefined) throw new Error(`no card for ${ticket}`)
    return text(headOf(card, theme, 42_000, "⣾", [seg(card.status)]))
  }

  test("has its Linear key beside its ID where it links one; an unlinked one's as before", () => {
    const view = viewOf([
      entryOf(issueOf("t-1", "NOE-12"), working, 0, 1),
      entryOf(issueOf("t-2"), working, 1, 2),
    ])
    expect(head(view, "t-1")).toContain("t-1 NOE-12  ")
    expect(head(view, "t-2")).toMatch(/t-2 {2}\S/)
    expect(head(view, "t-2")).not.toContain("NOE")
  })
})

describe("the dispatch line", () => {
  test("names a linked ticket's Linear key beside its ID", () => {
    expect(String(dispatchLine(1, null, issueOf("t-1", "NOE-12")))).toBe(
      "[1] t-1 (NOE-12) dispatching: Title of t-1",
    )
    expect(String(dispatchLine(2, 5, issueOf("t-2")))).toBe("[2/5] t-2 dispatching: Title of t-2")
  })
})

const pull = (fields: Partial<Extract<Event, { kind: "linear" }>>): Event =>
  ({ kind: "linear", sync: "pull", text: "", ...fields }) as Event

const push = (fields: Partial<Extract<Event, { kind: "linear" }>>): Event =>
  ({ kind: "linear", sync: "push", text: "", ...fields }) as Event

const figuresOf = (events: ReadonlyArray<Event>): Figures =>
  events.reduce((sum, event) => addRecord(sum, event, 0), noFigures)

const linearLine = (figures: Figures) =>
  figuresLines(figures, { subscription: false, label: (window) => window })
    .filter((each) => each.label === "Linear")
    .map(figuresText)

describe("the summary's Linear line", () => {
  test("counts what the pulls added, released and updated, and the tickets pushed", () => {
    const figures = figuresOf([
      pull({ start: true, added: ["NOE-1", "NOE-2"], released: ["NOE-3"] }),
      pull({ added: ["NOE-4"], updated: ["NOE-5"] }),
      // An issue listed twice counts once.
      pull({ added: ["NOE-4"] }),
      push({ ticket: "t-1", issue: "NOE-1", outcome: "updated" }),
      push({ ticket: "t-1", issue: "NOE-1", outcome: "skipped" }),
      push({ ticket: "t-9", issue: "NOE-9", outcome: "created" }),
    ])
    expect(linearLine(figures)).toEqual([
      "Linear  3 pulls · 3 added · 1 released · 1 updated · 2 pushed (1 created)",
    ])
  })

  test("lists what failed: a whole pull, an issue no later pull took, a push failed at the end", () => {
    const figures = figuresOf([
      pull({ start: true, why: "Linear's API: 503" }),
      pull({ added: ["NOE-1"], failed: ["NOE-7", "NOE-8"] }),
      // NOE-8 was pulled after all.
      pull({ added: ["NOE-8"] }),
      push({ ticket: "t-1", outcome: "failed", why: "timed out" }),
      push({ ticket: "t-1", outcome: "updated", issue: "NOE-1" }),
      push({ ticket: "t-3", outcome: "failed", why: "timed out" }),
      push({ ticket: "t-3", outcome: "failed", why: "timed out", last: true }),
      // A look for filed tickets that failed names no ticket.
      push({ outcome: "failed", why: "bd list failed" }),
    ])
    expect(linearLine(figures)).toEqual([
      "Linear  3 pulls · 2 added · 1 pushed · failed: 1 pull, NOE-7 not pulled, t-3 not pushed",
    ])
  })

  test("names three of what failed, and counts the rest", () => {
    const figures = figuresOf([pull({ failed: ["NOE-1", "NOE-2", "NOE-3", "NOE-4", "NOE-5"] })])
    expect(linearLine(figures)).toEqual([
      "Linear  1 pull · failed: NOE-1, NOE-2, NOE-3, +2 more not pulled",
    ])
  })

  test("a run without the sync has none", () => {
    expect(noFigures.linear).toBeNull()
    expect(linearLine(figuresOf([]))).toEqual([])
  })

  const summarised = (figures: Figures, rows: RunView["rows"]): Summary => ({
    version: "0.1.0",
    branch: "main",
    scope: null,
    took: 60_000,
    totals: emptyView.totals,
    figures: figuresLines(figures, { subscription: false, label: (window) => window }),
    rows,
  })

  test("is in the summary, plain and styled, whether or not the run took up a ticket", () => {
    const figures = figuresOf([pull({ start: true })])
    for (const rows of [[], viewOf([entryOf(issueOf("t-1", "NOE-12"), merged, 0, null)]).rows]) {
      const s = summarised(figures, rows)
      const plain = summaryLines({ ...s, base: "main" }).map(String)
      expect(plain).toContain("  Linear  1 pull")
      expect(summary(s, theme, 100).replace(sgr, "")).toContain("  Linear  1 pull")
    }
  })

  test("a linked ticket's plain row names its Linear key; an unlinked one's is as before", () => {
    const rows = viewOf([
      entryOf(issueOf("t-1", "NOE-12"), merged, 0, null),
      entryOf(issueOf("t-2"), merged, 1, null),
    ]).rows
    const plain = summaryLines({ ...summarised(noFigures, rows), base: "main" }).map(String)
    expect(plain.find((each) => each.includes("t-1"))).toMatch(/^ {2}\S+ t-1 \(NOE-12\) done: /)
    expect(plain.find((each) => each.includes("t-2"))).toMatch(/^ {2}\S+ t-2 done: /)
    expect(plain.some((each) => each.includes("Linear"))).toBe(false)
  })
})

describe("the report's evidence", () => {
  test("names the Linear issue of each ticket the run closed that links one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tutti-linear-shown-"))
    const deps = Layer.mergeAll(
      configLayer(appConfig({}, repo)),
      beadsLayer([
        { id: "a", title: "Do a", status: "closed", externalRef: linearUrl("NOE-12") },
        { id: "b", title: "Do b", status: "closed" },
      ]),
      gitLayer({ dir: repo }),
      logLayer(),
      eventsLayer(),
    )
    const services = Layer.mergeAll(OrganCost.layer, Ledger.layer, attentionLayer()).pipe(
      Layer.provideMerge(deps),
    )
    const parts = await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        for (const ticket of ["a", "b"] as ReadonlyArray<TicketId>) {
          yield* ledger.transition(ticket, Move.Ready(), { title: `Do ${ticket}` })
          yield* ledger.transition(ticket, Move.Dispatched())
          yield* ledger.transition(ticket, Move.Verified({ place: 1 }))
          yield* ledger.transition(ticket, Move.ItsTurn())
          yield* ledger.transition(ticket, Move.FastForwarded({ commit: "abc123" }))
        }
        return yield* gather({
          started: 0,
          base: "main",
          startHead: yield* (yield* Repository).head("main"),
          ending: Ending.Done({ text: "DONE", tickets: 2, limit: null, took: 0 }),
          exitCode: 0,
          quit: false,
        })
      }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
    )
    const input = renderInput("0123456789abcdef", parts)
    expect(input).toContain("a: Do a\nDone (merged in abc123)\nLinear issue: NOE-12\nClose reason:")
    expect(input).toContain("b: Do b\nDone (merged in abc123)\nClose reason:")
  })
})
