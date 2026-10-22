// The UI's colours and layouts (§ 7.11, § 13 "UI tests", § 14 M3): scenes drawn at fixed sizes, in
// the light and the dark variant. Each state's cells carry the role § 7.11 gives it, in the
// `orchestra` scheme's colours as § 7.11's tables give them; a scheme that changes one role changes
// only that role's cells; NO_COLOR leaves every glyph, word, bold and faint in place, in the
// terminal's own colours; and every colour drawn is a role's. Then a snapshot of each layout: narrow,
// 120 columns, the smallest size, attention cards (with defaultToNo), the end-of-run box, the usage
// banner, wind-down, and one per phase.
import { describe, expect, test } from "bun:test"
import type { PermissionUpdate, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { type RGBA, TextAttributes } from "@opentui/core"
import { Effect } from "effect"
import { type ReactNode, useEffect } from "react"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies, type WindDown } from "../src/run/ledger.ts"
import { hasCard, Outcome, type PhaseTag, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { App, Root } from "../src/ui/App.tsx"
import { useInput } from "../src/ui/keys.ts"
import { TicketCount } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import {
  type Appearance,
  makeTheme,
  orchestra,
  type Role,
  roles,
  type Scheme,
  type Theme,
} from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, type Size, withRender } from "./render.ts"

/** § 7.11's tables: each role's colour in the `orchestra` scheme, light and dark. */
const orchestraColours: { readonly [R in Role]: readonly [light: string, dark: string] } = {
  live: ["#0E7490", "#22D3EE"],
  done: ["#15803D", "#4ADE80"],
  notice: ["#A16207", "#FACC15"],
  needsYou: ["#B91C1C", "#F87171"],
  windingDown: ["#C2410C", "#FB923C"],
  frame: ["#9CA3AF", "#6B7280"],
  organ: ["#6D28D9", "#A78BFA"],
  organText: ["#7C3AED", "#C4B5FD"],
  toMerge: ["#1D4ED8", "#60A5FA"],
  merging: ["#BE185D", "#F472B6"],
  emphasis: ["#374151", "#E5E7EB"],
  pill: ["#7D56F4", "#7D56F4"],
  pillText: ["#FAFAFA", "#FAFAFA"],
  heading1: ["#6D28D9", "#A78BFA"],
  heading2: ["#0E7490", "#22D3EE"],
  heading3: ["#374151", "#E5E7EB"],
  code: ["#BE185D", "#F472B6"],
  link: ["#1D4ED8", "#60A5FA"],
  added: ["#15803D", "#4ADE80"],
  removed: ["#B91C1C", "#F87171"],
  selection: ["#7D56F4", "#7D56F4"],
  selectionText: ["#FAFAFA", "#FAFAFA"],
  formText: ["ansi:235", "ansi:252"],
  formTitle: ["#5A56E0", "#7571F9"],
  formAccent: ["#F780E2", "#F780E2"],
  formAccentText: ["#FFFDF5", "#FFFDF5"],
  formSelected: ["#02BA84", "#02BF87"],
  formSelectedMark: ["#02CF92", "#02A877"],
  formError: ["#FF4672", "#ED567A"],
  formMuted: ["default", "ansi:248"],
  formFaint: ["default", "ansi:245"],
  formHelpKey: ["#909090", "#9A9A9A"],
  formHelpDesc: ["#B2B2B2", "#7A7A7A"],
  formHelpSeparator: ["#DDDADA", "#5A5A5A"],
  formButton: ["ansi:252", "ansi:237"],
  formPlaceholder: ["ansi:248", "ansi:243"],
  formFrame: ["ansi:238", "ansi:238"],
}

const variants: ReadonlyArray<Appearance> = ["light", "dark"]

const themeIn =
  (scheme: Scheme, noColor = false) =>
  (appearance: Appearance): Theme =>
    makeTheme(scheme, { appearance, depth: "truecolor", noColor })

// Local times, as the banners' clock shows them.
const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + (18 * 60 + 40) * 1000
const resets = new Date(2026, 9, 20, 14, 5).getTime()

interface Ticket {
  readonly ticket: string
  readonly title?: string
  readonly phase: TicketPhase
  /** The worker's number, for a ticket with a card. */
  readonly worker?: number
  /** Its row; none for a ticket queued or held back. */
  readonly row?: number | null
  readonly steered?: boolean
  readonly since?: number
}

const entryOf = (t: Ticket, i: number): Entry => ({
  ticket: t.ticket,
  title: t.title ?? `Title of ${t.ticket}`,
  phase: t.phase,
  since: t.since ?? began,
  worker: t.worker ?? null,
  row: t.row === undefined ? i : t.row,
  rechecking: false,
  steered: t.steered ?? false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView for `tickets`, taken up in that order, on batch/2026-10-20 with 3 workers. */
const viewOf = (
  tickets: ReadonlyArray<Ticket>,
  over: {
    readonly status?: Partial<Status>
    readonly workers?: ReadonlyArray<readonly [string, WorkerState]>
    readonly requests?: ReadonlyArray<AttentionRequest>
    readonly actions?: ReadonlyArray<
      readonly [string, { readonly text: string; readonly denied: boolean }]
    >
    readonly windDown?: WindDown
  } = {},
): RunView =>
  project({
    ledger: {
      tickets: new Map(tickets.map((t, i) => [t.ticket, entryOf(t, i)])),
      rows: tickets.filter((t) => t.row !== null).length,
      windDown: over.windDown ?? null,
      bugs: [],
    },
    workers: new Map(over.workers ?? []),
    requests: over.requests ?? [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch/2026-10-20",
      began,
      concurrency: 3,
      ...over.status,
    },
    actions: new Map(over.actions ?? []),
  })

const working = (activity: Parameters<typeof TicketPhase.Working>[0]["activity"]) =>
  TicketPhase.Working({ activity })
const merged = (commit: string) => TicketPhase.Done({ outcome: Outcome.Merged({ commit }) })

const permission = (
  id: string,
  ticket: string,
  over: Partial<AttentionRequest> & { readonly suggestions?: ReadonlyArray<PermissionUpdate> } = {},
): AttentionRequest => {
  const { suggestions, ...rest } = over
  return {
    id,
    ticket,
    kind: {
      _tag: "Permission",
      tool: "Bash",
      input: { command: "rm -rf build" },
      suggestions: suggestions ?? [],
      summary: "rm -rf build",
    },
    displayName: "Bash",
    description: "Remove the build cache",
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    createdAt: began,
    ...rest,
  }
}

const question = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "Which migration?",
        options: [{ label: "Keep the old" }, { label: "Write a new" }],
        multiSelect: false,
      },
    ],
    input: {},
  },
  displayName: "AskUserQuestion",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began + 1,
})

// A worker's transcript, for its view: SDK messages with only the fields tutti reads.
const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage
const assistant = (content: ReadonlyArray<unknown>) =>
  sdk({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null })
const said = (words: string) => assistant([{ type: "text", text: words }])
const call = (id: string, name: string, input: unknown) =>
  assistant([{ type: "tool_use", id, name, input }])
const answered = (id: string, content: unknown, error = false) =>
  sdk({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: error }],
    },
    parent_tool_use_id: null,
  })

