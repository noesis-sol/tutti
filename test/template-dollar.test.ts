// Commands with $ sequences ($$, $&, $` and $', which a replacement string reads as patterns) go
// into the worker prompt and the verifier exactly as written, and --update leaves them as they are.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { suiteLines, verifierSection, verifierText } from "../src/init/checks.ts"
import type { Suite } from "../src/init/runners.ts"
import { currentPrompt } from "../src/init/templates.ts"
import {
  builtInWorkerPrompt,
  forTicket,
  unknownSuitesLines,
  withSuites,
} from "../src/project/prompt.ts"

const port = "PORT=$((3000 + $$ % 100)) bun test"

/** A shell command of words, the replacement patterns among them. */
const command = fc
  .array(
    fc.oneof(
      fc.constantFrom("$$", "$&", "$`", "$'", "$1", "$<a>", "$((1 + $$))", "\"$'x'\"", "$"),
      fc.constantFrom("bun", "test", "PORT=$$", "grep", "-c", "x", "%", "100"),
    ),
    { minLength: 1, maxLength: 6 },
  )
  .map((words) => words.join(" "))

const suite = fc.record({
  name: fc.constantFrom("unit", "e2e $$", "", "lint $&"),
  command,
  targeted: fc.option(command, { nil: undefined }),
  serial: fc.boolean(),
})

const suites = fc.array(suite, { maxLength: 4 }).map((each) =>
  each.map((one): Suite => {
    const { targeted, ...rest } = one
    return targeted === undefined ? { ...rest, foundIn: "x" } : { ...rest, targeted, foundIn: "x" }
  }),
)

/** `text` with every $ as ¤, which the templates don't hold; `dollars` turns them back. */
const plain = (text: string): string => text.replaceAll("$", "¤")
const dollars = (text: string): string => text.replaceAll("¤", "$")
const plainSuites = (list: ReadonlyArray<Suite>): ReadonlyArray<Suite> =>
  list.map((each) => ({
    ...each,
    name: plain(each.name),
    command: plain(each.command),
    ...(each.targeted === undefined ? {} : { targeted: plain(each.targeted) }),
  }))

describe("$ in commands written into templates", () => {
  test("the worker prompt has the suite lines as written, and --update keeps them", () => {
    fc.assert(
      fc.property(suites, suites, (fast, full) => {
        const lines = suiteLines(fast, full)
        const prompt = withSuites(builtInWorkerPrompt, lines)
        const expected =
          lines === ""
            ? builtInWorkerPrompt
            : builtInWorkerPrompt.split(unknownSuitesLines).join(lines)
        expect(prompt).toBe(expected)
        expect(prompt).toBe(
          dollars(
            withSuites(builtInWorkerPrompt, suiteLines(plainSuites(fast), plainSuites(full))),
          ),
        )
        // --update fills the template again with the prompt's own lines, as often as it runs.
        expect(currentPrompt(prompt)).toBe(prompt)
        expect(currentPrompt(currentPrompt(prompt))).toBe(prompt)
        const verifying = `${prompt}${verifierSection}`
        expect(currentPrompt(verifying)).toBe(verifying)
      }),
    )
  })

  test("the verifier has the commands and the stack as written", () => {
    fc.assert(
      fc.property(fc.array(command), fc.array(command), fc.array(command), (stack, fast, full) => {
        const text = verifierText(stack, fast, full)
        expect(text).toBe(dollars(verifierText(stack.map(plain), fast.map(plain), full.map(plain))))
        for (const each of [...fast, ...full]) expect(text).toContain(`- \`${each}\`\n`)
      }),
    )
  })

  test("a port from the shell's PID reaches the prompt and the verifier whole", () => {
    const lines = suiteLines([{ name: "unit", command: port, foundIn: "x", serial: false }], [])
    const prompt = withSuites(builtInWorkerPrompt, lines)
    expect(prompt).toContain(`\`${port}\``)
    expect(currentPrompt(prompt)).toBe(prompt)
    expect(verifierText([], [port], [])).toContain(`  - \`${port}\`\n`)
  })

  test("a ticket's ID goes in as written", () => {
    expect(forTicket({ text: "ticket TICKET_ID.", file: null }, "a-$&")).toBe("ticket a-$&.")
  })
})
