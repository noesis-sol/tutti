// A box's keys row (tutti-q55k): in a narrow pane it breaks onto more rows, between two keys, and
// inside one only when it is wider than a row, so that no key runs past the box's frame.
import { describe, expect, test } from "bun:test"
import { Effect, Option, Queue } from "effect"
import fc from "fast-check"
import { makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { seg, widthOf } from "../src/ui/line.tsx"
import { choiceRows } from "../src/ui/Modal.tsx"
import { quitQuestion } from "../src/ui/QuitBox.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const shellOf = (): ShellValue => ({
  view: external(emptyView),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => 0,
})

const sent = (value: ShellValue): ReadonlyArray<UiCommand> => {
  const out: Array<UiCommand> = []
  for (;;) {
    const next = Effect.runSync(Queue.poll(value.commands))
    if (Option.isNone(next)) return out
    out.push(next.value)
  }
}

const openQuitBox = (rendered: Rendered) =>
  rendered.input((setup) => setup.mockInput.pressKey("c", { ctrl: true }))

/** The box's lines, from its top corner's row to its bottom corner's, cut to its columns. */
const boxOf = (frame: string) => {
  const lines = frame.split("\n")
  const top = lines.findIndex((line) => line.includes("╭"))
  const bottom = lines.findIndex((line, i) => i > top && line.includes("╰"))
  const left = (lines[top] ?? "").indexOf("╭")
  const right = (lines[top] ?? "").indexOf("╮")
  return { lines: lines.slice(top, bottom + 1), top, left, right }
}

describe("a box's keys", () => {
  for (const width of [30, 40, 53]) {
    test(`stay inside the quit box's frame in a ${width}-column pane`, async () => {
      await withRender(<Root value={shellOf()} />, { width, height: 30 }, async (rendered) => {
        await openQuitBox(rendered)
        const frame = (await rendered.capture()).chars
        expect(frame).toContain(quitQuestion.split(" ")[0] ?? "")
        const box = boxOf(frame)
        expect(box.right).toBeGreaterThan(box.left)
        for (const line of box.lines.slice(1, -1)) {
          expect(line[box.left]).toBe("│")
          expect(line[box.right]).toBe("│")
          expect(line.slice(box.right + 1).trim()).toBe("")
        }
        const inside = box.lines.map((line) => line.slice(box.left, box.right + 1)).join("\n")
        for (const words of ["stop after", "quit now", "Esc cancel"]) {
          expect(inside.replace(/[\s│]+/g, " ")).toContain(words)
        }
      })
    })
  }

  test("keep their click targets on the rows they break onto", async () => {
    const value = shellOf()
    await withRender(<Root value={value} />, { width: 30, height: 30 }, async (rendered) => {
      await openQuitBox(rendered)
      const lines = (await rendered.capture()).chars.split("\n")
      const y = lines.findIndex((line) => line.includes("Esc cancel"))
      const x = (lines[y] ?? "").indexOf("Esc cancel")
      expect(y).toBeGreaterThan(-1)
      const quit = lines.findIndex((line) => line.includes("q quit now"))
      expect(quit).not.toBe(y)
      await rendered.input((setup) => setup.mockMouse.click(x + 1, y))
      expect(sent(value)).toEqual([])
      expect((await rendered.capture()).chars).not.toContain("Esc cancel")
    })
  })

  test("stay on one row where they fit", () => {
    const keys = [
      [seg("s"), seg(" stop")],
      [seg("q"), seg(" quit")],
    ]
    expect(choiceRows(keys, seg(" · "), 20)).toEqual([
      [
        { choice: 0, segments: keys[0] ?? [] },
        { choice: 1, segments: [seg(" · "), ...(keys[1] ?? [])] },
      ],
    ])
  })

  test("are each on rows no wider than the width, every key's words in order", () => {
    const words = fc.stringMatching(/^[a-z]{1,12}( [a-z]{1,12}){0,3}$/)
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.stringMatching(/^[a-zA-Z]{1,4}$/), words), { minLength: 1 }),
        fc.integer({ min: 4, max: 60 }),
        (choices, width) => {
          const keys = choices.map(([name, does]) => [seg(name), seg(` ${does}`)])
          const rows = choiceRows(keys, seg(" · "), width)
          const pieces = rows.flat()
          for (const row of rows) {
            expect(widthOf(row.flatMap((piece) => piece.segments))).toBeLessThanOrEqual(width)
          }
          const order = pieces.map((piece) => piece.choice)
          expect(order).toEqual([...order].sort((a, b) => a - b))
          expect([...new Set(order)]).toEqual(choices.map((_, i) => i))
          choices.forEach(([name, does], i) => {
            const text = pieces
              .filter((piece) => piece.choice === i)
              .flatMap((piece) => piece.segments.map((each) => each.text))
              .join(" ")
              .replace(" · ", "")
            expect(text.replace(/\s+/g, "")).toBe(`${name}${does}`.replace(/\s+/g, ""))
          })
        },
      ),
    )
  })
})
