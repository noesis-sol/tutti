// A run's pulls from Linear and its pushes never run side by side (§ 5 items 19 and 20,
// tutti-311y): a pull every pull_every is skipped while a pull holds the sync or a push is queued
// or under way, and a push waits for a pull under way, as a pull that listed an issue a push had
// created but not yet linked would add a second ticket for it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { type Log, line } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import { type LinearPulls, make as makePulls } from "../src/run/linearPull.ts"
import { type LinearPushes, make as makePushes } from "../src/run/linearPush.ts"
import { run } from "../src/run/run.ts"
import { sayer } from "../src/run/say.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import type { EventRecord } from "../src/services/events.ts"
import { Git } from "../src/services/Git.ts"
import { LinearIssues } from "../src/services/LinearIssues.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import {
  Backlog,
  layer as beadsLayer,
  type LinearSeed,
  linearUrl,
  type Seed,
} from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { Listings, layer as linearIssuesLayer } from "../src/testing/LinearIssues.ts"
import { texts } from "../src/testing/Log.ts"
import { expectExitCode, scenario, type World } from "./harness.ts"

type Env = Beads | Backlog | Listings | Ledger | Log | EventStream | RunFibers | Scope.Scope

const minute = Duration.minutes(1)

/** Before the run began: the backlog's history. */
const before = "1969-12-31T00:00:00.000Z"

/** `body` given a run's pulls, every minute, and its pushes holding the pulls' sync. */
const within = <A>(
  seeds: ReadonlyArray<Seed>,
  issues: ReadonlyArray<LinearSeed>,
  body: (pulls: LinearPulls, pushes: LinearPushes) => Effect.Effect<A, unknown, Env>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* LinearIssues
      if (source === null) return yield* Effect.die("no LinearIssues source")
      const pulls = yield* makePulls({
        linear: { team: "NOE", pull_every: minute },
        source,
        beads: yield* Beads,
        held: Effect.succeed(new Set<string>()),
        sayer: yield* sayer,
        wakeUp: Effect.void,
      })
      const pushes = yield* makePushes({ since: 0, sync: pulls.busy })
      return yield* body(pulls, pushes)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        linearIssuesLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              beadsLayer(seeds, { linearTeam: { issues } }),
              ledgerLayer(),
              runFibersLayer,
            ),
          ),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** Lets forked fibers run a while, without moving the clock. */
const settle = Effect.promise(() => Bun.sleep(5))

/** Moves the clock on a minute, a pull's time, and lets the pulls run. */
const aMinute = Effect.andThen(TestClock.adjust(minute), settle)

const linearLines = Effect.map(texts, (all) => all.filter((text) => /LINEAR/.test(text)))

const listings = Effect.flatMap(Listings, (listings) => listings.asked)

describe("pulls and pushes to Linear", () => {
  test("a pull is skipped while a push is queued or under way", async () => {
    const seen = await within([], [], (pulls) =>
      Effect.gen(function* () {
        const pushing = yield* Ref.make(true)
        const fiber = yield* Effect.forkChild(pulls.every(Ref.get(pushing)))
        yield* settle
        yield* aMinute
        const whilePushing = (yield* listings).length
        yield* Ref.set(pushing, false)
        yield* aMinute
        yield* Fiber.interrupt(fiber)
        return { whilePushing, after: (yield* listings).length, lines: yield* linearLines }
      }),
    )
    expect(seen.whilePushing).toBe(0)
    expect(seen.after).toBe(1)
    expect(seen.lines).toEqual(["LINEAR: pulled from NOE: nothing new"])
  })

  test("a push waits for a pull under way, then pushes", async () => {
    const seen = await within(
      [{ id: "t-1", status: "closed", externalRef: linearUrl("NOE-1"), createdAt: before }],
      [{ key: "NOE-1", title: "t-1" }],
      (pulls, pushes) =>
        Effect.gen(function* () {
          const stateOf = Effect.map(
            Effect.flatMap(Backlog, (backlog) => backlog.linearIssues),
            (issues) => issues.find((issue) => issue.key === "NOE-1")?.state,
          )
          // A pull holds the sync while the ticket closes.
          const during = yield* pulls.busy.withPermits(1)(
            Effect.gen(function* () {
              yield* pushes.changed("t-1" as TicketId, "closed")
              yield* settle
              return {
                busy: yield* pushes.busy,
                state: yield* stateOf,
                lines: yield* linearLines,
              }
            }),
          )
          yield* settle
          return { during, busy: yield* pushes.busy, state: yield* stateOf }
        }),
    )
    expect(seen.during).toEqual({ busy: true, state: "unstarted", lines: [] })
    expect(seen.busy).toBe(false)
    expect(seen.state).toBe("completed")
  })

  test("a ticket filed in the run is pushed after the pull under way, and no pull adds it again", async () => {
    const seen = await within([{ id: "f", title: "A follow-up" }], [], (pulls, pushes) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(pulls.every(pushes.busy))
        yield* settle
        // A pull holds the sync as the ticket is filed, and over the next pull's time.
        yield* pulls.busy.withPermits(1)(
          Effect.andThen(pushes.changed("f" as TicketId, "filed"), aMinute),
        )
        yield* settle
        // The push has gone through: the next pull finds the issue it created linked.
        yield* aMinute
        yield* Fiber.interrupt(fiber)
        const backlog = yield* Backlog
        return {
          listings: (yield* listings).length,
          lines: yield* linearLines,
          tickets: (yield* backlog.issues).map(
            (issue): ReadonlyArray<string | undefined> => [issue.id, issue.linearKey],
          ),
          issues: (yield* backlog.linearIssues).map((issue) => issue.key),
        }
      }),
    )
    expect(seen.listings).toBe(1)
    expect(seen.lines).toEqual([
      "  LINEAR: f filed, pushed to NOE-1 (created)",
      "LINEAR: pulled from NOE: nothing new",
    ])
    expect(seen.tickets).toEqual([["f", "NOE-1"]])
    expect(seen.issues).toEqual(["NOE-1"])
  })
})

