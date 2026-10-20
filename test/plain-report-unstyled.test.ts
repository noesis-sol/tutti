import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { printReport, renderMarkdown } from "../src/print/markdown.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import {
  type Appearance,
  makeTheme,
  orchestra,
  printedTheme,
  roles,
  styleNames,
} from "../src/ui/theme.ts"

const themeOf = (appearance: Appearance, styled: boolean) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false, styled })
const unstyled = themeOf("dark", false)

/** Output written to a pipe: not a terminal. */
const piped = () => {
  const written: Array<string> = []
  const out: Out = { write: (text) => void written.push(text), columns: () => 0, tty: false }
  return { out, text: () => written.join("") }
}

describe("an unstyled theme", () => {
  test("writes no ANSI: its styles paint nothing and its roles' colours are empty", () => {
    expect(unstyled.styled).toBe(false)
    for (const name of styleNames) {
      expect(unstyled.styles[name].open).toBe("")
      expect(unstyled.styles[name].paint("text")).toBe("text")
    }
    for (const style of Object.values(unstyled.form)) expect(style.paint("text")).toBe("text")
    for (const role of roles) {
      expect(unstyled.ansi(role, "fg")).toBe("")
      expect(unstyled.ansi(role, "bg")).toBe("")
    }
  })

  test("keeps OpenTUI's colours and attributes", () => {
    const styled = themeOf("dark", true)
    expect(styled.styled).toBe(true)
    expect(unstyled.styles.done.attributes).toBe(styled.styles.done.attributes)
    expect(unstyled.rgba("done")).toEqual(styled.rgba("done"))
  })

  test("a theme is styled unless told otherwise", () => {
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "256", noColor: false })
    expect(theme.styled).toBe(true)
    expect(theme.styles.done.paint("x")).toContain("\x1b[")
  })
})

describe("the plain run's report, piped", () => {
  const report = [
    "# The run",
    "",
    "**Bold**, _italic_, ~~struck~~ and `code`, [a link](https://example.com).",
    "",
    "> A quote",
    "",
    "- one",
    "- two",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
  ].join("\n")

  test("renders its Markdown without ANSI", () => {
    const out = renderMarkdown(report, unstyled, 80)
    expect(out).not.toContain("\x1b")
    expect(out).toContain("Bold")
    expect(out).toContain("italic")
  })

  test("prints the report and organ lines without ANSI", async () => {
    const { out, text } = piped()
    const printer = makePrinter(out, unstyled)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* printer.say("Reviewer is done")
        yield* printer.warn("Scout could not say")
        const line = yield* printer.organ("Writing the report")
        yield* line.detail("3 tickets")
        yield* line.done("Report written")
        yield* printReport(printer, report, unstyled, 80)
      }),
    )
    expect(text()).not.toContain("\x1b")
    expect(text()).toContain("◆ Reviewer is done")
    expect(text()).toContain("◆ Report written")
  })

  test("whatever the report says, renders without ANSI", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 200 }), (markdown, width) => {
        expect(renderMarkdown(markdown, unstyled, width)).not.toContain("\x1b")
      }),
    )
  })
})

describe("the theme of what is printed outside the renderer", () => {
  test("off a terminal is unstyled, in the appearance chosen", async () => {
    const theme = await Effect.runPromise(
      printedTheme(themeOf, "light", { dumb: false, tty: false }),
    )
    expect(theme.styled).toBe(false)
    expect(theme.appearance).toBe("light")
  })

  test("off a terminal, with the appearance auto, asks nothing and is dark", async () => {
    const theme = await Effect.runPromise(
      printedTheme(themeOf, "auto", { dumb: false, tty: false }),
    )
    expect(theme.styled).toBe(false)
    expect(theme.appearance).toBe("dark")
  })

  test("on a terminal is styled, in the appearance chosen", async () => {
    for (const dumb of [false, true]) {
      const theme = await Effect.runPromise(printedTheme(themeOf, "light", { dumb, tty: true }))
      expect(theme.styled).toBe(true)
      expect(theme.appearance).toBe("light")
    }
  })

  test("on a dumb terminal, with the appearance auto, asks nothing and is dark", async () => {
    const theme = await Effect.runPromise(printedTheme(themeOf, "auto", { dumb: true, tty: true }))
    expect(theme.styled).toBe(true)
    expect(theme.appearance).toBe("dark")
  })
})
