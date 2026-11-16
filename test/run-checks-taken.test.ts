// The merge check and the full check a merge changes (src/run/setup.ts's takeSettings, Checks'
// take): the run read .tutti/settings.json as it started, and a merge that changes checks.fast or
// checks.full there has the run check the merges after it, and end with the full check, with what
// it changed, each check's other settings as the run had them, a flag's time limit too
// (tutti-mllm), whether the merge changed the check's command or its time limit (tutti-5uv5).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Duration, Effect, Option, Result } from "effect"
import type { AppConfigValue } from "../src/core/AppConfig.ts"
import { line } from "../src/core/log.ts"
import { noFlags } from "../src/project/flags.ts"
import { defaultSettings, defaultUserConfig, resolve } from "../src/run/resolveConfig.ts"
import { run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { checksOf, type RunChecks } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, expectExitCode, expectLog, type Ran, scenario, type World } from "./harness.ts"

const settingsFile = ".tutti/settings.json"
const fast = "scripts/check-fast.sh"
const full = "scripts/check-full.sh"
const defaults = appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-checks-taken-${name}-`)))

/** The settings file's text with `checks`. */
const settingsText = (checks: object) => `${JSON.stringify({ checks }, null, 2)}\n`

/** Claims its ticket, commits `files` in its worktree under `root` and closes it, as a worker does. */
const works = (world: World, root: string, id: string, files: Files) =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id as TicketId, { claim: true }))),
      ),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
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
 * A whole run on main of a, then b, each in a worktree of its own: the run starts with `checks` as
 * its merge check and full check, their time limits given by `from` where it names a flag, main
 * holding `onMain` as its settings, and a commits `committed`.
 */
const runs = (
  checks: RunChecks,
  onMain: string,
  committed: string,
  from: AppConfigValue["checkTimeoutsFrom"] = { fast: null, full: null },
) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: {
        repo,
        settings: { ...defaults, concurrent: 1, checks: { ...defaults.checks, ...checks } },
        checkTimeoutsFrom: from,
      },
      backlog: backlog().chain("a", "b").seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world) => ({
        a: [works(world, root, "a", { [settingsFile]: committed })],
        b: [works(world, root, "b", { "b.txt": "b\n" })],
      }),
    },
    Effect.gen(function* () {
      yield* (yield* Repository).commit(repo, "Settings", { [settingsFile]: onMain })
      const git = yield* Git
      for (const id of ["a", "b"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      return yield* run({
        version: "0.1.0-test",
        base: "main",
        start: [line`START tutti 0.1.0-test`],
      })
    }),
  ).then((ran) => ({ ...ran, root }))
}

/** The checks of `kind` the run ran: their folder's name, command and time limit in minutes. */
const ranOf = (ran: Ran<unknown>, kind: "fast" | "full") =>
  ran.checkRuns
    .filter((each) => each.check === kind)
    .map((each) => ({
      in: basename(each.cwd),
      command: each.command,
      minutes: Duration.toMinutes(Duration.fromInputUnsafe(each.timeLimit)),
    }))

describe("checks a merge changed in .tutti/settings.json", () => {
  test("a merge check the run started without runs on the merges after it", async () => {
    const ran = await runs(
      {
        fast: { command: null, timeout: Duration.minutes(30) },
        full: { command: null, timeout: Duration.minutes(60) },
      },
      settingsText({ fast: { command: null } }),
      settingsText({ fast: { command: fast, timeout: "7m" } }),
    )
    expectExitCode(ran, 0)
    expectLog(ran, [
      `  SETUP: a's merge changed ${settingsFile} on main: checks.fast is '${fast}', time limit 7m, from now on`,
    ])
    // a merged unchecked, as the run had no merge check yet; b is checked with a's.
    expect(ranOf(ran, "fast")).toEqual([{ in: "b", command: fast, minutes: 7 }])
  })

  test("the full check runs as a merge set it, the merge check keeping a flag's time limit", async () => {
    const ran = await runs(
      {
        fast: { command: fast, timeout: Duration.minutes(45) },
        full: { command: null, timeout: Duration.minutes(60) },
      },
      settingsText({ fast: { command: fast } }),
      settingsText({ fast: { command: fast }, full: { command: full, timeout: "2h" } }),
    )
    expectExitCode(ran, 0)
    expectLog(ran, [
      `  SETUP: a's merge changed ${settingsFile} on main: checks.full is '${full}', time limit 2h, from now on`,
    ])
    expect(ran.log.some((text) => text.includes("checks.fast is"))).toBe(false)
    expect(ranOf(ran, "fast").map((each) => [each.in, each.minutes])).toEqual([
      ["a", 45],
      ["b", 45],
    ])
    expect(ranOf(ran, "full")).toEqual([expect.objectContaining({ command: full, minutes: 120 })])
  })
})

