import { expect, test } from "bun:test"
import { Exit } from "effect"
import fc from "fast-check"
import { schemaText } from "../scripts/gen-schemas.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import { Settings } from "../src/project/settings.ts"

const keys = ["fast", "full", "own", "setup"] as const

type Key = (typeof keys)[number]

/** The settings with `command` as checks.<key>'s, decoded: its command, or each problem. */
const decoded = (key: Key, command: string): string | ReadonlyArray<string> => {
  const exit = decodeConfig(Settings, "settings.json", { checks: { [key]: { command } } })
  if (Exit.isSuccess(exit)) return exit.value.checks[key].command ?? "null"
  return exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail"
      ? reason.error.problems.map((problem) => `${problem.path}: ${problem.message}`)
      : [],
  )
}

/** The pattern schema/settings.json gives checks.<key>.command's text. */
const schemaPattern = (key: Key): RegExp => {
  const document = JSON.parse(schemaText("settings.json"))
  const command = document.properties.checks.properties[key].properties.command
  const text = command.anyOf.find((s: { type?: string }) => s.type === "string")
  return new RegExp(text.pattern, "u")
}

const blank = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 1, maxLength: 8 })
  .map((parts) => parts.join(""))

test("a check's command of only spaces is refused, naming the key, as a blank requirement check", () => {
  for (const key of keys) {
    for (const command of [" ", "\t", "\n", "  \t\n"]) {
      expect(decoded(key, command)).toEqual([
        `checks.${key}.command: needs a check: a command that exits 0 when it is met, or null for none`,
      ])
    }
  }
})

test("a check's command with spaces around a real one decodes as it is", () => {
  for (const key of keys) {
    expect(decoded(key, " scripts/check.sh\n")).toBe(" scripts/check.sh\n")
    expect(decoded(key, "scripts/check.sh")).toBe("scripts/check.sh")
  }
})

test("the settings and their schema file refuse the same commands", () => {
  const word = fc.string({ minLength: 1 }).filter((s) => /\S/u.test(s))
  const command = fc.oneof(
    blank,
    fc.tuple(blank, word, blank).map((parts) => parts.join("")),
  )
  for (const key of keys) {
    const pattern = schemaPattern(key)
    expect(pattern.test("")).toBe(false)
    fc.assert(
      fc.property(command, (text) => {
        const taken = typeof decoded(key, text) === "string"
        expect(taken).toBe(/\S/u.test(text))
        expect(pattern.test(text)).toBe(taken)
      }),
    )
  }
})
