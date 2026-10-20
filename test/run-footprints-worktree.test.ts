import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { Log } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { Git } from "../src/services/Git.ts"
import { bash, type SessionScript, run as step, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, expectExitCode, scenario, type World } from "./harness.ts"

// A ticket's footprint reads the worktree it really works in, the one the Store saved for it, not
// <worktrees>/<id>: git may have it elsewhere, as when --worktrees changed since an earlier run.

/** A new folder, its real path. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-footprints-worktree-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** Waits, in real time, until a log line matches `pattern`; dies after 20 s without one. */
const until = (logged: { texts: Effect.Effect<ReadonlyArray<string>> }, pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 4000; i++) {
      if ((yield* logged.texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(5))
    }
    return yield* Effect.die(
      new Error(`no log line matched ${pattern}:\n${(yield* logged.texts).join("\n")}`),
    )
  })

/** Claims `id`, commits src/z.ts in its worktree under `root`, waits for `after`, closes it. */
const works = (world: World, root: string, id: string, after: Effect.Effect<void>): SessionScript =>
  turn([
    ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
    ...bash(
      `git commit -am "Change (${id})"`,
      orDie(world.repository.commit(join(root, id), `Change (${id})`, { "src/z.ts": "z\n" })),
    ),
    step(after),
    ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
  ])

describe("the run's footprints, in a ticket's own worktree", () => {
  test("two worktrees outside --worktrees changing one file give LIKELY_CONFLICT", async () => {
    const repo = folder("repo")
    // The configuration's worktrees folder stays empty: git has the tickets' worktrees elsewhere.
    const configured = folder("configured")
    const elsewhere = folder("elsewhere")
    const seeds = backlog()
      .ticket("t-1", { priority: 0, metadata: { files: ["src/a.ts"] } })
      .ticket("t-2", { priority: 1, metadata: { files: ["src/b.ts"] } }).seeds
    const warning = /LIKELY_CONFLICT/
    const settings = appConfig().settings
    const logged = { texts: Effect.succeed<ReadonlyArray<string>>([]) }
    const ran = await scenario(
      {
        config: {
          repo,
          worktrees: configured,
          settings: { ...settings, concurrent: 2, queue: { ...settings.queue, footprint: true } },
        },
        backlog: seeds,
        git: { dir: repo },
        worktrees: { root: elsewhere },
        scripts: (world: World) => ({
          "t-1": [works(world, elsewhere, "t-1", until(logged, warning))],
          "t-2": [works(world, elsewhere, "t-2", until(logged, warning))],
        }),
      },
      Effect.gen(function* () {
        logged.texts = texts.pipe(Effect.provideService(Log, yield* Log))
        const git = yield* Git
        for (const seed of seeds) {
          yield* git.addWorktree(repo, join(elsewhere, seed.id), {
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
    expectExitCode(ran, 0)
    expect(ran.log.filter((text) => warning.test(text))).toEqual([
      "  LIKELY_CONFLICT: t-1 and t-2 both edit src/z.ts; the second to merge may conflict",
    ])
  }, 30_000)
})
