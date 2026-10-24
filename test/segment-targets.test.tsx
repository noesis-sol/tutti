// Click targets in the text model (tutti-rvzn.28): a segment may name the target it is part of, an
// id that the line drawing it hands to its `press`, kept as the line is cut, wrapped and padded; a
// frame's edge holds a label of such segments, and a FrameRow draws its sides around what isn't
// segments.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  boxed,
  cut,
  FrameRow,
  frameEdge,
  Line,
  Lines,
  padded,
  type Segments,
  seg,
  widthOf,
  wrap,
} from "../src/ui/line.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const frame = theme.look("frame")

/** The letters of `line`, its spaces left out, each with its target. */
const lettersOf = (line: Segments) =>
  line.flatMap((each) =>
    [...each.text].filter((ch) => ch !== " ").map((ch) => [ch, each.target] as const),
  )

describe("a segment's target", () => {
  test("seg puts it only where it is given", () => {
    expect(seg("a")).toEqual({ text: "a", look: null })
    expect(seg("a", null, 2)).toEqual({ text: "a", look: null, target: 2 })
  })

  test("is kept by cut, the piece cut short included", () => {
    expect(cut([seg("plain "), seg("[ Allow ]", null, 1)], 10)).toEqual([
      seg("plain "),
      seg("[ A…", null, 1),
    ])
  })

  test("is kept on each grapheme as a line is wrapped and padded", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.stringMatching(/^[a-z ]{1,10}$/), fc.option(fc.nat(3), { nil: undefined })),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 4, max: 30 }),
        (pieces, width) => {
          const line = pieces.map(([text, target]) => seg(text, null, target))
          const wrapped = wrap(line, width).flatMap((each) => padded(each, width))
          // A wrap drops spaces and pads with its own: each letter keeps its target.
          expect(lettersOf(wrapped)).toEqual(lettersOf(line))
        },
      ),
    )
  })
})

describe("a frame's edge", () => {
  test("is boxed's top and bottom without a label", () => {
    const lines = boxed([[seg("in it")]], 12, frame)
    expect(lines[0]).toEqual(frameEdge("top", 12, frame))
    expect(lines.at(-1)).toEqual(frameEdge("bottom", 12, frame))
    expect(
      frameEdge("top", 12, frame)
        .map((each) => each.text)
        .join(""),
    ).toBe(`╭${"─".repeat(10)}╮`)
  })

  test("holds a label at its right, its target kept, the frame's width whatever its length", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z ]{1,40}$/),
        fc.integer({ min: 6, max: 50 }),
        (word, width) => {
          const line = frameEdge("top", width, frame, "rounded", [seg(word, null, 0)])
          expect(widthOf(line)).toBe(width)
          const text = line.map((each) => each.text).join("")
          expect(text.startsWith("╭")).toBe(true)
          expect(text.endsWith(" ─╮")).toBe(true)
          expect(line.filter((each) => each.target === 0).length).toBe(1)
        },
      ),
    )
  })
})

describe("a line's press", () => {
  test("a click on a target's segments presses its id; elsewhere, nothing", async () => {
    const pressed: Array<number> = []
    const line: Segments = [
      seg("deny it? "),
      seg("[ Deny ]", theme.form.button, 0),
      seg("  "),
      seg("[ Allow", theme.form.button, 1),
      seg(" ]", theme.form.button, 1),
    ]
    await withRender(
      <Lines lines={[line]} press={(target) => pressed.push(target)} />,
      { width: 40, height: 2 },
      async (rendered) => {
        expect((await rendered.capture()).chars).toContain("deny it? [ Deny ]  [ Allow ]")
        await rendered.input((setup) => setup.mockMouse.click(2, 0))
        expect(pressed).toEqual([])
        await rendered.input((setup) => setup.mockMouse.click(11, 0))
        await rendered.input((setup) => setup.mockMouse.click(26, 0))
        // The two segments of a target, one after the other, are one target.
        await rendered.input((setup) => setup.mockMouse.click(27, 0))
        expect(pressed).toEqual([0, 1, 1])
      },
    )
  })

  test("a line without press draws its targets as plain text", async () => {
    await withRender(
      <Line segments={[seg("[ Release ]", theme.form.button, 0)]} />,
      { width: 20, height: 1 },
      async (rendered) => {
        expect((await rendered.capture()).chars).toContain("[ Release ]")
      },
    )
  })
})

describe("a FrameRow", () => {
  test("draws boxed's sides around what it holds, in boxed's columns", async () => {
    const lines = boxed([[seg("above")], [], [seg("below")]], 16, frame)
    await withRender(
      <box flexDirection="column">
        <Lines lines={lines.slice(0, 2)} />
        <FrameRow width={16} frame={frame}>
          <text>field</text>
        </FrameRow>
        <Lines lines={lines.slice(3)} />
      </box>,
      { width: 16, height: 5 },
      async (rendered) => {
        const rows = (await rendered.capture()).chars.split("\n")
        const drawn = lines.map((each) => each.map((piece) => piece.text).join(""))
        expect(rows.slice(0, 5)).toEqual(
          drawn.map((each, i) => (i === 2 ? `│ ${"field".padEnd(12)} │` : each)),
        )
      },
    )
  })
})
