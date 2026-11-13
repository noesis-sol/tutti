// A poll with every slot taken reads bd for its Asked tickets as rarely as for the queue
// (tutti-1odn): a look the ready poll alone woke, between the queue's reads (busyPoll), lists no
// open tickets for the answers, as an answered ticket has no slot to come back in; the first poll
// past busyPoll reads them again, and the slot freed takes the answered ticket back. Such a look
// keeps an answered ticket waiting for a slot from the run's end: no end-of-run box beside a worker
// waiting on you.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Fiber, SubscriptionRef } from "effect"
import { line } from "../src/core/log.ts"
import { run } from "../src/run/run.ts"
import { busyPoll, readyPoll } from "../src/run/schedule.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  filesQuestion,
  type SessionScript,
  sleep,
  run as step,
  tool,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { advance, backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-busy-poll-asked-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

const asks = (world: World, id: TicketId): SessionScript =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        world.beads.create({ title: "Which way?", labels: ["human"], blocks: [id] }),
        world.beads.update(id, { status: "open" }),
      ),
    ),
  })

/** Claims, does `meanwhile`, commits and closes its ticket. */
const finishes = (
  world: World,
  root: string,
  id: TicketId,
  meanwhile: ReadonlyArray<SessionScript[number]>,
): SessionScript =>
  turn([
    ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
    ...meanwhile,
    ...bash(
      `git commit -am "Change (${id})"`,
      orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
    ),
    ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
  ])

/** Waits, in real time, until `ready`, then a little longer for the run's looks to settle. */
const until = (ready: Effect.Effect<boolean>, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if (yield* ready) {
        yield* Effect.promise(() => Bun.sleep(100))
        return
      }
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`never ${what}`)
  })

/** A little real time for the looks a wake started to settle. */
const settle = Effect.promise(() => Bun.sleep(100))

describe("a run with a ticket Asked and every slot taken", () => {
  test("lists no open tickets on a 30 s poll, and reads the answer within busyPoll", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const working = Deferred.makeUnsafe<void>()
    // The run's bd calls on the polls with t-2 in the one slot, after t-1's question is answered,
    // and from then on.
    let onPolls: ReadonlyArray<string> = ["unread"]
    let answeredPoll: ReadonlyArray<string> = ["unread"]
    let within: ReadonlyArray<string> = []
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          "t-1": [asks(world, "t-1" as TicketId), finishes(world, root, "t-1" as TicketId, [])],
          // t-2 holds the one slot past busyPoll.
          "t-2": [
            finishes(world, root, "t-2" as TicketId, [
              step(Deferred.succeed(working, undefined)),
              sleep(Duration.times(busyPoll, 2)),
            ]),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        const beads = yield* Beads
        for (const id of ["t-1", "t-2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        // The run's bd calls, by command; the workers' and the test's go to the backlog without.
        const bd: Array<string> = []
        const counted = Beads.of(
          Object.fromEntries(
            Object.entries(beads).map(([name, call]) => [
              name,
              (...args: ReadonlyArray<unknown>) =>
                Effect.andThen(
                  Effect.sync(() => bd.push(name)),
                  (call as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
                ),
            ]),
          ) as unknown as Beads["Service"],
        )
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }).pipe(
            Effect.provideService(Beads, counted),
          ),
        )
        // t-1 Asked, t-2 in the one slot.
        yield* Deferred.await(working)
        yield* settle
        const before = bd.length
        yield* advance(readyPoll)
        yield* settle
        yield* advance(readyPoll)
        yield* settle
        onPolls = bd.slice(before)
        // t-1's question answered by hand: the next poll, still between reads, doesn't list it.
        for (const dependency of (yield* Effect.orDie(beads.show("t-1" as TicketId)))
          .dependencies) {
          if (dependency.issue?.labels.includes("human") === true) {
            yield* Effect.orDie(beads.close(dependency.id, "answered"))
          }
        }
        const answered = bd.length
        yield* advance(readyPoll)
        yield* settle
        answeredPoll = bd.slice(answered)
        // busyPoll since the queue's read: the poll's look lists the open tickets again.
        yield* advance(busyPoll)
        yield* until(
          Effect.sync(() => bd.slice(answered).includes("list")),
          "listed the open tickets again",
        )
        within = bd.slice(answered)
        // t-2's sleep runs out, its slot frees, and t-1 comes back.
        for (let i = 0; i < 8; i++) {
          yield* advance(readyPoll)
          yield* settle
        }
        return yield* Fiber.join(fiber)
      }),
    )
    expect(onPolls).toEqual([])
    expect(answeredPoll).toEqual([])
    expect(within).toContain("list")
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
  }, 30_000)

  test("keeps the answered ticket from the run's end while a worker in the slot waits on you", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const working = Deferred.makeUnsafe<void>()
    // The end-of-run box every 10 s while no hold is on, with t-1's row.
    const seen: Array<string> = []
    await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World) => ({
          "t-1": [asks(world, "t-1" as TicketId), turn([])],
          // t-2 works 135 s in the one slot, between two polls, then asks you and waits.
          "t-2": [
            turn([
              ...bash(
                "bd update t-2 --claim",
                orDie(world.beads.update("t-2" as TicketId, { claim: true })),
              ),
              step(Deferred.succeed(working, undefined)),
              sleep(Duration.seconds(135)),
              canUseTool("Bash", { command: "rm -rf build" }),
              ...tool("Bash", { command: "rm -rf build" }),
            ]),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        const beads = yield* Beads
        for (const id of ["t-1", "t-2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", dashboard }),
        )
        yield* Deferred.await(working)
        yield* settle
        // t-1's question answered by hand, read at a look that has no slot for it.
        for (const dependency of (yield* Effect.orDie(beads.show("t-1" as TicketId)))
          .dependencies) {
          if (dependency.issue?.labels.includes("human") === true) {
            yield* Effect.orDie(beads.close(dependency.id, "answered"))
          }
        }
        // Every 10 s, so that the look t-2's request wakes, before the next poll, is seen too.
        for (let i = 0; i < 30; i++) {
          yield* advance(Duration.seconds(10))
          yield* settle
          if (shown === undefined) continue
          const view = yield* SubscriptionRef.get(shown.view)
          if (view.banners.length > 0) continue
          const row = view.rows.find((each) => each.ticket === "t-1")
          seen.push(`${row?.word ?? "no row"} · ${JSON.stringify(view.endOfRun ?? null)}`)
        }
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(seen).toContain("answered · null")
    expect(seen.filter((each) => !each.endsWith(" · null"))).toEqual([])
  }, 30_000)
})
