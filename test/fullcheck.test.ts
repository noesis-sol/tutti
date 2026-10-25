import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import fc from "fast-check"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import {
  filedForSuite,
  fullCheckDue,
  fullCheckLabel,
  fullCheckTitle,
  titleWidth,
} from "../src/run/fullcheck.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { CheckFailed, CheckTimedOut, type Said } from "../src/services/Checks.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { runExcludeEntry, Worktrees } from "../src/services/Worktrees.ts"
import {
  claimsAndCloses,
  defers,
  gone,
  type SessionScript,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import {
  type CheckRun,
  type Script as ChecksScript,
  passed,
  type Scripted,
} from "../src/testing/Checks.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"
import { backlog, expectEvents, expectLog, type Ran, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-fullcheck-${name}-`)))

const fullCommand = "scripts/check-full.sh"
const setupCommand = "bun install"

/** The settings with a full check, and a setup when `setup` is set. */
const config = (setup = false): Partial<AppConfigValue> => {
  const { settings } = appConfig()
  return {
    settings: {
      ...settings,
      checks: {
        ...settings.checks,
        full: { command: fullCommand, timeout: Duration.minutes(60) },
        setup: { ...settings.checks.setup, command: setup ? setupCommand : null },
      },
    },
  }
}

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** Claims its ticket and defers it: nothing merges. */
const gives = (world: World, id: TicketId): SessionScript =>
  defers(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    defer: Effect.asVoid(Effect.orDie(world.beads.defer(id))),
  })

/** Claims its ticket and goes, is resumed once and goes again: PAUSED. */
const pauses = (world: World, id: TicketId): ReadonlyArray<SessionScript> => [
  [
    ...turn([step(Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))))]).slice(
      0,
      -2,
    ),
    gone("exit 1"),
  ],
  [gone("exit 1")],
]

interface Plan {
  readonly config: Partial<AppConfigValue>
  readonly backlog: ReadonlyArray<Seed>
  /** Each ticket's worker: it finishes and merges, defers, or goes twice (PAUSED). */
  readonly workers: Readonly<Record<string, "finishes" | "defers" | "pauses">>
  readonly checks?: ChecksScript
  /** Once this is done, the run is quit (interrupted). */
  readonly quitWhen?: Deferred.Deferred<void>
}

/** A whole run on main, each ticket's worktree in the in-memory git where the test layer puts it. */
const runs = (plan: Plan): Promise<Ran<Outcome | undefined>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: { ...plan.config, repo },
      git: { dir: repo },
      worktrees: { root },
      backlog: plan.backlog,
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world) =>
        Object.fromEntries(
          Object.entries(plan.workers).map(([id, how]) => [
            id,
            how === "finishes"
              ? [finishes(world, root, id as TicketId)]
              : how === "defers"
                ? [gives(world, id as TicketId)]
                : pauses(world, id as TicketId),
          ]),
        ),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of Object.keys(plan.workers)) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main" }))
      if (plan.quitWhen !== undefined) {
        yield* Deferred.await(plan.quitWhen)
        yield* Fiber.interrupt(fiber)
        return undefined
      }
      return yield* Fiber.join(fiber)
    }),
  )
}

const recordsOf = (ran: Ran<unknown>, kind: string) =>
  ran.events.filter((record) => record.kind === kind)

const said = (fields: Partial<Said> = {}): Said => ({
  failingLines: [],
  lastLines: [],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
  ...fields,
})

/** A full check that prints `output` to its file and fails in `suite`. */
const failsIn =
  (suite: string, output = `SUITE: ${suite}\nFAIL: it broke\n`): Scripted =>
  (ran: CheckRun) =>
    Effect.suspend(() => {
      if (ran.outputFd !== undefined) writeSync(ran.outputFd, output)
      return Effect.fail(
        new CheckFailed({
          check: "full",
          command: fullCommand,
          exitCode: 1,
          outputFile: ran.outputFile,
          ...said({
            failingLines: ["FAIL: it broke"],
            lastLines: output.trimEnd().split("\n"),
            suites: [suite],
            suite,
          }),
        }),
      )
    })

const checkFullTickets = (ran: Ran<unknown>): ReadonlyArray<Issue> =>
  ran.issues.filter((issue) => issue.labels.includes(fullCheckLabel))

describe("when the full check runs", () => {
  test("after a run that ended by itself and merged: the setup, then the check, in a worktree of its own, removed afterwards", async () => {
    const ran = await runs({
      config: config(true),
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "finishes" },
    })
    // The setup in t-1's new worktree came before its worker, the full check's after the run.
    const [setup, full] = ran.checkRuns.filter(
      (each) => each.check === "full" || each.before === "full",
    )
    expect(setup).toEqual(expect.objectContaining({ check: "setup", before: "full" }))
    expect(full).toEqual(expect.objectContaining({ check: "full" }))
    const added = ran.worktreeCalls.find((call) => call.op === "addDetached")
    if (added?.op !== "addDetached") throw new Error("no worktree was made for the full check")
    expect(added.path).toMatch(/\/check-full-[^/]+$/)
    expect(setup?.cwd).toBe(added.path)
    expect(full?.cwd).toBe(added.path)
    expect(ran.worktreeCalls).toContainEqual({ op: "removeDetached", path: added.path })
    expect(existsSync(added.path)).toBe(false)
    expectLog(ran, [
      "READY_EMPTY after 1 tickets",
      /^ {2}FULL_CHECK: running 'bun install', then 'scripts\/check-full\.sh', on main at [0-9a-f]{7} in .*check-full-.* \(time limit 1h\)$/,
      /^ {2}FULL_CHECK passed: 'scripts\/check-full\.sh' on main at [0-9a-f]{7} \(0s\)$/,
    ])
    expectEvents(ran, ["done", "full_check", "end"])
    expect(recordsOf(ran, "full_check")).toEqual([expect.objectContaining({ detail: "passed" })])
    expect(ran.exit._tag === "Success" && ran.exit.value?.exitCode).toBe(0)
    expect(checkFullTickets(ran)).toEqual([])
  })

  test("not after a run that merged nothing", async () => {
    const ran = await runs({
      config: config(true),
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "defers" },
    })
    expect(ran.checkRuns.filter((each) => each.check === "full" || each.before === "full")).toEqual(
      [],
    )
    expect(ran.worktreeCalls.filter((call) => call.op === "addDetached")).toEqual([])
    expect(recordsOf(ran, "full_check")).toEqual([])
  })

  test("not when the project has no full check", async () => {
    const ran = await runs({
      config: {},
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "finishes" },
    })
    expect(ran.checkRuns.filter((each) => each.check === "full")).toEqual([])
    expect(recordsOf(ran, "full_check")).toEqual([])
  })

  test("not after a stop, though a ticket merged", async () => {
    // t-1 merges; t-2's worker goes, is resumed once and goes again: PAUSED, exit 3.
    const ran = await runs({
      config: config(),
      backlog: backlog().ticket("t-1").ticket("t-2").seeds,
      workers: { "t-1": "finishes", "t-2": "pauses" },
    })
    expect(ran.exit._tag === "Success" && ran.exit.value?.exitCode).toBe(3)
    expect(ran.exit._tag === "Success" && ran.exit.value?.phases["t-1"]?._tag).toBe("Done")
    expect(ran.checkRuns.filter((each) => each.check === "full")).toEqual([])
    expect(recordsOf(ran, "full_check")).toEqual([])
  })

  test("fullCheckDue: a full check, no stop, and a ticket merged", () => {
    const closedOnly = TicketPhase.Done({ outcome: Finished.NoChange() })
    expect(fullCheckDue(fullCommand, false, [merged])).toBe(true)
    expect(fullCheckDue(null, false, [merged])).toBe(false)
    expect(fullCheckDue(fullCommand, true, [merged])).toBe(false)
    expect(fullCheckDue(fullCommand, false, [closedOnly])).toBe(false)
    expect(fullCheckDue(fullCommand, false, [])).toBe(false)
  })

  test("a quit while it runs stops it, says it was skipped, and removes its worktree", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const ran = await runs({
      config: config(),
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "finishes" },
      checks: { full: [Effect.andThen(Deferred.succeed(started, undefined), Effect.never)] },
      quitWhen: started,
    })
    expect(recordsOf(ran, "full_check")).toEqual([expect.objectContaining({ detail: "skipped" })])
    expectLog(ran, [
      /^ {2}FULL_CHECK_SKIPPED: 'scripts\/check-full\.sh' was stopped after 0s, as asked$/,
    ])
    const added = ran.worktreeCalls.find((call) => call.op === "addDetached")
    if (added?.op !== "addDetached") throw new Error("no worktree was made for the full check")
    expect(ran.worktreeCalls).toContainEqual({ op: "removeDetached", path: added.path })
    expect(existsSync(added.path)).toBe(false)
    expect(recordsOf(ran, "end")).toEqual([])
  })
})

const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc1234" }) })

describe("FULL_CHECK_FAILED", () => {
  test("files a P2 bug labelled check-full for the suite, and keeps the output in .tutti/run/check-full.log", async () => {
    const ran = await runs({
      config: config(),
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "finishes" },
      checks: { full: [failsIn("e2e")] },
    })
    const [filed, ...others] = checkFullTickets(ran)
    expect(others).toEqual([])
    expect(filed).toEqual(
      expect.objectContaining({
        title: "Full check fails: e2e",
        type: "bug",
        priority: 2,
        status: "open",
      }),
    )
    expect(filed?.description).toContain("in the suite e2e, at the end of the run of")
    expect(filed?.description).toContain("    FAIL: it broke")
    const [record] = recordsOf(ran, "full_check")
    expect(record).toEqual(
      expect.objectContaining({ detail: "failed", suite: "e2e", ticket: filed?.id }),
    )
    const output = record?.kind === "full_check" ? record.output : undefined
    expect(output).toMatch(/\.tutti\/run\/check-full\.log$/)
    expect(readFileSync(output ?? "", "utf8")).toBe("SUITE: e2e\nFAIL: it broke\n")
    expectLog(ran, [
      /^ {2}FULL_CHECK_FAILED: 'scripts\/check-full\.sh' fails on main at [0-9a-f]{7}, in the suite e2e; the whole output is in .*check-full\.log; filed /,
    ])
    expect(ran.exit._tag === "Success" && ran.exit.value?.exitCode).toBe(0)
    const added = ran.worktreeCalls.find((call) => call.op === "addDetached")
    if (added?.op !== "addDetached") throw new Error("no worktree was made for the full check")
    expect(existsSync(added.path)).toBe(false)
  })

  test("one ticket per failing suite: a suite with one open has it noted, another suite gets its own", async () => {
    const open = {
      title: "Full check fails: e2e",
      labels: [fullCheckLabel],
      type: "bug",
      description: "tutti's full check fails in the suite e2e, at the end of the run of …",
      status: "deferred" as const,
    }
    const again = await runs({
      config: config(),
      backlog: backlog().ticket("t-1").ticket("cf-1", open).seeds,
      workers: { "t-1": "finishes" },
      checks: { full: [failsIn("e2e")] },
    })
    expect(checkFullTickets(again).map((issue) => issue.id)).toEqual(["cf-1" as TicketId])
    expect(checkFullTickets(again)[0]?.notes).toContain("fails again on main at")
    expect(recordsOf(again, "full_check")).toEqual([
      expect.objectContaining({ ticket: "cf-1", suite: "e2e" }),
    ])
    expectLog(again, [/; cf-1 is open for it already$/])

    const another = await runs({
      config: config(),
      backlog: backlog().ticket("t-1").ticket("cf-1", open).seeds,
      workers: { "t-1": "finishes" },
      checks: { full: [failsIn("unit")] },
    })
    expect(checkFullTickets(another).map((issue) => issue.title)).toEqual([
      "Full check fails: e2e",
      "Full check fails: unit",
    ])
  })

  test("a check that names no suite is filed under its command; one that times out says so", async () => {
    const ran = await runs({
      config: config(),
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "finishes" },
      checks: {
        full: [
          new CheckTimedOut({
            check: "full",
            command: fullCommand,
            timeLimit: Duration.minutes(60),
            outputFile: "/dev/null",
            ...said(),
          }),
        ],
      },
    })
    expect(checkFullTickets(ran).map((issue) => issue.title)).toEqual([
      `Full check fails: ${fullCommand}`,
    ])
    expect(recordsOf(ran, "full_check")).toEqual([
      expect.objectContaining({ detail: "timed out", suite: fullCommand }),
    ])
    expectLog(ran, [/^ {2}FULL_CHECK_FAILED: 'scripts\/check-full\.sh' did not finish within 1h /])
  })

  test("a setup that fails is said as such, and files no ticket", async () => {
    const ran = await runs({
      config: config(true),
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "finishes" },
      checks: {
        // The setup in t-1's new worktree passes; the one before the full check fails.
        setup: [
          passed("setup"),
          new CheckFailed({
            check: "setup",
            command: setupCommand,
            exitCode: 1,
            outputFile: "/dev/null",
            ...said(),
          }),
        ],
      },
    })
    expect(ran.checkRuns.filter((each) => each.check === "full")).toEqual([])
    expect(checkFullTickets(ran)).toEqual([])
    const [record] = recordsOf(ran, "full_check")
    expect(record).toEqual(expect.objectContaining({ detail: "failed" }))
    expect(record).not.toHaveProperty("suite")
    expect(record).not.toHaveProperty("ticket")
    expectLog(ran, [
      /^ {2}FULL_CHECK_FAILED: the setup 'bun install', run before 'scripts\/check-full\.sh', fails on main at [0-9a-f]{7}; .*; no ticket filed: it is not a suite's failure$/,
    ])
  })
})

describe("the ticket's title", () => {
  const issue = (title: string, description: string): Issue =>
    ({ id: "x-1", title, description, labels: [fullCheckLabel] }) as unknown as Issue

  test("is cut to the title width, and a cut title's description tells its suites apart", () => {
    const long = "a suite with a name long enough to be cut in the title"
    const title = fullCheckTitle(`${long} one`)
    expect(title).toBe(fullCheckTitle(`${long} two`))
    expect(Array.from(title)).toHaveLength(titleWidth)
    const filed = issue(title, `… in the suite ${long} one, at the end of the run of …`)
    expect(filedForSuite(filed, `${long} one`)).toBe(true)
    expect(filedForSuite(filed, `${long} two`)).toBe(false)
  })

  test("any suite: a title of at most the width, and the ticket filed for it is found again", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1, maxLength: 120 }), (suite) => {
        const title = fullCheckTitle(suite)
        expect(Array.from(title).length).toBeLessThanOrEqual(titleWidth)
        const filed = issue(title, `in the suite ${suite}, at the end of the run of 2026-10-18`)
        expect(filedForSuite(filed, suite)).toBe(true)
        expect(filedForSuite({ ...filed, labels: [] }, suite)).toBe(false)
      }),
    )
  })
})

slow.describe("the full check's worktree, in real git", () => {
  test("is made on the base's head on no branch, and removed whatever is left in it", async () => {
    const repo = makeRepo()
    const head = repo.commit("Second", { "a.txt": "a\n" })
    const root = folder("live")
    const layer = Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
      Layer.provideMerge(Git.layer()),
      Layer.provideMerge(GitWriter.layer),
      Layer.provideMerge(BunServices.layer),
    )
    const path = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(Worktrees), (worktrees) =>
          worktrees.addDetached("check-full-", "main"),
        ),
        layer,
      ),
    )
    expect(path.startsWith(`${root}/check-full-`)).toBe(true)
    expect(repo.head("HEAD", path)).toBe(head)
    expect(repo.git(["status", "--porcelain", "--branch"], path)).toStartWith("## HEAD (no branch)")
    expect(readFileSync(join(repo.dir, ".git", "info", "exclude"), "utf8")).toContain(
      runExcludeEntry,
    )
    repo.write({ "left.txt": "x\n", "a.txt": "changed\n" }, path)
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Effect.service(Worktrees), (worktrees) => worktrees.removeDetached(path)),
        layer,
      ),
    )
    expect(existsSync(path)).toBe(false)
    expect(repo.git(["worktree", "list", "--porcelain"])).not.toContain(path)
    expect(repo.git(["branch", "--list"]).trim()).toBe("* main")
  })
})
