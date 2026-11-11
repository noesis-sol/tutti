// Tab starts the box selection (§ 7.3, tutti-149z.5): from the dashboard's top level it goes into
// Current on its first card, Shift+Tab its last, Enter opens it and Esc comes back out. It goes on
// through an attention card's buttons, the next card, past the last Needs you or the totals' Needs
// you, then the rows that want you, and round. The arrows keep the two levels.

import { describe, expect, test } from "bun:test"
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
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { type TabStop, tabStop } from "../src/ui/panelFocus.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { emptyTranscript, type TranscriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"
import { hintFrom, hintOf, pointedAt, selectedRow } from "./screen.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

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

const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "0c1a9e7" }) })

const cardsOf = (workers: number) =>
  Array.from({ length: workers }, (_, i) =>
    entryOf(`w-${i + 1}`, 10 + i, TicketPhase.Working(), i + 1),
  )

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

/** A done row and `workers` cards, with nothing else wanting you. */
const quiet = (workers: number, requests: ReadonlyArray<AttentionRequest> = []): RunView =>
  projected([entryOf("d-1", 0, merged, null), ...cardsOf(workers)], requests)

/** `others`, a-1 waiting on q-1, and `workers` cards. */
const asking = (workers: number, others: ReadonlyArray<Entry> = []): RunView =>
  projected(
    [
      ...others,
      entryOf("a-1", 5, TicketPhase.Asked({ question: "q-1" }), null),
      ...cardsOf(workers),
    ],
    [],
    {
      questions: new Map([
        [
          "q-1",
          {
            id: "q-1" as TicketId,
            title: "Which flag name?",
            description: "",
            options: [
              { label: "Use --flag", description: "" },
              { label: "Use --other", description: "" },
            ],
            maintainerOnly: false,
            waiting: ["a-1" as TicketId],
          },
        ],
      ]),
    },
  )

/** B-1 Blocked and a-1 Asked, the rows that want you in that order, and `workers` cards. */
const wanting = (workers: number): RunView =>
  asking(workers, [entryOf("b-1", 0, TicketPhase.Blocked({ why: "DIRTY_TREE" }), null)])

const permission = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket: ticket as TicketId,
  kind: { _tag: "Permission", tool: "Bash", input: {}, suggestions: [], summary: "ls" },
  displayName: "Bash",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

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

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
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
    readonly screen: Settable<Screen>
    readonly commands: Commands
    readonly pass: (millis: number) => void
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(start)
  const screen = external<Screen>(Screen.Dashboard())
  const commands = Effect.runSync(makeCommands)
  let at = began
  const value = {
    view,
    screen,
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    transcripts: feed,
    now: () => at,
  }
  await withRender(<Root value={value} />, size, (rendered) =>
    body({ view, screen, commands, pass: (millis) => (at += millis), rendered }),
  )
}

const wide = { width: 155, height: 40 }
const narrow = { width: 100, height: 40 }

const linesOf = (frame: Frame) => frame.chars.split("\n")

/** Whether a card's heavy frame is drawn round `ticket`, and no other card's. */
const heavyOn = (frame: Frame, ticket: string) =>
  linesOf(frame).some((line) => line.includes("┃") && line.includes(ticket))

/** Whether a span of `text` on `frame` has the focus's fill. */
const lit = (frame: Frame, text: string) =>
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

