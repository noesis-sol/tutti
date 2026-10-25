// Whole runs with a ticket merged by hand, and the tickets a run keeps from their recheck
// (handMerged.ts, recheck.ts's dropRechecks), and a carried-over ticket dropped as merged by hand
// (carry.ts).

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import type { TicketRecord } from "../src/services/Store.ts"
import {
  bash,
  gone,
  result,
  type SessionScript,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import type { Script as ChecksScript } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-hand-merged-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** Where the run's main checkout and worktrees are, for the workers' scripts. */
interface Places {
  readonly repo: string
  readonly root: string
}

/** Claims its ticket, does `first`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  places: Places,
  id: TicketId,
  options: { readonly files?: Files; readonly first?: SessionScript } = {},
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...(options.first ?? []),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(
              join(places.root, id),
              `Change (${id})`,
              options.files ?? { [`${id}.txt`]: `${id}\n` },
            ),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** The fast check failing in a file no ticket here changes. */
const fails = new CheckFailed({
  check: "fast",
  command: check,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["shared/b.go:12: expected 1"],
  lastLines: ["1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  }).pipe(Effect.orDie)

/** a set aside: its check failed, with its hand-backs off. */
const setAside = /^ {2}CHECKS_FAILED: a closed, /

interface Plan {
  readonly backlog: ReadonlyArray<Seed>
  readonly tickets: ReadonlyArray<string>
  readonly checks?: ChecksScript
  readonly scripts: (world: World, places: Places) => Scripts
  /** Runs beside the run, before it is joined. */
  readonly during?: (places: Places) => Effect.Effect<void, unknown, Env>
}

/** A whole run on main with 2 workers and no check hand-backs, each ticket's worktree made first. */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const settings = {
    ...defaults,
    concurrent: 2,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    merge: { ...defaults.merge, check_hand_backs: 0 },
  }
  return scenario(
    {
      config: { repo: places.repo, settings },
      backlog: plan.backlog,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) => plan.scripts(world, places),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      if (plan.during !== undefined) yield* plan.during(places)
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

describe("a ticket set aside and merged by hand while the run goes on", () => {
  test("is found as the base moves: closed, not set aside, and the ticket it blocks starts", async () => {
    // a's check fails; b waits for a to merge; c works until a is found merged by hand.
    const found = Effect.runSync(Deferred.make<void>())
    const ran = await runs({
      backlog: backlog()
        .ticket("a")
        .ticket("c")
        .ticket("b", { blockedBy: ["a"] }).seeds,
      tickets: ["a", "b", "c"],
      checks: { fast: [fails] },
      scripts: (world, places) => ({
        a: [works(world, places, "a" as TicketId, { files: { "a.txt": "a\n" } })],
        b: [works(world, places, "b" as TicketId)],
        c: [works(world, places, "c" as TicketId, { first: [step(Deferred.await(found))] })],
      }),
      during: (places) =>
        Effect.gen(function* () {
          yield* untilLogged(setAside)
          const repository = yield* Repository
          yield* repository.commit(places.repo, "Merge a by hand (a)", { "a.txt": "a\n" })
          // The ready poll looks again.
          yield* advance("30 seconds")
          yield* untilLogged(/merged by hand/)
          yield* Deferred.succeed(found, undefined)
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expectLog(ran, [
      setAside,
      /^ {2}a, set aside in this run, is on main now \([0-9a-f]{7} Merge a by hand \(a\)\): merged by hand, so no longer set aside; worktree and branch removed$/,
      /^ {2}b closed \(.*\); merged into main/,
      "  Completed 3 · Set aside 0 · Needs you 0",
    ])
    expect(ran.log.some((text) => text.includes("RECHECK"))).toBe(false)
  })
})

describe("a run that stops", () => {
  test("names each ticket it keeps from its recheck", async () => {
    // a's check fails, kept to be checked once more; c's worker is gone twice: PAUSED.
    const aside = Effect.runSync(Deferred.make<void>())
    const ran = await runs({
      backlog: backlog().ticket("a").ticket("c").seeds,
      tickets: ["a", "c"],
      checks: { fast: [fails] },
      scripts: (world, places) => ({
        a: [works(world, places, "a" as TicketId)],
        c: [
          [
            ...turn([
              ...bash(
                "bd update c --claim",
                Effect.asVoid(Effect.orDie(world.beads.update("c" as TicketId, { claim: true }))),
              ),
              step(Deferred.await(aside)),
            ]).slice(0, -2),
            gone("exit 1"),
          ],
          [gone("exit 1")],
        ],
      }),
      during: () => Effect.andThen(untilLogged(setAside), Deferred.succeed(aside, undefined)),
    })
    expectExitCode(ran, 3)
    expectPhases(ran, { a: "Review", c: "Stopped" })
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, .*; checked once more if main moves on in this run$/,
      "  a is not checked again in this run, as the run stopped; it stays set aside",
      /^PAUSED: c still in_progress/,
    ])
  })
})

/** What the last run saved of a ticket, its worktree under `root`: suspended by a quit. */
const savedRecord = (root: string, id: string): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  suspended: "quit",
  phase: "Stopped",
  resumes: 0,
  metadata: {},
})

/**
 * A plain run after one that left t-1 suspended, closed since and its branch fast-forwarded onto
 * main by hand; `before` changes its worktree first.
 */
const carried = (before: (worktree: string) => Effect.Effect<void, unknown, Env>) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      backlog: backlog().ticket("t-1", { status: "closed" }).seeds,
      config: { repo },
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, tickets: { "t-1": savedRecord(root, "t-1") } },
    },
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      const worktree = join(root, "t-1")
      mkdirSync(worktree, { recursive: true })
      yield* git.addWorktree(repo, worktree, { branch: "tutti/t-1", base: "main" })
      yield* repository.commit(worktree, "Change (t-1)", { "t-1.txt": "x\n" })
      yield* git.fastForward(repo, "tutti/t-1")
      yield* before(worktree)
      return yield* Effect.scoped(run({ version: "0.1.0-test", base: "main" }))
    }),
  )
}

describe("a carried-over ticket dropped as merged by hand", () => {
  test("has its worktree and branch removed", async () => {
    const ran = await carried(() => Effect.void)
    expectLog(ran, [
      /^ {2}t-1, carried over from the last run, is dropped: tutti\/t-1 is on main already \([0-9a-f]{7} Change \(t-1\)\); worktree and branch removed$/,
    ])
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id: "t-1" as TicketId, force: false })
  })

  test("with uncommitted changes, keeps its worktree and branch, saying so", async () => {
    const ran = await carried((worktree) =>
      Effect.flatMap(Repository, (repository) =>
        repository.write(worktree, { "notes.txt": "mine\n" }),
      ),
    )
    expectLog(ran, [
      /^ {2}t-1, carried over from the last run, is dropped: tutti\/t-1 is on main already \([0-9a-f]{7} Change \(t-1\)\); worktree \S+ has uncommitted changes \(notes\.txt\), so it and tutti\/t-1 are left as they are \(commit or remove them, then remove it\)$/,
    ])
    expect(ran.worktreeCalls.some((call) => call.op === "remove")).toBe(false)
  })
})
