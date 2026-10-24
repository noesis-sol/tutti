// The full check's failure paths (§ 5 item 12): git can't give it a worktree, its worktree can't be
// removed, its whole output can't be kept in the main checkout, and bd fails as its ticket is filed.
// Each runs fullCheck itself, in the scenario harness's test layers, with the Worktrees or Beads
// service wrapped so the one call fails.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect } from "effect"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { PathRefused } from "../src/native/libc.ts"
import { type FullChecked, fullCheck, fullCheckLabel } from "../src/run/fullcheck.ts"
import { logFile } from "../src/run/log.ts"
import { Beads, BeadsFailed, BeadsTimedOut, type Issue } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { GitFailed } from "../src/services/Git.ts"
import { runFolder, Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import type { CheckRun, Scripted } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-fullcheck-failures-${name}-`)))

const fullCommand = "scripts/check-full.sh"

/** The settings with a full check and no setup, in the main checkout `repo`. */
const config = (repo: string): Partial<AppConfigValue> => {
  const { settings } = appConfig()
  return {
    repo,
    settings: {
      ...settings,
      checks: {
        ...settings.checks,
        full: { command: fullCommand, timeout: Duration.minutes(60) },
        setup: { ...settings.checks.setup, command: null },
      },
    },
  }
}

/** A full check that prints its output to its file and fails in the suite e2e. */
const failsInE2e: Scripted = (ran: CheckRun) =>
  Effect.suspend(() => {
    const output = "SUITE: e2e\nFAIL: it broke\n"
    if (ran.outputFd !== undefined) writeSync(ran.outputFd, output)
    return Effect.fail(
      new CheckFailed({
        check: "full",
        command: fullCommand,
        exitCode: 1,
        outputFile: ran.outputFile,
        failingLines: ["FAIL: it broke"],
        lastLines: output.trimEnd().split("\n"),
        suites: ["e2e"],
        suite: "e2e",
        flaky: [],
        flakyCount: 0,
      }),
    )
  })

const bdFailed = (command: string) =>
  new BeadsFailed({ command, exitCode: 1, stderr: "database is locked", noSuchIssue: false })

interface Plan {
  readonly repo?: string
  readonly backlog?: ReadonlyArray<Seed>
  /** The full check passes when absent. */
  readonly full?: Scripted
  /** Before the full check: makes a call fail, as git, the worktrees or bd would. */
  readonly before?: Effect.Effect<void, never, Env>
  /** Wraps the Worktrees service the full check is given. */
  readonly worktrees?: (live: Worktrees["Service"]) => Worktrees["Service"]
  /** Wraps the Beads service the full check is given. */
  readonly beads?: (live: Beads["Service"]) => Beads["Service"]
}

/** Runs the full check after a run on main, in the test layers, as `plan` has them. */
const checks = (plan: Plan): Promise<Ran<FullChecked>> => {
  const repo = plan.repo ?? folder("repo")
  return scenario(
    {
      config: config(repo),
      git: { dir: repo },
      worktrees: { root: folder("worktrees") },
      backlog: plan.backlog ?? backlog().seeds,
      ...(plan.full === undefined ? {} : { checks: { full: [plan.full] } }),
    },
    Effect.gen(function* () {
      if (plan.before !== undefined) yield* plan.before
      const worktrees = yield* Worktrees
      const beads = yield* Beads
      return yield* fullCheck({ base: "main", started: 0 }).pipe(
        Effect.provideService(Worktrees, plan.worktrees?.(worktrees) ?? worktrees),
        Effect.provideService(Beads, plan.beads?.(beads) ?? beads),
      )
    }),
  )
}

const checked = (ran: Ran<FullChecked>): FullChecked => {
  if (ran.exit._tag === "Failure") throw new Error(`the full check failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const recordsOf = (ran: Ran<unknown>, kind: string) =>
  ran.events.filter((record) => record.kind === kind)

const checkFullTickets = (ran: Ran<unknown>): ReadonlyArray<Issue> =>
  ran.issues.filter((issue) => issue.labels.includes(fullCheckLabel))

describe("FULL_CHECK_NOT_RUN: no worktree for it", () => {
  test("git can't say the base's head: it could not run, and nothing is run or filed", async () => {
    const ran = await checks({
      full: failsInE2e,
      before: Effect.gen(function* () {
        const repository = yield* Repository
        yield* repository.fail("rev-parse", { stderr: "fatal: bad revision 'main'" })
      }),
    })
    const result = checked(ran)
    expect(result).toEqual(
      expect.objectContaining({ outcome: "not run", at: "", took: 0, end: [] }),
    )
    expectLog(ran, [
      "  FULL_CHECK_NOT_RUN: 'scripts/check-full.sh' could not run on main: no worktree for it (fatal: bad revision 'main')",
    ])
    expect(recordsOf(ran, "full_check")).toEqual([
      expect.objectContaining({ detail: "not run", text: result.text }),
    ])
    expect(ran.checkRuns).toEqual([])
    expect(ran.worktreeCalls).toEqual([])
    expect(checkFullTickets(ran)).toEqual([])
  })

  test("the worktree can't be added: it could not run, saying why, on the head git gave", async () => {
    const ran = await checks({
      full: failsInE2e,
      worktrees: (live) => ({
        ...live,
        addDetached: () =>
          Effect.fail(
            new GitFailed({
              op: "worktree add",
              command: "git worktree add --detach",
              exitCode: 128,
              stderr: "fatal: could not create directory\nmore",
            }),
          ),
      }),
    })
    const result = checked(ran)
    expect(result.outcome).toBe("not run")
    expect(result.at).toMatch(/^[0-9a-f]{40}$/)
    expectLog(ran, [
      "  FULL_CHECK_NOT_RUN: 'scripts/check-full.sh' could not run on main: no worktree for it (fatal: could not create directory)",
    ])
    expect(recordsOf(ran, "full_check")).toEqual([expect.objectContaining({ detail: "not run" })])
    expect(ran.checkRuns).toEqual([])
  })
})

describe("CLEANUP_FAILED: the full check's worktree can't be removed", () => {
  test("warns that it is left, with the command that removes it, and the check's outcome stands", async () => {
    const ran = await checks({
      worktrees: (live) => ({
        ...live,
        removeDetached: () =>
          Effect.fail(
            new GitFailed({
              op: "worktree prune",
              command: "git worktree prune",
              exitCode: 1,
              stderr: "error: unable to prune",
            }),
          ),
      }),
    })
    expect(checked(ran).outcome).toBe("passed")
    const added = ran.worktreeCalls.find((call) => call.op === "addDetached")
    if (added?.op !== "addDetached") throw new Error("no worktree was made for the full check")
    const made = added.path
    expect(existsSync(made)).toBe(true)
    const text = `  CLEANUP_FAILED: the full check's worktree ${made} is left (error: unable to prune); git worktree remove --force ${made} removes it`
    expectLog(ran, [/^ {2}FULL_CHECK passed: /, text])
    expect(recordsOf(ran, "warn")).toEqual([expect.objectContaining({ kind: "warn", text })])
    expect(recordsOf(ran, "full_check")).toEqual([expect.objectContaining({ detail: "passed" })])
  })
})

describe("its whole output that can't be kept", () => {
  test("a link in place of .tutti/run/check-full.log: the log says why, and points to itself", async () => {
    const repo = folder("repo")
    const elsewhere = folder("elsewhere")
    mkdirSync(join(repo, runFolder), { recursive: true })
    symlinkSync(join(elsewhere, "taken.log"), join(repo, runFolder, "check-full.log"))
    const ran = await checks({ repo, full: failsInE2e })
    const result = checked(ran)
    const fallback = join(repo, logFile)
    expect(result).toEqual(
      expect.objectContaining({ outcome: "failed", suite: "e2e", output: fallback }),
    )
    expectLog(ran, [
      `  the full check's whole output can't be kept in ${join(repo, runFolder, "check-full.log")}: ${join(repo, runFolder, "check-full.log")} is a symbolic link; tutti writes a worker's run files only in its worktree's own ${runFolder} folder, which git ignores`,
      new RegExp(
        `^ {2}FULL_CHECK_FAILED: .* in the suite e2e; the whole output is in ${fallback.replaceAll(".", "\\.")}; filed `,
      ),
      "  the end of its output:",
      "    SUITE: e2e",
      "    FAIL: it broke",
    ])
    expect(recordsOf(ran, "full_check")).toEqual([expect.objectContaining({ output: fallback })])
    // The link is refused, not followed.
    expect(() => readFileSync(join(elsewhere, "taken.log"))).toThrow()
    const [filed] = checkFullTickets(ran)
    expect(filed?.description).toContain(`Its whole output is in ${fallback}`)
  })
})

describe("its output in its own worktree that can't be opened", () => {
  test("the check writes to /dev/null, the log says why, and the run's log has its end", async () => {
    const repo = folder("repo")
    const ran = await checks({
      repo,
      full: failsInE2e,
      worktrees: (live) => ({
        ...live,
        openRunFile: (worktree, name, flags, mode) =>
          worktree === repo
            ? live.openRunFile(worktree, name, flags, mode)
            : Effect.fail(new PathRefused({ directory: worktree, path: name })),
      }),
    })
    const [full] = ran.checkRuns
    if (full === undefined) throw new Error("the full check didn't run")
    expect(full.outputFile).toBe("/dev/null")
    expect(full.outputFd).toBeUndefined()
    const inWorktree = join(full.cwd, runFolder, "check-full.log")
    const fallback = join(repo, logFile)
    expect(checked(ran)).toEqual(expect.objectContaining({ outcome: "failed", output: fallback }))
    expectLog(ran, [
      `  the full check's whole output can't be kept in ${inWorktree}: "check-full.log" is not a plain path below ${full.cwd}`,
      new RegExp(
        `^ {2}the full check's whole output can't be kept in ${join(repo, runFolder, "check-full.log").replaceAll(".", "\\.")}: ${inWorktree.replaceAll(".", "\\.")} can't be read: `,
      ),
      /^ {2}FULL_CHECK_FAILED: /,
    ])
  })
})

describe("bd failing as the full check's ticket is filed", () => {
  const open: Seed = {
    id: "cf-1",
    title: "Full check fails: e2e",
    labels: [fullCheckLabel],
    type: "bug",
    description: "tutti's full check fails in the suite e2e, at the end of the run of …",
  }

  test("the open tickets can't be listed: the log says so, and a ticket is filed all the same", async () => {
    const ran = await checks({
      backlog: [open],
      full: failsInE2e,
      beads: (live) => ({
        ...live,
        list: () => Effect.fail(bdFailed("bd list --label check-full")),
      }),
    })
    const result = checked(ran)
    if (result.ticket === undefined) throw new Error("no ticket was filed")
    expect(checkFullTickets(ran).map((issue) => issue.id)).toEqual(["cf-1", result.ticket])
    expect(result.ticket).not.toBe("cf-1")
    expect(result.filed).toBe(`filed ${result.ticket}`)
    expectLog(ran, [
      "  bd can't list the open full check tickets: database is locked",
      new RegExp(`^ {2}FULL_CHECK_FAILED: .*; filed ${result.ticket}$`),
    ])
    expect(recordsOf(ran, "full_check")).toEqual([
      expect.objectContaining({ suite: "e2e", ticket: result.ticket }),
    ])
  })

  test("the note can't be added to the open one: the log says so, and it is still the suite's", async () => {
    const ran = await checks({
      backlog: [open],
      full: failsInE2e,
      beads: (live) => ({
        ...live,
        update: (id) =>
          Effect.fail(
            new BeadsTimedOut({ command: `bd update ${id}`, timeLimit: Duration.seconds(30) }),
          ),
      }),
    })
    const result = checked(ran)
    expect(result).toEqual(
      expect.objectContaining({ ticket: "cf-1", filed: "cf-1 is open for it already" }),
    )
    expectLog(ran, [
      "  bd can't add a note to cf-1: bd took longer than 30s",
      /^ {2}FULL_CHECK_FAILED: .*; cf-1 is open for it already$/,
    ])
    expect(checkFullTickets(ran).map((issue) => [issue.id, issue.notes])).toEqual([["cf-1", ""]])
    expect(recordsOf(ran, "full_check")).toEqual([expect.objectContaining({ ticket: "cf-1" })])
  })

  test("the ticket can't be created: no ticket filed, saying why", async () => {
    const ran = await checks({
      full: failsInE2e,
      beads: (live) => ({
        ...live,
        create: () => Effect.fail(bdFailed("bd create")),
      }),
    })
    const result = checked(ran)
    expect(result.ticket).toBeUndefined()
    expect(result.filed).toBe("no ticket filed: bd failed (database is locked)")
    expectLog(ran, [
      /^ {2}FULL_CHECK_FAILED: .* in the suite e2e; .*; no ticket filed: bd failed \(database is locked\)$/,
    ])
    expect(checkFullTickets(ran)).toEqual([])
    const [record] = recordsOf(ran, "full_check")
    expect(record).toEqual(expect.objectContaining({ detail: "failed", suite: "e2e" }))
    expect(record).not.toHaveProperty("ticket")
  })
})
