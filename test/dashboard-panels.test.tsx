// The dashboard's two levels (§ 7.3, tutti-149z.2): at the top the arrows move the focus
// between its panels, the focused panel's frame bright; Enter or a click goes into one, where the
// keys select in it; Esc comes out, closing an open box first. A panel gone from the pane moves the
// focus off it.

import { describe, expect, test } from "bun:test"
import { type RGBA, TextAttributes } from "@opentui/core"
import { Effect, Queue } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { orchestra } from "../src/project/scheme.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { marks } from "../src/text/marks.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { dashboardHint, dashboardLayout } from "../src/ui/Dashboard.tsx"
import {
  type Direction,
  focusAmong,
  gridMove,
  type Panel,
  panelTowards,
} from "../src/ui/panelFocus.ts"
import { needsLines, upNextLines } from "../src/ui/SidePanel.tsx"
import { boxPad } from "../src/ui/spacing.ts"
import { ticketsLines } from "../src/ui/TicketsTable.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { emptyTranscript, type TranscriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"
import { hintFrom, hintOf, pointedAt } from "./screen.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const blocked = TicketPhase.Blocked({ why: "DIRTY_TREE" })
const merged = (commit: string) => TicketPhase.Done({ outcome: Finished.Merged({ commit }) })

const entryOf = (
  ticket: string,
  row: number,
  phase: Entry["phase"],
  worker: number | null,
): Entry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const doneRows = [
  entryOf("d-1", 0, merged("0c1a9e7"), null),
  entryOf("d-2", 1, merged("ffd6ce4"), null),
]

/** RunView over `tickets`, with `requests` open. */
const projected = (
  tickets: ReadonlyArray<Entry>,
  requests: ReadonlyArray<AttentionRequest> = [],
  status: Partial<Status> = {},
): RunView =>
  project({
    ledger: {
      tickets: new Map(tickets.map((each) => [each.ticket, each])),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(
      tickets.flatMap((each) =>
        each.worker === null ? [] : [[each.ticket, WS.Idle({ at: began })] as const],
      ),
    ),
    requests,
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch",
      began,
      concurrency: 4,
      ...status,
    },
    actions: new Map(),
  })

/** Three done rows, a Blocked one, and `workers` cards. */
const viewOf = (workers: number, requests: ReadonlyArray<AttentionRequest> = []): RunView =>
  projected(
    [
      ...doneRows,
      entryOf("b-1", 2, blocked, null),
      ...Array.from({ length: workers }, (_, i) =>
        entryOf(`w-${i + 1}`, 3 + i, TicketPhase.Working(), i + 1),
      ),
    ],
    requests,
  )

const permission = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket: ticket as TicketId,
  kind: { _tag: "Permission", tool: "Bash", input: {}, suggestions: [], summary: "ls" },
  displayName: "Bash",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

/** A question of the worker's: a card's, whose options `1`–`4` pick. */
const cardQuestion = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket: ticket as TicketId,
  kind: {
    _tag: "Question",
    input: {},
    questions: [
      {
        question: "Which?",
        options: [{ label: "Keep the old" }, { label: "Write a new" }],
        multiSelect: false,
      },
    ],
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

/** q-1 is put to the maintainer, and a-1 waits on it, in Needs you. */
const askingView = (
  requests: ReadonlyArray<AttentionRequest> = [],
  workers = 0,
  options: ReadonlyArray<string> = ["Use --flag", "Use --other"],
): RunView =>
  projected(
    [
      ...doneRows,
      entryOf("a-1", 2, TicketPhase.Asked({ question: "q-1" }), null),
      ...Array.from({ length: workers }, (_, i) =>
        entryOf(`w-${i + 1}`, 3 + i, TicketPhase.Working(), i + 1),
      ),
    ],
    requests,
    {
      questions: new Map([
        [
          "q-1",
          {
            id: "q-1" as TicketId,
            title: "Which flag name?",
            description: "",
            options: options.map((label) => ({ label, description: "" })),
            maintainerOnly: false,
            waiting: ["a-1" as TicketId],
          },
        ],
      ]),
    },
  )

/** No transcript: the worker view is only opened and left. */
const feed: TranscriptFeed = {
  open: () => ({
    state: external(emptyTranscript),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
}

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

type Pressed = Direction | "tab" | "shift+tab" | "enter" | "escape"

const press = (rendered: Rendered, ...keys: ReadonlyArray<Pressed | string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key === "tab") setup.mockInput.pressTab()
      else if (key === "shift+tab") setup.mockInput.pressTab({ shift: true })
      else if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "escape") await pressEscape(setup)
      else if (key === "left" || key === "right" || key === "up" || key === "down") {
        setup.mockInput.pressArrow(key)
      } else await setup.mockInput.typeText(key)
    }
  })

