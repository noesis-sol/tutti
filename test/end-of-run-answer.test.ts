// An answer given in a run's last moments (tutti-5ko): plain, the run ends held while a worker
// waits on you, and you answer it after the loop's last look, while the end asks git whether a
// ticket was merged by hand. The run's end interrupts every ticket's fiber before that, and refuses
// the answers to their requests from then on (tutti-t7z7), so the answer changes nothing of it: it
// fails NotOpen, the worker doesn't run on to commit and close its ticket, no PHASE_BUG line, no
// merge, the worker suspended waiting on you, and the run's exit code its stop's.

import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Fiber } from "effect"
import { Attention, NotOpen, runEnding } from "../src/agent/Attention.ts"
import { type Log, line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, canUseTool, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-answer-${name}-`)))

/** Claims its ticket, asks to remove the build, commits and closes it, as a worker does. */
const asksThenFinishes = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      canUseTool("Bash", { command: "rm -rf build" }),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

test("an answer after the last look reaches no ticket fiber and changes nothing of the end", async () => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const answered: Array<string> = []
  const refusals: Array<unknown> = []
  const ran = await scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
      backlog: backlog().ticket("a").seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      scripts: (world: World) => ({ a: [asksThenFinishes(world, root, "a" as TicketId)] }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      const attention = yield* Attention
      const logged = Effect.provideContext(texts, yield* Effect.context<Log>())
      yield* git.addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
      // Once BLOCKED has held the run, the run's next look at the open requests is its last; the
      // next git rev-parse after it is the end's, looking for tickets merged by hand. The request
      // open then is answered, through `tutti answer`, and the worker given time to carry on.
      let looked = false
      const looking = Effect.gen(function* () {
        if ((yield* logged).some((text) => /^HOLD: BLOCKED/.test(text))) looked = true
      })
      const answering = Effect.gen(function* () {
        if (!looked || answered.length > 0) return
        const open = (yield* attention.current).find((request) => request.ticket === "a")
        answered.push(open === undefined ? "none open" : open.id)
        if (open === undefined) return
        const exit = yield* Effect.exit(
          attention.answer(open.id, { _tag: "Allow" }, "answer_command"),
        )
        if (Exit.isFailure(exit))
          refusals.push(
            exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : exit.cause,
          )
        yield* Effect.promise(() => Bun.sleep(50))
      })
      const watchedAttention = Attention.of({
        ...attention,
        current: Effect.tap(attention.current, () => looking),
      })
      const watchedGit = Git.of({
        ...git,
        revParse: (dir, rev) => Effect.andThen(answering, git.revParse(dir, rev)),
      })
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
        }).pipe(
          Effect.provideService(Attention, watchedAttention),
          Effect.provideService(Git, watchedGit),
        ),
      )
      for (let i = 0; i < 6 && fiber.pollUnsafe() === undefined; i++) {
        yield* advance(Duration.minutes(1))
        yield* Effect.promise(() => Bun.sleep(3))
      }
      return yield* Fiber.join(fiber)
    }),
  )
  expect(answered).toEqual(["r1"])
  // The answer is refused, so the worker never runs on unwatched: it neither commits nor closes a.
  expect(refusals).toHaveLength(1)
  expect(refusals[0]).toBeInstanceOf(NotOpen)
  expect((refusals[0] as NotOpen).message).toBe(`request r1 is no longer open: ${runEnding}`)
  expect(ran.log.filter((text) => text.includes("via tutti answer"))).toEqual([])
  expect(ran.issues.find((issue) => issue.id === "a")?.status).not.toBe("closed")
  // The ticket's fiber stopped before the answer: it neither settles nor merges the ticket.
  expect(ran.log.filter((text) => /a settled|; merged into main/.test(text))).toEqual([])
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expectExitCode(ran, 3)
  expectPhases(ran, { a: "Stopped" })
  expect(ran.log.at(-1)).toMatch(/^BLOCKED >4min: a needs you: Bash\(rm -rf build\)/)
  const suspended = ran.events.flatMap((record) =>
    record.kind === "suspended" ? [{ ticket: record.ticket, why: record.why }] : [],
  )
  expect(suspended).toEqual([{ ticket: "a", why: "waiting on you" }])
}, 30_000)
