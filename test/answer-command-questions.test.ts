// `tutti answer` on a question ticket, through the command line as main parses it (§ 8.1,
// tutti-kkb.35; src/cli/commands.ts's answerCommand): the listing gives the open questions after the
// requests; an option whose label starts with `-` is answered after `--`, as the listing's hint
// says, where without it the label is read as a flag; an ID that names neither a request nor an
// issue says so. A project without Beads lists no questions.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Exit, Layer } from "effect"
import { Command } from "effect/cli"
import { tuttiWith } from "../src/cli/commands.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { layer as lockLayer } from "../src/testing/RunLock.ts"

const backlog: ReadonlyArray<TestBeads.Seed> = [
  { id: "tut-1", title: "Add the flag", blockedBy: ["q-1"] },
  {
    id: "q-1",
    title: "Which flag name?",
    labels: ["human"],
    metadata: {
      options: [
        { label: "--json", description: "machine-readable" },
        { label: "--format", description: "a format name" },
      ],
      recommended: 0,
    },
  },
]

/** A main checkout, with a .beads folder where `beads`. */
const checkout = (beads: boolean): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-answer-questions-")))
  if (beads) mkdirSync(join(dir, ".beads"))
  return dir
}

/** `tutti answer …args` in `repo`, bd's backlog `backlog`: what it printed, and its exit. */
const answer = async (repo: string, args: ReadonlyArray<string>) => {
  const printed: Array<string> = []
  const errors: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...each: ReadonlyArray<unknown>) => printed.push(each.join(" ")),
    error: (...each: ReadonlyArray<unknown>) => errors.push(each.join(" ")),
  })
  const services = () =>
    Layer.mergeAll(TestBeads.layer(backlog), gitLayer({ dir: repo, files: {} }), lockLayer())
  const exit = await Effect.runPromiseExit(
    Command.runWith(tuttiWith(Effect.succeed(repo), services), {
      version: "test",
      renderErrors: false,
    })(["answer", ...args]).pipe(
      Effect.provide(BunServices.layer),
      Effect.provideService(Console.Console, console),
    ),
  )
  return { printed: printed.join("\n"), errors: errors.join("\n"), ok: Exit.isSuccess(exit) }
}

describe("tutti answer on a question", () => {
  test("lists the open questions after the requests, with the hint to answer after --", async () => {
    const { printed, ok } = await answer(checkout(true), [])
    expect(ok).toBe(true)
    expect(printed).toContain("No open requests.\n\nOpen questions:\nq-1  Which flag name?")
    expect(printed).toContain("    2. --format - a format name")
    expect(printed).toContain("answer with: tutti answer q-1 -- <an option's number or label")
  })

  test("a label that starts with - is answered after --", async () => {
    const { printed, ok } = await answer(checkout(true), ["q-1", "--", "--format"])
    expect(ok).toBe(true)
    expect(printed).toBe(
      "Answered q-1 (Which flag name?): --format. The decision is in the design of tut-1.",
    )
  })

  test("an option's number answers it too", async () => {
    const { printed } = await answer(checkout(true), ["q-1", "1"])
    expect(printed).toBe(
      "Answered q-1 (Which flag name?): --json. The decision is in the design of tut-1.",
    )
  })

  test("a question without an answer: how to answer it", async () => {
    const { errors, ok } = await answer(checkout(true), ["q-1"])
    expect(ok).toBe(false)
    expect(errors).toBe(
      "tutti answer: say how to answer q-1: an option's number or label, or your own answer in quotes",
    )
  })

  test("without Beads, no questions are listed and an ID is a request's", async () => {
    const repo = checkout(false)
    expect((await answer(repo, [])).printed).toBe("No open requests.")
    const { errors } = await answer(repo, ["q-1", "1"])
    expect(errors).toBe("tutti answer: say how to answer request q-1: allow, allow-run or deny")
  })
})
