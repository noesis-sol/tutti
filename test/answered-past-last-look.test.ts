// A question answered past the run's last look (tutti-p7o0, § 5.1): READY_EMPTY has been said and
// the full check runs, with t-2 Asked. No look comes, so the run past them reads the answer itself:
// t-2 no longer needs you, its row says `↻ answered`, the next run takes it back, and this one
// resumes nothing.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Fiber, Queue, SubscriptionRef } from "effect"
import { UiCommand } from "../src/run/commands.ts"
import { run } from "../src/run/run.ts"
import type { RunView } from "../src/run/runView.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { CheckError, CheckResult } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses, filesQuestion } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
import { advance, backlog, expectExitCode, expectLog, expectPhases, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-answered-past-last-look-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

const settle = Effect.gen(function* () {
  for (let i = 0; i < 400; i++) yield* Effect.yieldNow
})

/** What the view says of t-2: its row, Needs you, the panel's needs and Up next. */
const said = (view: RunView) => {
  const row = view.rows.find((each) => each.ticket === "t-2")
  return {
    word: row?.word,
    note: row?.note,
    needsYou: view.totals.needsYou,
    needs: view.needs.length,
    upNext: view.queue.find((each) => each.ticket === "t-2")?.answered,
  }
}

const answeredNow = {
  word: "answered",
  note: "(resumes at the next run) t-2",
  needsYou: 0,
  needs: 0,
  upNext: "the next run",
}

/**
 * A whole run with a dashboard, where t-1 merges and t-2 asks, with `answer` given the question
 * once the full check is going and the view read before and after it.
 */
const pastLastLook = async (
  answer: (shown: ScreenInputs, question: string) => Effect.Effect<void, never, Beads>,
) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const started = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  const held: Effect.Effect<CheckResult, CheckError> = Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(release)
    return passed("full")
  })
  const { settings } = appConfig()
  let before: ReturnType<typeof said> | undefined
  let after: ReturnType<typeof said> | undefined
  const ran = await scenario(
    {
      config: {
        repo,
        settings: {
          ...settings,
          checks: {
            ...settings.checks,
            full: { command: "scripts/check-full.sh", timeout: Duration.minutes(60) },
          },
        },
      },
      backlog: backlog().ticket("t-1").ticket("t-2").seeds,
      git: { dir: repo },
      worktrees: { root },
      checks: { full: [held] },
      scripts: (world) => ({
        "t-1": [
          claimsAndCloses("t-1" as TicketId, {
            claim: orDie(world.beads.update("t-1" as TicketId, { claim: true })),
            commit: orDie(
              world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
            ),
            close: orDie(world.beads.close("t-1" as TicketId, "done")),
          }),
        ],
        "t-2": [
          filesQuestion("t-2" as TicketId, {
            claim: orDie(world.beads.update("t-2" as TicketId, { claim: true })),
            file: orDie(
              Effect.andThen(
                world.beads.create({
                  title: "Which way?",
                  labels: ["human"],
                  blocks: ["t-2" as TicketId],
                }),
                world.beads.update("t-2" as TicketId, { status: "open" }),
              ),
            ),
          }),
        ],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["t-1", "t-2"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main", dashboard }))
      for (let i = 0; i < 40 && !(yield* Deferred.isDone(started)); i++) {
        yield* settle
        yield* advance(readyPoll)
      }
      yield* settle
      const inputs = shown
      if (inputs === undefined) return yield* Effect.die("no dashboard shown")
      before = said(yield* SubscriptionRef.get(inputs.view))
      const dependencies = (yield* Effect.orDie((yield* Beads).show("t-2" as TicketId)))
        .dependencies
      const question = dependencies.find((each) => each.issue?.labels.includes("human"))?.id
      if (question === undefined) return yield* Effect.die("t-2 asked nothing")
      yield* answer(inputs, question)
      // The view's projection redraws at most every frame.
      yield* advance(Duration.millis(100))
      yield* settle
      after = said(yield* SubscriptionRef.get(inputs.view))
      yield* Deferred.succeed(release, undefined)
      return yield* Fiber.join(fiber)
    }),
  )
  return { ran, before, after }
}

describe("a question answered past the run's last look", () => {
  test("from the panel, during the full check: answered at once, and the next run takes it back", async () => {
    const { ran, before, after } = await pastLastLook((inputs, question) =>
      Effect.gen(function* () {
        yield* Queue.offer(
          inputs.commands,
          UiCommand.AnswerQuestion({
            question: question as TicketId,
            answer: "This way",
            uuid: "u-1",
          }),
        )
        // Short of a ready poll: the answer's own wake reads it.
        yield* settle
      }),
    )
    expect(before).toMatchObject({ word: "for you", needsYou: 1, needs: 1 })
    expect(after).toEqual(answeredNow)
    expectExitCode(ran, 0)
    // It stays Asked, its worker not resumed: this run has ended.
    expectPhases(ran, { "t-1": "Done", "t-2": "Asked" })
    expect(ran.events.some((event) => event.kind === "answered")).toBe(false)
    expectLog(ran, ["READY_EMPTY after 2 tickets"])
  })

  test("by hand, with no command: the next ready poll reads it", async () => {
    const { ran, before, after } = await pastLastLook((_, question) =>
      Effect.gen(function* () {
        yield* Effect.orDie((yield* Beads).close(question as TicketId, "answered"))
        yield* settle
        yield* advance(readyPoll)
        yield* settle
      }),
    )
    expect(before).toMatchObject({ word: "for you", needsYou: 1, needs: 1 })
    expect(after).toEqual(answeredNow)
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Asked" })
  })
})