const scene = async (
  start: RunView,
  size: { readonly width: number; readonly height: number },
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly pass: (millis: number) => void
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(start)
  const commands = Effect.runSync(makeCommands)
  let at = began
  const value = {
    view,
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => at,
  }
  await withRender(<Root value={value} />, size, (rendered) =>
    body({ view, commands, pass: (millis) => (at += millis), rendered }),
  )
}

const wide = { width: 155, height: 40 }
const narrow = { width: 100, height: 40 }

const linesOf = (frame: Frame) => frame.chars.split("\n")

/** Whether a span of `text` on `frame` has the focus's fill. */
const lit = (frame: Frame, text: string): boolean =>
  frame.spans.lines.some((line) =>
    line.spans.some(
      (span) =>
        span.text.includes(text) &&
        Bun.deepEquals(span.bg.toInts(), theme.form.focusedButton.bg?.toInts()),
    ),
  )

/** The colour of the Tickets table's top border, in `frame`: the line under its label. */
const tableFrameColour = (frame: Frame) => {
  const label = linesOf(frame).findIndex((line) => line.trimStart().startsWith("Tickets"))
  return frame.spans.lines[label + 1]?.spans[0]?.fg.toInts()
}

/** The colour and boldness of the span saying `text`, on the first line of `frame` holding `on`. */
const labelOf = (frame: Frame, text: string, on = text) => {
  const y = linesOf(frame).findIndex((line) => line.includes(on))
  const span = frame.spans.lines[y]?.spans.find((each) => each.text.trim() === text)
  if (span === undefined) throw new Error(`no span says ${text} on the line of ${on}`)
  return { fg: span.fg.toInts(), bold: (span.attributes & TextAttributes.BOLD) !== 0 }
}

/** The contrast of a colour on the terminal's white or black, as WCAG works it out. */
const contrast = (colour: RGBA | undefined, on: "white" | "black") => {
  const [r = 0, g = 0, b = 0] = colour?.toInts() ?? []
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const light = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
  return on === "white" ? 1.05 / (light + 0.05) : (light + 0.05) / 0.05
}

const where = (frame: Frame, text: string) => {
  const lines = linesOf(frame)
  const y = lines.findIndex((line) => line.includes(text))
  if (y === -1) throw new Error(`no line holds ${text}`)
  return { x: (lines[y] ?? "").indexOf(text), y }
}

const has = (frame: Frame, text: string) => frame.chars.includes(text)

/**
 * The table's row holding `text`, in `frame`, char by char with its colours and boldness, from its
 * frame's left side to its right: the first `│` of its line and the fourth, as the table has three
 * columns.
 */
const tableRow = (frame: Frame, text: string) => {
  const line = frame.spans.lines[where(frame, text).y]
  const chars = (line?.spans ?? []).flatMap((span) =>
    Array.from(span.text).map((char) => ({
      char,
      fg: span.fg.toInts(),
      bg: span.bg.toInts(),
      bold: (span.attributes & TextAttributes.BOLD) !== 0,
    })),
  )
  const bars = chars.flatMap((each, i) => (each.char === "│" ? [i] : []))
  return chars.slice(bars[0], (bars[3] ?? chars.length) + 1)
}

/** A table row's gutter, where its pointer goes: the first column inside its frame's padding. */
const gutterOf = (row: ReturnType<typeof tableRow>) => row[1 + boxPad.length]

/** Whether a card's heavy frame is drawn round `ticket`. */
const heavyOn = (frame: Frame, ticket: string) =>
  linesOf(frame).some((line) => line.includes(`┃`) && line.includes(ticket))

