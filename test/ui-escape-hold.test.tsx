// The Esc hold (§ 7.3, OpenTUI #1661): a mouse report split after its ESC, the rest read after the
// stdin parser's timeout, gives an Esc key and then the mouse event; the Esc is held a moment and
// dropped when the rest of a report follows, so it doesn't close an open box.
import { describe, expect, test } from "bun:test"
import { ManualClock } from "@opentui/core/testing"
import { Effect } from "effect"
import fc from "fast-check"
import { makeCommands } from "../src/run/commands.ts"
import { emptyView, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { escapeHold, escapeHolder } from "../src/ui/keys.ts"
import { quitQuestion } from "../src/ui/QuitBox.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { leap, parserWait, pressEscape, type Rendered, withRender } from "./render.ts"

const ESC = "\x1b"

/**
 * A holder over `hold` ms on a manual clock, and what it has pressed: `esc` for each Esc it let
 * through.
 */
const holderOf = (hold: number = 20) => {
  const pressed: Array<string> = []
  const clock = new ManualClock()
  const holder = escapeHolder(() => pressed.push("esc"), clock, hold)
  /** A key, noted in `pressed` when the holder lets it through. */
  const key = (sequence: string) => {
    if (!holder.key(sequence)) pressed.push(sequence)
  }
  return { clock, holder, key, pressed }
}

describe("the Esc hold", () => {
  test("presses a lone Esc once the hold ends", () => {
    const { clock, key, pressed } = holderOf()
    key(ESC)
    clock.advance(19)
    expect(pressed).toEqual([])
    clock.advance(1)
    expect(pressed).toEqual(["esc"])
  })

  test("drops it when the rest of a report is read next, SGR or X10", () => {
    for (const rest of ["[<64;87;26M", "[<0;1;2m", "[M`!!"]) {
      const { clock, holder, key, pressed } = holderOf()
      key(ESC)
      holder.read(rest)
      clock.runAll()
      expect(pressed).toEqual([])
    }
  })

  test("a lone [ waits for the next read: the rest of a report drops it, other bytes press it", () => {
    const report = holderOf()
    report.key(ESC)
    report.holder.read("[")
    report.holder.read("<64;87;26M")
    report.clock.runAll()
    expect(report.pressed).toEqual([])
    const typed = holderOf()
    typed.key(ESC)
    typed.holder.read("[")
    typed.holder.read("x")
    expect(typed.pressed).toEqual(["esc"])
  })

  test("other bytes read press it at once", () => {
    const { holder, key, pressed } = holderOf(1000)
    key(ESC)
    holder.read("q")
    expect(pressed).toEqual(["esc"])
    holder.read("[<64;87;26M")
    expect(pressed).toEqual(["esc"])
  })

  test("a key while it is held presses it first", () => {
    const { key, pressed } = holderOf(1000)
    key(ESC)
    key("q")
    expect(pressed).toEqual(["esc", "q"])
  })

  test("a second Esc presses the first and is held in turn", () => {
    const { clock, key, pressed } = holderOf()
    key(ESC)
    key(ESC)
    expect(pressed).toEqual(["esc"])
    clock.runAll()
    expect(pressed).toEqual(["esc", "esc"])
  })

  test("stopping drops a held Esc", () => {
    const { clock, holder, key, pressed } = holderOf()
    key(ESC)
    holder.stop()
    clock.runAll()
    expect(pressed).toEqual([])
  })

  test("holds nothing but a lone Esc, whatever is read between keys", () => {
    const notEsc = fc.string().filter((sequence) => sequence !== ESC)
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.string(), notEsc)), (steps) => {
        const { holder, key, pressed } = holderOf(1000)
        for (const [bytes, sequence] of steps) {
          holder.read(bytes)
          key(sequence)
        }
        expect(pressed).toEqual(steps.map(([, sequence]) => sequence))
      }),
    )
  })
})

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const shellOf = (view: RunView = emptyView): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => 0,
})

/** The dashboard, with the quit box open. */
const withQuitBox = (body: (rendered: Rendered) => Promise<void>) =>
  withRender(<Root value={shellOf()} input={{}} />, { width: 80, height: 24 }, async (rendered) => {
    await rendered.input((setup) => setup.mockInput.pressCtrlC())
    expect((await rendered.capture()).chars).toContain(quitQuestion)
    await body(rendered)
  })

describe("a mouse report split after its ESC", () => {
  test("leaves the quit box open", async () => {
    await withQuitBox(async (rendered) => {
      await rendered.input((setup) => {
        setup.renderer.stdin.emit("data", Buffer.from(ESC))
        leap(setup, parserWait)
        setup.renderer.stdin.emit("data", Buffer.from("[<64;87;26M"))
        leap(setup, escapeHold)
      })
      expect((await rendered.capture()).chars).toContain(quitQuestion)
    })
  })

  test("while a lone Esc still closes it, after the hold", async () => {
    await withQuitBox(async (rendered) => {
      await rendered.input(pressEscape)
      expect((await rendered.capture()).chars).not.toContain(quitQuestion)
    })
  })
})
