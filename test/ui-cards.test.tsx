// The dashboard's cards, wind-down line, hint and key help (§ 5.1, § 7.2, § 7.11): a card for each
// status in its style, the frames and the highlight, two to a row from 120 columns, the compact
// mode, a stable order as workers finish, the spinner on the shell's clock, the keys and clicks
// that open a worker, the wind-down line, the key help, and the workers' latest actions.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber, Layer, Queue, Result, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { Transcripts } from "../src/agent/Transcripts.ts"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies, Ledger, type WindDown } from "../src/run/ledger.ts"
import { Cause, Outcome, TicketPhase } from "../src/run/phase.ts"
import { type Card, emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { actionPoll, latestActions, Screen } from "../src/run/screen.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import {
  cardLines,
  compactLines,
  elapsed,
  idleBox,
  keptLines,
  layoutOf,
  statusLook,
} from "../src/ui/Card.tsx"
import { moveHighlight } from "../src/ui/Dashboard.tsx"
import { hintSegments } from "../src/ui/Hint.tsx"
import { keyHelpLines } from "../src/ui/KeyHelp.tsx"
import { type Look, roleLook, type Segments, widthOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue, spinnerAt, spinnerFrames } from "../src/ui/useRunView.ts"
import { windDownSegments } from "../src/ui/WindDown.tsx"
import { type Frame, pressEscape, renderFrame, type Size, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + 67_000
const resets = new Date(2026, 9, 20, 14, 5).getTime()

interface Ticket {
  readonly ticket: string
  readonly title?: string
  readonly phase: TicketPhase
  readonly worker: number | null
  readonly steered?: boolean
}

const entryOf = (t: Ticket, row: number): Entry => ({
  ticket: t.ticket,
  title: t.title ?? `Title of ${t.ticket}`,
  phase: t.phase,
  since: began,
  worker: t.worker,
  row,
  rechecking: false,
  steered: t.steered ?? false,
  lastMessage: null,
  tallies: emptyTallies,
})

const working = TicketPhase.Working({ activity: "working" })

/**
 * RunView for `tickets`, with their workers' states, open requests and latest actions, the run
 * having room for 3 workers, or `concurrency`.
 */
const viewOf = (
  tickets: ReadonlyArray<Ticket>,
  over: {
    readonly workers?: ReadonlyMap<string, WorkerState>
    readonly requests?: ReadonlyArray<AttentionRequest>
    readonly actions?: ReadonlyMap<string, { readonly text: string; readonly denied: boolean }>
    readonly windDown?: WindDown | null
    readonly stopping?: boolean
    readonly concurrency?: number
  } = {},
): RunView =>
  project({
    ledger: {
      tickets: new Map(tickets.map((t, i) => [t.ticket, entryOf(t, i)])),
      rows: tickets.length,
      windDown: over.windDown ?? null,
      bugs: [],
    },
    workers: over.workers ?? new Map(),
    requests: over.requests ?? [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch/2026-10-20",
      began,
      concurrency: over.concurrency ?? 3,
      stopping: over.stopping ?? false,
    },
    actions: over.actions ?? new Map(),
  })

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

const question = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket,
  kind: { _tag: "Question", questions: [], input: {} },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

/** The one card of a view of one ticket. */
const cardOf = (
  phase: TicketPhase,
  over: Parameters<typeof viewOf>[1] & { readonly steered?: boolean } = {},
): Card => {
  const card = viewOf([{ ticket: "t-1", phase, worker: 1, steered: over.steered ?? false }], over)
    .cards[0]
  if (card === undefined) throw new Error("no card")
  return card
}

const textOf = (lines: ReadonlyArray<Segments>): string =>
  `\n${lines
    .map((line) =>
      line
        .map((s) => s.text)
        .join("")
        .trimEnd(),
    )
    .join("\n")}\n`

const spin = spinnerFrames[0]

const drawn = (card: Card, highlighted = false, width = 50) =>
  cardLines(card, theme, { now, spin, width, inside: 3, highlighted })

/** The look of the first segment holding `text`. */
const lookOf = (lines: ReadonlyArray<Segments>, text: string): Look => {
  const found = lines.flat().find((s) => s.text === text)
  if (found?.look === undefined || found.look === null) throw new Error(`no look for ${text}`)
  return found.look
}

const sameLook = (a: Look, b: Look) => {
  expect(a.attributes).toBe(b.attributes)
  expect(a.fg?.toInts()).toEqual(b.fg?.toInts())
}

const states = (state: WorkerState) => ({ workers: new Map([["t-1", state]]) })

describe("a card for each status", () => {
  test("a worker at work: its doing, with the spinner, framed live", () => {
    const card = cardOf(working, {
      ...states(WS.Working({ doing: "testing" })),
      actions: new Map([["t-1", { text: "Bash(scripts/check-fast.sh)", denied: false }]]),
    })
    const lines = drawn(card)
    expect(textOf(lines)).toMatchInlineSnapshot(`
      "
      ╭────────────────────────────────────────────────╮
      │ ⣾ t-1  testing  1m07s                          │
      │   Title of t-1                                 │
      │   ▸ Bash(scripts/check-fast.sh)                │
      ╰────────────────────────────────────────────────╯
      "
    `)
    sameLook(lookOf(lines, "testing"), theme.styles.testing)
    sameLook(lookOf(lines, "t-1"), theme.styles.picked)
    sameLook(lookOf(lines, "⣾"), theme.styles.picked)
    sameLook(lookOf(lines, "1m07s"), theme.styles.dim)
    sameLook(lookOf(lines, "▸ Bash(scripts/check-fast.sh)"), theme.styles.dim)
    const frame = lines[0]?.[0]?.look
    if (frame === undefined || frame === null) throw new Error("no frame")
    sameLook(frame, roleLook(theme, "live"))
  })

  test("each status as § 4.2 words it, in § 7.11's style", () => {
    const cases: ReadonlyArray<readonly [string, Card, Look]> = [
      ["starting", cardOf(working, states(WS.Starting())), theme.styles.dim],
      ["working", cardOf(working, states(WS.Working({ doing: "working" }))), theme.styles.picked],
      ["editing", cardOf(working, states(WS.Working({ doing: "editing" }))), theme.styles.picked],
      ["reading", cardOf(working, states(WS.Working({ doing: "reading" }))), theme.styles.picked],
      ["subagent", cardOf(working, states(WS.Working({ doing: "subagent" }))), theme.styles.picked],
      ["testing", cardOf(working, states(WS.Working({ doing: "testing" }))), theme.styles.testing],
      [
        "retrying 3/10 (529)",
        cardOf(working, states(WS.Retrying({ attempt: 3, max: 10, status: 529 }))),
        theme.styles.deferred,
      ],
      [
        "usage limit · resets 14:05",
        cardOf(working, states(WS.UsageLimited({ resetsAt: resets }))),
        theme.styles.deferred,
      ],
      ["done", cardOf(working, states(WS.Idle({ at: now }))), theme.styles.done],
      [
        "stopped",
        cardOf(working, states(WS.Failed({ at: now, error: "", interrupted: true }))),
        theme.styles.deferred,
      ],
      [
        "failed",
        cardOf(working, states(WS.Failed({ at: now, error: "x", interrupted: false }))),
        roleLook(theme, "needsYou"),
      ],
      ["gone", cardOf(working, states(WS.Gone({ why: "exited" }))), roleLook(theme, "needsYou")],
      [
        "permission — waiting for you",
        cardOf(working, { requests: [permission("r1", "t-1")] }),
        theme.styles.stop,
      ],
      [
        "question — waiting for you (2)",
        cardOf(working, { requests: [question("r1", "t-1"), permission("r2", "t-1")] }),
        theme.styles.stop,
      ],
      ["resolving", cardOf(TicketPhase.Resolving({ attempt: 1 })), theme.styles.deferred],
      [
        "fixing check",
        cardOf(TicketPhase.Fixing({ attempt: 1, afterResolution: false })),
        theme.styles.deferred,
      ],
      ["to merge (2nd)", cardOf(TicketPhase.ToMerge({ place: 2 })), theme.styles.toMerge],
      ["merging", cardOf(TicketPhase.Merging({ step: "check" })), theme.styles.merging],
    ]
    for (const [status, card, look] of cases) {
      expect(card.status).toBe(status)
      sameLook(statusLook(card, theme), look)
      sameLook(lookOf(drawn(card), status), look)
    }
  })

  test("the marks: the spinner while it works, ◼ to merge, ◆ merging, • after a turn", () => {
    const head = (card: Card) => textOf(drawn(card)).split("\n")[2]
    expect(head(cardOf(working, states(WS.Working({ doing: "editing" }))))).toContain("│ ⣾ t-1")
    expect(head(cardOf(TicketPhase.Resolving({ attempt: 1 })))).toContain("│ ⣾ t-1")
    expect(head(cardOf(TicketPhase.ToMerge({ place: 1 })))).toContain("│ ◼ t-1")
    expect(head(cardOf(TicketPhase.Merging({ step: "rebase" })))).toContain("│ ◆ t-1")
    expect(head(cardOf(working, states(WS.Idle({ at: now }))))).toContain("│ • t-1")
    sameLook(lookOf(drawn(cardOf(TicketPhase.ToMerge({ place: 1 }))), "◼"), theme.styles.toMerge)
    sameLook(lookOf(drawn(cardOf(working, states(WS.Idle({ at: now })))), "•"), theme.styles.done)
  })

  test("a merge names its step, with no ▸", () => {
    expect(textOf(drawn(cardOf(TicketPhase.Merging({ step: "check" }))))).toMatchInlineSnapshot(`
      "
      ╭────────────────────────────────────────────────╮
      │ ◆ t-1  merging  1m07s                          │
      │   Title of t-1                                 │
      │   running the check on batch/2026-10-20        │
      ╰────────────────────────────────────────────────╯
      "
    `)
  })

  test("a worker waiting for you is framed needsYou; one whose turn ended, frame", () => {
    const waiting = drawn(cardOf(working, { requests: [permission("r1", "t-1")] }))
    sameLook(lookOf(waiting, "╭────────────────────────────────────────────────╮"), {
      ...roleLook(theme, "needsYou"),
    })
    const idle = drawn(cardOf(working, states(WS.Idle({ at: now }))))
    sameLook(lookOf(idle, "╭────────────────────────────────────────────────╮"), {
      fg: theme.rgba("frame"),
      bg: undefined,
      attributes: 0,
    })
  })

  test("steered beside the status, emphasis", () => {
    const lines = drawn(cardOf(working, { ...states(WS.Idle({ at: now })), steered: true }))
    expect(textOf(lines).split("\n")[2]).toBe("│ • t-1  done  steered  1m07s                    │")
    sameLook(lookOf(lines, "steered"), roleLook(theme, "emphasis"))
  })

  test("a denied call on the action line, notice", () => {
    const lines = drawn(
      cardOf(working, {
        ...states(WS.Working({ doing: "working" })),
        actions: new Map([
          ["t-1", { text: "Bash(rm -rf build) denied by the classifier", denied: true }],
        ]),
      }),
      false,
      60,
    )
    sameLook(lookOf(lines, "▸ Bash(rm -rf build) denied by the classifier"), theme.styles.deferred)
  })

  test("the highlight keeps the frame's colour, bold, in the heavy border style", () => {
    const lines = drawn(cardOf(working, states(WS.Working({ doing: "testing" }))), true, 30)
    expect(textOf(lines)).toMatchInlineSnapshot(`
      "
      ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
      ┃ ⣾ t-1  testing  1m07s      ┃
      ┃   Title of t-1             ┃
      ┃                            ┃
      ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
      "
    `)
    sameLook(lookOf(lines, "┃"), roleLook(theme, "live", true))
  })

  test("the box with no worker: picking the next ticket…, or stopping…", () => {
    expect(textOf(idleBox(false, theme, spin, 40))).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────╮
      │ ⣾ picking the next ticket…           │
      ╰──────────────────────────────────────╯
      "
    `)
    const stopping = idleBox(true, theme, spin, 40)
    expect(textOf(stopping)).toContain("│ ⣾ stopping…")
    sameLook(lookOf(stopping, "stopping…"), theme.styles.dim)
    sameLook(lookOf(stopping, "⣾"), roleLook(theme, "live"))
  })

  test("elapsed times", () => {
    expect([0, 42_000, 67_000, 391_000, 3_900_000].map(elapsed)).toEqual([
      "0s",
      "42s",
      "1m07s",
      "6m31s",
      "1h05m",
    ])
  })

  test("a card is as wide as it is given, whatever its title and action say", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 300 }),
        fc.string({ unit: "grapheme", maxLength: 300 }),
        fc.boolean(),
        fc.integer({ min: 10, max: 160 }),
        (title, action, denied, width) => {
          const card = viewOf([{ ticket: "t-1", title, phase: working, worker: 1 }], {
            actions: new Map([["t-1", { text: action, denied }]]),
          }).cards[0]
          if (card === undefined) return false
          const lines = cardLines(card, theme, { now, spin, width, inside: 3, highlighted: false })
          return lines.every(
            (line) => widthOf(line) === width && line.every((s) => !/\p{Cc}/u.test(s.text)),
          )
        },
      ),
    )
  })
})

const value = (
  view: RunView,
  options: { readonly clock?: () => number; readonly commands?: Commands } = {},
): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: options.commands ?? Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: options.clock ?? (() => now),
})

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((_, i, all) => i < all.length - 1 || all[i] !== "")

/** The spinner's frame the dashboard draws at `now`. */
const turned = spinnerAt(now)

/** The lines from `Current` to the hint, the blank ones left out. */
const currentOf = (frame: Frame): string => {
  const lines = linesOf(frame)
  const from = lines.findIndex((line) => line.trim() === "Current")
  return `\n${lines
    .slice(from)
    .filter((line) => line !== "")
    .join("\n")}\n`
}

const draw = (view: RunView, size: Size) => renderFrame(<Root value={value(view)} />, size)

const four: ReadonlyArray<Ticket> = [
  { ticket: "tut-kco", phase: TicketPhase.Merging({ step: "fast-forward" }), worker: 1 },
  { ticket: "tut-zq4", phase: working, worker: 2 },
  { ticket: "tut-9a1", phase: TicketPhase.ToMerge({ place: 1 }), worker: 3 },
  { ticket: "tut-b7c", phase: working, worker: 4 },
]
const fourStates = new Map<string, WorkerState>([
  ["tut-zq4", WS.Working({ doing: "testing" })],
  ["tut-b7c", WS.Idle({ at: now })],
])
const fourActions = new Map([["tut-zq4", { text: "Bash(scripts/check-fast.sh)", denied: false }]])

describe("the Current section", () => {
  test("two to a row from 120 columns, every card as tall as the tallest", async () => {
    const view = viewOf(four, { workers: fourStates, actions: fourActions })
    expect(currentOf(await draw(view, { width: 120, height: 40 }))).toMatchInlineSnapshot(`
      "
        Current
      ╭──────────────────────────────────────────────────────────╮╭──────────────────────────────────────────────────────────╮
      │ ◆ tut-kco  merging  1m07s                                ││ ⣯ tut-zq4  testing  1m07s                                │
      │   Title of tut-kco                                       ││   Title of tut-zq4                                       │
      │   merging into batch/2026-10-20                          ││   ▸ Bash(scripts/check-fast.sh)                          │
      ╰──────────────────────────────────────────────────────────╯╰──────────────────────────────────────────────────────────╯
      ╭──────────────────────────────────────────────────────────╮╭──────────────────────────────────────────────────────────╮
      │ ◼ tut-9a1  to merge (1st)  1m07s                         ││ • tut-b7c  done  1m07s                                   │
      │   Title of tut-9a1                                       ││   Title of tut-b7c                                       │
      │                                                          ││                                                          │
      ╰──────────────────────────────────────────────────────────╯╰──────────────────────────────────────────────────────────╯
        Tab select · Enter open · s stop after current · ? keys
      "
    `)
  })

  test("one to a row below 120 columns", async () => {
    const view = viewOf(four.slice(0, 2), { workers: fourStates, actions: fourActions })
    expect(currentOf(await draw(view, { width: 80, height: 40 }))).toMatchInlineSnapshot(`
      "
        Current
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ ◆ tut-kco  merging  1m07s                                                    │
      │   Title of tut-kco                                                           │
      │   merging into batch/2026-10-20                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ ⣯ tut-zq4  testing  1m07s                                                    │
      │   Title of tut-zq4                                                           │
      │   ▸ Bash(scripts/check-fast.sh)                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯
        Tab select · Enter open · s stop after current · ? keys
      "
    `)
  })

  test("one line a card, in one box, when the pane can't hold a card each", async () => {
    const view = viewOf(four, {
      workers: fourStates,
      actions: fourActions,
      requests: [permission("r1", "tut-b7c")],
    })
    expect(layoutOf(view.cards, 80, 12)._tag).toBe("Compact")
    expect(layoutOf(view.cards, 80, 22)._tag).toBe("Cards")
    expect(currentOf(await draw(view, { width: 80, height: 24 }))).toMatchInlineSnapshot(`
      "
        Current
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ ◆ tut-kco  merging         1m07s  Title of tut-kco                           │
      │ ⣯ tut-zq4  testing         1m07s  Title of tut-zq4                           │
      │ ◼ tut-9a1  to merge (1st)  1m07s  Title of tut-9a1                           │
      ┃ • tut-b7c  ■ allow?        1m07s  Title of tut-b7c                           │
      ╰──────────────────────────────────────────────────────────────────────────────╯
        Tab select · Enter open · s stop after current · ? keys
      "
    `)
    // The card of the oldest request is highlighted, with none chosen (§ 4.5). Any worker in the
    // box waiting for you frames it needsYou.
    const lines = compactLines(view.cards, theme, { now, spin, width: 80, highlighted: "tut-zq4" })
    sameLook(lookOf(lines, `╭${"─".repeat(78)}╮`), roleLook(theme, "needsYou"))
    expect(lines[2]?.[0]?.text).toBe("┃")
  })

  test("the dashboard keeps it a full card for each of up to 6 workers, a line each for more", () => {
    // Its label, and 5 lines a card: a row a card, or two to a row from 120 columns.
    expect([0, 1, 3, 6, 8, 16].map((slots) => keptLines(80, slots, 0))).toEqual([
      6, 6, 16, 31, 31, 31,
    ])
    // 16 workers want a line each, its label and its frame: 19.
    expect([0, 1, 3, 6, 8, 16].map((slots) => keptLines(120, slots, 0))).toEqual([
      6, 6, 11, 16, 16, 19,
    ])
  })

  test("six workers keep their full cards in a pane that holds them; the table takes the rest", async () => {
    const six: ReadonlyArray<Ticket> = [1, 2, 3, 4, 5, 6].map((worker) => ({
      ticket: `tut-${worker}`,
      phase: working,
      worker,
    }))
    const actions = new Map(
      six.map((t) => [t.ticket, { text: "Bash(scripts/check-fast.sh)", denied: false }]),
    )
    const view = viewOf(six, { actions, concurrency: 6 })
    for (const size of [
      { width: 80, height: 50 },
      { width: 120, height: 32 },
    ]) {
      const lines = linesOf(await draw(view, size))
      // A card's title has a line of its own, where the compact box has it on the card's line.
      expect(lines.flatMap((line) => line.match(/│ {3}Title of tut-/g) ?? [])).toHaveLength(6)
      const tickets = lines.findIndex((line) => line === "  Tickets")
      const current = lines.findIndex((line) => line === "  Current")
      // The label, the frame and 6 blank rows, the tickets Current shows left out; 3 at 120×32.
      expect(current - tickets).toBe(size.width === 80 ? 9 : 6)
    }
  })

  test("the cards keep their order as workers finish; a new one takes the first gap", async () => {
    const all: ReadonlyArray<Ticket> = [
      { ticket: "a", phase: working, worker: 1 },
      { ticket: "b", phase: working, worker: 2 },
      { ticket: "c", phase: working, worker: 3 },
    ]
    const heads = async (view: RunView) =>
      linesOf(await draw(view, { width: 80, height: 40 }))
        .filter((line) => /^│ \S [a-d] {2}/.test(line))
        .map((line) => line.slice(2, 5))
    expect(await heads(viewOf(all))).toEqual([`${turned} a`, `${turned} b`, `${turned} c`])
    const merged = TicketPhase.Done({ outcome: Outcome.Merged({ commit: "abc1234" }) })
    const finished: ReadonlyArray<Ticket> = all.map((t) =>
      t.ticket === "a" ? { ...t, phase: merged, worker: null } : t,
    )
    expect(await heads(viewOf(finished))).toEqual([`${turned} b`, `${turned} c`])
    const next: ReadonlyArray<Ticket> = [...finished, { ticket: "d", phase: working, worker: 1 }]
    expect(await heads(viewOf(next))).toEqual([`${turned} d`, `${turned} b`, `${turned} c`])
  })

  test("with no worker, the box says the run is picking the next ticket, or stopping", async () => {
    expect(currentOf(await draw(viewOf([]), { width: 80, height: 24 }))).toContain(
      `│ ${turned} picking the next ticket…`,
    )
    expect(
      currentOf(await draw(viewOf([], { stopping: true }), { width: 80, height: 24 })),
    ).toContain(`│ ${turned} stopping…`)
  })
})

describe("the spinner", () => {
  test("Dot's frames, ten a second, from the shell's clock", () => {
    expect(spinnerFrames.join(" ")).toBe("⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷")
    expect([0, 99, 100, 250, 799, 800].map(spinnerAt)).toEqual(["⣾", "⣾", "⣽", "⣻", "⣷", "⣾"])
  })

  test("turns as the clock moves, and stands still with it", async () => {
    let time = 0
    const view = viewOf([{ ticket: "a", phase: working, worker: 1 }])
    await withRender(
      <Root value={value(view, { clock: () => time })} />,
      { width: 80, height: 24 },
      async (rendered) => {
        const mark = async () =>
          linesOf(await rendered.capture()).find((line) => /^│ \S a {2}/.test(line))?.[2]
        expect(await mark()).toBe("⣾")
        time = 300
        await rendered.input(() => new Promise((done) => setTimeout(done, 250)))
        expect(await mark()).toBe("⢿")
        await rendered.input(() => new Promise((done) => setTimeout(done, 250)))
        expect(await mark()).toBe("⢿")
      },
    )
  })
})

describe("opening a worker", () => {
  const view = viewOf(four, { workers: fourStates, actions: fourActions })
  const taken = (commands: Commands) => Effect.runSync(Queue.takeAll(commands))

  test("a click on a card, or Enter on the highlighted one; no number opens one", async () => {
    const commands = Effect.runSync(makeCommands)
    await withRender(
      <Root value={value(view, { commands })} />,
      { width: 120, height: 40 },
      async (rendered) => {
        const lines = linesOf(await rendered.capture())
        const y = lines.findIndex((line) => line.includes("◼ tut-9a1"))
        await rendered.input((setup) => setup.mockMouse.click(10, y))
        await rendered.input((setup) => setup.mockMouse.click(70, y))
        expect(taken(commands)).toEqual([
          UiCommand.OpenWorker({ ticket: "tut-9a1" }),
          UiCommand.OpenWorker({ ticket: "tut-b7c" }),
        ])
        await rendered.input((setup) => {
          setup.mockInput.pressTab()
          setup.mockInput.pressTab()
          setup.mockInput.pressEnter()
        })
        const highlighted = linesOf(await rendered.capture())
        expect(highlighted.some((line) => line.includes(`┃ ${turned} tut-zq4`))).toBe(true)
        await rendered.input((setup) => {
          setup.mockInput.pressTab({ shift: true })
          setup.mockInput.pressEnter()
          setup.mockInput.pressKey("4")
          setup.mockInput.pressKey("7")
        })
        expect(taken(commands)).toEqual([
          UiCommand.OpenWorker({ ticket: "tut-zq4" }),
          UiCommand.OpenWorker({ ticket: "tut-kco" }),
        ])
      },
    )
  })

  test("the highlight moves round, and from none to the first or the last", () => {
    expect(moveHighlight(view.cards, null, 1)).toBe("tut-kco")
    expect(moveHighlight(view.cards, null, -1)).toBe("tut-b7c")
    expect(moveHighlight(view.cards, "tut-b7c", 1)).toBe("tut-kco")
    expect(moveHighlight(view.cards, "tut-kco", -1)).toBe("tut-b7c")
    expect(moveHighlight([], null, 1)).toBe(null)
  })
})

describe("the wind-down line", () => {
  test("a ■ for each ticket, coloured by its phase", () => {
    const view = viewOf(
      [
        { ticket: "a", phase: working, worker: 1 },
        { ticket: "b", phase: TicketPhase.Merging({ step: "check" }), worker: 2 },
        {
          ticket: "c",
          phase: TicketPhase.Done({ outcome: Outcome.Merged({ commit: "abc1234" }) }),
          worker: null,
        },
        { ticket: "d", phase: TicketPhase.Review({ why: "OFF_BRANCH" }), worker: null },
        { ticket: "e", phase: TicketPhase.Waiting({ for: "x" }), worker: null },
      ],
      { windDown: { since: began, tickets: ["a", "b", "c", "d", "e"] } },
    )
    if (view.windDown === null) throw new Error("no wind-down")
    const line = windDownSegments(view.windDown, theme, 80)
    expect(line.map((s) => s.text).join("")).toBe(
      "  ■ ■ ■ ■ ■  Winding down · 2 running, no new tickets",
    )
    const marks = line.filter((s) => s.text === "■").map((s) => s.look)
    const looks = [
      theme.styles.windDown,
      theme.styles.windDown,
      theme.styles.done,
      roleLook(theme, "needsYou"),
      theme.styles.dim,
    ]
    looks.forEach((look, i) => {
      const mark = marks[i]
      if (mark === undefined || mark === null) throw new Error("no mark")
      sameLook(mark, look)
    })
    sameLook(lookOf([line], "Winding down"), roleLook(theme, "windingDown", true))
    sameLook(lookOf([line], " · 2 running, no new tickets"), theme.styles.dim)
  })

  test("drawn above the hint while the run winds down", async () => {
    const view = viewOf([{ ticket: "a", phase: working, worker: 1 }], {
      windDown: { since: began, tickets: ["a"] },
    })
    const lines = linesOf(await draw(view, { width: 80, height: 24 }))
    expect(lines.slice(-2)).toEqual([
      "  ■  Winding down · 1 running, no new tickets",
      "  Tab select · Enter open · s keep taking tickets · ? keys",
    ])
  })
})

describe("the hint and the key help", () => {
  test("the hint's keys emphasis bold, their words and the dots faint", () => {
    const line = hintSegments(viewOf(four).hint, theme, 120)
    expect(line.map((s) => s.text).join("")).toBe(
      "  Tab select · Enter open · s stop after current · ? keys",
    )
    sameLook(lookOf([line], "Tab"), theme.styles.key)
    sameLook(lookOf([line], " select"), theme.styles.dim)
    sameLook(lookOf([line], " · "), theme.styles.dim)
  })

  test("? opens the key help over the dashboard, and Esc or ? closes it", async () => {
    const commands = Effect.runSync(makeCommands)
    await withRender(
      <Root value={value(viewOf(four), { commands })} />,
      { width: 100, height: 40 },
      async (rendered) => {
        const shows = async () =>
          linesOf(await rendered.capture()).some((line) => line.includes("these keys"))
        expect(await shows()).toBe(false)
        await rendered.input((setup) => setup.mockInput.typeText("?"))
        expect(await shows()).toBe(true)
        // Keys under the box do nothing while it is open.
        await rendered.input((setup) => setup.mockInput.pressEnter())
        expect(Effect.runSync(Queue.size(commands))).toBe(0)
        // A lone Esc reaches the keys once the parser has waited for more of a sequence.
        await rendered.input(pressEscape)
        expect(await shows()).toBe(false)
        await rendered.input((setup) => setup.mockInput.typeText("?"))
        await rendered.input((setup) => setup.mockInput.typeText("?"))
        expect(await shows()).toBe(false)
      },
    )
  })

  test("the key help lists the dashboard's keys", () => {
    expect(textOf(keyHelpLines(theme, 100))).toMatchInlineSnapshot(`
      "
      ╭─────────────────────────────────────────────────────────────────────────────╮
      │ Keys                                                                        │
      │                                                                             │
      │ Tab, Shift+Tab, arrows  move the highlight between cards                    │
      │ Enter, a click          open the highlighted card; press the focused button │
      │ Esc                     close an open box                                   │
      │ d, Shift+D              deny the request; deny with a reason                │
      │ a                       allow the request, unless it opens on Deny          │
      │ r                       allow for this run                                  │
      │ 1–4 in a question       pick an option                                      │
      │ s                       stop after current, or keep taking tickets          │
      │ Ctrl+C                  quit: stop after current, or quit now               │
      │ a drag                  select text and copy it                             │
      │ ?                       these keys                                          │
      │                                                                             │
      │ Esc close                                                                   │
      ╰─────────────────────────────────────────────────────────────────────────────╯
      "
    `)
  })
})

describe("the latest actions", () => {
  const assistant = (id: string, command: string) =>
    ({
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "s-1",
      uuid: `u-${id}`,
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    }) as unknown as SDKMessage

  test("are read from Transcripts for each ticket with a worker, every actionPoll", async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const transcripts = yield* Transcripts
        for (const cause of [Cause.Ready(), Cause.Dispatched()]) {
          const next = yield* ledger.transition("t-1", cause, { title: "One" })
          if (Result.isFailure(next)) throw new Error("invalid transition")
        }
        yield* ledger.transition("t-2", Cause.Ready(), { title: "Queued" })
        yield* transcripts.record("t-1", "s-1", assistant("call-1", "scripts/check-fast.sh"))
        yield* transcripts.record("t-2", "s-2", assistant("call-9", "ls"))
        const actions = yield* latestActions
        const fiber = yield* Stream.take(actions, 2).pipe(Stream.runCollect, Effect.forkScoped)
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        yield* transcripts.record("t-1", "s-1", assistant("call-2", "git status"))
        yield* TestClock.adjust(actionPoll)
        return Array.from(yield* Fiber.join(fiber), (each) => [...each])
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(ledgerLayer(), transcriptsLayer()).pipe(
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )
    // t-2 is only queued: it has no worker, and no card to show an action on.
    expect(seen).toEqual([
      [["t-1", { text: "Bash(scripts/check-fast.sh)", denied: false }]],
      [["t-1", { text: "Bash(git status)", denied: false }]],
    ])
  })
})