describe("the focus's moves", () => {
  const upper: ReadonlyArray<Panel> = ["tickets", "needs", "current"]
  const tall: ReadonlyArray<Panel> = ["tickets", "cell", "current"]

  test("the arrows go as the panels are laid out, and stay where there is none that way", () => {
    expect(panelTowards(upper, "tickets", "right")).toBe("needs")
    expect(panelTowards(upper, "needs", "left")).toBe("tickets")
    expect(panelTowards(upper, "tickets", "down")).toBe("current")
    expect(panelTowards(upper, "needs", "down")).toBe("current")
    expect(panelTowards(upper, "current", "up")).toBe("tickets")
    expect(panelTowards(upper, "current", "up", "needs")).toBe("needs")
    expect(panelTowards(upper, "tickets", "left")).toBe("tickets")
    expect(panelTowards(upper, "tickets", "up")).toBe("tickets")
    expect(panelTowards(upper, "needs", "right")).toBe("needs")
    expect(panelTowards(upper, "current", "down")).toBe("current")
    expect(panelTowards(upper, "current", "left")).toBe("current")
  })

  test("a panel not there is passed over", () => {
    expect(panelTowards(["tickets", "current"], "tickets", "right")).toBe("tickets")
    expect(panelTowards(["needs", "current"], "current", "up")).toBe("needs")
    expect(panelTowards(["current"], "current", "up")).toBe("current")
    expect(panelTowards(upper, "current", "up", "cell")).toBe("tickets")
  })

  test("with no panel beside the table, its Needs you cell is over it", () => {
    expect(panelTowards(tall, "tickets", "up")).toBe("cell")
    expect(panelTowards(tall, "tickets", "right")).toBe("cell")
    expect(panelTowards(tall, "cell", "down")).toBe("tickets")
    expect(panelTowards(tall, "cell", "left")).toBe("tickets")
    expect(panelTowards(["cell", "current"], "cell", "down")).toBe("current")
  })

  test("a panel gone moves the focus off it, to the top level; an emptied one out of it", () => {
    const inside = (panel: Panel) => ({ panel, inside: true })
    expect(focusAmong(inside("needs"), tall, tall)).toEqual({ panel: "tickets", inside: false })
    expect(focusAmong(inside("tickets"), ["cell", "current"], [])).toEqual({
      panel: "cell",
      inside: false,
    })
    expect(focusAmong(inside("cell"), upper, upper)).toEqual({ panel: "tickets", inside: false })
    expect(focusAmong(inside("current"), upper, ["tickets"])).toEqual({
      panel: "current",
      inside: false,
    })
    const there = inside("tickets")
    expect(focusAmong(there, upper, upper)).toBe(there)
  })

  test("the cards' grid: across in reading order, down and up its column, round", () => {
    expect(gridMove(4, 2, 0, "right")).toBe(1)
    expect(gridMove(4, 2, 1, "right")).toBe(2)
    expect(gridMove(4, 2, 3, "right")).toBe(0)
    expect(gridMove(4, 2, 0, "left")).toBe(3)
    expect(gridMove(4, 2, 0, "down")).toBe(2)
    expect(gridMove(4, 2, 3, "up")).toBe(1)
    expect(gridMove(4, 2, 2, "down")).toBe(0)
    expect(gridMove(4, 2, 1, "up")).toBe(3)
    // A shorter last row: under its gap is its last card, and over its gap too.
    expect(gridMove(3, 2, 1, "down")).toBe(2)
    expect(gridMove(3, 2, 1, "up")).toBe(2)
    expect(gridMove(3, 2, 2, "down")).toBe(0)
    // One to a row, and from none.
    expect(gridMove(3, 1, 0, "right")).toBe(1)
    expect(gridMove(3, 1, 2, "down")).toBe(0)
    expect(gridMove(3, 2, -1, "right")).toBe(0)
    expect(gridMove(3, 2, -1, "up")).toBe(2)
    expect(gridMove(0, 2, -1, "down")).toBe(-1)
  })
})

describe("the hint follows the level", () => {
  const view = viewOf(1)
  const words = (inside: boolean) =>
    dashboardHint(view, true, null, inside)
      .slice(0, 3)
      .map((key) => `${key.keys} ${key.does}`)
  test("names the keys of each", () => {
    expect(words(false)).toEqual(["Tab select", "arrows panels", "Enter go in"])
    expect(words(true)).toEqual(["Esc back", "arrows select", "Enter open"])
  })

  test("going in moves nothing over the hint, however it wraps", () => {
    const start = viewOf(2, [permission("r1", "w-1")])
    for (const width of [60, 70, 85, 100, 120, 155]) {
      const top = dashboardLayout(start, theme, width, 40)
      const inside = { panel: "tickets", inside: true } as const
      const side = {
        needs: start.needs,
        at: { focused: false, inside: false, choice: 0 },
      }
      const within = dashboardLayout(start, theme, width, 40, null, side, inside, "b-1" as TicketId)
      expect([within.table, within.current]).toEqual([top.table, top.current])
      expect(within.spare + within.hint.length).toBe(top.spare + top.hint.length)
    }
  })

  test("is drawn at each level", async () => {
    await scene(viewOf(1), narrow, async ({ rendered }) => {
      expect(hintFrom(await rendered.capture(), "arrows panels", 3)).toEqual([
        "arrows panels",
        "Enter go in",
        "s stop after current",
      ])
      await press(rendered, "enter")
      expect(hintFrom(await rendered.capture(), "Esc back", 3)).toEqual([
        "Esc back",
        "arrows select",
        "Enter open",
      ])
      await press(rendered, "escape")
      expect(hintFrom(await rendered.capture(), "arrows panels", 2)).toEqual([
        "arrows panels",
        "Enter go in",
      ])
    })
  })
})