describe("pulls and pushes in a whole run", () => {
  const folder = (name: string) =>
    realpathSync(mkdtempSync(join(tmpdir(), `tutti-linear-exclusion-${name}-`)))

  /** A worker that claims its ticket, does `first`, takes `span`, then commits and closes it. */
  const works = (
    world: World,
    root: string,
    id: string,
    span: Duration.Input,
    first: ReadonlyArray<ReturnType<typeof bash>[number]> = [],
  ): SessionScript =>
    turn(
      [
        ...bash(
          `bd update ${id} --claim`,
          Effect.asVoid(Effect.orDie(world.beads.update(id as TicketId, { claim: true }))),
        ),
        ...first,
        sleep(span),
        ...bash(
          `git commit -am "Change (${id})"`,
          Effect.asVoid(
            Effect.orDie(
              world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
            ),
          ),
        ),
        ...bash(
          `bd close ${id}`,
          Effect.asVoid(Effect.orDie(world.beads.close(id as TicketId, "done"))),
        ),
      ],
      result(`Closed ${id}.`),
    )

  /**
   * A whole run with a pull every minute of t-1, linked to NOE-1, and t-2, the backlog's history,
   * whose worker keeps the run going 8 minutes; the clock moved on 10 s at a time, `during` run at
   * the start of each minute.
   */
  const runs = (setup: {
    readonly t1: (world: World, root: string) => SessionScript
    readonly before?: Effect.Effect<void, never, Backlog>
    readonly during?: (minute: number) => Effect.Effect<void, never, Backlog>
  }) => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = TestAppConfig.appConfig().settings
    return scenario(
      {
        config: {
          repo,
          settings: { ...defaults, concurrent: 2 },
          linear: { team: "NOE", pull_every: minute },
        },
        backlog: [
          { id: "t-1", externalRef: linearUrl("NOE-1"), createdAt: before },
          { id: "t-2", createdAt: before },
        ],
        bd: { linearTeam: { issues: [{ key: "NOE-1", title: "t-1" }] } },
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          "t-1": [setup.t1(world, root)],
          "t-2": [works(world, root, "t-2", "8 minutes")],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["t-1", "t-2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        if (setup.before !== undefined) yield* setup.before
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        for (let step = 0; step < 15 * 6; step++) {
          yield* Effect.promise(() => Bun.sleep(5))
          if (setup.during !== undefined && step % 6 === 0) yield* setup.during(step / 6)
          yield* TestClock.adjust("10 seconds")
        }
        return yield* Fiber.join(fiber)
      }),
    )
  }

  /** The run's Linear records of `sync`, each with its time in seconds since the run began. */
  const synced = (events: ReadonlyArray<EventRecord>, sync: "pull" | "push") =>
    events.flatMap((record) =>
      record.kind === "linear" && record.sync === sync
        ? [{ ...record, at: Date.parse(record.time) / 1000 }]
        : [],
    )

  test("a push waits for the pull under way", async () => {
    const ran = await runs({
      // The pull of NOE-2, filed in Linear at a minute, takes a minute.
      before: Effect.flatMap(Backlog, (backlog) =>
        backlog.fail("linear sync --pull", { takes: minute }),
      ),
      during: (at) =>
        at === 1
          ? Effect.flatMap(Backlog, (backlog) =>
              backlog.putLinear({ key: "NOE-2", title: "Filed in Linear", state: "backlog" }),
            )
          : Effect.void,
      t1: (world, root) => works(world, root, "t-1", "130 seconds"),
    })
    expectExitCode(ran, 0)
    const pulled = synced(ran.events, "pull").find((record) => record.added !== undefined)
    const closed = synced(ran.events, "push").find(
      (record) => record.ticket === "t-1" && /closed/.test(record.text),
    )
    expect(pulled?.added).toEqual(["NOE-2"])
    // t-1 closed at 2:20, as the pull from 2:00 to 3:00 went: its push waited for the pull's end.
    expect(closed?.at).toBeGreaterThanOrEqual(pulled?.at ?? Infinity)
  }, 30_000)

  test("a pull is skipped while a push is under way", async () => {
    const ran = await runs({
      // The push of t-1's follow-up reads it for 3 minutes before it pushes it.
      t1: (world, root) =>
        works(
          world,
          root,
          "t-1",
          "1 minute",
          bash(
            'bd create "A follow-up"',
            Effect.orDie(
              Effect.gen(function* () {
                const filed = yield* world.beads.create({ title: "A follow-up" })
                yield* world.beads.defer(filed.id)
                yield* world.backlog.fail("show", { id: filed.id, takes: "3 minutes" })
              }),
            ),
          ),
        ),
    })
    expectExitCode(ran, 0)
    const filed = synced(ran.events, "push").find((record) => /filed/.test(record.text))
    const pulls = synced(ran.events, "pull").filter((record) => record.start !== true)
    expect(filed?.issue).toBe("NOE-2")
    const at = filed?.at ?? 0
    expect(pulls.filter((pull) => pull.at > at - 180 && pull.at < at)).toEqual([])
    expect(pulls.length).toBeGreaterThan(0)
  }, 30_000)
})
