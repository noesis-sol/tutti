// A full check, or the setup before it, that could not be run (§ 5 item 12): a command that didn't
// start, or whose output couldn't be kept, failed in the machine, not in a suite. It is
// FULL_CHECK_NOT_RUN, a full_check record `not run`, and files no ticket.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect } from "effect"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import {
  type FullChecked,
  fullCheck,
  fullCheckEvidence,
  fullCheckLabel,
  fullCheckLogName,
  fullCheckReport,
} from "../src/run/fullcheck.ts"
import { CheckNotRun } from "../src/services/Checks.ts"
import { runFolder } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import type { Script } from "../src/testing/Checks.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-fullcheck-not-run-${name}-`)))

const fullCommand = "scripts/check-full.sh"
const setupCommand = "bun install"
const filed = "no ticket filed: it is not a suite's failure"

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

/** Runs the full check after a run on main, the setup first when `setup` is given. */
const checks = (
  script: Script,
  f: { readonly repo?: string; readonly setup?: string; readonly backlog?: ReadonlyArray<Seed> },
): Promise<Ran<FullChecked>> => {
  const repo = f.repo ?? folder("repo")
  return scenario(
    {
      config: config(repo),
      git: { dir: repo },
      worktrees: { root: folder("worktrees") },
      backlog: f.backlog ?? backlog().seeds,
      checks: script,
    },
    fullCheck({ base: "main", started: 0, ...(f.setup === undefined ? {} : { setup: f.setup }) }),
  )
}

const checked = (ran: Ran<FullChecked>): FullChecked => {
  if (ran.exit._tag === "Failure") throw new Error(`the full check failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const fullCheckRecords = (ran: Ran<unknown>) =>
  ran.events.filter((record) => record.kind === "full_check")

const checkFullTickets = (ran: Ran<unknown>) =>
  ran.issues.filter((issue) => issue.labels.includes(fullCheckLabel))

describe("FULL_CHECK_NOT_RUN: a command that could not be run", () => {
  test("the full check didn't start: not run, why, and no ticket filed", async () => {
    const repo = folder("repo")
    // The last failing full check's output stays where it is.
    mkdirSync(join(repo, runFolder), { recursive: true })
    const kept = join(repo, runFolder, fullCheckLogName)
    writeFileSync(kept, "SUITE: e2e\nFAIL: an earlier failure\n")
    const ran = await checks(
      {
        full: [
          Effect.fail(
            new CheckNotRun({ check: "full", command: fullCommand, reason: "sh: not found" }),
          ),
        ],
      },
      { repo },
    )
    const result = checked(ran)
    expect(result).toEqual(expect.objectContaining({ outcome: "not run", end: [], filed }))
    expect(result.suite).toBeUndefined()
    expect(result.ticket).toBeUndefined()
    expect(result.output).toBeUndefined()
    expectLog(ran, [
      /^ {2}FULL_CHECK_NOT_RUN: 'scripts\/check-full\.sh' could not be run \(sh: not found\) on main at [0-9a-f]{7}; no ticket filed: it is not a suite's failure$/,
    ])
    expect(fullCheckRecords(ran)).toEqual([
      expect.objectContaining({ detail: "not run", text: result.text }),
    ])
    expect(fullCheckRecords(ran)[0]).not.toHaveProperty("suite")
    expect(fullCheckRecords(ran)[0]).not.toHaveProperty("ticket")
    expect(checkFullTickets(ran)).toEqual([])
    expect(readFileSync(kept, "utf8")).toBe("SUITE: e2e\nFAIL: an earlier failure\n")
    // The reviewer hears of it; the report's Full check section is for a check that failed.
    expect(fullCheckEvidence(result)).toBe(result.text)
    expect(fullCheckReport(result, fullCommand)).toBe("")
  })

  test("an open ticket for the command is left as it is", async () => {
    const open: Seed = {
      id: "cf-1",
      title: `Full check fails: ${fullCommand}`,
      labels: [fullCheckLabel],
      type: "bug",
      description: `tutti's full check fails in the suite ${fullCommand}, at the end of the run of …`,
    }
    const ran = await checks(
      {
        full: [
          Effect.fail(new CheckNotRun({ check: "full", command: fullCommand, reason: "EACCES" })),
        ],
      },
      { backlog: [open] },
    )
    expect(checked(ran)).toEqual(expect.objectContaining({ outcome: "not run", filed }))
    expect(checkFullTickets(ran)).toEqual([
      expect.objectContaining({ id: "cf-1", notes: expect.not.stringContaining("EACCES") }),
    ])
  })

  test("the setup before it didn't start: not run, the full check not started, no ticket", async () => {
    const ran = await checks(
      {
        setup: [
          Effect.fail(
            new CheckNotRun({ check: "setup", command: setupCommand, reason: "bun: not found" }),
          ),
        ],
      },
      { setup: setupCommand },
    )
    const result = checked(ran)
    expect(result).toEqual(
      expect.objectContaining({ outcome: "not run", setup: setupCommand, end: [], filed }),
    )
    expect(result.suite).toBeUndefined()
    expectLog(ran, [
      /^ {2}FULL_CHECK_NOT_RUN: the setup 'bun install', run before 'scripts\/check-full\.sh', could not be run \(bun: not found\) on main at [0-9a-f]{7}; no ticket filed: it is not a suite's failure$/,
    ])
    expect(fullCheckRecords(ran)).toEqual([expect.objectContaining({ detail: "not run" })])
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["setup"])
    expect(checkFullTickets(ran)).toEqual([])
  })
})
