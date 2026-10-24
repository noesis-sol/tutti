// tutti init's form on a screen too short for it (tutti-v62n): each of its lines is one the form
// draws on a tall screen, none drawn over another; the field is drawn whole, and above it the done
// lines give up their top lines first, then the title, init's words and the stepper.
import { describe, expect, test } from "bun:test"
import {
  type Asking,
  aboveField,
  type Done,
  type InitScreen,
  InitView,
} from "../src/ui/InitForm.tsx"
import { seg } from "../src/ui/line.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { type Size, withRender } from "./render.ts"

const dark = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const never = () => {}

const done: ReadonlyArray<Done> = [
  { _tag: "Answered", title: "Workers at once", answer: "3" },
  { _tag: "Answered", title: "Install Beads", answer: "Yes" },
  { _tag: "Note", text: "Its changelog is merged with union, so that tickets keep both lines." },
  { _tag: "Answered", title: "Changelog union", answer: "Yes" },
]

const fields: Record<string, Asking | null> = {
  confirm: {
    _tag: "Confirm",
    id: 1,
    field: { question: "Install Beads?", description: "tutti tracks its tickets with bd." },
    answer: never,
    cancel: never,
  },
  select: {
    _tag: "Select",
    id: 2,
    field: {
      title: "Workers at once",
      description: "How many tickets are worked on side by side.",
      options: ["1", "2", "3 (recommended for this machine)"],
    },
    answer: never,
    cancel: never,
  },
  text: {
    _tag: "Text",
    id: 3,
    field: {
      title: "Fast check",
      description: "The command the merge check runs.",
      validate: () => "A check is a command: type one, or leave it to the scout.",
    },
    answer: never,
    cancel: never,
  },
  checklist: {
    _tag: "Checklist",
    id: 4,
    field: {
      title: "MCP servers workers get",
      description: "Those defined for this project here. Each worker gets the ones ticked.",
      options: ["github", "linear", "a server with a long name that wraps"],
      ticked: [0],
    },
    answer: never,
    cancel: never,
  },
  scout: { _tag: "Scout", id: 5, since: 0, skip: never, cancel: never },
  working: null,
}

const screenOf = (asking: Asking | null): InitScreen => ({
  steps: ["Workers", "Checks"],
  at: 0,
  done,
  asking,
})

/** The frame's lines at `size`; for a line to type in, after Enter has shown its error. */
const frame = (asking: Asking | null, size: Size) =>
  withRender(
    <InitView theme={dark} repo="/work/shop" screen={screenOf(asking)} now={0} />,
    size,
    async (rendered) => {
      if (asking?._tag === "Text") {
        await rendered.input((setup) => setup.mockInput.pressEnter())
      }
      return (await rendered.capture()).chars.split("\n")
    },
  )

/** Each of `lines` is one of `whole`'s, as a tall screen draws it. */
const expectLinesOf = (lines: ReadonlyArray<string>, whole: ReadonlyArray<string>) => {
  const known = new Set(whole)
  expect(lines.filter((line) => !known.has(line))).toEqual([])
}

/** The lines of `lines` from the first that has `text` on. */
const from = (lines: ReadonlyArray<string>, text: string) =>
  lines.slice(lines.findIndex((line) => line.includes(text)))

/** Text each field's first line has. */
const firstOf: Record<string, string> = {
  confirm: "┃ Install Beads?",
  select: "┃ Workers at once",
  text: "┃ Fast check",
  checklist: "┃ MCP servers",
  scout: "Looking for",
  working: "Setting the",
}

describe("init's form on a short screen", () => {
  for (const [name, asking] of Object.entries(fields)) {
    for (const width of [24, 40]) {
      test(`${name}, at ${width} columns: no line is drawn over another, the field whole`, async () => {
        const tall = await frame(asking, { width, height: 60 })
        const whole = from(tall, firstOf[name] ?? "")
        // The field's lines, to its last, and those with text on.
        const tallness = whole.findLastIndex((line) => line.trim() !== "") + 1
        const field = whole.filter((line) => line.trim() !== "")
        for (const height of [8, 10, 12, 14, 16, 18, 20, 24]) {
          const short = await frame(asking, { width, height })
          expectLinesOf(short, tall)
          // The field is drawn whole, so far as the screen is tall.
          const shown = from(short, firstOf[name] ?? "").filter((line) => line.trim() !== "")
          expect(shown).toEqual(field.slice(0, shown.length))
          if (tallness <= height - 1) expect(shown).toEqual(field)
        }
      })
    }
  }

  test("the done lines give up their top lines first, then the title", async () => {
    const short = (await frame(fields.checklist ?? null, { width: 40, height: 20 })).join("\n")
    expect(short).toContain("Tutti  init")
    expect(short).toContain("● Workers")
    expect(short).toContain("Changelog union  Yes")
    expect(short).not.toContain("Workers at once  3")
    const shorter = (await frame(fields.checklist ?? null, { width: 40, height: 15 })).join("\n")
    expect(shorter).not.toContain("Tutti  init")
    expect(shorter).not.toContain("Changelog union")
    expect(shorter).toContain("● Workers")
  })
})

describe("the lines above a field", () => {
  const head = [[seg("title")], [seg("about")]]
  const lines = [[seg("one")], [seg("two")], [seg("three")]]
  const texts = (left: number) =>
    aboveField(head, lines, left).map((line) => line.map((each) => each.text).join(""))

  test("are the head, a blank line, and the done lines with a blank line under them", () => {
    expect(texts(20)).toEqual(["title", "about", "", "one", "two", "three", ""])
    expect(texts(7)).toEqual(["title", "about", "", "one", "two", "three", ""])
  })

  test("give up the done lines' top lines first, keeping the blank lines around them", () => {
    expect(texts(6)).toEqual(["title", "about", "", "two", "three", ""])
    expect(texts(5)).toEqual(["title", "about", "", "three", ""])
    expect(texts(4)).toEqual(["title", "about", ""])
  })

  test("then the head's top lines, and are none where none are left", () => {
    expect(texts(2)).toEqual(["about", ""])
    expect(texts(0)).toEqual([])
    expect(texts(-3)).toEqual([])
  })

  test("with nothing done, are the head and a blank line", () => {
    expect(aboveField(head, [], 10).length).toBe(3)
  })
})
