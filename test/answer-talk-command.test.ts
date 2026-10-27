// `tutti answer --talk <question>` through the command line as main parses it (tutti-i0sz, § 8.1;
// src/answer/questions.ts's talkAnswer): the talk's answer recorded as any other, the decision in
// the blocked ticket's design; a talk left says the question stays open; one that ends otherwise
// without an answer, or can't start, fails saying why; --talk with an answer, or on a question that
// isn't open, is refused, nothing talked.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Exit, Layer } from "effect"
import { Command } from "effect/cli"
import { TalkEnd, talkLeftWhy } from "../src/agent/answerTalk.ts"
import { talkLeftLine } from "../src/answer/questions.ts"
import { needsTerminal } from "../src/answer/talkHere.ts"
import { tuttiWith } from "../src/cli/commands.ts"
import type { TicketId } from "../src/services/Beads.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { layer as lockLayer } from "../src/testing/RunLock.ts"
import type { OpenQuestion } from "../src/ui/questions.ts"

const backlog: ReadonlyArray<TestBeads.Seed> = [
  { id: "tut-1", title: "Add the flag", blockedBy: ["q-1"] },
  { id: "q-1", title: "Which flag name?", labels: ["human"] },
  { id: "q-2", title: "Answered", labels: ["human"], status: "closed" },
]

/**
 * `tutti answer …args` in a checkout with Beads, the talk ending with `end` (a string: it couldn't
 * start): what it printed, the questions talked, the backlog after it, and whether it succeeded.
 */
const answer = async (args: ReadonlyArray<string>, end: TalkEnd | string) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-answer-talk-")))
  mkdirSync(join(repo, ".beads"))
  const printed: Array<string> = []
  const errors: Array<string> = []
  const talked: Array<OpenQuestion> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...each: ReadonlyArray<unknown>) => printed.push(each.join(" ")),
    error: (...each: ReadonlyArray<unknown>) => errors.push(each.join(" ")),
  })
  const beads = TestBeads.layer(backlog)
  const services = () => Layer.mergeAll(beads, gitLayer({ dir: repo, files: {} }), lockLayer())
  const talk = (top: string) => (question: OpenQuestion) =>
    Effect.suspend(() => {
      expect(top).toBe(repo)
      talked.push(question)
      return typeof end === "string" ? Effect.fail(end) : Effect.succeed(end)
    })
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* Command.runWith(
        tuttiWith(Effect.succeed(repo), services, undefined, undefined, talk),
        { version: "test", renderErrors: false },
      )(["answer", ...args]).pipe(Effect.ignore)
      return yield* (yield* TestBeads.Backlog).issues
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, beads)),
      Effect.provideService(Console.Console, console),
    ),
  )
  const issues = Exit.isSuccess(exit) ? exit.value : []
  return {
    printed: printed.join("\n"),
    errors: errors.join("\n"),
    talked: talked.map((question) => String(question.id)),
    design: issues.find((issue) => issue.id === "tut-1")?.design ?? "",
    q1: issues.find((issue) => issue.id === "q-1")?.status,
  }
}

describe("tutti answer --talk", () => {
  test("records the answer the talk gives, as any other", async () => {
    const said = await answer(["--talk", "q-1"], TalkEnd.Answered({ answer: "--long-flag" }))
    expect(said.talked).toEqual(["q-1"])
    expect(said.printed).toBe(
      "Answered q-1 (Which flag name?): --long-flag. The decision is in the design of tut-1.",
    )
    expect(said.design).toContain("Decided (q-1): Which flag name?\n--long-flag")
    expect(said.q1).toBe("closed")
  })

  test("a talk left says the question stays open", async () => {
    const said = await answer(["--talk", "q-1"], TalkEnd.Ended({ why: talkLeftWhy }))
    expect(said.printed).toBe(talkLeftLine("q-1" as TicketId))
    expect(said.errors).toBe("")
    expect(said.q1).toBe("open")
  })

  test("a talk that ends otherwise without an answer, or can't start, says why", async () => {
    const ended = await answer(
      ["--talk", "q-1"],
      TalkEnd.Ended({ why: "its session ended: Claude Code exited" }),
    )
    expect(ended.errors).toBe(
      "tutti answer: the talk about q-1 ended without an answer: its session ended: Claude Code exited; it stays open",
    )
    expect(ended.q1).toBe("open")
    const notStarted = await answer(["--talk", "q-1"], needsTerminal)
    expect(notStarted.errors).toBe(
      `tutti answer: the answer to q-1 wasn't recorded: the talk couldn't start: ${needsTerminal}`,
    )
  })

  test("with an answer, or on a question that isn't open, nothing is talked", async () => {
    const withAnswer = await answer(["--talk", "q-1", "--", "--flag"], TalkEnd.Ended({ why: "" }))
    expect(withAnswer.errors).toBe(
      "tutti answer: --talk talks q-1 through: give it no answer and no --json",
    )
    const closed = await answer(["--talk", "q-2"], TalkEnd.Ended({ why: "" }))
    expect(closed.errors).toBe(
      "tutti answer: the answer to q-2 wasn't recorded: it isn't an open question",
    )
    const missing = await answer(["--talk", "q-9"], TalkEnd.Ended({ why: "" }))
    expect(missing.errors).toBe(
      "tutti answer: there is no open request or question q-9; tutti answer lists them",
    )
    expect([...withAnswer.talked, ...closed.talked, ...missing.talked]).toEqual([])
  })
})
