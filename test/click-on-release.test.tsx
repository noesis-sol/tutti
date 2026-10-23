// Clicks act on release (D9, § 7.3): a click target acts when the left button is released on the
// cell it was pressed on with no text selected, so a drag that selects text to copy, over a card's
// title or a tool line, neither opens the worker's view nor toggles the line (tutti-bh51).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeCommands } from "../src/run/commands.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { type Card, emptyView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Cards, layoutOf } from "../src/ui/Card.tsx"
import { clickable } from "../src/ui/click.ts"
import { Line, seg } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, ShellContext, type ShellValue } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/** A target on the first line, with a button on the second inside it; what each click ran. */
const target = (ran: Array<string>) => (
  <box flexDirection="column" {...clickable(() => ran.push("target"))}>
    <Line segments={[seg("Remove the build directory")]} />
    <text wrapMode="none" height={1} {...clickable(() => ran.push("button"))}>
      [ Allow ]
    </text>
  </box>
)

const onTarget = (body: (rendered: Rendered, ran: ReadonlyArray<string>) => Promise<void>) => {
  const ran: Array<string> = []
  return withRender(
    <box flexDirection="column">
      {target(ran)}
      <Line segments={[seg("Text around it, to drag from")]} />
    </box>,
    { width: 40, height: 6 },
    (rendered) => body(rendered, ran),
  )
}

const selectedText = (rendered: Rendered) =>
  (rendered.setup.renderer.getSelection()?.getSelectedText() ?? "").trim()

describe("a click target", () => {
  test("acts on a click, once", async () => {
    await onTarget(async (rendered, ran) => {
      await rendered.input((setup) => setup.mockMouse.click(3, 0))
      expect(ran).toEqual(["target"])
    })
  })

  test("acts on each of two quick clicks, though the second selects the word", async () => {
    await onTarget(async (rendered, ran) => {
      await rendered.input(async (setup) => {
        await setup.mockMouse.click(3, 0)
        await setup.mockMouse.click(3, 0)
      })
      expect(ran).toEqual(["target", "target"])
    })
  })

  test("acts on the release, not the press", async () => {
    await onTarget(async (rendered, ran) => {
      await rendered.input((setup) => setup.mockMouse.pressDown(3, 0))
      expect(ran).toEqual([])
      await rendered.input((setup) => setup.mockMouse.release(3, 0))
      expect(ran).toEqual(["target"])
    })
  })

  test("doesn't act on a drag across its text, which selects the text", async () => {
    await onTarget(async (rendered, ran) => {
      await rendered.input((setup) => setup.mockMouse.drag(0, 0, 16, 0))
      expect(ran).toEqual([])
      expect(selectedText(rendered)).toBe("Remove the build")
    })
  })

  test("doesn't act on a drag that leaves it, or one that ends on it", async () => {
    await onTarget(async (rendered, ran) => {
      await rendered.input((setup) => setup.mockMouse.drag(3, 0, 10, 2))
      await rendered.input((setup) => setup.mockMouse.drag(10, 2, 3, 0))
      expect(ran).toEqual([])
    })
  })

  test("doesn't act on a press and release of one cell after a drag away from it", async () => {
    await onTarget(async (rendered, ran) => {
      await rendered.input((setup) => setup.mockMouse.drag(3, 0, 10, 2))
      await rendered.input(async (setup) => {
        await setup.mockMouse.pressDown(0, 2)
        await setup.mockMouse.moveTo(3, 0)
        await setup.mockMouse.release(3, 0)
      })
      expect(ran).toEqual([])
    })
  })

  test("doesn't act on the right button", async () => {
    await onTarget(async (rendered, ran) => {
      await rendered.input((setup) => setup.mockMouse.click(3, 0, 2))
      expect(ran).toEqual([])
    })
  })

  test("a click on a button inside it runs the button only", async () => {
    await onTarget(async (rendered, ran) => {
      await rendered.input((setup) => setup.mockMouse.click(3, 1))
      await rendered.input((setup) => setup.mockMouse.click(3, 0))
      expect(ran).toEqual(["button", "target"])
    })
  })
})

describe("a card", () => {
  const card: Card = {
    ticket: "t-1",
    label: "t-1",
    title: "Remove the build",
    worker: 1,
    phase: TicketPhase.ToMerge({ place: 1 }),
    state: null,
    status: "to merge",
    motion: "◼",
    since: 0,
    action: null,
    latest: null,
    steered: false,
    requests: [],
  }

  // The cards run their own clock: the shell's, at 0.
  const shell: ShellValue = {
    view: external(emptyView),
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf: () => theme,
    now: () => 0,
  }

  const onCard = (body: (rendered: Rendered, opened: ReadonlyArray<string>) => Promise<void>) => {
    const opened: Array<string> = []
    return withRender(
      <ShellContext.Provider value={shell}>
        <Cards
          cards={[card]}
          theme={theme}
          layout={layoutOf([card], 80, 20)}
          width={80}
          room={20}
          stopping={false}
          highlighted={null}
          open={(ticket) => opened.push(ticket)}
          focusOf={() => null}
          press={() => {}}
        />
      </ShellContext.Provider>,
      { width: 80, height: 20 },
      (rendered) => body(rendered, opened),
    )
  }

  const titleAt = async (rendered: Rendered) => {
    const lines = (await rendered.capture()).chars.split("\n")
    const y = lines.findIndex((line) => line.includes("Remove the build"))
    return { x: (lines[y] ?? "").indexOf("Remove the build"), y }
  }

  test("a drag across its title selects it and opens nothing", async () => {
    await onCard(async (rendered, opened) => {
      const { x, y } = await titleAt(rendered)
      await rendered.input((setup) => setup.mockMouse.drag(x, y, x + 16, y))
      expect(opened).toEqual([])
      expect(selectedText(rendered)).toBe("Remove the build")
    })
  })

  test("a click on it opens its worker's view", async () => {
    await onCard(async (rendered, opened) => {
      const { x, y } = await titleAt(rendered)
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      expect(opened).toEqual(["t-1"])
    })
  })
})
