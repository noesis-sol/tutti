// A ticket frees its slot as it goes to the merge queue, but holds back what it did while it ran
// until it merges (§ 5 item 5, orchestra 0.8.5's orchestra-z8lr): a ready ticket overlapping its
// footprint waits for it, and a solo ticket for it to merge. Up to `concurrent` tickets merge, or
// wait to merge, without a slot; beyond that, each takes one until a merge ends.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll, slotsTaken } from "../src/run/schedule.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Script as ChecksScript, passed } from "../src/testing/Checks.ts"
import { Captured } from "../src/testing/EventStream.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  type BacklogBuilder,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-merging-slots-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A ticket whose `files` metadata names `files`, which its footprint holds. */
const touching = (...files: ReadonlyArray<string>) => ({ metadata: { files } })

/** Claims its ticket and, after `takes`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  root: string,
  id: string,
  options: { readonly files?: Files; readonly takes?: Duration.Input } = {},
): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(options.takes ?? 0),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(
          world.repository.commit(
            join(root, id),
            `Change (${id})`,
            options.files ?? { [`${id}.txt`]: `${id}\n` },
          ),
        ),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** A merge check that passes after `takes`. */
const slowCheck = (takes: Duration.Input) => Effect.as(Effect.sleep(takes), passed("fast"))

/** Waits, in real time, until the run has written no log line or record for 30 ms. */
const caughtUp = Effect.gen(function* () {
  const captured = yield* Captured
  let said = -1
  for (let i = 0, still = 0; i < 1000 && still < 6; i++) {
    const now = (yield* texts).length + (yield* captured.records).length
    still = now === said ? still + 1 : 0
    said = now
    yield* Effect.promise(() => Bun.sleep(5))
  }
})

/** Moves TestClock on by `total`, a ready poll at a time, once the run has caught up each time. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const polls = Duration.toMillis(Duration.fromInputUnsafe(total)) / Duration.toMillis(readyPoll)
    for (let i = 0; i < polls; i++) {
      yield* caughtUp
      yield* advance(readyPoll)
    }
  })

/** The repository's files on main, which footprints are resolved against. */
const files = { "README.md": "tutti\n", "src/a.ts": "a\n", "src/c.ts": "c\n" }

/** A whole run on main with 2 workers, each ticket's worktree made in git first. */
const runs = (plan: {
  readonly backlog: BacklogBuilder
  readonly checks: ChecksScript
  readonly scripts: (
    world: World,
    root: string,
  ) => Readonly<Record<string, ReadonlyArray<SessionScript>>>
  readonly lasts: Duration.Input
}): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: 2,
    checks: {
      ...defaults.checks,
      fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
    },
  }
  const tickets = plan.backlog.seeds.map((seed) => seed.id)
  return scenario(
    {
      config: { repo, worktrees: root, settings },
      backlog: plan.backlog.seeds,
      git: { dir: repo, files },
      worktrees: { root },
      checks: plan.checks,
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* passes(plan.lasts)
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The tickets dispatched, in order, with when: the minute since the run began. */
const dispatches = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "dispatch"
      ? [`${record.ticket} ${Math.floor(Date.parse(record.time) / 60_000)}m`]
      : [],
  )

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

describe("slots taken", () => {
  test("up to concurrent tickets past their work take no slot, each beyond them one", () => {
    expect(slotsTaken(1, 0, 2)).toBe(1)
    expect(slotsTaken(1, 2, 2)).toBe(1)
    expect(slotsTaken(1, 3, 2)).toBe(2)
    expect(slotsTaken(0, 5, 2)).toBe(3)
  })
})

describe("a ticket past its work", () => {
  test("holds back a ticket overlapping it until it merges, and past the cap a merge frees the slot", async () => {
    // Two slots. x merges at once, unchecked; every merge after it is checked. b settles at 1m and
    // its check takes 10m; a, touching src/a.ts, settles at 2m and waits for b, then its check takes
    // 5m: it merges at 16m. o, touching src/a.ts too, waits for a to merge, though slots are free:
    // c takes b's slot at 1m, and d a's at 2m. c settles at 4m, the third ticket past its work: d
    // works, and e waits for a merge to end, b's at 11m. Every slot is taken or waits at the cap
    // whenever o is skipped, so it waits Queued, as for a slot, rather than HeldBack.
    const ran = await runs({
      backlog: backlog()
        .ticket("x", { priority: 0 })
        .ticket("b", { priority: 1 })
        .ticket("a", { priority: 2, ...touching("src/a.ts") })
        .ticket("o", { priority: 3, ...touching("src/a.ts") })
        .ticket("c", { priority: 4, ...touching("src/c.ts") })
        .ticket("d", { priority: 5 })
        .ticket("e", { priority: 6 }),
      checks: { fast: [slowCheck("10 minutes"), slowCheck("5 minutes")] },
      scripts: (world, root) => ({
        x: [works(world, root, "x")],
        b: [works(world, root, "b", { takes: "1 minute" })],
        a: [works(world, root, "a", { takes: "2 minutes", files: { "src/a.ts": "a2\n" } })],
        o: [works(world, root, "o")],
        c: [works(world, root, "c", { takes: "3 minutes", files: { "src/c.ts": "c2\n" } })],
        d: [works(world, root, "d", { takes: "20 minutes" })],
        e: [works(world, root, "e")],
      }),
      lasts: "23 minutes",
    })
    expectExitCode(ran, 0)
    expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
    expectPhases(ran, {
      x: "Done",
      b: "Done",
      a: "Done",
      o: "Done",
      c: "Done",
      d: "Done",
      e: "Done",
    })
    expect(dispatches(ran)).toEqual(["x 0m", "b 0m", "a 0m", "c 1m", "d 2m", "e 11m", "o 16m"])
    expect(ran.log.filter((text) => text.startsWith("  skipping"))).toEqual([
      "  skipping o: touches src/a.ts, like running a",
    ])
    expectLog(ran, [
      closedLine("x"),
      "[3/40] a dispatching: a",
      "  skipping o: touches src/a.ts, like running a",
      "[4/40] c dispatching: c",
      "[5/40] d dispatching: d",
      closedLine("b"),
      "[6/40] e dispatching: e",
      closedLine("a"),
      "[7/40] o dispatching: o",
      closedLine("d"),
      "READY_EMPTY after 7 tickets",
    ])
  }, 30_000)

  test("keeps a solo ticket next waiting until it merges", async () => {
    // x merges at once, unchecked; b settles at 1m and its check takes 10m. s, solo, is next from
    // the start, and waits for b's merge, not only for its worker.
    const ran = await runs({
      backlog: backlog()
        .ticket("x", { priority: 0 })
        .ticket("b", { priority: 1 })
        .ticket("s", { priority: 2, labels: ["solo"] }),
      checks: { fast: [slowCheck("10 minutes")] },
      scripts: (world, root) => ({
        x: [works(world, root, "x")],
        b: [works(world, root, "b", { takes: "1 minute" })],
        s: [works(world, root, "s")],
      }),
      lasts: "12 minutes",
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { x: "Done", b: "Done", s: "Done" })
    expect(dispatches(ran)).toEqual(["x 0m", "b 0m", "s 11m"])
    expectLog(ran, [
      "  solo ticket s is next: no new tickets start until the running ones finish, then it runs alone",
      closedLine("b"),
      "[3/40] s dispatching solo: s",
      closedLine("s"),
      "READY_EMPTY after 3 tickets",
    ])
  }, 30_000)
})