describe("tabStop", () => {
  const card = (ticket: string): TabStop => ({ panel: "current", ticket })
  const row = (ticket: string): TabStop => ({ panel: "tickets", ticket })
  const needs: TabStop = { panel: "needs", ticket: null }
  const stops = [card("w-1"), card("w-2"), needs, row("a-1"), row("b-1")]

  test("from the top level, the first or last card, whatever else there is", () => {
    expect(tabStop(stops, null, 1)).toEqual(card("w-1"))
    expect(tabStop(stops, null, -1)).toEqual(card("w-2"))
  })

  test("goes on through them, round both ways", () => {
    expect(tabStop(stops, card("w-1"), 1)).toEqual(card("w-2"))
    expect(tabStop(stops, card("w-2"), 1)).toEqual(needs)
    expect(tabStop(stops, needs, 1)).toEqual(row("a-1"))
    expect(tabStop(stops, row("b-1"), 1)).toEqual(card("w-1"))
    expect(tabStop(stops, card("w-1"), -1)).toEqual(row("b-1"))
    expect(tabStop(stops, needs, -1)).toEqual(card("w-2"))
  })

  test("from a row that is no stop, as from the top level", () => {
    expect(tabStop(stops, row("d-1"), 1)).toEqual(card("w-1"))
    expect(tabStop(stops, row("d-1"), -1)).toEqual(card("w-2"))
  })

  test("with no cards, the first or last of what needs you; with nothing, none", () => {
    const left = [needs, row("a-1")]
    expect(tabStop(left, null, 1)).toEqual(needs)
    expect(tabStop(left, null, -1)).toEqual(row("a-1"))
    expect(tabStop([], null, 1)).toBeUndefined()
    expect(tabStop([], card("w-1"), -1)).toBeUndefined()
  })

  test("the one stop there is stays", () => {
    expect(tabStop([card("w-1")], card("w-1"), 1)).toEqual(card("w-1"))
    expect(tabStop([card("w-1")], card("w-1"), -1)).toEqual(card("w-1"))
  })
})

