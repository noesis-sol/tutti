// Files without an extension (Makefile, Dockerfile, scripts/release) in a ticket's text: named by
// their path, or by their base name in backticks or capitalised, when the repository's files are
// known (tutti-shrg).
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { type FootprintTicket, ticketFootprint } from "../src/run/footprint.ts"
import { overlaps } from "../src/run/overlap.ts"
import { repoFiles } from "../src/run/repoFiles.ts"

const ticket = (title: string, description = ""): FootprintTicket => ({
  title,
  description,
  design: "",
  acceptance: "",
  labels: [],
  metadata: {},
  files: [],
  predictedFiles: [],
})

const tracked = [
  "Makefile",
  "Dockerfile",
  "web/Dockerfile",
  "scripts/release",
  "bin/tutti",
  "src/a.ts",
  "src/b.ts",
]
const repo = repoFiles(tracked)
const filesOf = (title: string, description = "", r = repo) =>
  ticketFootprint(ticket(title, description), r).files

describe("a file without an extension", () => {
  test("named capitalised holds two tickets apart, as the review reproduced", () => {
    const a = ticketFootprint(ticket("Add a lint target to the Makefile and src/a.ts"), repo)
    const b = ticketFootprint(ticket("Fix the Makefile install target; touch src/b.ts"), repo)
    expect(a.files).toEqual(["Makefile", "src/a.ts"])
    expect(b.files).toEqual(["Makefile", "src/b.ts"])
    expect(overlaps(a, b)).toBe(true)
  })

  test("is named by its path", () => {
    expect(filesOf("Update scripts/release")).toEqual(["scripts/release"])
    expect(filesOf("Run ./bin/tutti, then see bin/tutti:12.")).toEqual(["bin/tutti"])
  })

  test("named capitalised by its base name means every file of that name", () => {
    expect(filesOf("Slim the Dockerfile.")).toEqual(["Dockerfile", "web/Dockerfile"])
    expect(filesOf("Slim web/Dockerfile.")).toEqual(["web/Dockerfile"])
  })

  test("is named by its base name in backticks, not bare in lower case", () => {
    expect(filesOf("Rename `tutti` in the help")).toEqual(["bin/tutti"])
    expect(filesOf("Rename tutti in the help")).toEqual([])
  })

  test("is no path but by its exact path: a partial one or a folder names nothing", () => {
    expect(filesOf("Update release and scripts/rel and scripts")).toEqual([])
    expect(filesOf("Update src/run and nowhere/Makefile2")).toEqual([])
  })

  test("names nothing when the repository's files aren't known", () => {
    expect(filesOf("Fix the Makefile and scripts/release", "", repoFiles(undefined))).toEqual([])
  })

  test("a check command names is left out", () => {
    const checked = repoFiles(tracked, ["make check && scripts/release --dry-run"])
    expect(filesOf("Fix scripts/release; touch src/a.ts", "", checked)).toEqual(["src/a.ts"])
  })
})

// Names of a file or folder without an extension: letters, digits, _ and -.
const part = fc.stringMatching(/^[a-z](?:[a-z0-9_-]{0,6}[a-z0-9])?$/)
const capitalised = fc.stringMatching(/^[A-Z][A-Za-z0-9_]{0,9}$/)
// Words around a name: no path token runs into it.
const filler = fc.array(fc.constantFrom("fix", "the", "and", "then", "a", "target", "—"), {
  maxLength: 5,
})
const sentence = (before: ReadonlyArray<string>, name: string, after: ReadonlyArray<string>) =>
  [...before, name, ...after].join(" ")

describe("properties", () => {
  test("a tracked path without an extension, written in any sentence, is in the footprint", () => {
    fc.assert(
      fc.property(part, part, filler, filler, (dir, base, before, after) => {
        const path = `${dir}/${base}`
        const r = repoFiles([path, "src/a.ts"])
        expect(filesOf(sentence(before, path, after), "", r)).toEqual([path])
      }),
    )
  })

  test("two tickets naming a tracked capitalised base name overlap", () => {
    fc.assert(
      fc.property(capitalised, filler, filler, (base, before, after) => {
        const r = repoFiles([base, "src/a.ts", "src/b.ts"])
        const a = ticketFootprint(ticket(sentence(before, base, ["src/a.ts"])), r)
        const b = ticketFootprint(ticket(sentence(["src/b.ts"], base, after)), r)
        expect(a.files).toContain(base)
        expect(overlaps(a, b)).toBe(true)
      }),
    )
  })

  test("a lower-case base name counts in backticks only", () => {
    fc.assert(
      fc.property(part, part, filler, filler, (dir, base, before, after) => {
        const r = repoFiles([`${dir}/${base}`])
        expect(filesOf(sentence(before, base, after), "", r)).not.toContain(`${dir}/${base}`)
        expect(filesOf(sentence(before, `\`${base}\``, after), "", r)).toEqual([`${dir}/${base}`])
      }),
    )
  })

  test("without the repository's files, no word without an extension is a path", () => {
    const unknown = repoFiles(undefined)
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            part,
            capitalised,
            fc.tuple(part, part).map(([d, b]) => `${d}/${b}`),
          ),
          {
            maxLength: 8,
          },
        ),
        (words) => {
          expect(filesOf(words.join(" "), "", unknown)).toEqual([])
        },
      ),
    )
  })
})