describe("at the top level", () => {
  test("the focus starts on Tickets, its frame bright; moved off, it dims", async () => {
    await scene(viewOf(1), wide, async ({ rendered }) => {
      const on = await rendered.capture()
      expect(tableFrameColour(on)).toEqual(theme.rgba("emphasis").toInts())
      expect(has(on, "┏")).toBe(false)
      await press(rendered, "right")
      const off = await rendered.capture()
      expect(tableFrameColour(off)).toEqual(theme.rgba("frame").toInts())
      // Needs you's own frame goes heavy, without going in: no choice is marked.
      expect(has(off, "┏")).toBe(true)
      expect(has(off, "> ")).toBe(false)
    })
  })

  test("each panel's label is lit with the focus on it, at the top level or inside, else quiet", async () => {
    const dimmed = { fg: theme.rgba("quiet").toInts(), bold: false }
    const lighted = { fg: theme.rgba("emphasis").toInts(), bold: true }
    await scene(viewOf(1), wide, async ({ rendered }) => {
      const labels = async () => {
        const frame = await rendered.capture()
        return [
          labelOf(frame, "Tickets"),
          labelOf(frame, "Needs you", "Needs you ·"),
          labelOf(frame, "Current"),
        ]
      }
      const on = await rendered.capture()
      // The label's bright look is the frame's.
      expect(tableFrameColour(on)).toEqual(labelOf(on, "Tickets").fg)
      expect(await labels()).toEqual([lighted, dimmed, dimmed])
      await press(rendered, "enter")
      expect(await labels()).toEqual([lighted, dimmed, dimmed])
      await rendered.input(pressEscape)
      await press(rendered, "right")
      expect(await labels()).toEqual([dimmed, lighted, dimmed])
      await press(rendered, "enter")
      expect(await labels()).toEqual([dimmed, lighted, dimmed])
      await rendered.input(pressEscape)
      await press(rendered, "down")
      expect(await labels()).toEqual([dimmed, dimmed, lighted])
      await press(rendered, "enter")
      expect(await labels()).toEqual([dimmed, dimmed, lighted])
    })
  })

  test("Needs you's count stays in the stop style wherever the focus is, faint at 0", async () => {
    const stop = { fg: theme.rgba("needsYou").toInts(), bold: true }
    await scene(viewOf(1), wide, async ({ rendered }) => {
      expect(labelOf(await rendered.capture(), "1", "Needs you ·")).toEqual(stop)
      await press(rendered, "right")
      expect(labelOf(await rendered.capture(), "1", "Needs you ·")).toEqual(stop)
    })
    for (const shown of [themeOf("dark"), themeOf("light")]) {
      const at = { focused: true, inside: false, choice: 0 }
      const [none] = needsLines(undefined, 0, at, shown, 60, 8)
      expect(none?.find((each) => each.text === "0")?.look).toBe(shown.styles.dim)
      const [some] = needsLines(undefined, 2, { ...at, focused: false }, shown, 60, 8)
      expect(some?.find((each) => each.text === "2")?.look).toBe(shown.styles.stop)
    }
  })

  test("Up next's label is never lit, as the focus doesn't go there", () => {
    for (const shown of [themeOf("dark"), themeOf("light")]) {
      const [label] = upNextLines([], viewOf(1).totals, shown, 60, 8)
      expect(label?.find((each) => each.text === "Up next")?.look).toBe(shown.styles.quiet)
    }
  })

  test("the Tickets label's two looks are legible on either background, and under NO_COLOR", () => {
    const reach = { highlighted: null, target: () => undefined, idTarget: () => 0, copied: null }
    const label = (shown: ReturnType<typeof themeOf>, focused?: boolean) =>
      ticketsLines(
        viewOf(1).rows,
        shown,
        80,
        { lines: 6 },
        focused === undefined ? reach : { ...reach, focused },
      )[0]?.find((each) => each.text === "Tickets")?.look
    for (const shown of [themeOf("dark"), themeOf("light")]) {
      expect(label(shown, true)).toBe(shown.look("emphasis", "bold"))
      expect(label(shown, false)).toBe(shown.styles.quiet)
    }
    // Where the dim frame's own grey is too pale for a word on a light terminal, about 2.5:1.
    expect(contrast(themeOf("light").look("frame").fg, "white")).toBeLessThan(3)
    expect(contrast(label(themeOf("light"), false)?.fg, "white")).toBeGreaterThan(4.5)
    expect(contrast(label(themeOf("dark"), false)?.fg, "black")).toBeGreaterThan(4.5)
    const plain = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
    expect((label(plain, true)?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    expect((label(plain, false)?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM)
  })

  test("printed, where nothing has the focus, the Tickets label stays lit", () => {
    const [label] = ticketsLines(viewOf(1).rows, theme, 80, { lines: 6 })
    expect(label?.find((each) => each.text === "Tickets")?.look).toBe(theme.styles.tickets)
  })

  test("← → move between the upper two, ↓ to Current, ↑ back to where it came from", async () => {
    await scene(viewOf(1), wide, async ({ rendered }) => {
      const panelHeavy = async () => has(await rendered.capture(), "┏")
      await press(rendered, "right", "down")
      // Current: its card's frame is heavy, as every frame in it is.
      expect(heavyOn(await rendered.capture(), "w-1")).toBe(true)
      await press(rendered, "up")
      expect(heavyOn(await rendered.capture(), "w-1")).toBe(false)
      expect(await panelHeavy()).toBe(true)
      await press(rendered, "left")
      expect(await panelHeavy()).toBe(false)
      await press(rendered, "down", "up")
      expect(tableFrameColour(await rendered.capture())).toEqual(theme.rgba("emphasis").toInts())
    })
  })

  test("Enter on Current goes in and opens nothing; Enter again opens the card", async () => {
    await scene(viewOf(2), narrow, async ({ commands, rendered }) => {
      await press(rendered, "down", "enter")
      expect(taken(commands)).toEqual([])
      expect(heavyOn(await rendered.capture(), "w-1")).toBe(true)
      expect(heavyOn(await rendered.capture(), "w-2")).toBe(false)
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-1" as TicketId })])
    })
  })

  test("Esc does nothing, with nothing to come out of", async () => {
    await scene(viewOf(1), narrow, async ({ commands, rendered }) => {
      await press(rendered, "escape")
      expect(taken(commands)).toEqual([])
      expect(hintOf(await rendered.capture())).toContain("arrows panels")
    })
  })

  test("a request is answered from any panel, its card highlighted", async () => {
    await scene(
      viewOf(1, [permission("r1", "w-1")]),
      narrow,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        expect(hintFrom(await rendered.capture(), "d deny", 2)).toEqual(["d deny", "a allow"])
        await press(rendered, "a")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Allow" } }),
        ])
      },
    )
  })

  test("Enter on Current goes in at the oldest request's card, its first button ready", async () => {
    await scene(
      viewOf(2, [permission("r1", "w-2")]),
      { width: 80, height: 40 },
      async ({ commands, pass, rendered }) => {
        pass(settle)
        await press(rendered, "down", "enter")
        expect(taken(commands)).toEqual([])
        await press(rendered, "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Deny" } }),
        ])
      },
    )
  })
})

