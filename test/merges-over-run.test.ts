// Whether Needs you's conflict text may offer `h` (tutti-5mc3): a whole run tells the view once a
// merge has stopped the merges, as its queue's stop stands whatever becomes of the ticket.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, SubscriptionRef } from "effect"
import { run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, run as step, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository } from "../src/testing/Git.ts"
import { advance, backlog, expectPhases, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-merges-over-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

describe("a merge that stops the merges, in a whole run", () => {
  test("is shown as no merge to come, once its ticket is Blocked", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const id = "t-1" as TicketId
    const seen: Array<boolean> = []
    const ran = await scenario(
      {
        config: { repo, settings: appConfig().settings },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => {
          const stray = Effect.flatMap(Repository, (repository) =>
            repository.write(repository.dir, { "README.md": "edited by hand\n" }),
          ).pipe(Effect.provideService(Repository, world.repository))
          return {
            "t-1": [
              turn([
                ...bash("bd update t-1 --claim", orDie(world.beads.update(id, { claim: true }))),
                step(orDie(stray)),
                ...bash(
                  'git commit -am "Change (t-1)"',
                  orDie(
                    world.repository.commit(join(root, id), "Change (t-1)", { "t.txt": "x\n" }),
                  ),
                ),
                ...bash("bd close t-1", orDie(world.beads.close(id, "done"))),
              ]),
            ],
          }
        },
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, id), { branch: "tutti/t-1", base: "main" })
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const look = Effect.gen(function* () {
          if (shown === undefined) return
          const need = (yield* SubscriptionRef.get(shown.view)).needs[0]
          if (need?._tag === "Blocked") seen.push(need.mergesOver)
        })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", dashboard }),
        )
        for (let i = 0; i < 8; i++) {
          for (let j = 0; j < 200; j++) yield* Effect.yieldNow
          yield* look
          yield* advance(readyPoll)
        }
        return yield* Fiber.join(fiber)
      }),
    )
    expectPhases(ran, { "t-1": "Blocked" })
    expect(seen.at(-1)).toBe(true)
  })
})
