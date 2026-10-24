// The glob engine (glob.ts): a part matched as Go's path.Match matches it, ** any number of
// folders, and whether a glob holds a path or meets another glob, checked against what the
// globs match on paths drawn at random.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { collapseAny, globHolds, globMatch, globsMeet, isGlob } from "../src/run/glob.ts"

/** A name with each character escaped, which matches that name alone. */
const escaped = (name: string): string => [...name].map((c) => `\\${c}`).join("")

const letters = fc.constantFrom("a", "b", "c", ".", "-", "é", "[", "]", "*", "?", "\\")
const anyName = fc.array(letters, { minLength: 1, maxLength: 5 }).map((cs) => cs.join(""))
const name = fc.constantFrom("a", "b", "ab", "ba", "a.ts", "b.go", "c")
const path = fc.array(name, { minLength: 1, maxLength: 4 })
const part = fc.constantFrom(
  "**",
  "*",
  "?",
  "a",
  "b",
  "ab",
  "a*",
  "*b",
  "*.ts",
  "?.go",
  "[ab]",
  "[^a]",
  "[a-b]*",
  "\\a",
)
const glob = fc.array(part, { minLength: 1, maxLength: 4 })

describe("a part of a glob", () => {
  test("escaped, matches the name it spells and no other", () => {
    fc.assert(
      fc.property(anyName, anyName, (s, t) => {
        expect(globMatch([escaped(s)], [s])).toBe(true)
        expect(globMatch([escaped(s)], [t])).toBe(s === t)
      }),
    )
  })

  test("* matches any name, ? any one character", () => {
    fc.assert(
      fc.property(anyName, (s) => {
        expect(globMatch(["*"], [s])).toBe(true)
        expect(globMatch(["?"], [s])).toBe([...s].length === 1)
      }),
    )
  })

  test("with * between a beginning and an end matches the names with both", () => {
    const plain = fc.stringMatching(/^[a-c.]{0,3}$/)
    fc.assert(
      fc.property(plain, plain, fc.stringMatching(/^[a-c.]{1,6}$/), (start, end, s) => {
        const both = s.startsWith(start) && s.endsWith(end) && s.length >= start.length + end.length
        expect(globMatch([`${start}*${end}`], [s])).toBe(both)
      }),
    )
  })

  test("a class matches one character in it, a negated class one outside it", () => {
    fc.assert(
      fc.property(fc.constantFrom("a", "b", "c", "d", "é", "-"), (c) => {
        const inRange = c >= "a" && c <= "c"
        expect(globMatch(["[a-c]"], [c])).toBe(inRange)
        expect(globMatch(["[^a-c]"], [c])).toBe(!inRange)
        expect(globMatch(["[a-c]"], [`${c}${c}`])).toBe(false)
      }),
    )
  })

  test("malformed, matches nothing", () => {
    fc.assert(
      fc.property(anyName, (s) => {
        for (const bad of ["[", "a\\", "[a-", "[]", "[z-"])
          expect(globMatch([bad], [s])).toBe(false)
      }),
    )
  })
})

describe("a glob", () => {
  test("with its runs of ** collapsed matches the same paths", () => {
    fc.assert(
      fc.property(glob, path, (g, p) => {
        const collapsed = collapseAny(g.join("/")).split("/")
        expect(globMatch(collapsed, p)).toBe(globMatch(g, p))
      }),
    )
  })

  test("holds each path it matches, and each folder holding one", () => {
    fc.assert(
      fc.property(glob, path, (g, p) => {
        if (!globMatch(g, p)) return
        expect(globHolds(g.join("/"), p.join("/"))).toBe(true)
        if (p.length > 1) expect(globHolds(g.join("/"), `${p.slice(0, -1).join("/")}/`)).toBe(true)
      }),
    )
  })

  test("meets each glob that matches a path it matches, whichever way round", () => {
    fc.assert(
      fc.property(glob, glob, path, (g, h, p) => {
        const meet = globsMeet(g.join("/"), h.join("/"))
        expect(meet).toBe(globsMeet(h.join("/"), g.join("/")))
        if (globMatch(g, p) && globMatch(h, p)) expect(meet).toBe(true)
      }),
    )
  })

  test("is told from a plain name by its *, ? or [", () => {
    fc.assert(
      fc.property(anyName, (s) => {
        expect(isGlob(s)).toBe(/[*?[]/.test(s))
      }),
    )
  })
})
