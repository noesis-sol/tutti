// A lock file a git stopped mid-write left in the main repository (tutti killed mid fast-forward, a
// power loss) keeps every later git from writing there until it is deleted. A fast-forward git was
// kept from is tried again for minutes, further apart each time (branch.ts's keptAgain), and between
// the tries a lock left staleLockAge ago or longer is removed (clearStaleLocks), so the merge goes
// on; a younger lock is left to the git that holds it. The merges run under TestClock, moved on
// gitAgainAfter at a time; Git's live removeStaleLocks is run on a real repository, slow.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Clock, Duration, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { retrying } from "../src/run/again.ts"
import { gitAgainAfter, keptAgain, staleLockAge } from "../src/run/branch.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository, type Tree } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"
import { advance, backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

describe("keptAgain", () => {
  test("tries again 3 s after the first failure, then twice as long each time, up to a minute", async () => {
    const made = await Effect.runPromise(
      Effect.gen(function* () {
        const times = yield* Ref.make<ReadonlyArray<number>>([])
        const once = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* Ref.update(times, (all) => [...all, now / 1000])
          return yield* Effect.fail("kept")
        })
        const fiber = yield* Effect.forkChild(Effect.exit(retrying(once, keptAgain)))
        for (let i = 0; i < 1000 && fiber.pollUnsafe() === undefined; i++) {
          yield* TestClock.adjust(Duration.seconds(1))
        }
        yield* Fiber.join(fiber)
        return yield* Ref.get(times)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(made).toEqual([0, 3, 9, 21, 45, 93, 153, 213, 273, 333])
    // A lock left as the first try failed is old enough to be removed before the tries run out.
    expect(Duration.toSeconds(staleLockAge)).toBeLessThan(made.at(-1) ?? 0)
  })
})

const options = { repo: "/repo", base: "main" }
const setup = {
  config: { repo: "/repo", settings: appConfig().settings },
  backlog: backlog().ticket("a").seeds,
}

/** A ticket its worker finished on top of main, `<id>.txt` committed, closed, Working. */
const finished = (id: TicketId) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

interface Merged {
  readonly phase: TicketPhase | undefined
  readonly stop: string | undefined
  readonly main: Tree
  /** How many fast-forwards the main checkout was asked for. */
  readonly fastForwards: number
}

/**
 * Finishes a, runs `before` (a lock left, another git's lock taken away later), and merges a
 * through a queue of its own until it settles, the clock moved on gitAgainAfter at a time; `each`
 * runs after each move.
 */
const merges = (
  before: Effect.Effect<void, unknown, Env>,
  each: (moved: number) => Effect.Effect<void, unknown, Env> = () => Effect.void,
) =>
  scenario(
    setup,
    Effect.gen(function* () {
      const a = yield* finished("a" as TicketId)
      yield* before
      const repository = yield* Repository
      const queue = yield* makeQueue(options)
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* queue.offer(a)
          yield* queue.settled
        }),
      )
      for (let i = 1; i <= 300 && fiber.pollUnsafe() === undefined; i++) {
        yield* advance(gitAgainAfter)
        yield* each(i)
      }
      yield* Fiber.join(fiber)
      const state = yield* (yield* Ledger).current
      return {
        phase: state.tickets.get("a" as TicketId)?.phase,
        stop: (yield* queue.state).stop?.why,
        main: yield* repository.tree("main"),
        fastForwards: (yield* repository.calls).filter((call) => call.op === "merge --ff-only")
          .length,
      } satisfies Merged
    }).pipe(Effect.provide(Ledger.layer)),
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const leave = (name: string) =>
  Effect.flatMap(Repository, (repository) => repository.leaveLock(name))

describe("a lock file a git stopped mid-write left in the main repository", () => {
  for (const name of ["index.lock", "refs/heads/main.lock"]) {
    test(`${name}: removed once it is staleLockAge old, and the ticket merges`, async () => {
      const ran = await merges(leave(name))
      const merged = resultOf(ran)
      expect(merged.phase?._tag).toBe("Done")
      expect(merged.stop).toBeUndefined()
      expect(merged.main.get("a.txt")).toBe("a\n")
      // Refused while the lock was younger than staleLockAge, then once more as it was removed.
      expect(merged.fastForwards).toBeGreaterThan(2)
      expect(merged.fastForwards).toBeLessThan(keptAgain.tries)
      expectLog(ran, [
        new RegExp(
          `^STALE_LOCK: removed /repo/\\.git/${name.replaceAll(".", "\\.")}, which a git left (3|4)m[0-9s]* ago and no git holds that long: one stopped mid-write leaves its lock, which keeps git from writing there$`,
        ),
      ])
      expect(ran.log.some((text) => /GIT_FAILED|MERGE_FAILED/.test(text))).toBe(false)
      expect(ran.events).toContainEqual(
        expect.objectContaining({ kind: "warn", text: expect.stringContaining("STALE_LOCK") }),
      )
    })
  }

  test("one another git holds for a minute is left to it, and the ticket merges once it goes", async () => {
    const ran = await merges(leave("index.lock"), (moved) =>
      // Another git releases its lock about a minute in.
      moved === 20
        ? Effect.flatMap(Repository, (repository) =>
            Effect.flatMap(Git, (git) =>
              Effect.asVoid(git.removeStaleLocks(repository.dir, Duration.zero)),
            ),
          )
        : Effect.void,
    )
    const merged = resultOf(ran)
    expect(merged.phase?._tag).toBe("Done")
    expect(merged.main.get("a.txt")).toBe("a\n")
    expect(ran.log.some((text) => /STALE_LOCK|GIT_FAILED/.test(text))).toBe(false)
  })
})

describe("Git's removeStaleLocks on a real repository", () => {
  const live = Git.layer().pipe(
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )

  /** Writes a lock file under the repository's .git, left `ago` seconds ago. */
  const lock = (dir: string, name: string, ago: number) => {
    const path = join(dir, ".git", name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "")
    const at = Date.now() / 1000 - ago
    utimesSync(path, at, at)
    return path
  }

  slow.test(
    "removes the locks left staleLockAge ago or longer, and keeps a younger one",
    async () => {
      const repo = makeRepo()
      const old = Duration.toSeconds(staleLockAge) + 60
      const index = lock(repo.dir, "index.lock", old)
      const ref = lock(repo.dir, "refs/heads/tutti/a.lock", old)
      const packed = lock(repo.dir, "packed-refs.lock", old)
      const young = lock(repo.dir, "refs/heads/young.lock", 10)
      const removed = await Effect.runPromise(
        Effect.flatMap(Git, (git) => git.removeStaleLocks(repo.dir, staleLockAge)).pipe(
          Effect.provide(live),
        ),
      )
      expect(removed.map((each) => each.path).sort()).toEqual([index, packed, ref].sort())
      for (const each of removed) {
        expect(Duration.toSeconds(each.age)).toBeGreaterThanOrEqual(old - 5)
      }
      expect(existsSync(index)).toBe(false)
      expect(existsSync(ref)).toBe(false)
      expect(existsSync(packed)).toBe(false)
      expect(existsSync(young)).toBe(true)
      // git writes again where the index lock kept it from.
      repo.commit("After", { "after.txt": "x\n" })
    },
  )
})