const transcript: ReadonlyArray<Item> = [
  said("I'll read the undo module first."),
  call("read-1", "Read", { file_path: "internal/history/undo.ts" }),
  answered("read-1", "const stack = []"),
  call("edit-1", "Edit", {
    file_path: "internal/history/undo.ts",
    old_string: "const stack = []\n",
    new_string: "const stack: Array<Group> = []\nexport const group = () => {}\n",
  }),
  answered("edit-1", "The file internal/history/undo.ts has been updated."),
  call("bash-1", "Bash", { command: "bun x nope" }),
  answered("bash-1", "Exit code 1\nerror: nope not found", true),
  said(
    "# Undone\n\n## Groups\n\n### Notes\n\nThe stack records `edits` now. See [the spec](https://x.test/spec).\n\nA **strong** word.\n\n---\n\n> quoted",
  ),
  sdk({ type: "result", subtype: "success", is_error: false }),
].map((message, i) => ({
  v: transcriptVersion,
  seq: i + 1,
  session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
  time: "2026-10-20T13:00:00.000Z",
  message,
}))

/** A feed that gives every worker `items`. */
const feedOf = (items: ReadonlyArray<Item>): TranscriptFeed => ({
  open: (): OpenTranscript => ({
    state: external<TranscriptState>({ ...emptyTranscript, window: windowOf(items) }),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
})

/** Shows a toast as the scene opens: a faint one, or a failure's. */
const Toast = ({ text, failure }: { readonly text: string; readonly failure: boolean }) => {
  const { toasts } = useInput()
  useEffect(() => {
    toasts.show(text, { failure })
  }, [toasts, text, failure])
  return null
}

/** The start question, answering nothing. */
const startQuestion = (theme: Theme) => (
  <StartQuestion
    theme={theme}
    count={TicketCount.Ready({ n: 3 })}
    answer={() => {}}
    cancel={() => {}}
  />
)

/** What a cell is drawn in, as § 7.11 gives it: a role, or the terminal's own text colour. */
interface Look {
  readonly fg: Role | "text"
  readonly bg: Role | null
  readonly bold: boolean
  readonly faint: boolean
}

const look = (
  fg: Role | "text",
  ...more: ReadonlyArray<"bold" | "faint" | { readonly bg: Role }>
): Look => ({
  fg,
  bg: more.reduce<Role | null>((bg, each) => (typeof each === "object" ? each.bg : bg), null),
  bold: more.includes("bold"),
  faint: more.includes("faint"),
})

/** `text`'s first cells in the frame: on the first line holding `on` (`text` when left out), from it. */
interface Where {
  readonly text: string
  readonly on?: string
  /** Which of the occurrences from there, counting from 0. */
  readonly nth?: number
}

/** A scene: what is drawn, at a fixed size, and what each of its states is drawn in. */
interface Scene {
  readonly name: string
  readonly size: Size
  readonly view: RunView
  readonly screen?: Screen
  readonly transcripts?: TranscriptFeed
  /** The tree under Root, in the theme drawn; the App when left out. */
  readonly children?: (theme: Theme) => ReactNode
  /** Keys pressed once it is drawn. */
  readonly keys?: ReadonlyArray<string>
  /** A drag with the mouse once it is drawn, from x, y to x, y: a selection. */
  readonly drag?: readonly [number, number, number, number]
  /** What the frame holds once drawn: text, or a test of it (Markdown is highlighted later). */
  readonly ready: string | ((frame: Frame) => boolean)
  readonly checks: ReadonlyArray<readonly [Where | string, Look]>
}

/** The cells of a frame, line by line: each character with its colours and attributes. */
interface Cell {
  readonly char: string
  readonly fg: RGBA
  readonly bg: RGBA
  readonly attributes: number
}

const cellsOf = (frame: Frame): ReadonlyArray<ReadonlyArray<Cell>> =>
  frame.spans.lines.map((line) =>
    line.spans.flatMap((span) =>
      Array.from(span.text).map((char) => ({
        char,
        fg: span.fg,
        bg: span.bg,
        attributes: span.attributes,
      })),
    ),
  )

/** The cells `where` names. */
const find = (frame: Frame, where: Where): ReadonlyArray<Cell> => {
  const want = Array.from(where.text)
  const on = Array.from(where.on ?? where.text)
  const at = (chars: ReadonlyArray<string>, sought: ReadonlyArray<string>, from: number) => {
    for (let i = from; i + sought.length <= chars.length; i++) {
      if (sought.every((char, j) => chars[i + j] === char)) return i
    }
    return -1
  }
  for (const line of cellsOf(frame)) {
    const chars = line.map((cell) => cell.char)
    let from = at(chars, on, 0)
    if (from === -1) continue
    for (let n = 0; ; n++) {
      from = at(chars, want, from)
      if (from === -1) break
      if (n === (where.nth ?? 0)) return line.slice(from, from + want.length)
      from += 1
    }
  }
  throw new Error(`the frame doesn't hold ${JSON.stringify(where)}:\n${frame.chars}`)
}

/** A colour as § 7.11 writes it: `#RRGGBB`, `ansi:N` or `default`; how the frame records it. */
const recorded = (colour: string): string =>
  colour === "default"
    ? "default"
    : colour.startsWith("ansi:")
      ? `indexed ${colour.slice(5)}`
      : `rgb ${colour.toUpperCase()}`

/** How the frame records a cell's colour, as `recorded` writes one. */
const recordOf = (colour: RGBA): string => {
  switch (colour.intent) {
    case "default":
      return "default"
    case "indexed":
      return `indexed ${colour.slot}`
    case "rgb": {
      const [r, g, b, a] = colour.toInts()
      if (a === 0) return "none"
      const hex = [r, g, b].map((n) => n.toString(16).padStart(2, "0").toUpperCase()).join("")
      return `rgb #${hex}`
    }
  }
}

/** What a cell drawn in `look` records in `appearance`, the `orchestra` scheme's colours. */
const expected = (look: Look, appearance: Appearance) => {
  const variant = appearance === "light" ? 0 : 1
  return {
    fg: look.fg === "text" ? "default" : recorded(orchestraColours[look.fg][variant]),
    bg: look.bg === null ? "none" : recorded(orchestraColours[look.bg][variant]),
    bold: look.bold,
    faint: look.faint,
  }
}

/** What a cell is drawn in; behind it, the terminal's own background is none. */
const drawnAs = (cell: Cell) => ({
  fg: recordOf(cell.fg),
  bg: recordOf(cell.bg) === "default" ? "none" : recordOf(cell.bg),
  bold: (cell.attributes & TextAttributes.BOLD) !== 0,
  faint: (cell.attributes & TextAttributes.DIM) !== 0,
})

/** Presses `keys` as `mockInput` does, each drawn before the next. */
const press = async (rendered: Rendered, keys: ReadonlyArray<string>) => {
  for (const key of keys) {
    await rendered.input(async (setup) => {
      if (key === "ctrl+z") setup.mockInput.pressKey("z", { ctrl: true })
      else if (key === "down") setup.mockInput.pressArrow("down")
      else if (key === "enter") setup.mockInput.pressEnter()
      else await setup.mockInput.typeText(key)
    })
  }
}

/** How long a scene may take to be drawn, and a test that draws it a few times: a busy machine's. */
const readyWait = 20_000
const renderTime = 30_000

/** Whether the frame has the attributes `where` names: a sign Markdown has been highlighted. */
const drawnWith = (frame: Frame, where: Where, attribute: number): boolean => {
  try {
    return find(frame, where).every((cell) => (cell.attributes & attribute) !== 0)
  } catch {
    return false
  }
}

/** The worker view's transcript once its Markdown has been highlighted: its headings bold, … */
const highlighted = (frame: Frame): boolean =>
  drawnWith(frame, { text: "Notes" }, TextAttributes.BOLD) &&
  drawnWith(frame, { text: "strong" }, TextAttributes.BOLD) &&
  drawnWith(frame, { text: "quoted" }, TextAttributes.DIM)

/** Draws `scene` in `themeOf`'s theme, in `appearance`. */
const draw = (
  scene: Scene,
  themeOf: (appearance: Appearance) => Theme,
  appearance: Appearance,
): Promise<Frame> => {
  const value: ShellValue = {
    view: external(scene.view),
    screen: external<Screen>(scene.screen ?? Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>(appearance),
    themeOf,
    now: () => now,
    ...(scene.transcripts === undefined ? {} : { transcripts: scene.transcripts }),
  }
  const children = scene.children?.(themeOf(appearance))
  return withRender(<Root value={value}>{children}</Root>, scene.size, async (rendered) => {
    if (scene.keys !== undefined) await press(rendered, scene.keys)
    const drag = scene.drag
    if (drag !== undefined) await rendered.input((setup) => setup.mockMouse.drag(...drag))
    const ready = scene.ready
    const deadline = Date.now() + readyWait
    for (;;) {
      const frame = await rendered.capture()
      const drawn = typeof ready === "string" ? frame.chars.includes(ready) : ready(frame)
      if (drawn || Date.now() > deadline) return frame
      await Bun.sleep(20)
    }
  })
}

const where = (each: Where | string): Where => (typeof each === "string" ? { text: each } : each)

const illustratedTickets: ReadonlyArray<Ticket> = [
  { ticket: "tut-dwv", title: "Lay out the property panel", phase: merged("ffd6ce4a1b2c3") },
  {
    ticket: "tut-kco",
    title: "Open the property model",
    phase: TicketPhase.Merging({ step: "check" }),
    worker: 2,
  },
  {
    ticket: "tut-zq4",
    title: "Add an undo stack for property edits",
    phase: working("working"),
    worker: 1,
  },
  { ticket: "tut-9a1", title: "Remove the build cache", phase: working("working"), worker: 3 },
  {
    ticket: "tut-vzg",
    title: "Animate the timeline",
    phase: TicketPhase.Deferred({ why: "BAD_TICKET_ID" }),
  },
  { ticket: "tut-q1", phase: TicketPhase.Queued(), row: null },
  { ticket: "tut-q2", phase: TicketPhase.HeldBack({ why: "overlap" }), row: null },
]

/** The run § 7.2 illustrates: a merge, a worker testing, one asking, one set aside, a queue. */
const illustrated = viewOf(illustratedTickets, {
  status: {
    scope: "tut-8f2",
    usage: { utilization: 0.85, resetsAt: resets },
    unclosed: 16,
    verdicts: new Map([["tut-vzg", "environment · high · prompt never submitted"]]),
  },
  workers: [["tut-zq4", WS.Working({ doing: "testing" })]],
  requests: [permission("r1", "tut-9a1", { decisionReason: "outside the working directories" })],
  actions: [["tut-zq4", { text: "Bash(bun test)", denied: false }]],
})

/** One row for each of `phases`, as tut-1, tut-2, …, with no worker. */
const rowsOf = (phases: ReadonlyArray<TicketPhase>) =>
  viewOf(
    phases.map((phase, i) => ({ ticket: `tut-${i + 1}`, phase })),
    { status: { concurrency: 1 } },
  )

/** One card for each of `states`, on t-1, t-2, …, with no table. */
const cardsOf = (
  states: ReadonlyArray<readonly [TicketPhase, WorkerState | null]>,
  over: Parameters<typeof viewOf>[1] = {},
  steered: ReadonlyArray<string> = [],
) =>
  viewOf(
    states.map(([phase], i) => ({
      ticket: `t-${i + 1}`,
      phase,
      worker: i + 1,
      steered: steered.includes(`t-${i + 1}`),
    })),
    {
      ...over,
      status: { concurrency: states.length, ...over.status },
      workers: states.flatMap(([, state], i) => (state === null ? [] : [[`t-${i + 1}`, state]])),
    },
  )

/** The head line of `ticket`'s card: its ticket, then its status. */
const head = (ticket: string) => ` ${ticket}  `

const scenes: ReadonlyArray<Scene> = [
  {
    name: "the dashboard",
    size: { width: 120, height: 44 },
    view: illustrated,
    ready: "? keys",
    checks: [
      // The title line.
      [" tutti ", look("pillText", { bg: "pill" }, "bold")],
      ["0.1.0", look("text", "faint")],
      ["batch/2026-10-20 · 18m40s", look("text", "faint")],
      ["usage 85% · resets 14:05", look("notice")],
      // The totals strip.
      ["╭───", look("frame")],
      ["Completed", look("text", "faint")],
      ["✓ 1", look("done", "bold")],
      ["↷ 1", look("notice")],
      [{ text: "◆ 1", on: "↷ 1" }, look("organ", "bold")],
      [{ text: "1", on: "│ 1    ", nth: 0 }, look("needsYou", "bold")],
      [{ text: "2", on: "2 of 3" }, look("live", "bold")],
      [" of 3", look("text", "faint")],
      [" of 16", look("text", "faint")],
      [" · 1 held back", look("notice")],
      // The section labels and the tickets table.
      ["Tickets", look("emphasis", "bold")],
      ["Current", look("live", "bold")],
      ["✓ done", look("done", "bold")],
      ["tut-dwv", look("done", "bold")],
      ["ffd6ce4 merged into batch/2026-10-20", look("text", "faint")],
      // Beside Current, the table leaves out the tickets it shows (rows at work has their rows).
      ["Add an undo stack for property edits", look("text")],
      ["↷ deferred", look("notice")],
      ["◆ environment · high", look("organ", "bold")],
      // The cards: a worker testing, a merge, and one waiting for you, highlighted.
      [{ text: "│", on: "│ ⣾ tut-zq4" }, look("live")],
      [{ text: "⣾", on: "│ ⣾ tut-zq4" }, look("live", "bold")],
      [{ text: "tut-zq4", on: head("tut-zq4") }, look("live", "bold")],
      [{ text: "testing", on: head("tut-zq4") }, look("notice", "bold")],
      [{ text: "18m40s", on: head("tut-zq4") }, look("text", "faint")],
      ["▸ Bash(bun test)", look("text", "faint")],
      [{ text: "│", on: "│ ◆ tut-kco" }, look("frame")],
      [{ text: "◆", on: "│ ◆ tut-kco" }, look("merging", "bold")],
      [{ text: "merging", on: head("tut-kco") }, look("merging", "bold")],
      ["running the check on batch/2026-10-20", look("text", "faint")],
      ["┏━━", look("needsYou", "bold")],
      [{ text: "┃", on: "┃ • tut-9a1" }, look("needsYou", "bold")],
      ["permission — waiting for you", look("needsYou", "bold")],
      ["Bash: Remove the build cache", look("text")],
      [{ text: "rm -rf build", on: "┃   rm -rf" }, look("text", "faint")],
      ["outside the working directories", look("text", "faint")],
      ["[ Deny ]", look("formAccentText", { bg: "formAccent" })],
      ["[ Allow ]", look("formText", { bg: "formButton" })],
      // The hint.
      ["Tab", look("emphasis", "bold")],
      [" select", look("text", "faint")],
      [{ text: " · ", on: "Tab select" }, look("text", "faint")],
    ],
  },
  {
    name: "rows at work",
    size: { width: 120, height: 60 },
    view: rowsOf([
      working("editing"),
      working("reading"),
      working("subagent"),
      working("starting"),
      working("testing"),
      working("retrying"),
      working("limit"),
      working("answer"),
      TicketPhase.ToMerge({ place: 2 }),
      TicketPhase.Resolving({ attempt: 1 }),
    ]),
    ready: "picking",
    checks: [
      ["▶ editing", look("live", "bold")],
      ["▶ reading", look("live", "bold")],
      ["▶ subagent", look("live", "bold")],
      ["▶ starting", look("live", "bold")],
      ["▶ testing", look("notice", "bold")],
      ["▶ retrying", look("notice")],
      ["◷ limit", look("notice")],
      ["■ answer?", look("needsYou", "bold")],
      ["◼ to merge", look("toMerge")],
      ["⟳ resolving", look("notice")],
      ["tut-9", look("toMerge")],
      // The box with no worker.
      [{ text: "│", on: "│ ⣾ picking" }, look("frame")],
      [{ text: "⣾", on: "⣾ picking" }, look("live")],
      ["picking the next ticket…", look("text", "faint")],
    ],
  },
  {
    name: "rows set aside and done",
    size: { width: 120, height: 60 },
    view: rowsOf([
      TicketPhase.Fixing({ attempt: 1, afterResolution: false }),
      TicketPhase.Done({ outcome: Outcome.NoChange() }),
      TicketPhase.Asked({ question: "q-1" }),
      TicketPhase.Waiting({ for: "tut-1" }),
      TicketPhase.Review({ why: "OFF_BRANCH" }),
      TicketPhase.Blocked({ why: "MERGE_CONFLICT" }),
      TicketPhase.Stopped({ why: "PAUSED" }),
      working("working"),
      TicketPhase.Merging({ step: "check" }),
      working("allow"),
    ]),
    ready: "picking",
    checks: [
      ["▶ working", look("live", "bold")],
      ["◆ merging", look("merging", "bold")],
      ["■ allow?", look("needsYou", "bold")],
      ["Title of tut-8", look("text")],
      ["⟳ fixing", look("notice")],
      ["no change to merge", look("text", "faint")],
      ["? for you", look("needsYou", "bold")],
      ["◷ waiting", look("text", "faint")],
      ["tut-4", look("text", "faint")],
      ["! review", look("notice")],
      ["■ blocked", look("needsYou", "bold")],
      ["■ stopped", look("needsYou", "bold")],
    ],
  },
  {
    name: "earlier tickets",
    size: { width: 80, height: 24 },
    view: rowsOf(Array.from({ length: 9 }, (_, i) => merged(`c0ffee${i}abcdef`))),
    ready: "earlier tickets",
    checks: [
      ["+5", look("text", "faint")],
      ["earlier tickets, see the log", look("text", "faint")],
    ],
  },
  {
    name: "cards at work",
    size: { width: 120, height: 50 },
    view: cardsOf(
      [
        [working("working"), WS.Working({ doing: "editing" })],
        [working("working"), WS.Working({ doing: "reading" })],
        [working("working"), WS.Working({ doing: "subagent" })],
        [working("working"), WS.Retrying({ attempt: 3, max: 10, status: 529 })],
        [working("working"), WS.UsageLimited({ resetsAt: resets })],
        [TicketPhase.Resolving({ attempt: 1 }), null],
        [working("working"), WS.Working({ doing: "working" })],
      ],
      { actions: [["t-1", { text: "Bash(rm -rf build) denied by the classifier", denied: true }]] },
    ),
    ready: "editing",
    checks: [
      [{ text: "editing", on: head("t-1") }, look("live", "bold")],
      [{ text: "reading", on: head("t-2") }, look("live", "bold")],
      [{ text: "subagent", on: head("t-3") }, look("live", "bold")],
      ["retrying 3/10 (529)", look("notice")],
      ["usage limit · resets 14:05", look("notice")],
      [{ text: "resolving", on: head("t-6") }, look("notice")],
      [{ text: "working", on: head("t-7") }, look("live", "bold")],
      ["▸ Bash(rm -rf build) denied by the classifier", look("notice")],
    ],
  },
  {
    name: "cards at rest",
    size: { width: 120, height: 50 },
    view: cardsOf(
      [
        [working("working"), WS.Idle({ at: began })],
        [working("working"), WS.Failed({ at: began, error: "", interrupted: true })],
        [working("working"), WS.Failed({ at: began, error: "x", interrupted: false })],
        [working("working"), WS.Gone({ why: "exited" })],
        [TicketPhase.ToMerge({ place: 2 }), null],
        [TicketPhase.Fixing({ attempt: 1, afterResolution: false }), null],
        [working("working"), WS.Idle({ at: began })],
      ],
      { requests: [question("q1", "t-7")] },
      ["t-1"],
    ),
    ready: "steered",
    checks: [
      [{ text: "•", on: "│ • t-1" }, look("done")],
      [{ text: "done", on: head("t-1") }, look("done")],
      ["steered", look("emphasis")],
      [{ text: "stopped", on: head("t-2") }, look("notice")],
      [{ text: "failed", on: head("t-3") }, look("needsYou")],
      [{ text: "gone", on: head("t-4") }, look("needsYou")],
      [{ text: "◼", on: "│ ◼ t-5" }, look("toMerge")],
      ["to merge (2nd)", look("toMerge")],
      ["fixing check", look("notice")],
      ["question — waiting for you", look("needsYou", "bold")],
      // The totals strip's zeros.
      [{ text: "0", on: "│ 0 " }, look("text", "faint")],
    ],
  },
  {
    name: "the title's states and the warning line",
    size: { width: 120, height: 24 },
    view: viewOf([], {
      status: {
        stopping: true,
        solo: { ticket: "tut-s1", running: true },
        usage: { utilization: 1, resetsAt: null },
        holds: [
          { word: "BLOCKED", resetsAt: null },
          { word: "USAGE_LIMIT", resetsAt: resets },
        ],
        warnings: ["colour scheme 'dusk' isn't used: it isn't found"],
      },
    }),
    ready: "BLOCKED",
    checks: [
      ["· stopping", look("needsYou", "bold")],
      ["· solo tut-s1 running", look("live", "bold")],
      ["usage 100%", look("notice", "bold")],
      ["BLOCKED", look("needsYou", "bold")],
      ["USAGE_LIMIT · resets 14:05", look("notice", "bold")],
      [" · held", look("windingDown")],
      [" ! colour scheme 'dusk' isn't used", look("notice")],
      ["stopping…", look("text", "faint")],
    ],
  },
  {
    name: "the solo ticket next",
    size: { width: 100, height: 24 },
    view: viewOf([], { status: { solo: { ticket: "tut-s1", running: false } } }),
    ready: "solo",
    checks: [["· solo tut-s1 next", look("notice")]],
  },
  {
    name: "wind-down",
    size: { width: 80, height: 24 },
    view: viewOf(
      [
        { ticket: "a", phase: working("working"), worker: 1 },
        { ticket: "b", phase: merged("abc1234") },
        { ticket: "c", phase: TicketPhase.Review({ why: "OFF_BRANCH" }) },
        { ticket: "d", phase: TicketPhase.Waiting({ for: "x" }) },
      ],
      {
        windDown: { since: began, tickets: ["a", "b", "c", "d"] },
        workers: [["a", WS.Working({ doing: "editing" })]],
      },
    ),
    ready: "Winding down",
    checks: [
      [{ text: "■", on: "■ ■ ■ ■", nth: 0 }, look("windingDown")],
      [{ text: "■", on: "■ ■ ■ ■", nth: 1 }, look("done")],
      [{ text: "■", on: "■ ■ ■ ■", nth: 2 }, look("needsYou")],
      [{ text: "■", on: "■ ■ ■ ■", nth: 3 }, look("text", "faint")],
      ["Winding down", look("windingDown", "bold")],
      [" · 1 running, no new tickets", look("text", "faint")],
    ],
  },
  {
    name: "the stop question",
    size: { width: 80, height: 30 },
    view: viewOf([{ ticket: "tut-1", phase: working("working"), worker: 1 }], {
      workers: [["tut-1", WS.Idle({ at: began })]],
    }),
    keys: ["s"],
    ready: "Stop after the running tickets?",
    checks: [
      ["Stop after the running tickets?", look("notice", "bold")],
      [{ text: "│", on: "Stop after the running" }, look("notice")],
      [{ text: "y", on: "y stop" }, look("emphasis", "bold")],
      [{ text: "n", on: "n keep going" }, look("emphasis", "bold")],
    ],
  },
  {
    name: "the end-of-run box",
    size: { width: 80, height: 30 },
    view: viewOf(
      [
        { ticket: "tut-dwv", phase: merged("ffd6ce4") },
        { ticket: "tut-9a1", phase: working("working"), worker: 1 },
        { ticket: "tut-7k2", phase: working("working"), worker: 2 },
      ],
      {
        status: { endOfRun: ["tut-9a1", "tut-7k2"] },
        requests: [permission("r1", "tut-9a1"), question("r2", "tut-7k2")],
      },
    ),
    ready: "Everything else is done",
    checks: [
      [{ text: "│", on: "│ Everything else" }, look("needsYou")],
      ["Everything else is done.", look("text")],
      [{ text: "q", on: "q end the run" }, look("emphasis", "bold")],
    ],
  },
  {
    name: "a defaultToNo card",
    size: { width: 80, height: 30 },
    view: viewOf([{ ticket: "t-1", phase: working("working"), worker: 1 }], {
      workers: [["t-1", WS.Idle({ at: began })]],
      requests: [
        permission("r1", "t-1", { defaultToNo: true, decisionReason: "held by the safety check" }),
      ],
    }),
    ready: "[ Deny ]",
    checks: [
      ["[ Deny ]", look("formAccentText", { bg: "formAccent" })],
      ["[ Allow ]", look("formText", { bg: "formButton" })],
      ["held by the safety check", look("text", "faint")],
    ],
  },
  {
    name: "toasts",
    size: { width: 80, height: 24 },
    view: viewOf([]),
    children: () => (
      <>
        <App />
        <Toast text="couldn't copy" failure />
      </>
    ),
    keys: ["ctrl+z"],
    ready: "suspended",
    checks: [
      ["couldn't copy", look("needsYou")],
      ["can't be suspended", look("text", "faint")],
    ],
  },
  {
    name: "the compact box",
    size: { width: 80, height: 30 },
    view: illustrated,
    ready: "? keys",
    checks: [
      [{ text: "│", on: "│ ⣾ tut-zq4" }, look("needsYou")],
      [{ text: "Add an undo stack for property edits", on: "│ ⣾ tut-zq4" }, look("text", "faint")],
      [{ text: "┃", on: "┃ • tut-9a1" }, look("needsYou", "bold")],
      [{ text: "■ allow?", on: "┃ • tut-9a1" }, look("needsYou", "bold")],
    ],
  },
  {
    name: "selected text",
    size: { width: 80, height: 24 },
    view: rowsOf([working("editing")]),
    drag: [26, 10, 40, 10],
    ready: "Title of tut-1",
    checks: [["Title of tut-1", look("selectionText", { bg: "selection" })]],
  },
  {
    name: "the start question",
    size: { width: 80, height: 16 },
    view: viewOf([]),
    children: (theme) => startQuestion(theme),
    ready: "New feature",
    checks: [
      ["What should this run work on?", look("formTitle", "bold")],
      [{ text: "┃", on: "┃ What should" }, look("formFrame")],
      [{ text: ">", on: "> Current" }, look("formAccent")],
      ["Current tickets: 3 ready", look("formSelected")],
      ["New feature", look("formText")],
      ["tutti --tickets runs the current tickets", look("formMuted")],
      [{ text: "↑↓", on: "↑↓ choose" }, look("formHelpKey")],
      [{ text: " choose", on: "↑↓ choose" }, look("formHelpDesc")],
      [{ text: " · ", on: "↑↓ choose" }, look("formHelpSeparator")],
      [{ text: "Enter", on: "↑↓ choose" }, look("formHelpKey")],
      [{ text: " confirm", on: "↑↓ choose" }, look("formHelpDesc")],
    ],
  },
  {
    name: "the start question's description",
    size: { width: 80, height: 24 },
    view: viewOf([]),
    children: (theme) => startQuestion(theme),
    keys: ["down", "enter", "enter"],
    ready: "What should it do, and why?",
    checks: [
      ["Describe the feature", look("formTitle", "bold")],
      ["What should it do, and why?", look("formPlaceholder")],
      ["describe the feature first", look("formError")],
      [{ text: "Shift+Tab", on: "Shift+Tab back" }, look("formHelpKey")],
      [{ text: " back", on: "Shift+Tab back" }, look("formHelpDesc")],
      [{ text: " · ", on: "Shift+Tab back" }, look("formHelpSeparator")],
    ],
  },
  {
    name: "the worker view",
    size: { width: 80, height: 30 },
    view: viewOf([{ ticket: "t-1", phase: working("working"), worker: 1, steered: true }], {
      workers: [["t-1", WS.Idle({ at: began })]],
    }),
    screen: Screen.Worker({ ticket: "t-1" }),
    transcripts: feedOf(transcript),
    ready: highlighted,
    checks: [
      ["← Dashboard", look("emphasis", "bold")],
      [{ text: "t-1", on: "← Dashboard" }, look("live", "bold")],
      [{ text: "steered", on: "← Dashboard" }, look("emphasis")],
      ["I'll read the undo module first.", look("text")],
      ["Read", look("emphasis", "bold")],
      [{ text: "✓", on: "Read" }, look("done")],
      ["Edit", look("emphasis", "bold")],
      ["+2", look("added")],
      ["−1", look("removed")],
      ["Exit code 1", look("needsYou")],
      ["Undone", look("heading1", "bold")],
      ["Groups", look("heading2", "bold")],
      ["Notes", look("heading3", "bold")],
      ["The stack records", look("text")],
      ["edits", look("code")],
      ["the spec", look("link")],
      ["https://x.test/spec", look("text", "faint")],
      ["strong", look("text", "bold")],
      ["word.", look("text")],
      ["quoted", look("text", "faint")],
      [{ text: "│", on: "│ quoted" }, look("text", "faint")],
      [{ text: "─".repeat(40), on: "  ─" }, look("text", "faint")],
      [{ text: ">", on: " > i to write" }, look("formAccent")],
      ["i to write to the worker", look("formPlaceholder")],
    ],
  },
]

describe("each state's cells carry § 7.11's role", () => {
  test("the orchestra scheme's colours are § 7.11's", () => {
    for (const role of roles) {
      const [light, dark] = orchestraColours[role]
      for (const [appearance, colour] of [
        ["light", light],
        ["dark", dark],
      ] as const) {
        const theme = themeIn(orchestra)(appearance)
        expect(`${role}: ${recordOf(theme.rgba(role))}`).toBe(`${role}: ${recorded(colour)}`)
      }
    }
  })

  for (const scene of scenes) {
    test.each(variants)(
      `${scene.name}, %s`,
      async (appearance) => {
        const frame = await draw(scene, themeIn(orchestra), appearance)
        for (const [each, want] of scene.checks) {
          const at = where(each)
          for (const cell of find(frame, at)) {
            expect({ at: at.text, cell: cell.char, ...drawnAs(cell) }).toEqual({
              at: at.text,
              cell: cell.char,
              ...expected(want, appearance),
            })
          }
        }
      },
      renderTime,
    )
  }
})

/** A scheme that gives each role a colour of its own, the same in both variants. */
const marked: Scheme = (() => {
  const colourOf = (i: number) => `#2A${i.toString(16).padStart(2, "0").toUpperCase()}7F`
  const colours = Object.fromEntries(
    roles.map((role, i) => {
      const colour = { _tag: "Hex", hex: colourOf(i) } as const
      return [role, { light: colour, dark: colour }]
    }),
  ) as Scheme["colours"]
  const from = Object.fromEntries(roles.map((role) => [role, "marked"])) as Scheme["from"]
  return { name: "marked", description: null, colours, from }
})()

/** The role each of `marked`'s colours stands for, by how the frame records it. */
const markedRoles: ReadonlyMap<string, Role> = new Map(
  roles.map((role) => [recordOf(themeIn(marked)("dark").rgba(role)), role]),
)

/**
 * The role a cell's colour comes from under `marked`: none for the terminal's own. A space shows
 * no foreground, and the screen's blank cells have OpenTUI's own.
 */
const roleOf = (cell: Cell, layer: "fg" | "bg"): Role | null => {
  const record = recordOf(cell[layer])
  if (record === "default" || (layer === "bg" && record === "none")) return null
  const role = markedRoles.get(record)
  if (role !== undefined) return role
  if (layer === "fg" && cell.char === " ") return null
  throw new Error(`a ${layer} colour no role gives: ${record} on ${JSON.stringify(cell.char)}`)
}

/** `scheme` with `role` given `colour` in both variants. */
const changed = (scheme: Scheme, role: Role, hex: string): Scheme => {
  const colour = { _tag: "Hex", hex } as const
  return { ...scheme, colours: { ...scheme.colours, [role]: { light: colour, dark: colour } } }
}

/** Each cell's role, fg and bg, under `marked`. */
const rolesIn = (frame: Frame) =>
  cellsOf(frame).map((line) =>
    line.map((cell) => ({ fg: roleOf(cell, "fg"), bg: roleOf(cell, "bg") })),
  )

describe("a scheme's roles", () => {
  for (const scene of scenes) {
    test.each(variants)(
      `every colour is a role's: ${scene.name}, %s`,
      async (appearance) => {
        // roleOf throws on a colour that isn't one of marked's.
        const frame = await draw(scene, themeIn(marked), appearance)
        expect(rolesIn(frame).flat().length).toBeGreaterThan(0)
      },
      renderTime,
    )
  }

  for (const scene of scenes) {
    test.each(variants)(
      `changing one role changes only its cells: ${scene.name}, %s`,
      async (appearance) => {
        const map = rolesIn(await draw(scene, themeIn(marked), appearance))
        const used = new Set(map.flat().flatMap((cell) => [cell.fg, cell.bg]))
        const before = cellsOf(await draw(scene, themeIn(orchestra), appearance))
        const recolour = "#123456"
        for (const role of roles.filter((each) => used.has(each))) {
          const after = cellsOf(
            await draw(scene, themeIn(changed(orchestra, role, recolour)), appearance),
          )
          const differences = before.flatMap((line, y) =>
            line.flatMap((was, x) => {
              const is = after[y]?.[x]
              const cell = map[y]?.[x]
              if (is === undefined || cell === undefined) throw new Error(`no cell ${x},${y}`)
              const kept = is.char === was.char && is.attributes === was.attributes
              return [
                ...(kept ? [] : [`${x},${y} ${was.char}: its character or attributes`]),
                ...(["fg", "bg"] as const).flatMap((layer) => {
                  const want = cell[layer] === role ? `rgb ${recolour}` : recordOf(was[layer])
                  const drawn = recordOf(is[layer])
                  return drawn === want ? [] : [`${x},${y} ${was.char} ${layer}: ${drawn}`]
                }),
              ]
            }),
          )
          expect({ role, differences }).toEqual({ role, differences: [] })
        }
      },
      // A frame for each role the scene uses.
      4 * renderTime,
    )
  }
})

describe("NO_COLOR", () => {
  for (const scene of scenes) {
    test.each(variants)(
      `keeps every glyph, word, bold and faint, in the terminal's colours: ${scene.name}, %s`,
      async (appearance) => {
        const coloured = await draw(scene, themeIn(orchestra), appearance)
        const plain = await draw(scene, themeIn(orchestra, true), appearance)
        expect(plain.chars).toBe(coloured.chars)
        const was = cellsOf(coloured)
        const differences = cellsOf(plain).flatMap((line, y) =>
          line.flatMap((cell, x) => {
            const fg = recordOf(cell.fg)
            const bg = recordOf(cell.bg)
            const before = was[y]?.[x]
            // A focused button, drawn on formAccent, is bold and reversed without it (§ 7.11).
            const focus =
              before !== undefined &&
              recordOf(before.bg) === recorded(orchestraColours.formAccent[variantOf(appearance)])
            const same =
              cell.attributes === (focus ? reversed(before.attributes) : before?.attributes)
            // Selected text is the one exception: orchestra's selection colours (§ 7.11).
            const selected =
              fg === recorded(orchestraColours.selectionText[1]) &&
              bg === recorded(orchestraColours.selection[1])
            const plain =
              (fg === "default" || cell.char === " ") && (bg === "default" || bg === "none")
            return (plain || selected) && same
              ? []
              : [`${x},${y} ${cell.char}: ${fg} on ${bg}, attributes ${cell.attributes}`]
          }),
        )
        expect(differences).toEqual([])
      },
      renderTime,
    )
  }
})

/** A focus's attributes under NO_COLOR: bold and reversed besides its own. */
const reversed = (attributes: number): number =>
  attributes | TextAttributes.BOLD | TextAttributes.INVERSE

/** `appearance`'s index in a role's colours. */
const variantOf = (appearance: Appearance): 0 | 1 => (appearance === "light" ? 0 : 1)

describe("NO_COLOR's focus", () => {
  test("paints the focused button bold and reversed, and only under NO_COLOR", () => {
    const options = { appearance: "dark", depth: "truecolor" } as const
    const plain = makeTheme(orchestra, { ...options, noColor: true }).form
    expect(plain.focusedButton.paint("[ Deny ]")).toBe("\x1b[1m\x1b[7m[ Deny ]\x1b[0m")
    expect(plain.button.paint("[ Allow ]")).toBe("[ Allow ]")
    const coloured = makeTheme(orchestra, { ...options, noColor: false }).form.focusedButton
    expect(coloured.attributes).toBe(0)
  })

  for (const name of ["the dashboard", "a defaultToNo card"]) {
    test.each(variants)(
      `the focused button is bold and reversed, the others plain: ${name}, %s`,
      async (appearance) => {
        const plain = await draw(sceneOf(name), themeIn(orchestra, true), appearance)
        const attributesOf = (text: string) => [
          ...new Set(find(plain, { text }).map((cell) => cell.attributes)),
        ]
        expect(attributesOf("[ Deny ]")).toEqual([reversed(0)])
        expect(attributesOf("[ Allow ]")).toEqual([0])
      },
      renderTime,
    )
  }
})

/** `scene`'s frame, the same in both variants, its lines' trailing spaces and blank foot left out. */
const layout = async (scene: Omit<Scene, "name" | "checks">): Promise<string> => {
  const drawn = { ...scene, name: "", checks: [] }
  // One after the other: a test renderer's act() environment is its own until it is disposed.
  const light = await draw(drawn, themeIn(orchestra), "light")
  const dark = await draw(drawn, themeIn(orchestra), "dark")
  expect(light.chars).toBe(dark.chars)
  const lines = light.chars.split("\n").map((line) => line.trimEnd())
  while (lines.at(-1) === "") lines.pop()
  return `\n${lines.join("\n")}\n`
}

const sceneOf = (name: string): Scene => {
  const found = scenes.find((scene) => scene.name === name)
  if (found === undefined) throw new Error(`no scene ${name}`)
  return found
}

describe("layouts", () => {
  test(
    "narrow: 80 columns",
    async () => {
      expect(
        await layout({ view: illustrated, size: { width: 80, height: 30 }, ready: "? keys" }),
      ).toMatchInlineSnapshot(`
      "

       tutti  0.1.0   batch/2026-10-20 · 18m40s · ticket tu…  usage 85% · resets 14:05

       ▶ 2 of 3 workers
      ╭────────────────┬────────────────┬────────────────┬───────────────────────────╮
      │ Completed      │ Set aside      │ Needs you      │ In queue                  │
      │ ✓ 1            │ ↷ 1 ◆ 1        │ 1              │ 1 of 16 · 1 held back     │
      ╰────────────────┴────────────────┴────────────────┴───────────────────────────╯
        Tickets
      ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
      │ ✓ done      │ tut-dwv │ ffd6ce4 merged into batch/2026-10-20                 │
      │ ↷ deferred  │ tut-vzg │ ◆ environment · high · prompt never submitted        │
      │             │         │                                                      │
      ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
        Current
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ ⣾ tut-zq4  testing   18m40s  Add an undo stack for property edits            │
      │ ◆ tut-kco  merging   18m40s  Open the property model                         │
      ┃ • tut-9a1  ■ allow?  18m40s  Remove the build cache                          │
      ╰──────────────────────────────────────────────────────────────────────────────╯









        Tab select · Enter open · s stop after current · ? keys
      "
    `)
    },
    renderTime,
  )

  test(
    "120 columns",
    async () => {
      expect(
        await layout({ view: illustrated, size: { width: 120, height: 40 }, ready: "? keys" }),
      ).toMatchInlineSnapshot(`
      "

       tutti  0.1.0   batch/2026-10-20 · 18m40s · ticket tut-8f2                                      usage 85% · resets 14:05

       ▶ 2 of 3 workers
      ╭──────────────────────────┬──────────────────────────┬──────────────────────────┬─────────────────────────────────────╮
      │ Completed                │ Set aside                │ Needs you                │ In queue                            │
      │ ✓ 1                      │ ↷ 1 ◆ 1                  │ 1                        │ 1 of 16 · 1 held back               │
      ╰──────────────────────────┴──────────────────────────┴──────────────────────────┴─────────────────────────────────────╯
        Tickets
      ╭─────────────┬─────────┬──────────────────────────────────────────────────────────────────────────────────────────────╮
      │ ✓ done      │ tut-dwv │ ffd6ce4 merged into batch/2026-10-20                                                         │
      │ ↷ deferred  │ tut-vzg │ ◆ environment · high · prompt never submitted                                                │
      │             │         │                                                                                              │
      │             │         │                                                                                              │
      │             │         │                                                                                              │
      │             │         │                                                                                              │
      │             │         │                                                                                              │
      │             │         │                                                                                              │
      │             │         │                                                                                              │
      │             │         │                                                                                              │
      ╰─────────────┴─────────┴──────────────────────────────────────────────────────────────────────────────────────────────╯
        Current
      ╭──────────────────────────────────────────────────────────╮╭──────────────────────────────────────────────────────────╮
      │ ⣾ tut-zq4  testing  18m40s                               ││ ◆ tut-kco  merging  18m40s                               │
      │   Add an undo stack for property edits                   ││   Open the property model                                │
      │   ▸ Bash(bun test)                                       ││   running the check on batch/2026-10-20                  │
      ╰──────────────────────────────────────────────────────────╯╰──────────────────────────────────────────────────────────╯
      ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
      ┃ • tut-9a1  permission — waiting for you  18m40s          ┃
      ┃   Remove the build cache                                 ┃
      ┃   Bash: Remove the build cache                           ┃
      ┃   rm -rf build                                           ┃
      ┃   outside the working directories                        ┃
      ┃   [ Deny ]  [ Allow ]                                    ┃
      ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛




        Tab select · Enter open · d deny · a allow · s stop after current · ? keys
      "
    `)
    },
    renderTime,
  )

  test(
    "the smallest size, 60×16",
    async () => {
      expect(
        await layout({ view: illustrated, size: { width: 60, height: 16 }, ready: "Tab select" }),
      ).toMatchInlineSnapshot(`
      "

       tutti  0.1.0   batch/2026-10-20 …  usage 85% · resets 14:05

       ▶ 2 of 3 workers
       ✓ 1 · ↷ 1 ◆ 1 · ? 1 · queue 1 of 16 · 1 held back
        Current
      ╭──────────────────────────────────────────────────────────╮
      │ ⣾ tut-zq4  testing   18m40s  Add an undo stack for prop… │
      │ ◆ tut-kco  merging   18m40s  Open the property model     │
      ┃ • tut-9a1  ■ allow?  18m40s  Remove the build cache      │
      ╰──────────────────────────────────────────────────────────╯




        Tab select · Enter open · s stop after current · ? keys
      "
    `)
    },
    renderTime,
  )

  test(
    "attention cards, one of them defaultToNo",
    async () => {
      const view = viewOf(
        [
          { ticket: "t-1", phase: working("working"), worker: 1 },
          { ticket: "t-2", phase: working("working"), worker: 2 },
        ],
        {
          workers: [
            ["t-1", WS.Idle({ at: began })],
            ["t-2", WS.Idle({ at: began })],
          ],
          requests: [
            permission("r1", "t-1", {
              decisionReason: "outside the working directories",
              suggestions: [
                {
                  type: "addRules",
                  behavior: "allow",
                  rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }],
                  destination: "localSettings",
                },
              ],
            }),
            permission("r2", "t-2", {
              defaultToNo: true,
              suppressAlwaysAllowRule: true,
              decisionReason: "held by the safety check",
            }),
          ],
        },
      )
      expect(
        await layout({ view, size: { width: 80, height: 36 }, ready: "? keys" }),
      ).toMatchInlineSnapshot(`
      "

       tutti  0.1.0   batch/2026-10-20 · 18m40s

       ▶ 2 of 3 workers
      ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
      │ Completed         │ Set aside         │ Needs you         │ In queue         │
      │ 0                 │ 0                 │ 2                 │ 0                │
      ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
        Tickets
      ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
      │             │         │                                                      │
      │             │         │                                                      │
      │             │         │                                                      │
      │             │         │                                                      │
      │             │         │                                                      │
      │             │         │                                                      │
      │             │         │                                                      │
      ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
        Current
      ╭──────────────────────────────────────────────────────────────────────────────╮
      ┃ • t-1  ■ allow?  18m40s  Title of t-1                                        │
      │ • t-2  ■ allow?  18m40s  Title of t-2                                        │
      ╰──────────────────────────────────────────────────────────────────────────────╯












        Tab select · Enter open · s stop after current · ? keys
      "
    `)
    },
    renderTime,
  )

  test(
    "the end-of-run box",
    async () => {
      expect(await layout(sceneOf("the end-of-run box"))).toMatchInlineSnapshot(`
      "

       tutti  0.1.0   batch/2026-10-20 · 18m40s

       ▶ 2 of 3 workers
      ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
      │ Completed         │ Set aside         │ Needs you         │ In queue         │
      │ ✓ 1               │ 0                 │ 2                 │ 0                │
      ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
        Tickets
      ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
      │ ✓ done      │ tut-dwv │ ffd6ce4 merged into batch/2026-10-20                 │
      │ ■ allow?    │ tut-9a1 │ Title of tut-9a1                                     │
      │ ■ answer?   │ tut-7k2 │ Title of tut-7k2                                     │
      ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ Everything else is done. 2 workers wait for you: tut-9a1 (Allow Bash(rm -rf  │
      │ build)?), tut-7k2 (a question)                                               │
      │ Answering lets them carry on. q ends the run, suspending them: the next run  │
      │ resumes them.                                                                │
      ╰──────────────────────────────────────────────────────────────────────────────╯









        Tab select · Enter open · q end the run · ? keys
      "
    `)
    },
    renderTime,
  )

  test(
    "the usage banner",
    async () => {
      const view = viewOf([], { status: { usage: { utilization: 0.85, resetsAt: resets } } })
      expect(
        await layout({ view, size: { width: 80, height: 16 }, ready: "usage" }),
      ).toMatchInlineSnapshot(`
      "

       tutti  0.1.0   batch/2026-10-20 · 18m40s               usage 85% · resets 14:05

       ▶ 0 of 3 workers
      ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
      │ Completed         │ Set aside         │ Needs you         │ In queue         │
      │ 0                 │ 0                 │ 0                 │ 0                │
      ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
        Current
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ ⣾ picking the next ticket…                                                   │
      ╰──────────────────────────────────────────────────────────────────────────────╯



        s stop after current · ? keys
      "
    `)
    },
    renderTime,
  )

  test(
    "wind-down",
    async () => {
      expect(await layout(sceneOf("wind-down"))).toMatchInlineSnapshot(`
      "

       tutti  0.1.0   batch/2026-10-20 · 18m40s

       ▶ 1 of 3 workers
      ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
      │ Completed         │ Set aside         │ Needs you         │ In queue         │
      │ ✓ 1               │ ↷ 1               │ 0                 │ 0 · held         │
      ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
        Tickets
      ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
      │ ✓ done      │ b       │ abc1234 merged into batch/2026-10-20                 │
      │ ! review    │ c       │ Title of c                                           │
      │ ◷ waiting   │ d       │ Title of d                                           │
      ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
        Current
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ ⣾ a  editing  18m40s                                                         │
      │   Title of a                                                                 │
      ╰──────────────────────────────────────────────────────────────────────────────╯



        ■ ■ ■ ■  Winding down · 1 running, no new tickets
        Tab select · Enter open · s keep taking tickets · ? keys
      "
    `)
    },
    renderTime,
  )
})

/** A phase of each kind, with its worker's state when it has a card: the compiler wants every one. */
const phaseExamples: { readonly [T in PhaseTag]: readonly [TicketPhase, WorkerState | null] } = {
  Queued: [TicketPhase.Queued(), null],
  HeldBack: [TicketPhase.HeldBack({ why: "overlap" }), null],
  Working: [working("editing"), WS.Working({ doing: "editing" })],
  ToMerge: [TicketPhase.ToMerge({ place: 2 }), null],
  Merging: [TicketPhase.Merging({ step: "rebase" }), null],
  Resolving: [TicketPhase.Resolving({ attempt: 1 }), null],
  Fixing: [TicketPhase.Fixing({ attempt: 2, afterResolution: false }), null],
  Done: [merged("ffd6ce4a1b2c3"), null],
  Asked: [TicketPhase.Asked({ question: "tut-q9" }), null],
  Waiting: [TicketPhase.Waiting({ for: "tut-2" }), null],
  Deferred: [TicketPhase.Deferred({ why: "BAD_TICKET_ID" }), null],
  Review: [TicketPhase.Review({ why: "OFF_BRANCH" }), null],
  Blocked: [TicketPhase.Blocked({ why: "MERGE_CONFLICT" }), null],
  Stopped: [TicketPhase.Stopped({ why: "PAUSED" }), null],
}

test(
  "a layout per phase: tut-1 in it, with its worker's card when it has one",
  async () => {
    const frames: Array<string> = []
    for (const [tag, [phase, state]] of Object.entries(phaseExamples)) {
      const frame = await layout({
        view: viewOf(
          [
            {
              ticket: "tut-1",
              title: "Add an undo stack for property edits",
              phase,
              ...(hasCard(phase) ? { worker: 1 } : {}),
              ...(tag === "Queued" || tag === "HeldBack" ? { row: null } : {}),
            },
          ],
          { workers: state === null ? [] : [["tut-1", state]], status: { unclosed: 4 } },
        ),
        size: { width: 80, height: 21 },
        ready: "? keys",
      })
      frames.push(`${tag}:${frame}`)
    }
    expect(`\n${frames.join("\n")}`).toMatchInlineSnapshot(`
    "
    Queued:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 0                 │ 1 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │             │         │                                                      │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys

    HeldBack:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭────────────────┬────────────────┬────────────────┬───────────────────────────╮
    │ Completed      │ Set aside      │ Needs you      │ In queue                  │
    │ 0              │ 0              │ 0              │ 0 of 4 · 1 held back      │
    ╰────────────────┴────────────────┴────────────────┴───────────────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │             │         │                                                      │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys

    Working:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 1 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │             │         │                                                      │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ tut-1  editing  18m40s                                                     │
    │   Add an undo stack for property edits                                       │
    ╰──────────────────────────────────────────────────────────────────────────────╯


      Tab select · Enter open · s stop after current · ? keys

    ToMerge:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │             │         │                                                      │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ◼ tut-1  to merge (2nd)  18m40s                                              │
    │   Add an undo stack for property edits                                       │
    ╰──────────────────────────────────────────────────────────────────────────────╯


      Tab select · Enter open · s stop after current · ? keys

    Merging:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │             │         │                                                      │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ◆ tut-1  merging  18m40s                                                     │
    │   Add an undo stack for property edits                                       │
    │   rebasing onto batch/2026-10-20                                             │
    ╰──────────────────────────────────────────────────────────────────────────────╯

      Tab select · Enter open · s stop after current · ? keys

    Resolving:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 1 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │             │         │                                                      │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ tut-1  resolving  18m40s                                                   │
    │   Add an undo stack for property edits                                       │
    ╰──────────────────────────────────────────────────────────────────────────────╯


      Tab select · Enter open · s stop after current · ? keys

    Fixing:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 1 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │             │         │                                                      │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ tut-1  fixing check  18m40s                                                │
    │   Add an undo stack for property edits                                       │
    ╰──────────────────────────────────────────────────────────────────────────────╯


      Tab select · Enter open · s stop after current · ? keys

    Done:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ ✓ 1               │ 0                 │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │ ✓ done      │ tut-1   │ ffd6ce4 merged into batch/2026-10-20                 │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys

    Asked:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 1                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │ ? for you   │ tut-1   │ Add an undo stack for property edits                 │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys

    Waiting:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │ ◷ waiting   │ tut-1   │ Add an undo stack for property edits                 │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys

    Deferred:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ ↷ 1               │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │ ↷ deferred  │ tut-1   │ Add an undo stack for property edits                 │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys

    Review:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ ↷ 1               │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │ ! review    │ tut-1   │ Add an undo stack for property edits                 │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys

    Blocked:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 1                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │ ■ blocked   │ tut-1   │ Add an undo stack for property edits                 │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys

    Stopped:

     tutti  0.1.0   batch/2026-10-20 · 18m40s
     ▶ 0 of 3 workers
    ╭───────────────────┬───────────────────┬───────────────────┬──────────────────╮
    │ Completed         │ Set aside         │ Needs you         │ In queue         │
    │ 0                 │ 0                 │ 0                 │ 0 of 4           │
    ╰───────────────────┴───────────────────┴───────────────────┴──────────────────╯
      Tickets
    ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
    │ ■ stopped   │ tut-1   │ Add an undo stack for property edits                 │
    │             │         │                                                      │
    │             │         │                                                      │
    ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
      Current
    ╭──────────────────────────────────────────────────────────────────────────────╮
    │ ⣾ picking the next ticket…                                                   │
    ╰──────────────────────────────────────────────────────────────────────────────╯



      s stop after current · ? keys
    "
  `)
    // Two frames a phase.
  },
  4 * renderTime,
)

test(
  "NO_COLOR draws selected text in orchestra's selection colours",
  async () => {
    const frame = await draw(sceneOf("selected text"), themeIn(orchestra, true), "dark")
    const [, text] = orchestraColours.selectionText
    const [, background] = orchestraColours.selection
    for (const cell of find(frame, { text: "Title of tut-1" })) {
      expect([recordOf(cell.fg), recordOf(cell.bg)]).toEqual([recorded(text), recorded(background)])
    }
  },
  renderTime,
)
