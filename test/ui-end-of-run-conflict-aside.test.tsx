// The end-of-run box naming a conflict set aside (§ 4.3, § 5 item 14) leaves within reach what it
// says: `h` in Needs you hands it back, and `q` ends the run.

import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { conflictSetAside, emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const t1 = "t-1" as TicketId

const view: RunView = project({
  ledger: {
    tickets: new Map([
      [
        t1,
        {
          ticket: t1,
          title: "Title of t-1",
          phase: TicketPhase.Blocked({ why: "MERGE_CONFLICT" }),
          since: began,
          worker: null,
          row: 0,
          rechecking: false,
          steered: false,
          lastMessage: null,
          tallies: emptyTallies,
        },
      ],
    ]),
    rows: 1,
    windDown: null,
    bugs: [],
  },
  workers: new Map(),
  requests: [],
  status: {
    ...emptyStatus,
    version: "0.1.0",
    branch: "batch",
    began,
    concurrency: 1,
    endOfRun: [t1],
  },
  actions: new Map(),
})

const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const scene = (
  size: { readonly width: number; readonly height: number },
  body: (at: { readonly commands: Commands; readonly rendered: Rendered }) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  return withRender(
    <Root
      value={{
        view: external(view),
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
      }}
    />,
    size,
    (rendered) => body({ commands, rendered }),
  )
}

const wide = { width: 160, height: 40 }

describe("the box naming a conflict set aside", () => {
  test("names it and says what you can do", async () => {
    await scene(wide, async ({ rendered }) => {
      const frame = await until(rendered, (now) => now.chars.includes(conflictSetAside))
      expect(frame.chars).toContain(`t-1 (${conflictSetAside})`)
      expect(frame.chars).toContain("hands it back once more")
    })
  })

  test("Tab to Needs you, then `h`, hands it back", async () => {
    await scene(wide, async ({ commands, rendered }) => {
      await until(rendered, (now) => now.chars.includes(conflictSetAside))
      await rendered.input((setup) => setup.mockInput.pressTab())
      await until(rendered, (now) => now.chars.includes("h hands it back"))
      taken(commands)
      await rendered.input((setup) => setup.mockInput.typeText("h"))
      expect(taken(commands)).toEqual([UiCommand.HandBackNow({ ticket: t1 })])
    })
  })

  test("`q` ends the run", async () => {
    await scene(wide, async ({ commands, rendered }) => {
      await until(rendered, (now) => now.chars.includes(conflictSetAside))
      taken(commands)
      await rendered.input((setup) => setup.mockInput.typeText("q"))
      expect(taken(commands)).toEqual([UiCommand.EndRun()])
    })
  })
})
