import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Organs } from "../src/organs/Organs.ts"
import { Log } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { Git } from "../src/services/Git.ts"
import { type SessionScript, run as step, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Backlog, type Seed } from "../src/testing/Beads.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
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

// A real run starts the predictor (predict.ts) with organs, the queue's footprint on and more than
// one slot. The fill reads the footprints' files for real, so the workers wait for the log lines
// they need rather than for TestClock, which a ready poll at a time moves on meanwhile.

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-predictor-${name}-`)))

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

/** Claims `id`, commits a file of its own in its worktree, waits for `after`, then closes it. */
const works = (
  world: World,
  root: string,
  id: string,
  after?: Effect.Effect<void>,
): SessionScript =>
  turn([
    step(orDie(world.beads.update(id, { claim: true }))),
    step(
      orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
    ),
    ...(after === undefined ? [] : [step(after)]),
    step(orDie(world.beads.close(id, "done"))),
  ])

interface Predicted {
  readonly calls: ReadonlyArray<OrganCallRecord>
  /** Each ticket's predicted_files metadata at the end of the run. */
  readonly kept: Readonly<Record<string, string | undefined>>
}

/**
 * A whole plain run on main of `seeds`, `concurrent` at a time with the queue's footprint on, with
 * organs whose predictor answers `files`; src/a.ts and src/b.ts are in the repository.
 */
const runs = (plan: {
  readonly seeds: ReadonlyArray<Seed>
  readonly concurrent: number
  readonly files: ReadonlyArray<string>
  readonly scripts: (
    world: World,
    root: string,
    logged: Logged,
  ) => Readonly<Record<string, SessionScript[]>>
}): Promise<Ran<Outcome & Predicted>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = appConfig().settings
  const logged: Logged = { texts: Effect.succeed([]) }
  const calls: Array<OrganCallRecord> = []
  const organs = Organs.layer.pipe(
    Layer.provideMerge(cannedLayer({ predictor: { files: plan.files } }, calls)),
  )
  return scenario(
    {
      config: {
        repo,
        worktrees: root,
        settings: {
          ...settings,
          concurrent: plan.concurrent,
          queue: { ...settings.queue, footprint: true },
        },
      },
      backlog: plan.seeds,
      git: {
        dir: repo,
        files: { "README.md": "# r\n", "src/a.ts": "// a\n", "src/b.ts": "// b\n" },
      },
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
      const backlog = yield* Backlog
      const kept: Record<string, string | undefined> = {}
      for (const seed of plan.seeds) {
        const files = (yield* Effect.orDie(backlog.get(seed.id)))?.metadata.predicted_files
        kept[seed.id] = typeof files === "string" ? files : undefined
      }
      return { ...outcome, calls, kept }
    }).pipe(Effect.provide(organs)),
  )
}

const value = <A>(ran: Ran<A>): A => {
  if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
  return ran.exit.value
}

describe("the run's predictor", () => {
  test("guesses a ticket naming nothing, which then waits for a running ticket on those files", async () => {
    const ran = await runs({
      seeds: backlog()
        .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
        .ticket("t-2", { priority: 1, ...touching("src/b.ts") })
        .ticket("t-3", { priority: 2, title: "Make the greeting friendlier" }).seeds,
      concurrent: 2,
      files: ["src/a.ts"],
      scripts: (world, root, logged) => ({
        "t-1": [works(world, root, "t-1", until(logged, /skipping t-3/))],
        "t-2": [works(world, root, "t-2", until(logged, /t-3 footprint predicted/))],
        "t-3": [works(world, root, "t-3")],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      /^ {2}t-3 footprint predicted: src\/a\.ts$/,
      /^ {2}skipping t-3: touches src\/a\.ts, like running t-1$/,
      /^ {2}t-1 settled/,
      /t-3 dispatching/,
    ])
    const { calls, kept } = value(ran)
    expect(calls.map((call) => call.input.match(/ticket (t-\d) will change/)?.[1])).toEqual(["t-3"])
    expect(kept["t-3"]).toBe('["src/a.ts"]')
  }, 30_000)

  test("is not started with one slot", async () => {
    const ran = await runs({
      seeds: backlog().ticket("t-1", { title: "Make the greeting friendlier" }).seeds,
      concurrent: 1,
      files: ["src/a.ts"],
      scripts: (world, root) => ({ "t-1": [works(world, root, "t-1")] }),
    })
    expectExitCode(ran, 0)
    const { calls, kept } = value(ran)
    expect(calls).toEqual([])
    expect(kept["t-1"]).toBeUndefined()
    expect(ran.log.some((text) => text.includes("footprint predicted"))).toBe(false)
  }, 30_000)
})
