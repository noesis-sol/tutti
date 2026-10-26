// A merge-queue change wakes the run only when a look can act on it (tutti-gr4z.9): a ticket put in
// line, or taking its turn, wakes no look, as the worker's freed slot wakes its own; a merge over, a
// stop and a hand-back each wake one. A look takes the wake pending for the reasons it takes, so
// that none follows it to look for nothing.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Logger, Option, References } from "effect"
import { line } from "../src/run/log.ts"
import type { MergeStop } from "../src/run/merge.ts"
import { emptyQueue, type QueueState } from "../src/run/mergequeue.ts"
import { run } from "../src/run/run.ts"
import { make as makeWakes, mergeWakes, type Wakes } from "../src/run/wakes.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const [a, b, c] = ["a", "b", "c"] as [TicketId, TicketId, TicketId]
const queue = (fields: Partial<QueueState>): QueueState => ({ ...emptyQueue, ...fields })
const stop = { why: "DIRTY_TREE", ticket: "a" } as unknown as MergeStop

describe("a merge-queue change", () => {
  test("wakes no look for an offer: tickets put in line behind the others", () => {
    expect(mergeWakes(queue({}), queue({ waiting: [a] }))).toBe(false)
    expect(mergeWakes(queue({ waiting: [a] }), queue({ waiting: [a, b] }))).toBe(false)
    // While a merge is under way, or tickets are handed back.
    const busy = { merging: c, resolving: [b] }
    expect(mergeWakes(queue(busy), queue({ ...busy, waiting: [a] }))).toBe(false)
  })

  test("wakes no look for a turn: a waiting ticket into an empty merging", () => {
    expect(mergeWakes(queue({ waiting: [a] }), queue({ merging: a }))).toBe(false)
    expect(mergeWakes(queue({ waiting: [a, b] }), queue({ waiting: [b], merging: a }))).toBe(false)
  })

  test("wakes a look for a merge over", () => {
    expect(mergeWakes(queue({ merging: a }), queue({}))).toBe(true)
    expect(mergeWakes(queue({ waiting: [b], merging: a }), queue({ waiting: [b] }))).toBe(true)
  })

  test("wakes a look for a stop", () => {
    expect(mergeWakes(queue({ merging: a }), queue({ stop }))).toBe(true)
    expect(mergeWakes(queue({ waiting: [b] }), queue({ waiting: [b], stop }))).toBe(true)
  })

  test("wakes a look for a hand-back, under way or over", () => {
    expect(mergeWakes(queue({ merging: a }), queue({ resolving: [a] }))).toBe(true)
    expect(mergeWakes(queue({ resolving: [a] }), queue({}))).toBe(true)
  })

  test("wakes a look for any other change, and for the first state seen", () => {
    expect(mergeWakes(null, queue({}))).toBe(true)
    // A turn the ledger refused: out of the line, merging nothing.
    expect(mergeWakes(queue({ waiting: [a] }), queue({}))).toBe(true)
    // Back at the head of the line, its merge cut short.
    expect(mergeWakes(queue({ merging: a }), queue({ waiting: [a] }))).toBe(true)
    // Put ahead of the others, not behind them.
    expect(mergeWakes(queue({ waiting: [b] }), queue({ waiting: [a, b] }))).toBe(true)
    // A turn while a merge is under way, or for a ticket not in line.
    expect(mergeWakes(queue({ waiting: [a], merging: b }), queue({ merging: a }))).toBe(true)
    expect(mergeWakes(queue({ waiting: [b] }), queue({ waiting: [b], merging: a }))).toBe(true)
  })
})

describe("a look", () => {
  // Whether a wake is pending: the loop's next look would start at once.
  const pending = (wakes: Wakes) =>
    Effect.map(Effect.timeoutOption(wakes.next(Effect.never), Duration.millis(20)), Option.isSome)

  test("takes the wake pending for the reasons it takes, so none looks for nothing", async () => {
    const [why, after] = await Effect.runPromise(
      Effect.gen(function* () {
        const wakes = yield* makeWakes
        yield* wakes.wakeUp("merge")
        return [yield* wakes.take, yield* pending(wakes)] as const
      }),
    )
    expect([...why]).toEqual(["merge"])
    expect(after).toBe(false)
  })

  test("leaves pending a wake that comes after it took the reasons", async () => {
    const [why, after] = await Effect.runPromise(
      Effect.gen(function* () {
        const wakes = yield* makeWakes
        const why = yield* wakes.take
        yield* wakes.wakeUp("merge")
        return [why, yield* pending(wakes)] as const
      }),
    )
    expect([...why]).toEqual([])
    expect(after).toBe(true)
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-merge-wakes-${name}-`)))

/** Claims, commits and closes its ticket. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
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

describe("a run of two tickets, one at a time", () => {
  test("looks once for each merge over, and fills the freed slot once", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    // The reasons of each look, as the loop logs them (look.ts).
    const looks: Array<string> = []
    const logged = Logger.make(({ message }) => {
      const text = (Array.isArray(message) ? message : [message]).join(" ")
      const woken = /^look, woken for (.*)$/.exec(text)
      if (woken !== null) looks.push(woken[1] ?? "")
    })
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("a").ticket("b").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          a: [finishes(world, root, a)],
          b: [finishes(world, root, b)],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
        yield* git.addWorktree(repo, join(root, "b"), { branch: "tutti/b", base: "main" })
        // The clock never moves: the ready poll never wakes the run.
        return yield* run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
        }).pipe(
          Effect.provide(Logger.layer([logged])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        )
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    const started = ran.sent.flatMap((sent) => (sent._tag === "Started" ? [sent.ticket] : []))
    expect(started).toEqual([a, b])
    // The looks' reasons, the ones that come together taken in one look: the queue as the run
    // begins, a's freed slot filled with b, b's with nothing left, the two merges over. a's offer
    // and turn, and b's, wake no look of their own, and no look is woken for nothing, its reasons
    // taken by the one before it: 8 looks before tutti-gr4z.9, 6 woken by the queue.
    const woken = (why: string) => looks.filter((each) => each.split(", ").includes(why))
    expect(woken("freed")).toHaveLength(2)
    expect(woken("merge").length).toBeLessThanOrEqual(3)
    expect(looks.length).toBeLessThanOrEqual(5)
  }, 30_000)
})