describe("inside Tickets", () => {
  test("↑↓ move through the rows, round; Esc comes out and the row is no longer pointed at", async () => {
    await scene(viewOf(0), narrow, async ({ rendered }) => {
      await press(rendered, "enter")
      expect(pointedAt(await rendered.capture(), "b-1")).toBe(true)
      await press(rendered, "down")
      const second = await rendered.capture()
      expect(pointedAt(second, "b-1")).toBe(false)
      expect(pointedAt(second, "d-")).toBe(true)
      await press(rendered, "up", "up")
      expect(pointedAt(await rendered.capture(), "d-1")).toBe(true)
      await press(rendered, "escape")
      const out = await rendered.capture()
      expect(pointedAt(out, "d-")).toBe(false)
      expect(pointedAt(out, "b-1")).toBe(false)
    })
  })

  test("the row selected has the pointer and goes bold, with no fill; the lines between the columns go bright with the frame", async () => {
    /** A row's state and ID: its text before the last column, the note drawn in a look of its own. */
    const beforeNote = (row: ReturnType<typeof tableRow>) =>
      row
        .slice(0, row.flatMap((each, i) => (each.char === "│" ? [i] : []))[2])
        .filter((each) => each.char.trim() !== "" && each.char !== "│")
    await scene(viewOf(0), narrow, async ({ rendered }) => {
      await press(rendered, "enter")
      const frame = await rendered.capture()
      const selected = tableRow(frame, "b-1")
      // The pointer is in its gutter inside the frame's left side, in the key's look.
      expect(gutterOf(selected)?.char).toBe(marks.selected)
      expect(gutterOf(selected)?.fg).toEqual(theme.styles.key.fg?.toInts())
      // Its text is bold on no fill, its state and ID in their own colours: the row unselected is
      // drawn in the same.
      const text = selected.filter((each) => each.char.trim() !== "" && each.char !== "│")
      expect(text.slice(1).every((each) => each.bold)).toBe(true)
      const fill = theme.form.focusedButton.bg?.toInts()
      expect(selected.some((each) => Bun.deepEquals(each.bg, fill))).toBe(false)
      await press(rendered, "down")
      const after = await rendered.capture()
      expect(gutterOf(tableRow(after, "b-1"))?.char).toBe(" ")
      expect(beforeNote(tableRow(after, "b-1")).map((each) => each.fg)).toEqual(
        beforeNote(selected)
          .slice(1)
          .map((each) => each.fg),
      )
      // Another row's lines between the columns go bright with its sides and the frame's top, and so
      // do their joins with the top and bottom, so that no column line has a bright stub at an end.
      const bright = tableFrameColour(frame)
      if (bright === undefined) throw new Error("no table frame")
      expect(bright).not.toEqual(theme.rgba("frame").toInts())
      const other = tableRow(frame, "d-1")
      const bars = other.filter((each) => each.char === "│")
      expect(bars).toHaveLength(4)
      expect(bars.map((each) => each.fg)).toEqual([bright, bright, bright, bright])
      const lines = linesOf(frame)
      const top = lines.findIndex((line) => line.trimStart().startsWith("Tickets")) + 1
      const bottom = lines.findIndex((line, y) => y > top && line.startsWith("╰"))
      const joins = [top, bottom].flatMap((y) =>
        (frame.spans.lines[y]?.spans ?? []).flatMap((span) =>
          Array.from(span.text).flatMap((char) =>
            char === "┬" || char === "┴" ? [span.fg.toInts()] : [],
          ),
        ),
      )
      expect(joins).toEqual([bright, bright, bright, bright])
    })
  })

  test("← → do nothing inside; Esc, then →, moves on", async () => {
    await scene(viewOf(1), narrow, async ({ rendered }) => {
      await press(rendered, "enter", "left", "right")
      expect(pointedAt(await rendered.capture(), "b-1")).toBe(true)
      await press(rendered, "escape", "right")
      const frame = await rendered.capture()
      expect(pointedAt(frame, "b-1")).toBe(false)
      expect(lit(frame, "Needs you")).toBe(true)
      expect(hintOf(frame)).toContain("arrows panels")
    })
  })

  test("Enter on a Blocked row opens what clears it, and Esc closes the box first", async () => {
    await scene(viewOf(0), narrow, async ({ rendered }) => {
      await press(rendered, "enter", "enter")
      expect(has(await rendered.capture(), "Leave the main checkout clean")).toBe(true)
      await press(rendered, "escape")
      const closed = await rendered.capture()
      expect(has(closed, "Leave the main checkout clean")).toBe(false)
      expect(pointedAt(closed, "b-1")).toBe(true)
      await press(rendered, "escape")
      expect(pointedAt(await rendered.capture(), "b-1")).toBe(false)
    })
  })

  test("Enter on a row with no worker view opens its box, beside the panel too", async () => {
    await scene(viewOf(1), wide, async ({ commands, rendered }) => {
      // Going in selects b-1; ↓ a merged row, whose worker is gone (w-1's is on its card).
      await press(rendered, "enter", "down")
      const before = await rendered.capture()
      expect(pointedAt(before, "d-2")).toBe(true)
      expect(has(before, "Esc close")).toBe(false)
      await press(rendered, "enter")
      // Its box, saying what the panel does of it, reading the ticket again; no open the run would
      // drop.
      const opened = await rendered.capture()
      expect(has(opened, "Esc close")).toBe(true)
      expect(has(opened, "Merged as ffd6ce4")).toBe(true)
      expect(taken(commands)).toEqual([UiCommand.ReadTicket({ ticket: "d-2" as TicketId })])
      await press(rendered, "escape")
      const closed = await rendered.capture()
      expect(has(closed, "Esc close")).toBe(false)
      expect(pointedAt(closed, "d-2")).toBe(true)
    })
  })

  test("the selection stays on its ticket as rows re-sort", async () => {
    await scene(viewOf(0), narrow, async ({ view, rendered }) => {
      await press(rendered, "enter", "down")
      const selected = await rendered.capture()
      const name = ["d-1", "d-2"].find((each) => pointedAt(selected, each)) ?? ""
      expect(name).not.toBe("")
      // Another ticket blocks, and goes above it.
      await rendered.input(() =>
        view.set(
          projected([
            ...doneRows,
            entryOf("b-1", 2, blocked, null),
            entryOf("b-2", 3, blocked, null),
          ]),
        ),
      )
      expect(pointedAt(await rendered.capture(), name)).toBe(true)
    })
  })
})

