// A quit while a worker starts (§ 4.8): its session, never begun, isn't saved, and the next run
// starts the ticket afresh rather than resume a session Claude Code never made. Two whole runs under
// TestClock in one world, as scenarios-sessions.test.ts runs them.
import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Queue } from "effect"
import { line } from "../src/run/log.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store } from "../src/services/Store.ts"
import { claimsAndCloses, Recording, run as step, wait } from "../src/testing/AgentHost.ts"
import { texts } from "../src/testing/Log.ts"
import { backlog, scenario } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-${name}-`)))

/** What one of the runs left: its outcome, state.json, its log and what its workers were sent. */
interface Run {
  readonly outcome: Outcome
  readonly state: State
  readonly log: ReadonlyArray<string>
  readonly sent: ReadonlyArray<string>
}

test("a quit before the worker's session begins saves none; the next run starts the ticket afresh", async () => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const quits = Effect.runSync(Queue.unbounded<QuitRequest>())
  const ran = await scenario(
    {
      config: { repo },
      backlog: backlog().ticket("t-1").seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world) => ({
        "t-1": [
          // The first run's session takes its first message, and the run is quit before the
          // session's system/init comes.
          [wait, step(Effect.asVoid(Queue.offer(quits, quitBy("SIGINT"))))],
          claimsAndCloses("t-1", {
            claim: Effect.orDie(world.beads.update("t-1", { claim: true })),
            commit: Effect.asVoid(
              Effect.orDie(
                world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
              ),
            ),
            close: Effect.orDie(world.beads.close("t-1", "done")),
          }),
        ],
      }),
    },
    Effect.gen(function* () {
      yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
        branch: "tutti/t-1",
        base: "main",
      })
      const recording = yield* Recording
      const once = (requests: Queue.Queue<QuitRequest>) =>
        Effect.gen(function* () {
          const logged = (yield* texts).length
          const sentBefore = (yield* recording.all).length
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              run({
                version: "0.1.0-test",
                base: "main",
                start: [line`START tutti 0.1.0-test`],
                quits: requests,
              }),
            ),
          )
          const outcome = yield* Fiber.join(fiber)
          return {
            outcome,
            state: yield* (yield* Store).state,
            log: (yield* texts).slice(logged),
            sent: (yield* recording.all).slice(sentBefore).map((sent) => sent._tag),
          } satisfies Run
        })
      const first = yield* once(quits)
      const status = (yield* (yield* Beads).show("t-1")).status
      const second = yield* once(yield* Queue.unbounded<QuitRequest>())
      return { first, status, second }
    }),
  )
  if (Exit.isFailure(ran.exit)) throw new Error(`the runs failed: ${ran.exit.cause}`)
  const { first, status, second } = ran.exit.value

  // The first run: quit as the worker started; its session ended, and nothing saved of it.
  expect(first.outcome.exitCode).toBe(130)
  expect(first.sent).toEqual(["Started", "Message", "Closed", "Ended"])
  expect(first.log).toContain("INTERRUPTED: quit with Ctrl+C")
  expect(first.log.some((each) => each.includes("saved for the next run"))).toBe(false)
  expect(first.state.tickets["t-1"]).toBeUndefined()
  // Never claimed: bd ready gives it to the next run.
  expect(status).toBe("open")

  // The second run: a new session, not a resume, and the ticket finished.
  expect(second.sent.slice(0, 2)).toEqual(["Started", "Message"])
  expect(second.sent).not.toContain("Resumed")
  expect(second.log.some((each) => each.includes("WORKER_GONE"))).toBe(false)
  expect(second.outcome.exitCode).toBe(0)
  expect(second.outcome.phases["t-1"]?._tag).toBe("Done")
})
