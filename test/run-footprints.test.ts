import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { Log } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  filesQuestion,
  type SessionScript,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { texts } from "../src/testing/Log.ts"
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

// The fill reads the footprints' files for real, so the workers here wait for the log lines they
// need rather than for TestClock, which the run is moved on by a ready poll at a time meanwhile.

/** A new folder, its real path: the main checkout's, or the worktrees'. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-footprints-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A ticket naming the files it works on. */
const touching = (...files: ReadonlyArray<string>): Omit<Seed, "id"> => ({ metadata: { files } })

/** The run's log so far, once the scenario has started. */
interface Logged {
  texts: Effect.Effect<ReadonlyArray<string>>
}

/** Waits, in real time, until a log line matches `pattern`; dies after 20 s without one. */
const until = (logged: Logged, pattern: RegExp): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 4000; i++) {
      if ((yield* logged.texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(5))
    }
    return yield* Effect.die(
      new Error(`no log line matched ${pattern}:\n${(yield* logged.texts).join("\n")}`),
    )
  })

/** Claims `id`, does `before`, commits `files` in its worktree, waits for `after`, then closes it. */
const works = (
  world: World,
  root: string,
  id: TicketId,
  options: {
    readonly files?: Readonly<Record<string, string>>
    readonly before?: Effect.Effect<void>
    readonly after?: Effect.Effect<void>
  } = {},
): SessionScript =>
  turn([
    ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
    ...(options.before === undefined ? [] : [step(options.before)]),
    ...bash(
      `git commit -am "Change (${id})"`,
      orDie(
        world.repository.commit(
          join(root, id),
          `Change (${id})`,
          options.files ?? { [`${id}.txt`]: "x\n" },
        ),
      ),
    ),
    ...(options.after === undefined ? [] : [step(options.after)]),
    ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
  ])

/** Claims `id`, files a question blocking it, and puts it back to open. */
const asks = (world: World, id: TicketId): SessionScript =>
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
const answers = (world: World, id: TicketId): Effect.Effect<void> =>
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

/**
 * A whole plain run on main of `seeds`, two at a time, the queue's footprint as `footprint` says,
 * each ticket's worktree in git at <worktrees>/<id>, where the configuration puts the worktrees.
 */
const runs = (plan: {
  readonly seeds: ReadonlyArray<Seed>
  readonly footprint: boolean
  readonly scripts: (
    world: World,
    root: string,
    logged: Logged,
  ) => Readonly<Record<string, SessionScript[]>>
}): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = appConfig().settings
  const logged: Logged = { texts: Effect.succeed([]) }
  return scenario(
    {
      config: {
        repo,
        worktrees: root,
        settings: {
          ...settings,
          concurrent: 2,
          queue: { ...settings.queue, footprint: plan.footprint },
        },
      },
      backlog: plan.seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root, logged),
    },
    Effect.gen(function* () {
      logged.texts = texts.pipe(Effect.provideService(Log, yield* Log))
      const git = yield* Git
      for (const seed of plan.seeds) {
        yield* git.addWorktree(repo, join(root, seed.id), {
          branch: `tutti/${seed.id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main" }))
      // A ready poll every few milliseconds, until the run ends.
      const clock = yield* Effect.forkChild(
        Effect.forever(
          Effect.andThen(
            Effect.promise(() => Bun.sleep(5)),
            advance(readyPoll),
          ),
        ),
      )
      const outcome = yield* Fiber.join(fiber)
      yield* Fiber.interrupt(clock)
      return outcome
    }),
  )
}

describe("the run's footprints", () => {
  const seeds = backlog()
    .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
    .ticket("t-2", { priority: 1, ...touching("src/a.ts") }).seeds

  test("with the queue's footprint on, a ticket touching a running one's file waits for it", async () => {
    const ran = await runs({
      seeds,
      footprint: true,
      scripts: (world, root, logged) => ({
        "t-1": [works(world, root, "t-1" as TicketId, { after: until(logged, /skipping t-2/) })],
        "t-2": [works(world, root, "t-2" as TicketId)],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expectLog(ran, [
      /t-1 dispatching/,
      /^ {2}skipping t-2: after t-1: both touch src\/a\.ts$/,
      /^ {2}t-1 settled/,
      /t-2 dispatching/,
    ])
  }, 30_000)

  test("with it off, the two run side by side", async () => {
    const ran = await runs({
      seeds,
      footprint: false,
      scripts: (world, root, logged) => ({
        "t-1": [works(world, root, "t-1" as TicketId, { after: until(logged, /t-2 dispatching/) })],
        "t-2": [works(world, root, "t-2" as TicketId)],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expect(ran.log.some((text) => text.includes("skipping"))).toBe(false)
    expectLog(ran, [/t-1 dispatching/, /t-2 dispatching/, /^ {2}t-1 closed \(.*\); merged/])
  }, 30_000)

  test("two running worktrees changing one file give LIKELY_CONFLICT", async () => {
    const warning = /LIKELY_CONFLICT/
    const ran = await runs({
      seeds: backlog()
        .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
        .ticket("t-2", { priority: 1, ...touching("src/b.ts") }).seeds,
      footprint: true,
      scripts: (world, root, logged) => ({
        "t-1": [
          works(world, root, "t-1" as TicketId, {
            files: { "src/z.ts": "z\n" },
            after: until(logged, warning),
          }),
        ],
        "t-2": [
          works(world, root, "t-2" as TicketId, {
            files: { "src/z.ts": "z\n" },
            after: until(logged, warning),
          }),
        ],
      }),
    })
    expectExitCode(ran, 0)
    expect(ran.log.filter((text) => warning.test(text))).toEqual([
      "  LIKELY_CONFLICT: t-1 and t-2 both edit src/z.ts; the second to merge may conflict",
    ])
  }, 30_000)

  test("an answered ticket's footprint counts as it is resumed", async () => {
    const ran = await runs({
      seeds: backlog()
        .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
        .ticket("t-2", { priority: 1, ...touching("src/b.ts") })
        // Ready once t-2 merges, while the resumed t-1 still runs.
        .ticket("t-3", { priority: 2, blockedBy: ["t-2"], ...touching("src/a.ts") }).seeds,
      footprint: true,
      scripts: (world, root, logged) => ({
        "t-1": [
          asks(world, "t-1" as TicketId),
          works(world, root, "t-1" as TicketId, { after: until(logged, /skipping t-3/) }),
        ],
        "t-2": [
          works(world, root, "t-2" as TicketId, {
            before: Effect.andThen(until(logged, /ASKED: t-1/), answers(world, "t-1" as TicketId)),
            after: until(logged, /RESUMED: t-1/),
          }),
        ],
        "t-3": [works(world, root, "t-3" as TicketId)],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      /^ {2}RESUMED: t-1's question \S+ is answered/,
      /^ {2}t-2 closed \(.*\); merged into main/,
      /^ {2}skipping t-3: after t-1: both touch src\/a\.ts$/,
      /^ {2}t-1 settled/,
      /t-3 dispatching/,
    ])
  }, 30_000)
})
