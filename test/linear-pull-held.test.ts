// A ticket set aside in this run is in the run's ledger, and a pull never changes one the ledger
// has (§ 5 item 19, tutti-r2z9): its worker defers it, its issue moves to Todo in Linear, and the
// pulls after it leave the ticket deferred and as it was, where one that read no ledger would
// release it. The pulls' own tests pass the ledger's tickets directly (linear-pull.test.ts); this
// one goes through the run's wiring of them.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { line } from "../src/core/log.ts"
import { run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { Backlog, linearUrl } from "../src/testing/Beads.ts"
import { Listings } from "../src/testing/LinearIssues.ts"
import { expectExitCode, expectLog, expectPhases, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-linear-pull-held-${name}-`)))

describe("a ticket set aside in this run", () => {
  test("is left deferred and as it was by the pulls after its issue moved to Todo", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = TestAppConfig.appConfig().settings
    const ran = await scenario(
      {
        config: {
          repo,
          settings: { ...defaults, concurrent: 2 },
          // Pulls at 50 s, 100 s, 150 s…: after the issue moves at 60 s.
          linear: { team: "NOE", pull_every: Duration.seconds(50) },
        },
        backlog: [
          { id: "a", title: "Set aside", externalRef: linearUrl("NOE-1") },
          { id: "b", title: "Long" },
        ],
        bd: { linearTeam: { issues: [{ key: "NOE-1", title: "Set aside", state: "started" }] } },
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World): Record<string, ReadonlyArray<SessionScript>> => ({
          // Its worker sets it aside at once, with nothing done.
          a: [
            turn(
              [
                sleep("5 seconds"),
                ...bash(
                  "bd defer a",
                  Effect.asVoid(Effect.orDie(world.beads.defer("a" as TicketId))),
                ),
              ],
              result("Deferred a."),
            ),
          ],
          // Keeps the run going over the pulls.
          b: [
            turn(
              [
                sleep("5 minutes"),
                ...bash(
                  `git commit -am "Change (b)"`,
                  Effect.asVoid(
                    Effect.orDie(
                      world.repository.commit(join(root, "b"), "Change (b)", { "b.txt": "x\n" }),
                    ),
                  ),
                ),
                ...bash(
                  "bd close b",
                  Effect.asVoid(Effect.orDie(world.beads.close("b" as TicketId, "done"))),
                ),
              ],
              result("Closed b."),
            ),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["a", "b"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        for (let step = 0; step < 30 * 6; step++) {
          yield* Effect.promise(() => Bun.sleep(5))
          if (step === 6) {
            const linear = yield* Backlog
            const deferred = (yield* linear.issues).find((issue) => issue.id === "a")?.status
            // Set aside before its issue moves.
            if (deferred !== "deferred") return yield* Effect.die(`a is ${deferred} at 60 s`)
            yield* linear.putLinear({
              key: "NOE-1",
              title: "Renamed in Linear",
              state: "unstarted",
            })
          }
          yield* TestClock.adjust("10 seconds")
        }
        const outcome = yield* Fiber.join(fiber)
        return { ...outcome, asked: yield* (yield* Listings).asked }
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Deferred", b: "Done" })
    expectLog(ran, [
      "LINEAR: pulled from NOE at the start: nothing new",
      "[1] a dispatching: Set aside",
      "LINEAR: pulled from NOE: nothing new",
    ])
    // Pulls ran after the issue moved, and none of them released it.
    expect(ran.log.filter((text) => text.startsWith("LINEAR:"))).not.toContainEqual(
      expect.stringContaining("NOE-1"),
    )
    // The start's, 50 s's, and at least the one at 100 s, after the move.
    expect(ran.exit._tag === "Success" ? ran.exit.value.asked.length : 0).toBeGreaterThanOrEqual(3)
    const a = ran.issues.find((issue) => issue.id === "a")
    expect(a?.status).toBe("deferred")
    expect(a?.title).toBe("Set aside")
    expect(
      ran.events.filter((record) => record.kind === "dispatch" && record.ticket === "a"),
    ).toHaveLength(1)
  }, 30_000)
})
