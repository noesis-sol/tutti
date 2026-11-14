// The one separator of the `·` lists (tutti-6bwa.3): marks.ts spells it, line.tsx's joined and
// separatorOf draw it faint, and no line of src/ui writes a `·` of its own.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import fc from "fast-check"
import { tuttiScheme } from "../src/project/scheme.ts"
import { separator } from "../src/text/marks.ts"
import { joined, type Segments, seg, separatorOf } from "../src/ui/line.tsx"
import { makeTheme } from "../src/ui/theme.ts"

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: false })

const root = resolve(import.meta.dir, "..")

/** The text of `segments`, looks left out. */
const text = (segments: Segments): string => segments.map((each) => each.text).join("")

describe("joined", () => {
  test("puts the separator, faint, between the parts", () => {
    const parts = [[seg("bug", theme.styles.key)], [seg("P2", theme.styles.stop)]]
    expect(joined(parts, theme)).toEqual([
      seg("bug", theme.styles.key),
      seg(separator, theme.styles.dim),
      seg("P2", theme.styles.stop),
    ])
    expect(text(joined(parts, theme))).toBe("bug · P2")
  })

  test("leaves the empty parts out, with no separator for them", () => {
    expect(text(joined([[], [seg("a")], [], [seg("b")], []], theme))).toBe(`a${separator}b`)
    expect(joined([[], []], theme)).toEqual([])
  })

  test("draws the separator in the look it is given", () => {
    const parts = [[seg("a")], [seg("b")]]
    expect(joined(parts, theme, theme.form.helpSeparator)[1]).toEqual(
      seg(separator, theme.form.helpSeparator),
    )
    expect(separatorOf(theme)).toEqual(seg(separator, theme.styles.dim))
  })

  test("says the parts' words joined by the separator, as a string's join does", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (words) => {
        const parts = words.map((word) => (word === "" ? [] : [seg(word)]))
        expect(text(joined(parts, theme))).toBe(words.filter((word) => word !== "").join(separator))
      }),
    )
  })
})

describe("the separator of src/ui", () => {
  test("is written nowhere but marks.ts", () => {
    const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(resolve(root, "src/ui"))].map(
      (file) => `src/ui/${file}`,
    )
    const found = files.flatMap((file) =>
      readFileSync(resolve(root, file), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /^\s*(\/\/|\/\*|\*)/.test(line) || !line.replace(/\s\/\/ .*$/, "").includes("·")
            ? []
            : [`${file}:${index + 1}`],
        ),
    )
    expect(files.length).toBeGreaterThan(20)
    expect(found).toEqual([])
  })
})
