// The keys under a form (§ 7.11's form roles): as bubbles' help draws them for huh, each key in
// formHelpKey, its words in formHelpDesc, ` · ` in formHelpSeparator, in both variants, the dark one
// lighter than bubbles'.
import { describe, expect, test } from "bun:test"
import type { RGBA } from "@opentui/core"
import { formHintSegments } from "../src/ui/Form.tsx"
import { scoutCommands } from "../src/ui/InitForm.tsx"
import { hintOf } from "../src/ui/keyCommands.ts"
import { TicketCount } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import { type Appearance, makeTheme, orchestra, type Role } from "../src/ui/theme.ts"
import { withRender } from "./render.ts"
import { noSpecAsk } from "./specAsk.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const variants: ReadonlyArray<Appearance> = ["light", "dark"]

const ints = (colour: RGBA | undefined) => colour?.toInts().slice(0, 3)

/**
 * bubbles v1.0.0's help styles, as huh's Charm theme keeps them: keys, their words, separator;
 * lighter on dark, on purpose (§ 7.11's form roles).
 */
const bubbles: {
  readonly [A in Appearance]: Readonly<Record<Role & `formHelp${string}`, string>>
} = {
  light: { formHelpKey: "#909090", formHelpDesc: "#B2B2B2", formHelpSeparator: "#DDDADA" },
  dark: { formHelpKey: "#9A9A9A", formHelpDesc: "#7A7A7A", formHelpSeparator: "#5A5A5A" },
}

const rgbOf = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))

describe("a form's hint", () => {
  test.each(variants)(
    "draws keys, words and separators in bubbles' help greys, %s",
    (appearance) => {
      const theme = themeOf(appearance)
      const keys = [
        { keys: "↑↓", does: "choose" },
        { keys: "Enter", does: "confirm" },
        { keys: "Esc", does: "cancel" },
      ]
      const segments = formHintSegments(keys, theme)
      expect(segments.map((each) => each.text).join("")).toBe(
        "↑↓ choose · Enter confirm · Esc cancel",
      )
      const roleOf = (text: string): Role | undefined => {
        const look = segments.find((each) => each.text === text)?.look
        const fg = ints(look?.fg ?? undefined)
        const found = Object.entries(bubbles[appearance]).find(
          ([, hex]) => JSON.stringify(rgbOf(hex)) === JSON.stringify(fg),
        )
        return found?.[0] as Role | undefined
      }
      for (const key of keys) {
        expect(roleOf(key.keys)).toBe("formHelpKey")
        expect(roleOf(` ${key.does}`)).toBe("formHelpDesc")
      }
      expect(roleOf(" · ")).toBe("formHelpSeparator")
    },
  )

  test("of the init form's scout names its keys and their words apart", () => {
    const scout = { _tag: "Scout", id: 1, since: 0, skip: () => {}, cancel: () => {} } as const
    expect(hintOf(scoutCommands(scout))).toEqual([
      { keys: "Esc", does: "skip" },
      { keys: "Ctrl+C", does: "cancel" },
    ])
  })

  test.each(variants)("under the start question, %s", async (appearance) => {
    const theme = themeOf(appearance)
    const node = (
      <StartQuestion
        spec={noSpecAsk}
        theme={theme}
        count={TicketCount.Ready({ n: 3 })}
        answer={() => {}}
        cancel={() => {}}
      />
    )
    await withRender(node, { width: 100, height: 16 }, async (rendered) => {
      const frame = await rendered.capture()
      expect(frame.chars).toContain("↑↓ choose · Enter confirm · Esc cancel")
      const spans = frame.spans.lines.flatMap((line) => line.spans)
      const colourOf = (text: string) => ints(spans.find((span) => span.text === text)?.fg)
      expect(colourOf("Enter")).toEqual(rgbOf(bubbles[appearance].formHelpKey))
      expect(colourOf(" confirm")).toEqual(rgbOf(bubbles[appearance].formHelpDesc))
      expect(colourOf(" · ")).toEqual(rgbOf(bubbles[appearance].formHelpSeparator))
    })
  })
})
