// tutti init's import question (§ 8.3) and the form's descriptions (§ 7.1): a setting tutti has no
// place for is named without its value, and a description or note keeps a path such as .orchestra/
// whole at any width, wrapped by tutti's wrap rather than OpenTUI's word mode, which breaks after
// its dot.
import { describe, expect, test } from "bun:test"
import { importOffer, importSettings, offerDescription } from "../src/init/import.ts"
import { type Asking, emptyScreen, InitView } from "../src/ui/InitForm.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { renderFrame } from "./render.ts"

const dark = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const never = () => {
  throw new Error("not answered in this test")
}

/** orchestra's settings in tutti's own checkout, 2026-10-22. */
const settings = {
  check_fast: "scripts/check-fast.sh",
  concurrent: 3,
  terminal: "herdr",
  templates: { worker_prompt: 7, verifier: 5 },
}

describe("a setting tutti has no place for", () => {
  test("is named without its value", () => {
    const imported = importSettings(settings)
    expect(imported.leftOut).toEqual([
      { key: "terminal", why: "tutti has no terminals; its workers run inside it" },
      {
        key: "templates",
        why: "the versions of orchestra's templates; tutti records those of its own",
      },
    ])
    const description = offerDescription(importOffer({ settings: imported, prompt: null }))
    expect(description).toContain(
      "It can't import terminal: tutti has no terminals; its workers run inside it and templates: the versions of orchestra's templates; tutti records those of its own.",
    )
    expect(description).not.toContain("{")
    expect(description).not.toContain("herdr")
  })

  test("a value tutti can't take, or a key it doesn't know, is still shown with its value", () => {
    const imported = importSettings({ concurrent: "many", agent_kind: "codex" })
    expect(imported.leftOut.map((each) => each.key)).toEqual([
      'concurrent ("many")',
      'agent_kind ("codex")',
    ])
  })
})

/** Collapses `text`'s runs of white space to one space. */
const collapsed = (text: string) => text.replace(/\s+/g, " ").trim()

/** The lines of `chars` where `path`, without its leading dot, doesn't follow its dot. */
const split = (chars: string, path: string): ReadonlyArray<string> =>
  chars.split("\n").filter((line) => {
    const bare = path.slice(1)
    for (let at = line.indexOf(bare); at >= 0; at = line.indexOf(bare, at + 1)) {
      if (line[at - 1] !== ".") return true
    }
    return line.trimEnd().endsWith(" .")
  })

describe("the form's descriptions", () => {
  const description = offerDescription(
    importOffer({ settings: importSettings(settings), prompt: null }),
  )
  const note = "Copied the worker prompt from .orchestra/ to .tutti/, with your changes."
  const asking: Asking = {
    _tag: "Confirm",
    id: 1,
    field: { question: "Import orchestra's settings and worker prompt?", description },
    answer: never,
    cancel: never,
  }
  const screen = {
    ...emptyScreen,
    steps: ["Workers", "Checks"] as const,
    at: 0,
    done: [{ _tag: "Note" as const, text: note }],
    asking,
  }

  test("keep .orchestra/ and .tutti/ whole at every width", async () => {
    for (let width = 24; width <= 120; width++) {
      const frame = await renderFrame(
        <InitView theme={dark} repo="/work/shop" screen={screen} now={0} />,
        { width, height: 60 },
      )
      const at = `at width ${width}:\n${frame.chars}`
      expect({ at, split: split(frame.chars, ".orchestra/") }).toEqual({ at, split: [] })
      expect({ at, split: split(frame.chars, ".tutti/") }).toEqual({ at, split: [] })
      // Every word is there, in order, and no line is wider than the screen.
      const shown = collapsed(frame.chars.replaceAll("┃", ""))
      expect({ at, has: shown.includes(collapsed(description)) }).toEqual({ at, has: true })
      expect({ at, has: shown.includes(collapsed(note)) }).toEqual({ at, has: true })
    }
  })
})
