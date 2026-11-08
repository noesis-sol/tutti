// The checks gate runs the checks the form set (§ 4.14, src/run/checksGate.ts): the run read
// .tutti/settings.json as it started, so once the form commits new settings on the base, the gate
// takes the commands and time limits they changed before it checks again, rather than hold on the
// settings it started with and file a question about checks already set (tutti-fnvd.4).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Duration, Effect } from "effect"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { fastScript, fullScript } from "../src/init/runners.ts"
import { type GateAsk, gateFolderPrefix, gateQuestionTitle } from "../src/run/checksGate.ts"
import type { EventRecord } from "../src/run/events.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { checksOf } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import type { CheckRun } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, expectExitCode, expectLog, type Ran, scenario, type World } from "./harness.ts"

const fast = "scripts/check-fast.sh"
const full = "scripts/check-full.sh"
const spec = "shop.md"
const settingsPath = ".tutti/settings.json"
const defaults = appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-checks-gate-settings-${name}-`)))

/** The settings file's text with `checks`. */
const settingsText = (checks: object) => `${JSON.stringify({ checks }, null, 2)}\n`

/** The settings the run starts with: no merge check, and the full check's time limit a flag's. */
const config = (repo: string): Partial<AppConfigValue> => ({
  repo,
  ticket: "s-1" as TicketId,
  specPath: spec,
  settings: {
    ...defaults,
    concurrent: 1,
    checks: {
      ...defaults.checks,
      setup: { ...defaults.checks.setup, command: null },
      fast: { command: null, timeout: Duration.minutes(30) },
      full: { command: full, timeout: Duration.minutes(45) },
    },
  },
})

/** What main holds as the run starts: settings turning the merge check off, and runners with suites. */
const onMain = {
  [settingsPath]: settingsText({ fast: { command: null }, full: { command: full } }),
  [fast]: fastScript([{ name: "unit", command: "bun test", foundIn: "", serial: false }]),
  [full]: fullScript([{ name: "e2e", command: "bun run e2e", foundIn: "", serial: false }], false),
}

const tree: ReadonlyArray<Seed> = backlog()
  .ticket("s-1", { type: "epic", metadata: { spec } })
  .ticket("s-1.1", { parent: "s-1", priority: 0, labels: ["solo"], metadata: { spec } })
  .ticket("s-1.2", { parent: "s-1", blockedBy: ["s-1.1"], metadata: { spec } }).seeds

const commits = (world: World, root: string, id: string, files: Record<string, string>) =>
  claimsAndCloses(id as TicketId, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id as TicketId, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id as TicketId, "done"))),
  })

/** A whole spec run whose gate asks through `ask`, as the form would. */
const askedRun = (ask: (repository: Repository["Service"], repo: string) => GateAsk) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: config(repo),
      git: { dir: repo },
      worktrees: { root },
      backlog: tree,
      scripts: (world) => ({
        "s-1.1": [commits(world, root, "s-1.1", { "README.md": "# Shop\n" })],
        "s-1.2": [commits(world, root, "s-1.2", { "shop.ts": "export {}\n" })],
      }),
    },
    Effect.gen(function* () {
      const repository = yield* Repository
      yield* repository.commit(repo, "tutti: set up for spec shop.md", onMain)
      const git = yield* Git
      for (const id of ["s-1.1", "s-1.2"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      return yield* run({
        version: "0.1.0-test",
        base: "main",
        start: [line`START tutti 0.1.0-test`],
        gateAsk: ask(repository, repo),
      })
    }),
  )
}

/** A gate's ask whose form commits `files` on the base the first time it holds, and leaves after. */
const settingOnce =
  (files: Record<string, string>, held: Array<string>) =>
  (repository: Repository["Service"], repo: string): GateAsk => ({
    held: (why) =>
      Effect.gen(function* () {
        held.push(why)
        if (held.length > 1) return "left" as const
        yield* Effect.orDie(repository.commit(repo, "tutti: set the checks", files))
        return "set" as const
      }),
    shown: () => Effect.succeed("accepted" as const),
  })

const gateRecords = (ran: Ran<unknown>) =>
  ran.events.filter(
    (record): record is Extract<EventRecord, { kind: "checks_gate" }> =>
      record.kind === "checks_gate",
  )

/** The gate's check runs: those in its worktrees. */
const gateRuns = (ran: Ran<unknown>): ReadonlyArray<CheckRun> =>
  ran.checkRuns.filter((each) => basename(each.cwd).startsWith(gateFolderPrefix))

describe("the checks gate, once the form set the checks", () => {
  test("runs the command and time limit the form committed, and the tree starts", async () => {
    const held: Array<string> = []
    const ran = await askedRun(
      settingOnce(
        {
          [settingsPath]: settingsText({
            fast: { command: fast, timeout: "7m" },
            full: { command: full },
          }),
        },
        held,
      ),
    )
    expectExitCode(ran, 0)
    expect(held).toEqual(["checks.fast.command is null: nothing runs it"])
    expect(gateRecords(ran)).toMatchObject([{ detail: "passed", changed: true }])
    expect(ran.issues.some((each) => each.title === gateQuestionTitle)).toBe(false)
    expectLog(ran, [
      /^CHECKS_GATE: checks\.fast from \.tutti\/settings\.json on main at \w+: 'scripts\/check-fast\.sh', time limit 7m$/,
      /^CHECKS_GATE: running scripts\/check-fast\.sh run 2 of 3 .*\(time limit 7m\)$/,
    ])
    const runs = gateRuns(ran)
    expect(runs.map((each) => [each.check, each.command])).toEqual([
      ["fast", fast],
      ["fast", fast],
      ["full", full],
    ])
    expect(runs.map((each) => Duration.toMillis(each.timeLimit))).toEqual([
      Duration.toMillis(Duration.minutes(7)),
      Duration.toMillis(Duration.minutes(7)),
      // The full check's settings didn't change: its time limit stays the flag's.
      Duration.toMillis(Duration.minutes(45)),
    ])
  })

  test("settings the form committed that can't be read leave the checks as they were", async () => {
    const held: Array<string> = []
    const ran = await askedRun(settingOnce({ [settingsPath]: "{ not json" }, held))
    expectExitCode(ran, 2)
    expect(held).toHaveLength(2)
    expect(gateRuns(ran)).toEqual([])
    expectLog(ran, [
      /^CHECKS_GATE: \.tutti\/settings\.json on main at \w+ could not be read \(it isn't valid JSON: .*\); the checks stay as they were$/,
      /^CHECKS_HELD: the checks gate held the spec's tree: checks\.fast\.command is null/,
    ])
  })
})

describe("checksOf", () => {
  const checks = {
    ...defaults.checks,
    setup: { command: "bun install", files: [] },
    fast: { command: "bun test", timeout: Duration.minutes(30) },
    full: { command: null, timeout: Duration.minutes(60) },
  }
  const asked = (
    given: (service: ReturnType<typeof checksOf>) => Effect.Effect<unknown, unknown>,
  ) => {
    const runs: Array<{ command: string; millis: number }> = []
    const service = checksOf(checks, (check, command, timeLimit) =>
      Effect.sync(() => {
        runs.push({ command, millis: Duration.toMillis(timeLimit) })
        return { _tag: "NoCheckCommand" as const, check }
      }),
    )
    Effect.runSync(Effect.ignore(given(service)))
    return runs
  }
  const options = { cwd: "/work", outputFile: "/work/check.log" }

  test("runs a check's own command and time limit in place of the settings'", () => {
    expect(
      asked((service) =>
        service.full({ ...options, command: "make check", timeLimit: Duration.minutes(5) }),
      ),
    ).toEqual([{ command: "make check", millis: Duration.toMillis(Duration.minutes(5)) }])
    expect(asked((service) => service.fast({ ...options, command: null }))).toEqual([])
    expect(
      asked((service) =>
        service.setup({ ...options, before: "fast", timeLimit: Duration.minutes(2) }),
      ),
    ).toEqual([{ command: "bun install", millis: Duration.toMillis(Duration.minutes(2)) }])
  })

  test("runs the settings' command within their time limit without them", () => {
    expect(asked((service) => service.fast(options))).toEqual([
      { command: "bun test", millis: Duration.toMillis(Duration.minutes(30)) },
    ])
  })
})
