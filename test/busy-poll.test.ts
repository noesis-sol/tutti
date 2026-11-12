// A fill the ready poll alone woke, with every slot taken, reads bd less often (tutti-jh9t): git
// alone, for the LIKELY_CONFLICT warning, until busyPoll has passed since the queue was last read
// from bd; a slot freed, or any other reason beside the poll, reads at once as ever, and so does a
// poll with a slot free. wakes.ts's polledOnly tells such a look; the run gives its fill the look's
// reasons.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Fiber, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { Attention } from "../src/agent/Attention.ts"
import { type Log, line } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { run } from "../src/run/run.ts"
import { busyPoll, make, readyPoll } from "../src/run/schedule.ts"
import { polledOnly, type Wake } from "../src/run/wakes.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  result,
  type SessionScript,
  tool,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const wakes: ReadonlyArray<Wake> = [
  "poll",
  "freed",
  "merge",
  "hold",
  "attention",
  "command",
  "verdict",
  "drain",
]

describe("polledOnly", () => {
  test("is the ready poll alone, with at most an attention change", () => {
    expect(polledOnly(new Set(["poll"]))).toBe(true)
    expect(polledOnly(new Set<Wake>(["poll", "attention"]))).toBe(true)
    expect(polledOnly(new Set())).toBe(false)
    expect(polledOnly(new Set(["attention"]))).toBe(false)
    for (const other of wakes) {
      if (other === "poll" || other === "attention") continue
      expect(polledOnly(new Set<Wake>(["poll", other]))).toBe(false)
    }
  })

  test("holds for any set of reasons", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom(...wakes)), (reasons) => {
        const why = new Set(reasons)
        const expected =
          why.has("poll") && [...why].every((each) => each === "poll" || each === "attention")
        expect(polledOnly(why)).toBe(expected)
      }),
    )
  })
})

type Env = Beads | Backlog | Ledger | Log | EventStream | RunFibers | Scope.Scope

const runWith = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

/**
 * A scheduler over the backlog's Beads, every bd call it makes logged by name in `calls`, whose
 * tickets run until `finish` ends them; `changed` is what each running ticket's worktree changed.
 */
const scheduler = (options: {
  readonly concurrent: number
  readonly changed?: Ref.Ref<ReadonlyArray<string>>
}) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const counted = Beads.of(
      Object.fromEntries(
        Object.entries(beads).map(([name, call]) => [
          name,
          (...args: ReadonlyArray<unknown>) =>
            Effect.andThen(
              Ref.update(calls, (all) => [...all, name]),
              (call as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
            ),
        ]),
      ) as unknown as Beads["Service"],
    )
    const started = yield* Ref.make<ReadonlyArray<string>>([])
    const ends = new Map<string, Deferred.Deferred<void>>()
    const endOf = (id: string) =>
      Effect.gen(function* () {
        const known = ends.get(id)
        if (known !== undefined) return known
        const made = yield* Deferred.make<void>()
        ends.set(id, made)
        return made
      })
    const { changed } = options
    const schedule = yield* make({
      concurrent: options.concurrent,
      limit: 40,
      scope: null,
      excludeTypes: ["epic"],
      ...(changed === undefined
        ? {}
        : {
            footprints: {
              repo: Effect.succeed(repoFiles(["src/a.ts", "src/b.ts"])),
              changed: () => Ref.get(changed),
              mentions: () => Effect.succeed(() => false),
            },
          }),
      start: {
        start: (issue: Issue) =>
          Effect.andThen(
            Ref.update(started, (all) => [...all, issue.id]),
            Effect.flatMap(endOf(issue.id), Deferred.await),
          ),
      },
    }).pipe(Effect.provideService(Beads, counted))
    // The calls made from here on.
    const since = Effect.map(Ref.get(calls), (all) => {
      const from = all.length
      return Effect.map(Ref.get(calls), (now) => now.slice(from))
    })
    const finish = (id: string) =>
      Effect.andThen(
        Effect.flatMap(endOf(id), (end) => Deferred.succeed(end, undefined)),
        flush,
      )
    return { schedule, started: Ref.get(started), since, finish }
  })

const seeds: ReadonlyArray<Seed> = [
  { id: "t-1", priority: 0 },
  { id: "t-2", priority: 1 },
]

