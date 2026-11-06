// A question answered past the run's last look (tutti-p7o0, § 5.1): READY_EMPTY has been said and
// the full check runs, with t-2 Asked. No look comes, so the run past them reads the answer itself:
// t-2 no longer needs you, its row says `↻ answered`, the next run takes it back, and this one
// resumes nothing. So too for the wait of the environment hold, whose loop is in its probe.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Fiber, Queue, SubscriptionRef } from "effect"
import { UiCommand } from "../src/run/commands.ts"
import { probeFile, probeWorker } from "../src/run/environment.ts"
import { run } from "../src/run/run.ts"
import type { RunView } from "../src/run/runView.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { CheckError, CheckResult } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { writeRunFile } from "../src/services/Worktrees.ts"
import { bash, claimsAndCloses, filesQuestion, result, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  scenario,
  type World,
} from "./harness.ts"

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

/** Claims, commits and closes `id`, as a worker does. */
const finishes = (world: World, root: string, id: string) =>
  claimsAndCloses(id as TicketId, {
    claim: orDie(world.beads.update(id as TicketId, { claim: true })),
    commit: orDie(
      world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
    ),
    close: orDie(world.beads.close(id as TicketId, "done")),
  })

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
        "t-1": [finishes(world, root, "t-1")],
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

describe("a question answered while the environment hold waits for its probe", () => {
  test("is read at once, though the loop is in the probe, and the look after it takes it back", async () => {
    const repo = folder("hold-repo")
    const root = folder("hold-worktrees")
    const givesUp = turn([], result("Every command was refused."))
    let before: Record<string, unknown> | undefined
    let after: Record<string, unknown> | undefined
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-2").ticket("t-3").ticket("t-4").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => ({
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
            finishes(world, root, "t-2"),
          ],
          "t-3": [givesUp, finishes(world, root, "t-3")],
          "t-4": [givesUp, finishes(world, root, "t-4")],
          [probeWorker]: [
            turn(
              bash(
                "echo ok > .tutti/run/probe",
                Effect.orDie(writeRunFile(repo, probeFile, "ok\n")),
              ),
            ),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["t-2", "t-3", "t-4"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", dashboard }),
        )
        // The workers' worktrees are real git, so the hold comes in real time.
        for (let i = 0; i < 2000; i++) {
          if ((yield* texts).some((text) => text.startsWith("PROBE: "))) break
          yield* Effect.promise(() => Bun.sleep(2))
          yield* settle
        }
        const inputs = shown
        if (inputs === undefined) return yield* Effect.die("no dashboard shown")
        yield* advance(Duration.millis(100))
        yield* settle
        before = said(yield* SubscriptionRef.get(inputs.view))
        const issue = yield* Effect.orDie((yield* Beads).show("t-2" as TicketId))
        const question = issue.dependencies.find((each) => each.issue?.labels.includes("human"))?.id
        if (question === undefined) return yield* Effect.die("t-2 asked nothing")
        yield* Queue.offer(
          inputs.commands,
          UiCommand.AnswerQuestion({
            question: question as TicketId,
            answer: "This way",
            uuid: "u-1",
          }),
        )
        yield* settle
        // Short of a ready poll and of the probe: the answer's own wake reads it.
        yield* advance(Duration.millis(100))
        yield* settle
        after = said(yield* SubscriptionRef.get(inputs.view))
        // The probe lifts the hold, whatever wakes the read took: the run goes on and ends.
        for (let i = 0; i < 40; i++) {
          yield* advance("1 minute")
          yield* settle
        }
        return yield* Fiber.join(fiber)
      }),
    )
    expect(before).toMatchObject({ word: "for you", needsYou: 1, needs: 1 })
    expect(after).toMatchObject({ word: "answered", needsYou: 0, needs: 0 })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-2": "Done", "t-3": "Done", "t-4": "Done" })
  })
})
