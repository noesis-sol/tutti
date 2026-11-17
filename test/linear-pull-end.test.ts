// A run's pulls from Linear stop at its end (§ 5 item 20, tutti-h22c): the wind-down stops them,
// none begins from then on and one under way ends first, so that none is said after the end record,
// though the run's scope, which its caller closes, stays open.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { type Log, line } from "../src/core/log.ts"
import { type LinearPulls, make as makePulls } from "../src/run/linearPull.ts"
import { run } from "../src/run/run.ts"
import { sayer } from "../src/run/say.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { Git } from "../src/services/Git.ts"
import { LinearIssues } from "../src/services/LinearIssues.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer, type LinearSeed, linearUrl } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { Listings, layer as linearIssuesLayer } from "../src/testing/LinearIssues.ts"
import { texts } from "../src/testing/Log.ts"
import { expectExitCode, scenario, type World } from "./harness.ts"

type Env = Beads | Backlog | Listings | Log | EventStream | Scope.Scope

const minute = Duration.minutes(1)

/** `body` given a run's pulls, every minute, of the team's `issues`. */
const within = <A>(
  issues: ReadonlyArray<LinearSeed>,
  body: (pulls: LinearPulls) => Effect.Effect<A, unknown, Env>,
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
      return yield* body(pulls)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        linearIssuesLayer.pipe(
          Layer.provideMerge(
            Layer.merge(beadsLayer([], { linearTeam: { issues } }), ledgerLayer()),
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

const listings = Effect.map(
  Effect.flatMap(Listings, (listings) => listings.asked),
  (asked) => asked.length,
)

describe("stopping a run's pulls from Linear", () => {
  test("no pull begins once they are stopped", async () => {
    const seen = await within([], (pulls) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(pulls.every(Effect.succeed(false)))
        yield* settle
        yield* aMinute
        const before = yield* listings
        yield* pulls.stop
        for (let at = 0; at < 3; at++) yield* aMinute
        yield* Fiber.interrupt(fiber)
        return { before, after: yield* listings, lines: yield* linearLines }
      }),
    )
    expect(seen.before).toBe(1)
    expect(seen.after).toBe(1)
    expect(seen.lines).toEqual(["LINEAR: pulled from NOE: nothing new"])
  })

  test("a pull under way ends before the stop does", async () => {
    const seen = await within([{ key: "NOE-1", title: "Filed in Linear" }], (pulls) =>
      Effect.gen(function* () {
        // The pull of NOE-1 takes a minute.
        yield* Effect.flatMap(Backlog, (backlog) =>
          backlog.fail("linear sync --pull", { takes: minute }),
        )
        const fiber = yield* Effect.forkChild(pulls.every(Effect.succeed(false)))
        yield* settle
        yield* aMinute
        const stopping = yield* Effect.forkChild(pulls.stop)
        yield* settle
        const during = { stopped: stopping.pollUnsafe() !== undefined, lines: yield* linearLines }
        yield* aMinute
        yield* Fiber.join(stopping)
        const stopped = yield* linearLines
        for (let at = 0; at < 3; at++) yield* aMinute
        yield* Fiber.interrupt(fiber)
        return { during, stopped, listings: yield* listings }
      }),
    )
    expect(seen.during).toEqual({ stopped: false, lines: [] })
    expect(seen.stopped).toEqual(["LINEAR: pulled from NOE: added NOE-1"])
    expect(seen.listings).toBe(1)
  })
})

describe("a whole run's pulls from Linear", () => {
  const folder = (name: string) =>
    realpathSync(mkdtempSync(join(tmpdir(), `tutti-linear-pull-end-${name}-`)))

  /** A worker that claims its ticket, takes `span`, then commits and closes it. */
  const works = (world: World, root: string, id: string, span: Duration.Input): SessionScript =>
    turn(
      [
        ...bash(
          `bd update ${id} --claim`,
          Effect.asVoid(Effect.orDie(world.beads.update(id as TicketId, { claim: true }))),
        ),
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

  test("none is pulled after the end record, while the run's scope stays open", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = TestAppConfig.appConfig().settings
    const before = "1969-12-31T00:00:00.000Z"
    const ran = await scenario(
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
          "t-1": [works(world, root, "t-1", "1 minute")],
          "t-2": [works(world, root, "t-2", "4 minutes")],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["t-1", "t-2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        // The clock goes on 10 minutes, past the run's end, its scope open all the while.
        for (let step = 0; step < 10 * 6; step++) {
          yield* Effect.promise(() => Bun.sleep(5))
          yield* TestClock.adjust("10 seconds")
        }
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    const kinds = ran.events.map((record) =>
      record.kind === "linear" ? `linear ${record.sync}` : record.kind,
    )
    const end = kinds.indexOf("end")
    expect(end).toBeGreaterThan(-1)
    expect(kinds.slice(0, end)).toContain("linear pull")
    expect(kinds.slice(end + 1)).not.toContain("linear pull")
  }, 30_000)
})