describe("inside Needs you", () => {
  test("Enter goes in; Esc comes out", async () => {
    await scene(viewOf(0), wide, async ({ rendered }) => {
      await press(rendered, "right")
      expect(has(await rendered.capture(), "Enter goes in")).toBe(true)
      await press(rendered, "enter")
      const within = await rendered.capture()
      expect(has(within, "Enter opens its worker view") || has(within, "Enter reads it all")).toBe(
        true,
      )
      await press(rendered, "escape")
      expect(has(await rendered.capture(), "Enter goes in")).toBe(true)
    })
  })
})

describe("the panel's foot says what its keys do from where the focus is", () => {
  test("a question's", async () => {
    await scene(askingView(), wide, async ({ rendered }) => {
      const elsewhere = await rendered.capture()
      expect(has(elsewhere, "1–2 answer")).toBe(true)
      expect(has(elsewhere, "Enter goes in")).toBe(false)
      await press(rendered, "right")
      expect(has(await rendered.capture(), "1–2 answer · Enter goes in")).toBe(true)
      await press(rendered, "enter")
      expect(has(await rendered.capture(), "↑↓ 1–2 · Enter answer")).toBe(true)
    })
  })

  test("a Blocked ticket's", async () => {
    await scene(viewOf(0), wide, async ({ rendered }) => {
      const elsewhere = await rendered.capture()
      expect(has(elsewhere, "move here to choose")).toBe(true)
      expect(has(elsewhere, "Enter goes in")).toBe(false)
      await press(rendered, "right")
      const focused = await rendered.capture()
      expect(has(focused, "Enter goes in")).toBe(true)
      expect(has(focused, "move here to choose")).toBe(false)
    })
  })
})

