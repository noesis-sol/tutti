import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Queue, Ref } from "effect"
import { line } from "../src/run/log.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import {
  awaitInterrupt,
  bash,
  interruptedResult,
  Recording,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { advance, backlog, expectExitCode, scenario } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-end-${name}-`)))

/** Waits, in real time, until `ready` holds: for what the run does outside the TestClock. */
const until = <E, R>(ready: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000; i++) {
      if (yield* ready) return
      yield* Effect.promise(() => Bun.sleep(1))
    }
    return yield* Effect.die(new Error("waited too long"))
  })

const closedAll = (tickets: ReadonlyArray<string>) =>
  Effect.flatMap(Recording, (recording) =>
    Effect.map(recording.all, (all) =>
      tickets.every((ticket) =>
        all.some((sent) => sent._tag === "Closed" && sent.ticket === ticket),
      ),
    ),
  )

describe("the run's end", () => {
  test("closes its sessions all at once, not one after another, under TestClock", async () => {
    const tickets = ["t-1" as TicketId, "t-2" as TicketId, "t-3" as TicketId]
    const repo = folder("repo")
    const root = folder("worktrees")
    const quits = Effect.runSync(Queue.unbounded<QuitRequest>())
    const claimed = Effect.runSync(Ref.make(0))
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: tickets.length } },
        git: { dir: repo },
        worktrees: { root },
        backlog: tickets.reduce((built, id) => built.ticket(id), backlog()).seeds,
        // Each session's Claude Code takes 10 s to exit, as one ignoring stdin's end until killed.
        closeTakes: "10 seconds",
        scripts: (world) =>
          Object.fromEntries(
            tickets.map((id) => [
              id,
              [
                turn(
                  [
                    ...bash(
                      `bd update ${id} --claim`,
                      Effect.orDie(world.beads.update(id, { claim: true })),
                    ),
                    // The last worker to claim its ticket quits the run.
                    step(
                      Effect.flatMap(
                        Ref.updateAndGet(claimed, (n) => n + 1),
                        (n) =>
                          n === tickets.length
                            ? Effect.asVoid(Queue.offer(quits, quitBy("SIGINT")))
                            : Effect.void,
                      ),
                    ),
                    awaitInterrupt,
                  ],
                  interruptedResult,
                ),
              ],
            ]),
          ),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            quits,
            exitNow: () => Effect.void,
          }),
        )
        // Every session is closing before any one's Claude Code has exited.
        yield* until(closedAll(tickets))
        const store = yield* Store
        for (const id of tickets) expect((yield* store.ticket(id))?.suspended).toBeUndefined()
        for (let i = 0; i < 200; i++) yield* Effect.yieldNow
        // One close's time, not three, and every session is suspended.
        yield* advance("10 seconds")
        const outcome = yield* Fiber.join(fiber)
        return { ...outcome, state: yield* store.state }
      }),
    )
    expectExitCode(ran, 130)
    if (Exit.isFailure(ran.exit)) throw new Error(`the run failed: ${ran.exit.cause}`)
    for (const id of tickets) {
      expect(ran.exit.value.state.tickets[id]).toMatchObject({
        suspended: "quit",
        phase: "Stopped",
      })
    }
  })
})
