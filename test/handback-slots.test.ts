// A ticket handed back to its worker, Resolving or Fixing, takes a slot as a running ticket does
// (§ 5 item 5, tutti-epza.11): its worker is at work and runs checks, so no ticket starts beside it
// until the workers at work are under `concurrent` again. The hand-back itself goes on at once,
// whatever the slots. Tickets waiting to merge or merging, with no worker at work, take none up to
// `concurrent` of them.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll, slotsTaken } from "../src/run/schedule.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Captured } from "../src/testing/EventStream.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const check = "scripts/check-fast.sh"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-handback-slots-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket and, after `takes`, commits a file of its own and closes it. */
const works = (world: World, root: string, id: TicketId, takes: Duration.Input = 0) =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(takes),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** A hand-back turn in which the worker, after `takes`, commits `files` as a fix of `id`. */
const fixes = (world: World, root: string, id: TicketId, takes: Duration.Input, files: Files) =>
  turn([
    sleep(takes),
    ...bash(
      `git commit -am "Fix the check (${id})"`,
      orDie(world.repository.commit(join(root, id), `Fix the check (${id})`, files)),
    ),
  ])

/** The merge check failing, its lines saying what failed. */
const failure = new CheckFailed({
  check: "fast",
  command: check,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: a.test.ts: expected 1"],
  lastLines: ["1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

/** The merge check failing after a minute. */
const failsAfterAMinute = Effect.andThen(Effect.sleep("1 minute"), Effect.fail(failure))

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

/** The tickets dispatched, in order, with when: the minute since the run began. */
const dispatches = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "dispatch"
      ? [`${record.ticket} ${Math.floor(Date.parse(record.time) / 60_000)}m`]
      : [],
  )

/**
 * A run on main with 2 workers and four tickets: a finishes at once and its check fails at 1m,
 * handed back to its worker, which fixes it in 10 minutes; b works for 30 minutes, c for 2, d at
 * once.
 */
const handedBackRun = (): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: 2,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    merge: { ...defaults.merge, train: 0 },
  }
  const tickets = ["a", "b", "c", "d"]
  return scenario(
    {
      config: { repo, worktrees: root, settings },
      backlog: tickets.reduce((b, id, priority) => b.ticket(id, { priority }), backlog()).seeds,
      git: { dir: repo, files: { "README.md": "tutti\n" } },
      worktrees: { root },
      checks: { fast: [failsAfterAMinute] },
      scripts: (world: World) => ({
        a: [
          [
            ...works(world, root, "a" as TicketId),
            ...fixes(world, root, "a" as TicketId, "10 minutes", { "fix.txt": "fixed\n" }),
          ],
        ],
        b: [works(world, root, "b" as TicketId, "30 minutes")],
        c: [works(world, root, "c" as TicketId, "2 minutes")],
        d: [works(world, root, "d" as TicketId)],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      // 40 minutes, a ready poll at a time, the run caught up each time.
      for (let i = 0; i < 80; i++) {
        yield* caughtUp
        yield* advance(readyPoll)
      }
      return yield* Fiber.join(fiber)
    }),
  )
}

describe("a ticket handed back", () => {
  test("takes a slot, each one handed back beside those running and past concurrent waiting", () => {
    expect(slotsTaken(1, 1, 0, 2)).toBe(2)
    expect(slotsTaken(1, 1, 2, 2)).toBe(2)
    expect(slotsTaken(0, 2, 2, 2)).toBe(2)
    expect(slotsTaken(2, 1, 3, 2)).toBe(4)
  })

  test("holds its slot while its worker fixes it, the next ticket starting once it is fixed", async () => {
    // Two slots. a finishes at once, freeing its slot for c, as it waits to merge with no worker at
    // work; its check fails at 1m and is handed back to its worker at once, though b and c hold
    // both slots. c finishes at 2m and merges, but a, being fixed, holds a slot beside b: d waits
    // until a's fix goes back in line at 11m. Counting a in no slot, d would start at 2m, a third
    // worker at work beside b's and a's.
    const ran = await handedBackRun()
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done", d: "Done" })
    expect(dispatches(ran)).toEqual(["a 0m", "b 0m", "c 0m", "d 11m"])
    expectLog(ran, [
      "[3] c dispatching: c",
      `  FIXING: '${check}' fails on tutti/a on top of main; handed back to its worker to fix (1 of 2, up to 20m)`,
      /^ {2}c closed /,
      "[4] d dispatching: d",
    ])
  })
})