describe("Tab at the top level", () => {
  test("goes into Current on its first card, Shift+Tab on its last", async () => {
    await scene(quiet(3), narrow, async ({ rendered }) => {
      await press(rendered, "tab")
      const first = await rendered.capture()
      expect(heavyOn(first, "w-1")).toBe(true)
      expect(heavyOn(first, "w-2")).toBe(false)
      expect(hintFrom(first, "Esc back", 3)).toEqual(["Esc back", "arrows select", "Enter open"])
    })
    await scene(quiet(3), narrow, async ({ rendered }) => {
      await press(rendered, "shift+tab")
      const last = await rendered.capture()
      expect(heavyOn(last, "w-3")).toBe(true)
      expect(heavyOn(last, "w-1")).toBe(false)
      expect(hintFrom(last, "Esc back", 3)).toEqual(["Esc back", "arrows select", "Enter open"])
    })
  })

  test("starts at the first card from any panel, not at the panel after it", async () => {
    await scene(wanting(2), wide, async ({ rendered }) => {
      await press(rendered, "right")
      expect(lit(await rendered.capture(), "1 Use --flag")).toBe(false)
      await press(rendered, "tab")
      expect(heavyOn(await rendered.capture(), "w-1")).toBe(true)
    })
    await scene(quiet(2), narrow, async ({ rendered }) => {
      await press(rendered, "down", "tab")
      const frame = await rendered.capture()
      expect(heavyOn(frame, "w-1")).toBe(true)
      expect(heavyOn(frame, "w-2")).toBe(false)
    })
  })

  test("starts at the first card, not the card of the oldest request", async () => {
    await scene(quiet(2, [permission("r2", "w-2")]), narrow, async ({ rendered }) => {
      expect(heavyOn(await rendered.capture(), "w-2")).toBe(true)
      await press(rendered, "tab")
      expect(heavyOn(await rendered.capture(), "w-1")).toBe(true)
    })
  })

  test("starts at the first card from a totals' Needs you the arrows came to", async () => {
    await scene(wanting(2), narrow, async ({ rendered }) => {
      await press(rendered, "up")
      expect(lit(await rendered.capture(), "Needs you")).toBe(true)
      await press(rendered, "tab")
      const frame = await rendered.capture()
      expect(heavyOn(frame, "w-1")).toBe(true)
      expect(pointedAt(frame, "b-1")).toBe(false)
    })
  })

  test("starts at the first card from a cell the arrows came to after a resize moved it off", async () => {
    await scene(wanting(2), narrow, async ({ rendered }) => {
      await press(rendered, "tab", "tab", "tab")
      expect(lit(await rendered.capture(), "Needs you")).toBe(true)
      await rendered.input((setup) => setup.resize(wide.width, wide.height))
      await rendered.input((setup) => setup.resize(narrow.width, narrow.height))
      await press(rendered, "up")
      expect(lit(await rendered.capture(), "Needs you")).toBe(true)
      await press(rendered, "tab")
      const frame = await rendered.capture()
      expect(heavyOn(frame, "w-1")).toBe(true)
      expect(pointedAt(frame, "b-1")).toBe(false)
    })
  })

  test("Enter then opens the card, in one press", async () => {
    await scene(quiet(2), narrow, async ({ commands, rendered }) => {
      await press(rendered, "tab", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-1" as TicketId })])
    })
    await scene(quiet(2), narrow, async ({ commands, rendered }) => {
      await press(rendered, "shift+tab", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-2" as TicketId })])
    })
  })

  test("Esc comes back out to the top, on Current", async () => {
    await scene(quiet(2), narrow, async ({ commands, rendered }) => {
      await press(rendered, "tab", "tab", "escape")
      expect(hintOf(await rendered.capture()).slice(0, 3)).toEqual([
        "Tab select",
        "arrows panels",
        "Enter go in",
      ])
      expect(taken(commands)).toEqual([])
      // Back in with Enter on the card it left, and out of it again with Tab from the top.
      await press(rendered, "enter", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-2" as TicketId })])
      await press(rendered, "escape", "tab", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-1" as TicketId })])
    })
  })

  test("with the key help open, does nothing", async () => {
    await scene(quiet(2), narrow, async ({ commands, rendered }) => {
      await press(rendered, "?", "tab", "?", "enter")
      expect(taken(commands)).toEqual([])
      expect(hintOf(await rendered.capture())).toContain("arrows select")
    })
  })
})

describe("Tab inside", () => {
  test("steps an attention card's buttons, then goes on to the next card", async () => {
    await scene(
      quiet(2, [permission("r1", "w-1")]),
      narrow,
      async ({ commands, pass, rendered }) => {
        pass(settle)
        // In on its Deny, then its Allow, which Enter presses; Tab goes on from there.
        await press(rendered, "tab", "tab", "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Allow" } }),
        ])
        await press(rendered, "tab")
        expect(heavyOn(await rendered.capture(), "w-2")).toBe(true)
        await press(rendered, "shift+tab")
        expect(heavyOn(await rendered.capture(), "w-1")).toBe(true)
        expect(heavyOn(await rendered.capture(), "w-2")).toBe(false)
      },
    )
  })
})

