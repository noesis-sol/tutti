import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Queue } from "effect"
import type { DrainRequest } from "../src/run/drain.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  filesQuestion,
  gone,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

/** A new folder, its real path: the main checkout's (for the attention files), or the worktrees'. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-answers-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What a ticket's worker's commands do to the in-memory Beads and git. */
const commands = (world: World, root: string, id: string) => ({
  claim: orDie(world.beads.update(id, { claim: true })),
  commit: orDie(
    world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
  ),
  close: orDie(world.beads.close(id, "done")),
})

/** Claims `id`, files a question blocking it, and puts it back to open. */
const asks = (world: World, id: string): SessionScript =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        world.beads.create({ title: "Which way?", labels: ["human"], blocks: [id] }),
        world.beads.update(id, { status: "open" }),
      ),
    ),
  })

/** Closes every open question blocking `id`: the maintainer answering it. */
const answers = (world: World, id: string): Effect.Effect<void> =>
  orDie(
    Effect.gen(function* () {
      const issue = yield* world.beads.show(id)
      for (const dependency of issue.dependencies) {
        const question = dependency.issue
        if (question === undefined || question.status === "closed") continue
        if (question.labels.includes("human")) yield* world.beads.close(question.id, "answered")
      }
    }),
  )

/** Claims `id`, does `meanwhile`, then commits and closes it. */
const finishesAfter = (
  world: World,
  root: string,
  id: string,
  meanwhile: ReadonlyArray<SessionScript[number]>,
): SessionScript => {
  const c = commands(world, root, id)
  return turn([
    ...bash(`bd update ${id} --claim`, c.claim),
    ...meanwhile,
    ...bash(`git commit -am "Change (${id})"`, c.commit),
    ...bash(`bd close ${id}`, c.close),
  ])
}

/** Claims its ticket and goes, is resumed once and goes again: PAUSED. */
const pauses = (world: World, id: string): ReadonlyArray<SessionScript> => [
  [...turn([step(orDie(world.beads.update(id, { claim: true })))]).slice(0, -2), gone("exit 1")],
  [gone("exit 1")],
]

/**
 * A whole plain run on main of t-1 and t-2, one at a time, each ticket's worktree in git where the
 * Worktrees test layer puts it; `during` runs beside it.
 */
const runs = (plan: {
  readonly scripts: (world: World, root: string) => Readonly<Record<string, SessionScript[]>>
  readonly drains?: Queue.Dequeue<DrainRequest>
  readonly during?: Effect.Effect<void>
}): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
      backlog: backlog().ticket("t-1").ticket("t-2").seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["t-1", "t-2"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          ...(plan.drains === undefined ? {} : { drains: plan.drains }),
        }),
      )
      if (plan.during !== undefined) yield* plan.during
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The index of the first log line `pattern` matches; -1 when none does. */
const lineOf = (ran: Ran<unknown>, pattern: RegExp): number =>
  ran.log.findIndex((each) => pattern.test(each))

describe("the run takes the answers", () => {
  test("on the ready poll: an answered ticket is resumed beside the one running, and merges", async () => {
    const ran = await runs({
      scripts: (world, root) => ({
        "t-1": [asks(world, "t-1"), finishesAfter(world, root, "t-1", [])],
        // t-2 answers t-1's question, then goes on past a ready poll before it finishes.
        "t-2": [
          finishesAfter(world, root, "t-2", [
            step(answers(world, "t-1")),
            sleep(Duration.times(readyPoll, 2)),
          ]),
        ],
      }),
      during: Effect.gen(function* () {
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < 200; j++) yield* Effect.yieldNow
          yield* advance(readyPoll)
        }
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expectLog(ran, [
      /ASKED: t-1 waits on your answer/,
      /t-2 dispatching/,
      /^ {2}ANSWERED: \S+ \(Which way\?\) is answered, so t-1 comes back$/,
      /^ {2}RESUMED: t-1's question \S+ is answered; resuming its session/,
      /^ {2}t-1 closed \(.*\); merged into main/,
      /^ {2}t-2 closed \(.*\); merged into main/,
    ])
  })

  test("a resumed worker that stops the run holds it: PAUSED, exit 3", async () => {
    const ran = await runs({
      scripts: (world, root) => ({
        "t-1": [asks(world, "t-1"), ...pauses(world, "t-1")],
        "t-2": [finishesAfter(world, root, "t-2", [step(answers(world, "t-1"))])],
      }),
    })
    expectExitCode(ran, 3)
    expectPhases(ran, { "t-1": "Stopped", "t-2": "Done" })
    expectLog(ran, [
      /ANSWERED: \S+ \(Which way\?\) is answered, so t-1 comes back/,
      /^ {2}t-2 closed \(.*\); merged into main/,
      /^HOLD: PAUSED: t-1 still in_progress/,
      /^PAUSED: t-1 still in_progress/,
    ])
  })

  test("not while the run winds down: the answered ticket stays Asked for the next run", async () => {
    const drains = Effect.runSync(Queue.unbounded<DrainRequest>())
    const ran = await runs({
      drains,
      scripts: (world, root) => ({
        "t-1": [asks(world, "t-1"), finishesAfter(world, root, "t-1", [])],
        "t-2": [
          finishesAfter(world, root, "t-2", [
            step(
              Effect.andThen(
                Queue.offer(drains, { on: true, how: "by SIGUSR1" }),
                answers(world, "t-1"),
              ),
            ),
          ]),
        ],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Asked", "t-2": "Done" })
    expectLog(ran, [/^ {2}t-2 closed \(.*\); merged into main/, "DRAINED after 2 tickets"])
    expect(lineOf(ran, /ANSWERED/)).toBe(-1)
  })
})