describe("inside Current", () => {
  test("the arrows move across the cards' grid, two columns", async () => {
    await scene(viewOf(4), { width: 120, height: 40 }, async ({ commands, rendered }) => {
      await press(rendered, "down", "enter", "right")
      expect(heavyOn(await rendered.capture(), "w-2")).toBe(true)
      await press(rendered, "down")
      expect(heavyOn(await rendered.capture(), "w-4")).toBe(true)
      await press(rendered, "left")
      expect(heavyOn(await rendered.capture(), "w-3")).toBe(true)
      await press(rendered, "up", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-1" as TicketId })])
    })
  })

  test("Tab and → step an attention card's buttons, then go on", async () => {
    await scene(
      viewOf(2, [permission("r1", "w-1")]),
      narrow,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        await press(rendered, "down", "enter", "right", "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Allow" } }),
        ])
        await press(rendered, "tab")
        expect(heavyOn(await rendered.capture(), "w-2")).toBe(true)
      },
    )
  })

  test("Esc comes out, then Enter goes back in; ↑ from the top level leaves", async () => {
    await scene(viewOf(2), narrow, async ({ commands, rendered }) => {
      await press(rendered, "down", "enter", "down", "escape")
      expect(hintOf(await rendered.capture())).toContain("arrows panels")
      await press(rendered, "enter", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-2" as TicketId })])
      await press(rendered, "escape", "up")
      expect(tableFrameColour(await rendered.capture())).toEqual(theme.rgba("emphasis").toInts())
    })
  })
})

describe("a click goes straight in", () => {
  test("a row selects it, without opening anything", async () => {
    await scene(viewOf(1), narrow, async ({ commands, rendered }) => {
      const frame = await rendered.capture()
      const { x, y } = where(frame, "Title of b-1")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      const after = await rendered.capture()
      expect(pointedAt(after, "b-1")).toBe(true)
      expect(hintOf(after)).toContain("arrows select")
      expect(taken(commands)).toEqual([])
    })
  })

  test("a card opens it, the keys inside Current on that card when the dashboard comes back", async () => {
    const commands = Effect.runSync(makeCommands)
    const screen = external<Screen>(Screen.Dashboard())
    const value = {
      view: external(viewOf(2)),
      screen,
      commands,
      appearance: external<Appearance>("dark"),
      themeOf,
      now: () => began,
      transcripts: feed,
    }
    await withRender(<Root value={value} />, narrow, async (rendered) => {
      const { x, y } = where(await rendered.capture(), "w-2")
      await rendered.input((setup) => setup.mockMouse.click(x + 1, y))
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-2" as TicketId })])
      await rendered.input(() => screen.set(Screen.Worker({ ticket: "w-2" as TicketId })))
      expect(has(await rendered.capture(), "← Dashboard")).toBe(true)
      await rendered.input(() => screen.set(Screen.Dashboard()))
      const back = await rendered.capture()
      expect(hintOf(back)).toContain("arrows select")
      expect(heavyOn(back, "w-2")).toBe(true)
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-2" as TicketId })])
    })
  })

  test("what is no target goes into the panel it is in", async () => {
    await scene(viewOf(1), wide, async ({ rendered }) => {
      const frame = await rendered.capture()
      const label = where(frame, "Current")
      await rendered.input((setup) => setup.mockMouse.click(label.x + 1, label.y))
      const inCurrent = await rendered.capture()
      expect(hintOf(inCurrent)).toContain("arrows select")
      expect(heavyOn(inCurrent, "w-1")).toBe(true)
      const tickets = where(inCurrent, "Tickets")
      await rendered.input((setup) => setup.mockMouse.click(tickets.x + 1, tickets.y))
      expect(pointedAt(await rendered.capture(), "b-1")).toBe(true)
      const panel = where(await rendered.capture(), "Needs you ·")
      await rendered.input((setup) => setup.mockMouse.click(panel.x + 1, panel.y))
      expect(has(await rendered.capture(), "┏")).toBe(true)
      expect(pointedAt(await rendered.capture(), "b-1")).toBe(false)
    })
  })
})

describe("a resize", () => {
  test("that drops the panel moves the focus off it, to the top of Tickets", async () => {
    await scene(viewOf(1), wide, async ({ rendered }) => {
      await press(rendered, "right", "enter")
      expect(has(await rendered.capture(), "┏")).toBe(true)
      await rendered.input((setup) => setup.resize(100, 40))
      const frame = await rendered.capture()
      expect(tableFrameColour(frame)).toEqual(theme.rgba("emphasis").toInts())
      expect(hintOf(frame)).toContain("arrows panels")
    })
  })

  test("that drops the table moves the focus off it, inside it or not", async () => {
    await scene(viewOf(1), { width: 80, height: 40 }, async ({ rendered }) => {
      await press(rendered, "enter")
      expect(pointedAt(await rendered.capture(), "b-1")).toBe(true)
      await rendered.input((setup) => setup.resize(80, 16))
      const frame = await rendered.capture()
      expect(has(frame, "Tickets")).toBe(false)
      expect(hintOf(frame)).toContain("arrows panels")
      expect(lit(frame, "Needs you")).toBe(true)
    })
  })
})