describe("Tab past the last card", () => {
  test("goes on to Needs you, the rows that want you, and round to the first card", async () => {
    await scene(wanting(2), wide, async ({ rendered }) => {
      await press(rendered, "tab", "tab")
      expect(heavyOn(await rendered.capture(), "w-2")).toBe(true)
      await press(rendered, "tab")
      const onPanel = await rendered.capture()
      expect(onPanel.chars).toContain("┏")
      expect(heavyOn(onPanel, "w-2")).toBe(false)
      expect(pointedAt(onPanel, "b-1")).toBe(false)
      expect(hintOf(onPanel)).toContain("Esc back")
      await press(rendered, "tab")
      const firstRow = await rendered.capture()
      expect(pointedAt(firstRow, "b-1")).toBe(true)
      expect(firstRow.chars).toContain("b-1 blocked: DIRTY_TREE")
      await press(rendered, "tab")
      const secondRow = await rendered.capture()
      expect(pointedAt(secondRow, "a-1")).toBe(true)
      expect(secondRow.chars).toContain("Which flag name?")
      await press(rendered, "tab")
      const round = await rendered.capture()
      expect(pointedAt(round, "a-1")).toBe(false)
      expect(heavyOn(round, "w-1")).toBe(true)
    })
  })

  test("Needs you's question takes the keys as Tab goes in", async () => {
    await scene(asking(1), wide, async ({ rendered }) => {
      await press(rendered, "tab", "tab")
      expect((await rendered.capture()).chars).toContain("> 1 Use --flag")
    })
  })

  test("Shift+Tab goes the other way, from the first card to the last row", async () => {
    await scene(wanting(2), wide, async ({ rendered }) => {
      await press(rendered, "tab", "shift+tab")
      expect(pointedAt(await rendered.capture(), "a-1")).toBe(true)
      await press(rendered, "shift+tab")
      expect(pointedAt(await rendered.capture(), "b-1")).toBe(true)
      await press(rendered, "shift+tab")
      const onPanel = await rendered.capture()
      expect(onPanel.chars).toContain("┏")
      expect(pointedAt(onPanel, "b-1")).toBe(false)
      await press(rendered, "shift+tab")
      expect(heavyOn(await rendered.capture(), "w-2")).toBe(true)
    })
  })

  test("goes round to the first card with nothing else wanting you", async () => {
    await scene(quiet(2), narrow, async ({ rendered }) => {
      await press(rendered, "tab", "tab", "tab")
      const frame = await rendered.capture()
      expect(heavyOn(frame, "w-1")).toBe(true)
      expect(heavyOn(frame, "w-2")).toBe(false)
    })
  })

  test("in a pane with no panel, goes on to the totals' Needs you, then the rows", async () => {
    await scene(wanting(1), narrow, async ({ rendered }) => {
      await press(rendered, "tab", "tab")
      expect(lit(await rendered.capture(), "Needs you")).toBe(true)
      await press(rendered, "tab")
      const row = await rendered.capture()
      expect(lit(row, "Needs you")).toBe(false)
      expect(pointedAt(row, "b-1")).toBe(true)
    })
  })

  test("Esc on the totals' Needs you it came to, and Tab starts over", async () => {
    await scene(wanting(1), narrow, async ({ rendered }) => {
      await press(rendered, "tab", "tab", "escape")
      expect(lit(await rendered.capture(), "Needs you")).toBe(true)
      await press(rendered, "tab")
      expect(heavyOn(await rendered.capture(), "w-1")).toBe(true)
    })
  })

  test("a row Tab reached opens as any row does", async () => {
    await scene(wanting(0), wide, async ({ rendered }) => {
      await press(rendered, "tab", "tab", "enter")
      expect((await rendered.capture()).chars).toContain("Leave the main checkout clean")
    })
  })

  test("skips a question answered here", async () => {
    await scene(asking(1), wide, async ({ commands, rendered }) => {
      await Bun.sleep(settle + 50)
      await press(rendered, "1")
      expect(taken(commands)).toMatchObject([{ question: "q-1", answer: "Use --flag" }])
      await press(rendered, "tab", "tab")
      const frame = await rendered.capture()
      expect(pointedAt(frame, "a-1")).toBe(false)
      expect(heavyOn(frame, "w-1")).toBe(true)
    })
  })

  test("reaches only the rows drawn", async () => {
    const blocked = Array.from({ length: 30 }, (_, i) =>
      entryOf(`b-${i}`, i, TicketPhase.Blocked({ why: "DIRTY_TREE" }), null),
    )
    await scene(projected(blocked), wide, async ({ rendered }) => {
      const drawn = linesOf(await rendered.capture()).flatMap(
        (line) => line.match(/b-\d+/)?.[0] ?? [],
      )
      expect(drawn.length).toBeLessThan(30)
      await press(rendered, "shift+tab")
      expect(selectedRow(await rendered.capture())?.ticket).toBe(drawn.at(-1))
    })
  })
})

