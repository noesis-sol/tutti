// `h` where Needs you's panel says `Press h` (tutti-aeah): selecting in the tickets table drives the
// panel, so `h` hands back the ticket Blocked on its merge conflict it shows, wherever the focus is,
// as the digits answer its question; never one the selection has only just moved to.

import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const conflict = TicketPhase.Blocked({ why: "MERGE_CONFLICT" })
const dirty = TicketPhase.Blocked({ why: "DIRTY_TREE" })

const entryOf = (ticket: string, row: number, phase: Entry["phase"]): Entry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since: began + row * 60_000,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const viewOf = (tickets: ReadonlyArray<Entry>): RunView =>
  project({
    ledger: {
      tickets: new Map(tickets.map((each) => [each.ticket, each])),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 4 },
    actions: new Map(),
  })

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key === "tab") setup.mockInput.pressTab()
      else if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "up" || key === "down") setup.mockInput.pressArrow(key)
      else await setup.mockInput.typeText(key)
    }
  })

const settled = () => Bun.sleep(settle + 50)

const wide = { width: 155, height: 40 }
const narrow = { width: 100, height: 40 }

const scene = async (
  tickets: ReadonlyArray<Entry>,
  size: { readonly width: number; readonly height: number },
  body: (at: { readonly commands: Commands; readonly rendered: Rendered }) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  const value = {
    view: external(viewOf(tickets)),
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began,
  }
  await withRender(<Root value={value} />, size, (rendered) => body({ commands, rendered }))
}

const handsBack = (ticket: string) => [UiCommand.HandBackNow({ ticket: ticket as TicketId })]

const two = [entryOf("b-1", 0, conflict), entryOf("b-2", 1, conflict)]

describe("`h` where the panel says to press it", () => {
  test("inside Tickets, hands back the row selected", async () => {
    await scene(two, wide, async ({ commands, rendered }) => {
      await press(rendered, "enter", "down")
      await settled()
      expect((await rendered.capture()).chars).toContain("b-2 blocked: MERGE_CONFLICT")
      await press(rendered, "h")
      expect(taken(commands)).toEqual(handsBack("b-2"))
    })
  })

  test("at the top level of Tickets, hands back the row the panel selected by itself", async () => {
    await scene(two, wide, async ({ commands, rendered }) => {
      await settled()
      await press(rendered, "h")
      expect(taken(commands)).toEqual(handsBack("b-1"))
    })
  })

  test("with the focus on Current, hands back the row the panel shows", async () => {
    await scene(two, wide, async ({ commands, rendered }) => {
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      await settled()
      await press(rendered, "h")
      expect(taken(commands)).toEqual(handsBack("b-1"))
    })
  })

  test("a row selected on anything but its conflict has no `h`", async () => {
    await scene(
      [entryOf("b-1", 0, conflict), entryOf("d-1", 1, dirty)],
      wide,
      async ({ commands, rendered }) => {
        await press(rendered, "enter", "down")
        await settled()
        expect((await rendered.capture()).chars).toContain("d-1 blocked: DIRTY_TREE")
        await press(rendered, "h")
        expect(taken(commands)).toEqual([])
      },
    )
  })

  test("a key meant for the row before does nothing to the row just moved to", async () => {
    await scene(two, wide, async ({ commands, rendered }) => {
      await press(rendered, "enter")
      await settled()
      // In one read: the row hasn't been drawn when `h` comes, whatever the time since the last.
      await press(rendered, "down", "h")
      expect(taken(commands)).toEqual([])
      // Drawn, but only just.
      await press(rendered, "h")
      expect(taken(commands)).toEqual([])
      await settled()
      await press(rendered, "h")
      expect(taken(commands)).toEqual(handsBack("b-2"))
    })
  })

  test("in a pane with no panel, says nothing and does nothing inside Tickets", async () => {
    await scene(two, narrow, async ({ commands, rendered }) => {
      await press(rendered, "enter")
      await settled()
      expect((await rendered.capture()).chars).not.toContain("Press h")
      await press(rendered, "h")
      expect(taken(commands)).toEqual([])
    })
  })

  test("with the key help open, does nothing", async () => {
    await scene(two, wide, async ({ commands, rendered }) => {
      await settled()
      await press(rendered, "?")
      await press(rendered, "h")
      expect(taken(commands)).toEqual([])
    })
  })

  test("the panel's foot names it with the focus in the table", async () => {
    await scene(two, wide, async ({ rendered }) => {
      await press(rendered, "enter")
      const frame = await rendered.capture()
      expect(frame.chars).toContain("h hands it back")
      expect(frame.chars).not.toContain("move here to choose")
    })
  })
})