describe("a poll's fill with every slot taken", () => {
  test("makes no bd call, and reads the queue again after busyPoll", async () => {
    const [first, between, later, started] = await runWith(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, since } = yield* scheduler({ concurrent: 1 })
        const sinceStart = yield* since
        yield* schedule.fillTrying
        const first = yield* sinceStart
        // The poll, 30 s later, with t-1 in the one slot.
        yield* TestClock.adjust(readyPoll)
        const sincePoll = yield* since
        const polled = yield* schedule.fillWith(undefined, true)
        const between = [yield* sincePoll, polled] as const
        // busyPoll since the queue was read: the poll's fill reads it again.
        yield* TestClock.adjust(Duration.subtract(busyPoll, readyPoll))
        const sinceLater = yield* since
        yield* schedule.fillWith(undefined, true)
        return [first, between, yield* sinceLater, yield* started] as const
      }),
    )
    expect(first).toContain("ready")
    expect(between).toEqual([[], { dispatched: [], setAside: [], queued: 1, heldBack: 0 }])
    expect(later).toContain("ready")
    expect(started).toEqual(["t-1"])
  })

  test("a slot freed is filled at once, within busyPoll", async () => {
    const started = await runWith(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fillTrying
        yield* TestClock.adjust(readyPoll)
        yield* schedule.fillWith(undefined, true)
        // t-1's fiber ends: the look it wakes isn't the poll's alone.
        yield* finish("t-1")
        yield* schedule.fillTrying
        return yield* started
      }),
    )
    expect(started).toEqual(["t-1", "t-2"])
  })

  test("with a slot free, the poll's fill reads as ever", async () => {
    const [calls, started] = await runWith(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, since, finish } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fillTrying
        yield* finish("t-1")
        yield* TestClock.adjust(readyPoll)
        const sincePoll = yield* since
        yield* schedule.fillWith(undefined, true)
        return [yield* sincePoll, yield* started] as const
      }),
    )
    expect(calls).toContain("ready")
    expect(started).toEqual(["t-1", "t-2"])
  })

  test("still warns of two worktrees changing one file, from git alone", async () => {
    const [calls, lines] = await runWith(
      [
        { id: "t-1", priority: 0, metadata: { files: ["src/a.ts"] } },
        { id: "t-2", priority: 1, metadata: { files: ["src/b.ts"] } },
        { id: "t-3", priority: 2, metadata: { files: ["src/b.ts"] } },
      ],
      Effect.gen(function* () {
        const changed = yield* Ref.make<ReadonlyArray<string>>([])
        const { schedule, since } = yield* scheduler({ concurrent: 2, changed })
        yield* schedule.fillTrying
        // Both worktrees change src/a.ts by the time the poll comes.
        yield* Ref.set(changed, ["src/a.ts"])
        yield* TestClock.adjust(readyPoll)
        const sincePoll = yield* since
        yield* schedule.fillWith(undefined, true)
        return [yield* sincePoll, yield* texts] as const
      }),
    )
    expect(calls).toEqual([])
    expect(lines.filter((text) => text.includes("LIKELY_CONFLICT"))).toHaveLength(1)
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-busy-poll-${name}-`)))

/** Asks to remove build, once answered commits and closes its ticket. */
const asksOnce = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      canUseTool("Bash", { command: "rm -rf build" }),
      ...tool("Bash", { command: "rm -rf build" }),
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

describe("a run with every slot taken", () => {
  test("starts no bd process on a 30 s poll, and reads the queue again within busyPoll", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    // The run's bd calls on the first poll with a's worker in the one slot, and from then on.
    let onPoll: ReadonlyArray<string> = ["unread"]
    let within: ReadonlyArray<string> = []
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("a").ticket("b").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World) => ({
          a: [asksOnce(world, root, "a" as TicketId)],
          b: [finishes(world, root, "b" as TicketId)],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        const beads = yield* Beads
        const attention = yield* Attention
        yield* git.addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
        yield* git.addWorktree(repo, join(root, "b"), { branch: "tutti/b", base: "main" })
        // The run's bd calls, by command; the workers' go to the backlog without them.
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
        const open = Effect.map(attention.current, (requests) =>
          requests.find((request) => request.ticket === "a"),
        )
        yield* until(
          Effect.map(open, (request) => request !== undefined),
          "asked to remove build",
        )
        // The ready poll, with a in the one slot: its fill reads no bd.
        const before = bd.length
        yield* advance(readyPoll)
        yield* Effect.promise(() => Bun.sleep(100))
        onPoll = bd.slice(before)
        // busyPoll since the start's read: the poll's fill reads the queue again.
        yield* advance(busyPoll)
        yield* until(
          Effect.sync(() => bd.slice(before).includes("ready")),
          "read the queue again",
        )
        within = bd.slice(before)
        const request = (yield* open)?.id ?? ""
        yield* attention.answer(request, { _tag: "Allow" }, "screen")
        return yield* Fiber.join(fiber)
      }),
    )
    expect(onPoll).toEqual([])
    expect(within).toContain("ready")
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
  }, 30_000)
})