describe("Tab with no cards", () => {
  test("goes to Needs you", async () => {
    await scene(asking(0), wide, async ({ rendered }) => {
      await press(rendered, "tab")
      expect((await rendered.capture()).chars).toContain("> 1 Use --flag")
    })
  })

  test("in a pane with no panel, to the totals' Needs you", async () => {
    await scene(wanting(0), narrow, async ({ rendered }) => {
      await press(rendered, "tab")
      expect(lit(await rendered.capture(), "Needs you")).toBe(true)
    })
  })

  test("to the first row that wants you, where the panel has nothing to go into", async () => {
    const aside = TicketPhase.Deferred({ why: "by the worker" })
    await scene(
      projected([entryOf("s-1", 0, aside, null), entryOf("s-2", 1, aside, null)]),
      wide,
      async ({ rendered }) => {
        await press(rendered, "tab")
        expect(pointedAt(await rendered.capture(), "s-")).toBe(true)
      },
    )
  })

  test("does nothing with nothing to go to, and the hint doesn't name it", async () => {
    await scene(quiet(0), wide, async ({ commands, rendered }) => {
      const before = await rendered.capture()
      expect(hintOf(before)).not.toContain("Tab select")
      expect(hintFrom(before, "arrows panels", 2)).toEqual(["arrows panels", "Enter go in"])
      await press(rendered, "tab")
      const after = await rendered.capture()
      expect(after.chars).toBe(before.chars)
      expect(tableFrameColour(after)).toEqual(tableFrameColour(before))
      await press(rendered, "shift+tab")
      expect((await rendered.capture()).chars).toBe(before.chars)
      expect(taken(commands)).toEqual([])
    })
  })

  test("once the only question is answered here, does nothing, and the hint doesn't name it", async () => {
    await scene(asking(0), wide, async ({ commands, rendered }) => {
      expect(hintOf(await rendered.capture())).toContain("Tab select")
      await Bun.sleep(settle + 50)
      await press(rendered, "1")
      expect(taken(commands)).toMatchObject([{ question: "q-1", answer: "Use --flag" }])
      const before = await rendered.capture()
      expect(hintOf(before)).not.toContain("Tab select")
      await press(rendered, "tab")
      expect((await rendered.capture()).chars).toBe(before.chars)
    })
  })

  test("with the table left out, does nothing, though the hint names it (tutti-qylo)", async () => {
    const aside = TicketPhase.Deferred({ why: "by the worker" })
    const size = { width: 80, height: 20 }
    await scene(
      projected([entryOf("s-1", 0, aside, null)]),
      size,
      async ({ commands, rendered }) => {
        const before = await rendered.capture()
        expect(before.chars).not.toContain("s-1")
        expect(before.chars).toContain("Tab select")
        await press(rendered, "tab")
        expect((await rendered.capture()).chars).toBe(before.chars)
        expect(taken(commands)).toEqual([])
      },
    )
  })

  describe("below the minimum size, which draws none", () => {
    const small = { width: 50, height: 20 }

    test("goes to the totals' Needs you, not a hidden card", async () => {
      await scene(wanting(2), small, async ({ commands, rendered }) => {
        expect((await rendered.capture()).chars).toContain("Tab select")
        await press(rendered, "tab")
        const frame = await rendered.capture()
        expect(frame.chars).toContain("Enter go in")
        expect(frame.chars).not.toContain("Esc back")
        expect(taken(commands)).toEqual([])
        await press(rendered, "enter")
        expect(taken(commands).some((command) => command._tag === "OpenWorker")).toBe(false)
      })
    })

    test("does nothing with nothing needing you, though workers run, and isn't named", async () => {
      await scene(quiet(2), small, async ({ commands, rendered }) => {
        expect((await rendered.capture()).chars).not.toContain("Tab select")
        await press(rendered, "tab")
        expect((await rendered.capture()).chars).toContain("arrows panels")
        await press(rendered, "shift+tab")
        expect((await rendered.capture()).chars).toContain("arrows panels")
        expect(taken(commands)).toEqual([])
      })
    })

    test("a row only set aside is no stop, as the table isn't drawn, and isn't named", async () => {
      const aside = TicketPhase.Deferred({ why: "by the worker" })
      await scene(projected([entryOf("s-1", 0, aside, null)]), small, async ({ rendered }) => {
        const before = await rendered.capture()
        expect(before.chars).not.toContain("Tab select")
        await press(rendered, "tab")
        expect((await rendered.capture()).chars).toBe(before.chars)
      })
    })

    test("beside the end-of-run box too", async () => {
      const ended = { ...quiet(1), endOfRun: [{ ticket: "w-1", asks: ["a question"] }] }
      await scene(ended, small, async ({ commands, rendered }) => {
        await press(rendered, "tab")
        const frame = await rendered.capture()
        expect(frame.chars).not.toContain("Tab select")
        expect(frame.chars).not.toContain("Esc back")
        expect(taken(commands)).toEqual([])
      })
    })
  })

  describe("beside the end-of-run box, which draws none", () => {
    const ending = (view: RunView): RunView => ({
      ...view,
      endOfRun: [{ ticket: "w-1", asks: ["a question"] }],
    })

    test("goes to what needs you, not behind the box", async () => {
      await scene(ending(asking(1)), wide, async ({ rendered }) => {
        await press(rendered, "tab")
        expect((await rendered.capture()).chars).toContain("> 1 Use --flag")
      })
    })

    test("does nothing with nothing to go to, and Enter still goes in, to open a worker", async () => {
      await scene(ending(quiet(1)), wide, async ({ commands, rendered }) => {
        expect(hintOf(await rendered.capture())).not.toContain("Tab select")
        await press(rendered, "tab")
        expect(hintOf(await rendered.capture())).not.toContain("Esc back")
        await press(rendered, "down", "enter", "enter")
        expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-1" as TicketId })])
      })
    })
  })
})