describe("a flag's time limit and a merge that changes the check", () => {
  const flagged = {
    fast: { command: fast, timeout: Duration.minutes(45) },
    full: { command: full, timeout: Duration.hours(3) },
  }
  const onMain = settingsText({ fast: { command: fast }, full: { command: full } })

  test("a merge that changes only the merge check's command keeps the flag's time limit", async () => {
    const other = "scripts/check-other.sh"
    const ran = await runs(
      flagged,
      onMain,
      settingsText({ fast: { command: other }, full: { command: full } }),
      { fast: "--check-timeout", full: null },
    )
    expectExitCode(ran, 0)
    expectLog(ran, [
      `  SETUP: a's merge changed ${settingsFile} on main: checks.fast is '${other}', time limit 45m (--check-timeout), from now on`,
    ])
    expect(ran.log.some((text) => text.includes("is not taken"))).toBe(false)
    expect(ranOf(ran, "fast")).toEqual([
      { in: "a", command: fast, minutes: 45 },
      { in: "b", command: other, minutes: 45 },
    ])
  })

  test("a merge that changes only the full check's command keeps the flag's time limit", async () => {
    const other = "scripts/check-other-full.sh"
    const ran = await runs(
      flagged,
      onMain,
      settingsText({ fast: { command: fast }, full: { command: other } }),
      { fast: null, full: "TUTTI_CHECK_FULL_TIMEOUT" },
    )
    expectExitCode(ran, 0)
    expectLog(ran, [
      `  SETUP: a's merge changed ${settingsFile} on main: checks.full is '${other}', time limit 3h (TUTTI_CHECK_FULL_TIMEOUT), from now on`,
    ])
    expect(ranOf(ran, "full")).toEqual([expect.objectContaining({ command: other, minutes: 180 })])
  })

  test("a merge that changes the settings' time limit leaves the flag's, saying so", async () => {
    const ran = await runs(
      flagged,
      onMain,
      settingsText({ fast: { command: fast, timeout: "20m" }, full: { command: full } }),
      { fast: "--check-timeout", full: null },
    )
    expectExitCode(ran, 0)
    expectLog(ran, [
      `  SETUP: a's merge changed ${settingsFile} on main: checks.fast's time limit 20m is not taken, as --check-timeout gave 45m`,
    ])
    expect(ran.log.some((text) => text.includes("checks.fast is"))).toBe(false)
    expect(ranOf(ran, "fast").map((each) => [each.in, each.minutes])).toEqual([
      ["a", 45],
      ["b", 45],
    ])
  })

  test("with no flag, the settings' new time limit is taken", async () => {
    const ran = await runs(
      { ...flagged, fast: { command: fast, timeout: Duration.minutes(30) } },
      onMain,
      settingsText({ fast: { command: fast, timeout: "20m" }, full: { command: full } }),
    )
    expectExitCode(ran, 0)
    expectLog(ran, [
      `  SETUP: a's merge changed ${settingsFile} on main: checks.fast is '${fast}', time limit 20m, from now on`,
    ])
    expect(ran.log.some((text) => text.includes("is not taken"))).toBe(false)
    expect(ranOf(ran, "fast").map((each) => [each.in, each.minutes])).toEqual([
      ["a", 30],
      ["b", 20],
    ])
  })

  test("the configuration names the flag or the variable that gave a check's time limit", () => {
    const from = (flags: Partial<typeof noFlags>, env: Record<string, string>) => {
      const resolved = resolve({
        repo: "/work/project",
        flags: { ...noFlags, ...flags },
        env: (name) => env[name],
        user: defaultUserConfig,
        settings: defaultSettings,
        cores: 10,
      })
      if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
      return resolved.success.checkTimeoutsFrom
    }
    expect(from({}, {})).toEqual({ fast: null, full: null })
    expect(from({}, { TUTTI_CHECK_TIMEOUT: "45m", TUTTI_CHECK_FULL_TIMEOUT: "" })).toEqual({
      fast: "TUTTI_CHECK_TIMEOUT",
      full: null,
    })
    expect(
      from(
        { checkTimeout: Option.some("45m"), checkFullTimeout: Option.some("3h") },
        { TUTTI_CHECK_TIMEOUT: "20m" },
      ),
    ).toEqual({ fast: "--check-timeout", full: "--check-full-timeout" })
  })
})

describe("checksOf's take", () => {
  test("has the merge check, the full check and a setup's time limit run as taken", () => {
    const runs: Array<{ check: string; command: string; minutes: number }> = []
    const service = checksOf(
      {
        ...defaults.checks,
        setup: { command: "bun install", files: [] },
        fast: { command: null, timeout: Duration.minutes(30) },
        full: { command: "make full", timeout: Duration.minutes(60) },
      },
      (check, command, timeLimit) =>
        Effect.sync(() => {
          runs.push({
            check,
            command,
            minutes: Duration.toMinutes(Duration.fromInputUnsafe(timeLimit)),
          })
          return { _tag: "NoCheckCommand" as const, check }
        }),
    )
    const options = { cwd: "/work", outputFile: "/work/check.log" }
    const taken = Effect.runSync(
      Effect.gen(function* () {
        yield* service.fast(options)
        yield* service.take({
          fast: { command: "bun test", timeout: Duration.minutes(7) },
          full: { command: null, timeout: Duration.minutes(90) },
        })
        yield* service.fast(options)
        yield* service.full(options)
        yield* service.setup({ ...options, before: "fast" })
        return yield* service.now
      }),
    )
    expect(runs).toEqual([
      { check: "fast", command: "bun test", minutes: 7 },
      { check: "setup", command: "bun install", minutes: 7 },
    ])
    expect(taken.fast.command).toBe("bun test")
    expect(taken.full.command).toBeNull()
  })
})
