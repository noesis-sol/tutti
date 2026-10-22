// init's question of tickets at the same time (§ 8.3), as orchestra's init asks it: options 1 to 4
// and Custom…, which asks the number, starting on the current setting's option, or on Custom… with
// the number filled in above 4. Here the choices themselves and the line form (TERM=dumb); the
// renderer's are in ui-init-form.test.tsx.
import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Effect, Exit } from "effect"
import {
  concurrencyOptions,
  concurrencyStart,
  customConcurrency,
  readConcurrency,
} from "../src/init/form.ts"
import { lineForm } from "../src/init/lineForm.ts"
import type { WorkersQuestions } from "../src/init/workers.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const plain = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const questions = (initial: number): WorkersQuestions => ({
  installBeads: null,
  concurrent: { initial, max: 16 },
  mcp: null,
  changelogUnion: false,
})

/** The Workers step in lines over `input`, which then ends: its answers, and what it wrote. */
const asked = async (initial: number, input: string) => {
  const stream = new PassThrough()
  stream.write(input)
  stream.end()
  let output = ""
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const form = lineForm({
          input: yield* streamInput(stream),
          write: (text) => {
            output += text
          },
          theme: plain,
        })
        return yield* form.workers(questions(initial))
      }),
    ),
  )
  return {
    answers: Exit.isSuccess(exit) ? exit.value : String(exit),
    output: Bun.stripANSI(output),
  }
}

describe("the choice of tickets at the same time", () => {
  test("offers orchestra's five options, Custom… up to the most", () => {
    expect(concurrencyOptions(16)).toEqual([
      "1  · one at a time (safest)",
      "2  · checks must cope with running side by side",
      "3  · that, and room for three workers and their checks",
      "4  · that, for four: a busy machine",
      "Custom…  · type a number, up to 16",
    ])
    expect(customConcurrency).toBe(4)
  })

  test("starts on the current setting's option, or on Custom… above 4", () => {
    expect([1, 2, 3, 4].map(concurrencyStart)).toEqual([0, 1, 2, 3])
    expect([5, 6, 16].map(concurrencyStart)).toEqual([4, 4, 4])
  })

  test("a typed number is a whole one from 1 to the most; nothing keeps one, or is refused", () => {
    expect(readConcurrency(" 7 ", null, 16)).toEqual({ ok: 7 })
    expect(readConcurrency("", 6, 16)).toEqual({ ok: 6 })
    for (const typed of ["", "0", "17", "2.5", "six"]) {
      expect(readConcurrency(typed, null, 16)).toEqual({
        error: "Enter a whole number from 1 to 16.",
      })
    }
  })
})

describe("the choice in lines", () => {
  test.each([1, 2, 3, 4])("option %i answers %i, with the memory note above 1", async (n) => {
    const { answers, output } = await asked(1, `${n}\n`)
    expect(answers).toEqual({ concurrent: n })
    expect(output).toContain(`5. Custom…  · type a number, up to 16`)
    expect(output.includes(`${n} workers: about ${n} GiB of memory`)).toBe(n > 1)
  })

  test("Enter keeps the current setting's option", async () => {
    expect((await asked(3, "\n")).answers).toEqual({ concurrent: 3 })
  })

  test("Custom… asks the number, refusing nothing and one out of range", async () => {
    const { answers, output } = await asked(2, "5\n\n40\n9\n")
    expect(answers).toEqual({ concurrent: 9 })
    expect(output).toContain(
      "Number of tickets at the same time\nFrom 1 to 16. Above 4: a big machine, and tickets that rarely touch the same files.\n> ",
    )
    expect(output.match(/Enter a whole number from 1 to 16\./g)).toHaveLength(2)
    expect(output).toContain("9 workers: about 9 GiB of memory, about 1 GiB per worker")
  })

  test("above 4 it starts on Custom…, and Enter keeps the number", async () => {
    const { answers, output } = await asked(6, "\n\n")
    expect(answers).toEqual({ concurrent: 6 })
    expect(output).toContain("same files. Enter keeps 6.\n")
  })

  test("above 4, another option or number can still be chosen", async () => {
    expect((await asked(6, "2\n")).answers).toEqual({ concurrent: 2 })
    expect((await asked(6, "\n12\n")).answers).toEqual({ concurrent: 12 })
  })
})
