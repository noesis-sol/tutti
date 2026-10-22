// tutti init's faint text in `formFaint` (§ 7.11's form roles): faint in the text's own colour on
// light, as tutti's other faint text, and drawn in `ansi:245`, not faint, on dark, where faint text
// reads too dim; the about line, the stepper's steps to come, the working line and the summary.
import { describe, expect, test } from "bun:test"
import { type RGBA, TextAttributes } from "@opentui/core"
import { stepNames } from "../src/init/form.ts"
import { initHeader, initSummary } from "../src/print/initSummary.ts"
import { InitView } from "../src/ui/InitForm.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { type Frame, renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

/** How a cell's colour is recorded: the terminal's default, a palette slot, or exact. */
const recordOf = (colour: RGBA): string =>
  colour.intent === "default"
    ? "default"
    : colour.intent === "indexed"
      ? `ansi:${colour.slot}`
      : `rgb ${colour.toInts().slice(0, 3).join(",")}`

/** The colour and faintness of the span that holds `text`. */
const drawnAs = (frame: Frame, text: string) => {
  const span = frame.spans.lines
    .flatMap((line) => line.spans)
    .find((each) => each.text.includes(text))
  if (span === undefined) throw new Error(`the frame doesn't hold ${text}:\n${frame.chars}`)
  return { fg: recordOf(span.fg), faint: (span.attributes & TextAttributes.DIM) !== 0 }
}

describe("the formFaint style", () => {
  test("is faint in the text's own colour where the role is default, as the light variant is", () => {
    const light = themeOf("light")
    expect(light.form.faint).toMatchObject({
      fg: undefined,
      attributes: TextAttributes.DIM,
      open: "\x1b[2m",
    })
    expect(light.form.faint.paint("x")).toBe(light.styles.dim.paint("x"))
  })

  test("is drawn in its colour, not faint, on dark", () => {
    const dark = themeOf("dark")
    expect(dark.form.faint.attributes).toBe(0)
    expect(dark.form.faint.paint("x")).toBe("\x1b[38;5;245mx\x1b[0m")
    expect(dark.form.faint.fg === undefined ? null : recordOf(dark.form.faint.fg)).toBe("ansi:245")
  })

  test("stays faint under NO_COLOR, where every role is the default", () => {
    const plain = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
    expect(plain.form.faint.paint("x")).toBe("\x1b[2mx\x1b[0m")
  })
})

describe("init's faint text", () => {
  const screen = { steps: stepNames, at: 0, done: [], asking: null }
  const draw = (appearance: Appearance) =>
    renderFrame(
      <InitView theme={themeOf(appearance)} repo="/work/shop" screen={screen} now={0} />,
      {
        width: 80,
        height: 12,
      },
    )

  test("in the form, lighter on dark and faint on light", async () => {
    const dark = await draw("dark")
    const light = await draw("light")
    for (const text of [
      "/work/shop",
      "Sets this project up",
      "○ Checks",
      "Setting the project up",
    ]) {
      expect({ text, ...drawnAs(dark, text) }).toEqual({ text, fg: "ansi:245", faint: false })
      expect({ text, ...drawnAs(light, text) }).toEqual({ text, fg: "default", faint: true })
    }
  })

  test("in the header and the summary, lighter on dark and faint on light", () => {
    const summary = {
      steps: [{ label: "worker prompt", detail: "kept .tutti/worker-prompt.md", kind: "kept" }],
      next: ["Start a run"],
      ready: true,
    } as const
    const dark = themeOf("dark")
    const light = themeOf("light")
    for (const [theme, open] of [
      [dark, "\x1b[38;5;245m"],
      [light, "\x1b[2m"],
    ] as const) {
      const text = `${initHeader(theme, "/work/shop")}\n${initSummary(summary, theme, 72)}`
      for (const faint of [
        " Sets this project up for tutti, in .tutti/.",
        "/work/shop",
        "•",
        "kept .tutti/worker-prompt.md",
        "1.",
      ]) {
        expect(text).toContain(`${open}${faint}\x1b[0m`)
      }
    }
  })
})