describe("the two levels stay", () => {
  test("the arrows move between the panels at the top, Enter goes in, Esc comes out", async () => {
    await scene(wanting(1), wide, async ({ commands, rendered }) => {
      const onTable = tableFrameColour(await rendered.capture())
      await press(rendered, "right")
      const onPanel = await rendered.capture()
      expect(onPanel.chars).toContain("┏")
      expect(tableFrameColour(onPanel)).not.toEqual(onTable)
      expect(hintOf(onPanel)).toContain("arrows panels")
      await press(rendered, "down")
      const onCurrent = await rendered.capture()
      expect(heavyOn(onCurrent, "w-1")).toBe(true)
      expect(hintOf(onCurrent)).toContain("arrows panels")
      await press(rendered, "enter")
      expect(hintOf(await rendered.capture())).toContain("Esc back")
      expect(taken(commands)).toEqual([])
      await press(rendered, "escape", "up")
      expect(hintOf(await rendered.capture())).toContain("arrows panels")
    })
  })

  test("the hint and the key help name Tab apart from the arrows", async () => {
    await scene(quiet(1), narrow, async ({ rendered }) => {
      expect(hintOf(await rendered.capture()).slice(0, 3)).toEqual([
        "Tab select",
        "arrows panels",
        "Enter go in",
      ])
      await press(rendered, "?")
      const help = await rendered.capture()
      expect(help.chars).toContain("select the cards and buttons, then what needs you")
      expect(help.chars).toContain("move between the panels; inside one, select in it")
      await press(rendered, "?", "tab")
      expect(hintOf(await rendered.capture())).not.toContain("Tab select")
    })
  })
})

describe("coming back from a worker's view", () => {
  test("finds the keys on the card Tab opened", async () => {
    await scene(quiet(2), narrow, async ({ commands, rendered, screen }) => {
      await press(rendered, "tab", "tab", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-2" as TicketId })])
      await rendered.input(() => screen.set(Screen.Worker({ ticket: "w-2" as TicketId })))
      await rendered.input(() => screen.set(Screen.Dashboard()))
      const back = await rendered.capture()
      expect(heavyOn(back, "w-2")).toBe(true)
      expect(hintOf(back)).toContain("Esc back")
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "w-2" as TicketId })])
    })
  })
})
