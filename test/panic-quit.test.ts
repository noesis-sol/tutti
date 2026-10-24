// Requests to quit after a panic (quit.ts, § 4.8): the panic already quit the run, so the first
// Ctrl+C says what quitting waits for, as a second would, and the next ends tutti at once.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Queue, Ref } from "effect"
import { line } from "../src/run/log.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { run } from "../src/run/run.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, Recording, sleep, run as step, turn } from "../src/testing/AgentHost.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, expectLog, scenario } from "./harness.ts"

// A whole run takes up to a second on an idle machine: bun's 5 s default fails it when other
// checks run beside this one.
setDefaultTimeout(30_000)

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-panic-quit-${name}-`)))

const ctrlC = quitBy("SIGINT")

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

describe("quitting after a panic", () => {
  test("the first Ctrl+C says what quitting waits for; the next quits at once", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    let armed = false
    const ran = await scenario(
      {
        config: { repo },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        // t-1's worker claims its ticket and is still at work an hour on, interrupted or not.
        scripts: (world) => ({
          "t-1": [
            turn([
              ...bash(
                "bd update t-1 --claim",
                Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
              ),
              step(
                Effect.sync(() => {
                  armed = true
                }),
              ),
              sleep("1 hour"),
            ]),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        const quits = yield* Queue.unbounded<QuitRequest>()
        const exits = yield* Ref.make<ReadonlyArray<number>>([])
        const beads = yield* Beads
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            quits,
            exitNow: (code) => Ref.update(exits, (all) => [...all, code]),
          }).pipe(
            // The next fill's bd list dies, once: the run's loop panics.
            Effect.provideService(Beads, {
              ...beads,
              list: (filter) => {
                if (!armed) return beads.list(filter)
                armed = false
                return Effect.die(new Error("loop boom"))
              },
            }),
          ),
        )
        // The clock moves on to the next fill, and stops once the panic has t-1's worker interrupted:
        // quitting waits for it for 10 seconds.
        const recording = yield* Recording
        const interrupted = Effect.map(recording.all, (all) =>
          all.some((sent) => sent._tag === "Interrupted" && sent.ticket === "t-1"),
        )
        for (let i = 0; i < 20 && !(yield* texts).some((text) => /^PANIC in /.test(text)); i++) {
          for (let j = 0; j < 200; j++) yield* Effect.yieldNow
          if ((yield* texts).some((text) => /^PANIC in /.test(text))) break
          yield* advance("10 seconds")
        }
        for (let i = 0; i < 2000 && !(yield* interrupted); i++) {
          yield* Effect.promise(() => Bun.sleep(2))
        }
        yield* Queue.offer(quits, ctrlC)
        yield* untilLogged(/^ {2}quitting: waiting for t-1's worker/)
        yield* Queue.offer(quits, ctrlC)
        yield* untilLogged(/^INTERRUPTED: quit at once with Ctrl\+C/)
        yield* advance("10 seconds")
        yield* Fiber.join(fiber)
        return yield* Ref.get(exits)
      }),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the run failed: ${ran.exit.cause}`)
    expectLog(ran, [
      /^PANIC in the run: loop boom$/,
      "  quitting: waiting for t-1's worker; press Ctrl+C again to quit at once",
      "INTERRUPTED: quit at once with Ctrl+C; saved the sessions of t-1",
      /^PANIC: the run's loop: loop boom/,
    ])
    expect(ran.exit.value).toEqual([130])
  })
})
