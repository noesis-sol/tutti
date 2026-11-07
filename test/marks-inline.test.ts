// Every glyph src/ui draws comes from src/ui/marks.ts: a scan of the source, comments left out, for
// the marks' glyphs and for an `…` that isn't the end of a word in a sentence. A text cut anywhere
// ends in the one `ellipsis` (tutti-6bwa.4).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { cut } from "../src/ui/line.tsx"
import { arrowKeys, ellipsis, marks } from "../src/ui/marks.ts"
import { oneLine } from "../src/ui/oneLine.ts"

const root = resolve(import.meta.dir, "..")

/** Each source file under `folder`, marks.ts left out. */
const sources = (folder: string): ReadonlyArray<string> =>
  [...new Bun.Glob("**/*.{ts,tsx}").scanSync(resolve(root, folder))]
    .map((file) => `${folder}/${file}`)
    .filter((file) => file !== "src/ui/marks.ts")

/** `line` of source without its comment; nothing for a line that is all comment. */
const code = (line: string): string =>
  /^\s*(\/\/|\/\*|\*)/.test(line) ? "" : line.replace(/\s\/\/ .*$/, "")

/** Each line of `files` the pattern finds in code, as `file:line`. */
const found = (files: ReadonlyArray<string>, pattern: RegExp): ReadonlyArray<string> =>
  files.flatMap((file) =>
    readFileSync(resolve(root, file), "utf8")
      .split("\n")
      .flatMap((line, index) => (pattern.test(code(line)) ? [`${file}:${index + 1}`] : [])),
  )

/**
 * The glyphs no line of src/ui spells. Not `?` and `!`, which are text as well, nor the gauge's `━`
 * and `─`, which are frames' too, nor `→`: a sentence's `a → b`, and what the transcript parses in a
 * Read tool's lines.
 */
const glyphs = [...new Set([...Object.values(marks), ...Object.values(arrowKeys).join("")])].filter(
  (glyph) => !["?", "!", "━", "─", "→"].includes(glyph),
)

describe("the glyphs of src/ui", () => {
  test("come from marks.ts", () => {
    expect(glyphs.length).toBeGreaterThan(20)
    expect(found(sources("src/ui"), new RegExp(`[${glyphs.join("")}]`, "u"))).toEqual([])
  })

  test("an ellipsis is the constant, or the end of a word in a sentence", () => {
    expect(found(sources("src/ui"), /(?<!\p{L})…/u)).toEqual([])
  })

  test("no cutter outside src/ui spells the ellipsis", () => {
    const cutters = /(\.slice\([^)]*\)|\.join\(""\)|\.trimEnd\(\))\}…/u
    expect(found(sources("src"), cutters)).toEqual([])
  })
})

describe("a text cut short", () => {
  test("ends in the ellipsis, whichever cutter cut it", () => {
    expect(
      cut([{ text: "abcdefgh", look: null }], 4)
        .at(-1)
        ?.text.at(-1),
    ).toBe(ellipsis)
    expect(oneLine("abcdefgh", 4).at(-1)).toBe(ellipsis)
  })
})
