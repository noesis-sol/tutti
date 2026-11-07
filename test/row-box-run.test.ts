// A row's box through the run (§ 7.2, tutti-149z.9): the run's scoring reaches a done ticket's row,
// its scorecard's figures with it, and ReadTicket reads a done ticket again with bd show, so that
// notes added during the run show in its box.
import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Queue, type Scope, SubscriptionRef } from "effect"
import { UiCommand } from "../src/run/commands.ts"
import { line } from "../src/run/log.ts"
import { run as runTutti } from "../src/run/run.ts"
import type { Row } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { init, result, run, sessionState, wait } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, type Env, type Scripts, scenario, type World } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-rowbox-${name}-`)))

test("a done ticket's row has its scorecard, and ReadTicket brings the notes added since", async () => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const hold = Deferred.makeUnsafe<void>()
  const ran = await scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 }, limit: 2 },
      backlog: backlog()
        .ticket("a", { description: "Its description." })
        .ticket("b", { blockedBy: ["a"] }).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World): Scripts => ({
        a: [
          [
            wait,
            init(),
            sessionState("running"),
            run(Effect.asVoid(Effect.orDie(world.beads.close("a" as TicketId, "nothing to do")))),
            result("Closed a."),
            sessionState("idle"),
          ],
        ],
        // What holds the run open, while a's row is looked at.
        b: [
          [
            wait,
            init(),
            sessionState("running"),
            run(Deferred.await(hold)),
            run(Effect.asVoid(Effect.orDie(world.beads.close("b" as TicketId, "nothing to do")))),
            result("Closed b."),
            sessionState("idle"),
          ],
        ],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
      yield* git.addWorktree(repo, join(root, "b"), { branch: "tutti/b", base: "main" })
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      const fiber = yield* Effect.forkChild(
        runTutti({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
        }),
      )
      const until = (what: string, found: () => Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          for (let i = 0; i < 2000; i++) {
            if (yield* found()) return
            yield* advance("1 second")
            yield* Effect.promise(() => Bun.sleep(2))
          }
          throw new Error(`waited in vain for ${what}: ${(yield* texts).join("\n")}`)
        })
      yield* until("the dashboard", () => Effect.sync(() => shown !== undefined))
      const inputs = shown as ScreenInputs
      const rowOf = Effect.map(SubscriptionRef.get(inputs.view), (view) =>
        view.rows.find((row) => row.ticket === "a"),
      )
      yield* until("a's scorecard", () => Effect.map(rowOf, (row) => row?.stats.seconds != null))
      const scored = (yield* rowOf) as Row
      yield* Effect.orDie(
        (yield* Beads).update("a" as TicketId, { appendNotes: "Noted after it closed." }),
      )
      yield* Queue.offer(inputs.commands, UiCommand.ReadTicket({ ticket: "a" as TicketId }))
      yield* until("the notes", () =>
        Effect.map(rowOf, (row) => row?.issue?.notes.includes("Noted after it closed.") === true),
      )
      const read = (yield* rowOf) as Row
      yield* Deferred.succeed(hold, undefined)
      for (let i = 0; i < 3; i++) {
        yield* advance("1 minute")
        yield* Effect.promise(() => Bun.sleep(3))
      }
      yield* Fiber.join(fiber)
      return { scored, read }
    }) as Effect.Effect<{ readonly scored: Row; readonly read: Row }, unknown, Env | Scope.Scope>,
  )
  expect(ran.exit._tag).toBe("Success")
  if (ran.exit._tag !== "Success") return
  const { scored, read } = ran.exit.value
  expect(scored.detail._tag).toBe("NoChange")
  expect(scored.stats.outcome).toBe("no_change")
  expect(scored.stats.took).not.toBeNull()
  expect(scored.issue?.description).toBe("Its description.")
  expect(read.issue?.description).toBe("Its description.")
  expect(read.issue?.notes).toContain("Noted after it closed.")
}, 30_000)
