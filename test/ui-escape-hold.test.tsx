// The Esc hold (§ 7.3, OpenTUI #1661): a mouse report split after its ESC, the rest read after the
// stdin parser's timeout, gives an Esc key and then the mouse event; the Esc is held a moment and
// dropped when the rest of a report follows, so it doesn't close an open box.
import { describe, expect, test } from "bun:test"
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
import { type Rendered, withRender } from "./render.ts"

const ESC = "\x1b"

/** A holder over `hold` ms, and what it has pressed: `esc` for each Esc it let through. */
const holderOf = (hold: number = 20) => {
  const pressed: Array<string> = []
  const holder = escapeHolder(() => pressed.push("esc"), hold)
  /** A key, noted in `pressed` when the holder lets it through. */
  const key = (sequence: string) => {
    if (!holder.key(sequence)) pressed.push(sequence)
  }
  return { holder, key, pressed }
}

describe("the Esc hold", () => {
  test("presses a lone Esc once the hold ends", async () => {
    const { key, pressed } = holderOf()
    key(ESC)
    expect(pressed).toEqual([])
    await Bun.sleep(40)
    expect(pressed).toEqual(["esc"])
  })

  test("drops it when the rest of a report is read next, SGR or X10", async () => {
    for (const rest of ["[<64;87;26M", "[<0;1;2m", "[M`!!"]) {
      const { holder, key, pressed } = holderOf()
      key(ESC)
      holder.read(rest)
      await Bun.sleep(40)
      expect(pressed).toEqual([])
    }
  })

  test("a lone [ waits for the next read: the rest of a report drops it, other bytes press it", async () => {
    const report = holderOf()
    report.key(ESC)
    report.holder.read("[")
    report.holder.read("<64;87;26M")
    await Bun.sleep(40)
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

  test("a second Esc presses the first and is held in turn", async () => {
    const { key, pressed } = holderOf()
    key(ESC)
    key(ESC)
    expect(pressed).toEqual(["esc"])
    await Bun.sleep(40)
    expect(pressed).toEqual(["esc", "esc"])
  })

  test("stopping drops a held Esc", async () => {
    const { holder, key, pressed } = holderOf()
    key(ESC)
    holder.stop()
    await Bun.sleep(40)
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

/** How long the stdin parser waits before a lone ESC is a key: its 20 ms, and some. */
const parserWait = 40

describe("a mouse report split after its ESC", () => {
  test("leaves the quit box open", async () => {
    await withQuitBox(async (rendered) => {
      await rendered.input(async (setup) => {
        setup.renderer.stdin.emit("data", Buffer.from(ESC))
        await Bun.sleep(parserWait)
        setup.renderer.stdin.emit("data", Buffer.from("[<64;87;26M"))
        await Bun.sleep(escapeHold + 20)
      })
      expect((await rendered.capture()).chars).toContain(quitQuestion)
    })
  })

  test("while a lone Esc still closes it, after the hold", async () => {
    await withQuitBox(async (rendered) => {
      await rendered.input(async (setup) => {
        setup.renderer.stdin.emit("data", Buffer.from(ESC))
        await Bun.sleep(parserWait + escapeHold + 20)
      })
      expect((await rendered.capture()).chars).not.toContain(quitQuestion)
    })
  })
})
