import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  filesQuestion,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
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

/** A new folder, its real path: the main checkout's, or the worktrees'. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-footprints-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A ticket naming the files it works on. */
const touching = (...files: ReadonlyArray<string>): Omit<Seed, "id"> => ({ metadata: { files } })

/**
 * Claims `id`, does `before`, commits `files` in its worktree, goes on past `polls` ready polls (two
 * by default: long enough for the run to fill its slots beside it), then closes it.
 */
const works = (
  world: World,
  root: string,
  id: string,
  options: {
    readonly files?: Readonly<Record<string, string>>
    readonly before?: ReadonlyArray<SessionScript[number]>
    readonly polls?: number
  } = {},
): SessionScript =>
  turn([
    ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
    ...(options.before ?? []),
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
    sleep(Duration.times(readyPoll, options.polls ?? 2)),
    ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
  ])

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

/**
 * A whole plain run on main of `seeds`, two at a time, the queue's footprint as `footprint` says,
 * each ticket's worktree in git at <worktrees>/<id>, where the configuration puts the worktrees.
 */
const runs = (plan: {
  readonly seeds: ReadonlyArray<Seed>
  readonly footprint: boolean
  readonly scripts: (world: World, root: string) => Readonly<Record<string, SessionScript[]>>
}): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = appConfig().settings
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
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const seed of plan.seeds) {
        yield* git.addWorktree(repo, join(root, seed.id), {
          branch: `tutti/${seed.id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main" }))
      for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 200; j++) yield* Effect.yieldNow
        yield* advance(readyPoll)
      }
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The index of the first log line `pattern` matches; -1 when none does. */
const lineOf = (ran: Ran<unknown>, pattern: RegExp): number =>
  ran.log.findIndex((each) => pattern.test(each))

describe("the run's footprints", () => {
  const seeds = backlog()
    .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
    .ticket("t-2", { priority: 1, ...touching("src/a.ts") }).seeds

  test("with the queue's footprint on, a ticket touching a running one's file waits for it", async () => {
    const ran = await runs({
      seeds,
      footprint: true,
      scripts: (world, root) => ({
        "t-1": [works(world, root, "t-1")],
        "t-2": [works(world, root, "t-2")],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expectLog(ran, [
      /t-1 dispatching/,
      /^ {2}skipping t-2: touches src\/a\.ts, like running t-1$/,
      /^ {2}t-1 settled/,
      /t-2 dispatching/,
    ])
  })

  test("with it off, the two run side by side", async () => {
    const ran = await runs({
      seeds,
      footprint: false,
      scripts: (world, root) => ({
        "t-1": [works(world, root, "t-1")],
        "t-2": [works(world, root, "t-2")],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expect(lineOf(ran, /skipping/)).toBe(-1)
    expectLog(ran, [/t-1 dispatching/, /t-2 dispatching/, /^ {2}t-1 closed \(.*\); merged/])
  })

  test("two running worktrees changing one file give LIKELY_CONFLICT", async () => {
    const ran = await runs({
      seeds: backlog()
        .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
        .ticket("t-2", { priority: 1, ...touching("src/b.ts") }).seeds,
      footprint: true,
      scripts: (world, root) => ({
        "t-1": [works(world, root, "t-1", { files: { "src/z.ts": "z\n" } })],
        "t-2": [works(world, root, "t-2", { files: { "src/z.ts": "z\n" } })],
      }),
    })
    expectLog(ran, [
      /t-1 dispatching/,
      /t-2 dispatching/,
      /^ {2}LIKELY_CONFLICT: t-1 and t-2 both edit src\/z\.ts; the second to merge may conflict$/,
    ])
  })

  test("an answered ticket's footprint counts as it is resumed", async () => {
    const ran = await runs({
      seeds: backlog()
        .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
        .ticket("t-2", { priority: 1, ...touching("src/b.ts") })
        // Ready once t-2 merges, while the resumed t-1 still runs.
        .ticket("t-3", { priority: 2, blockedBy: ["t-2"], ...touching("src/a.ts") }).seeds,
      footprint: true,
      scripts: (world, root) => ({
        "t-1": [asks(world, "t-1"), works(world, root, "t-1", { polls: 6 })],
        "t-2": [
          works(world, root, "t-2", {
            before: [sleep(readyPoll), step(answers(world, "t-1"))],
          }),
        ],
        "t-3": [works(world, root, "t-3")],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      /^ {2}RESUMED: t-1's question \S+ is answered/,
      /^ {2}t-2 closed \(.*\); merged into main/,
      /^ {2}skipping t-3: touches src\/a\.ts, like running t-1$/,
      /^ {2}t-1 settled/,
      /t-3 dispatching/,
    ])
  })
})