describe("1–9", () => {
  test("answer the panel's question at once from the top level, without going in", async () => {
    await scene(askingView(), wide, async ({ commands, rendered }) => {
      await Bun.sleep(settle + 50)
      await press(rendered, "1")
      expect(taken(commands)).toMatchObject([
        { _tag: "AnswerQuestion", question: "q-1", answer: "Use --flag" },
      ])
    })
  })

  test("inside Needs you ↑↓ move through its options, and Enter picks one", async () => {
    await scene(askingView(), wide, async ({ commands, rendered }) => {
      await press(rendered, "right", "enter")
      expect(has(await rendered.capture(), "> 1 Use --flag")).toBe(true)
      await press(rendered, "down")
      expect(has(await rendered.capture(), "> 2 Use --other")).toBe(true)
      await Bun.sleep(settle + 50)
      await press(rendered, "enter")
      expect(taken(commands)).toMatchObject([
        { _tag: "AnswerQuestion", question: "q-1", answer: "Use --other" },
      ])
    })
  })

  test("a click on an option picks it", async () => {
    await scene(askingView(), wide, async ({ commands, rendered }) => {
      await Bun.sleep(settle + 50)
      const { x, y } = where(await rendered.capture(), "2 Use --other")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      expect(taken(commands)).toMatchObject([
        { _tag: "AnswerQuestion", question: "q-1", answer: "Use --other" },
      ])
    })
  })

  test("answer the panel's question with the focus on Current, on a card with no request", async () => {
    const first = { _tag: "AnswerQuestion", question: "q-1", answer: "Use --flag" }
    await scene(askingView([], 1), wide, async ({ commands, rendered }) => {
      await Bun.sleep(settle + 50)
      await press(rendered, "down", "1")
      expect(taken(commands)).toMatchObject([first])
    })
    await scene(askingView([], 1), wide, async ({ commands, rendered }) => {
      await Bun.sleep(settle + 50)
      await press(rendered, "down", "enter", "1")
      expect(taken(commands)).toMatchObject([first])
    })
  })

  test("answer the panel's question at the top level, a card's question on screen as well", async () => {
    await scene(
      askingView([cardQuestion("c1", "w-1")], 1),
      wide,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        await Bun.sleep(settle + 50)
        await press(rendered, "1")
        expect(taken(commands)).toMatchObject([
          { _tag: "AnswerQuestion", question: "q-1", answer: "Use --flag" },
        ])
      },
    )
  })

  test("answer the panel's question with the focus on a card whose request has no options", async () => {
    await scene(
      askingView([permission("r1", "w-1")], 1),
      wide,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        await Bun.sleep(settle + 50)
        await press(rendered, "down")
        expect(has(await rendered.capture(), "1–2 answer")).toBe(true)
        await press(rendered, "enter", "2")
        expect(taken(commands)).toMatchObject([
          { _tag: "AnswerQuestion", question: "q-1", answer: "Use --other" },
        ])
      },
    )
  })

  test("leave a card's question its digits, the panel's foot saying what is left it", async () => {
    await scene(
      askingView([cardQuestion("c1", "w-1")], 1),
      wide,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        await Bun.sleep(settle + 50)
        await press(rendered, "down")
        const frame = await rendered.capture()
        expect(has(frame, "move here to answer")).toBe(true)
        expect(has(frame, "1–2 answer")).toBe(false)
        await press(rendered, "1", "2")
        expect(taken(commands)).toEqual([])
        await press(rendered, "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({
            requestId: "c1",
            answer: { _tag: "Choose", answers: ["Write a new"] },
          }),
        ])
      },
    )
  })

  test("answer the panel's question with a digit the card's question doesn't take", async () => {
    const five = ["One", "Two", "Three", "Four", "Five"]
    await scene(
      askingView([cardQuestion("c1", "w-1")], 1, five),
      wide,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        await Bun.sleep(settle + 50)
        await press(rendered, "down")
        expect(has(await rendered.capture(), "3–5 answer")).toBe(true)
        await press(rendered, "5")
        expect(taken(commands)).toMatchObject([
          { _tag: "AnswerQuestion", question: "q-1", answer: "Five" },
        ])
      },
    )
  })

  test("go to the card's question with the focus on Current, not the panel's", async () => {
    await scene(
      askingView([cardQuestion("c1", "w-1")], 1),
      wide,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        await press(rendered, "down", "enter", "2", "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({
            requestId: "c1",
            answer: { _tag: "Choose", answers: ["Write a new"] },
          }),
        ])
      },
    )
  })

  test("go to the target card's question where the panel shows no question", async () => {
    await scene(
      viewOf(1, [cardQuestion("c1", "w-1")]),
      wide,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        await press(rendered, "2")
        expect(hintOf(await rendered.capture())).toContain("arrows select")
        expect(taken(commands)).toEqual([])
        await press(rendered, "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({
            requestId: "c1",
            answer: { _tag: "Choose", answers: ["Write a new"] },
          }),
        ])
      },
    )
  })
})
