// A spec run's checks gate without a terminal (§ 4.14, src/run/checksGate.ts): once the spec's
// environment ticket merges, before any other ticket of the tree starts, a runner still checking
// nothing holds the tree with a question for the maintainer, check-fast runs twice more and
// check-full once on the base's head, a failure holds the tree, and what each runner runs is said;
// it runs once per spec, and never in a run that isn't a spec run.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Duration, Effect, Fiber, Queue } from "effect"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { fastScript, fullScript } from "../src/init/runners.ts"
import { type Summary, summary } from "../src/print/summary.ts"
import {
  emptyWhy,
  environmentOf,
  fingerprint,
  gateKey,
  gateQuestionTitle,
  gateSpecKey,
  type RunnerRead,
  runsOf,
} from "../src/run/checksGate.ts"
import type { DrainRequest } from "../src/run/drain.ts"
import { summaryLines } from "../src/run/endOfRun.ts"
import type { EventRecord } from "../src/run/events.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { emptyView } from "../src/run/runView.ts"
import { HumanLabel, type Issue, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed, CheckOutput } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import type { CheckRun, Script as ChecksScript } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { backlog, expectExitCode, expectLog, type Ran, scenario, type World } from "./harness.ts"

const fast = "scripts/check-fast.sh"
const full = "scripts/check-full.sh"
const spec = "shop.md"
const defaults = appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-checks-gate-${name}-`)))

/** A spec run's settings: the runners as the checks, no setup. */
const config = (repo: string, specRun = true): Partial<AppConfigValue> => ({
  repo,
  ...(specRun ? { ticket: "s-1" as TicketId, specPath: spec } : {}),
  settings: {
    ...defaults,
    concurrent: 1,
    checks: {
      ...defaults.checks,
      setup: { ...defaults.checks.setup, command: null },
      fast: { command: fast, timeout: Duration.minutes(10) },
      full: { command: full, timeout: Duration.minutes(60) },
    },
  },
})

/** The runners a spec run's setup writes: checking nothing. */
const emptyRunners = { [fast]: fastScript([]), [full]: fullScript([], true) }

/** Runners with a suite each. */
const realRunners = {
  [fast]: fastScript([{ name: "unit", command: "bun test", foundIn: "", serial: false }]),
  [full]: fullScript([{ name: "e2e", command: "bun run e2e", foundIn: "", serial: false }], false),
}

/** The spec's tree: the root epic, its environment ticket and one ticket waiting on it. */
const tree = (environment: Partial<Seed> = {}, root: Partial<Seed> = {}): ReadonlyArray<Seed> =>
  backlog()
    .ticket("s-1", { type: "epic", metadata: { spec }, ...root })
    .ticket("s-1.1", {
      parent: "s-1",
      priority: 0,
      labels: ["solo"],
      metadata: { spec },
      ...environment,
    })
    .ticket("s-1.2", { parent: "s-1", blockedBy: ["s-1.1"], metadata: { spec } }).seeds

/** Claims, commits `files` and closes its ticket, as a worker does. */
const commits = (world: World, root: string, id: string, files: Record<string, string>) =>
  claimsAndCloses(id as TicketId, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id as TicketId, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id as TicketId, "done"))),
  })

/**
 * A whole spec run, plain: main holding `onMain` first, the environment ticket's worker committing
 * `environmentWrites`, s-1.2's worker a file of its own.
 */
const specRun = (o: {
  readonly onMain?: Record<string, string>
  readonly environmentWrites?: Record<string, string>
  readonly checks?: ChecksScript
  readonly backlog?: ReadonlyArray<Seed>
  readonly specRun?: boolean
  /** A spec update's environment ticket, s-1.3, and what its worker commits. */
  readonly updateWrites?: Record<string, string>
}): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: config(repo, o.specRun ?? true),
      git: { dir: repo },
      worktrees: { root },
      backlog: o.backlog ?? tree(),
      ...(o.checks === undefined ? {} : { checks: o.checks }),
      scripts: (world) => ({
        "s-1.1": [commits(world, root, "s-1.1", o.environmentWrites ?? realRunners)],
        "s-1.2": [commits(world, root, "s-1.2", { "shop.ts": "export {}\n" })],
        ...(o.updateWrites === undefined
          ? {}
          : { "s-1.3": [commits(world, root, "s-1.3", o.updateWrites)] }),
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      if (o.onMain !== undefined) {
        yield* (yield* Repository).commit(repo, "tutti: set up for spec shop.md", o.onMain)
      }
      for (const id of ["s-1.1", "s-1.2", "s-1.3"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const running = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      return yield* Fiber.join(running)
    }),
  )
}

const started = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.sent.flatMap((sent) => (sent._tag === "Started" ? [sent.ticket] : []))

const gateRecords = (ran: Ran<unknown>) =>
  ran.events.filter(
    (record): record is Extract<EventRecord, { kind: "checks_gate" }> =>
      record.kind === "checks_gate",
  )

/** The checks run, by kind, in order: the merge check's as `fast`. */
const kinds = (runs: ReadonlyArray<CheckRun>) => runs.map((each) => each.check)

const issue = (ran: Ran<unknown>, id: string): Issue | undefined =>
  ran.issues.find((each) => each.id === id)

/** What the check's output says, as Checks takes it. */
const saidOf = (output: string) => {
  const taken = new CheckOutput()
  taken.write(new TextEncoder().encode(output))
  taken.end()
  return taken.summary()
}

describe("the checks gate, once the environment ticket merges", () => {
  test("runs check-fast twice more and check-full once before the rest of the tree starts", async () => {
    const ran = await specRun({ onMain: emptyRunners })
    expectExitCode(ran, 0)
    expect(started(ran)).toEqual(["s-1.1", "s-1.2"])
    // s-1.1's merge check, the gate's two check-fast runs and check-full, s-1.2's merge check, and
    // the full check at the end of the run.
    expect(kinds(ran.checkRuns)).toEqual(["fast", "fast", "fast", "full", "fast", "full"])
    const gate = ran.worktreeCalls.filter(
      (call) => call.op === "addDetached" && basename(call.path).startsWith("checks-gate-"),
    )
    expect(gate).toHaveLength(3)
    expectLog(ran, [
      /^CHECKS_GATE: s-1\.1, the spec's environment ticket, merged: checking the checks on main at \w+ before the rest of s-1 starts$/,
      /^CHECKS_GATE: scripts\/check-fast\.sh and scripts\/check-full\.sh check something: running check-fast twice more and check-full once on \w+$/,
      /^CHECKS_GATE: running scripts\/check-fast\.sh run 2 of 3 in .*checks-gate-/,
      /^CHECKS_GATE: scripts\/check-fast\.sh run 2 of 3 passed; its whole output is in .*\.tutti\/run\/checks-gate-fast-2-3\.log$/,
      /^CHECKS_GATE: running scripts\/check-fast\.sh run 3 of 3 /,
      /^CHECKS_GATE: running scripts\/check-full\.sh run 1 of 1 /,
      "CHECKS_GATE: scripts/check-fast.sh runs: bun test",
      "CHECKS_GATE: scripts/check-full.sh runs: scripts/check-fast.sh; bun run e2e",
      /^CHECKS_GATE: passed on main at \w+ in \w+: check-fast three times with the merge's, check-full once; the rest of s-1 starts$/,
      /s-1\.2 dispatching/,
    ])
    const [record] = gateRecords(ran)
    expect(record).toMatchObject({
      detail: "passed",
      ticket: "s-1.1",
      ran: [
        { check: "fast", outcome: "passed" },
        { check: "fast", outcome: "passed" },
        { check: "full", outcome: "passed" },
      ],
    })
    // Recorded on the root epic, for the next run.
    expect(issue(ran, "s-1")?.metadata[gateKey]).toBeString()
    expect(ran.log).toContainEqual(expect.stringMatching(/^ {2}Checks gate: passed in \w+$/))
  })

  test("a runner still checking nothing holds the tree with a question it waits on: CHECKS_HELD", async () => {
    const ran = await specRun({
      onMain: emptyRunners,
      environmentWrites: { "README.md": "# Shop\n" },
    })
    expectExitCode(ran, 2)
    expect(started(ran)).toEqual(["s-1.1"])
    expect(kinds(ran.checkRuns)).toEqual(["fast"])
    const question = ran.issues.find((each) => each.title === gateQuestionTitle)
    if (question === undefined) throw new Error("no question was filed")
    expect(question.labels).toContain(HumanLabel)
    expect(question.metadata).toMatchObject({
      [gateSpecKey]: spec,
      maintainer_only: true,
      recommended: 0,
    })
    expect(question.description).toContain(
      "scripts/check-fast.sh checks nothing, and scripts/check-full.sh checks nothing",
    )
    // The tree's ticket waits on it.
    const waiting = issue(ran, "s-1.2")
    expect(waiting?.dependencies.map((link) => link.id)).toContain(question.id)
    expectLog(ran, [
      "CHECKS_GATE: scripts/check-fast.sh checks nothing, and scripts/check-full.sh checks nothing",
      new RegExp(
        `^CHECKS_GATE: held on main at \\w+: scripts/check-fast\\.sh checks nothing, and scripts/check-full\\.sh checks nothing; the spec's tree waits on ${question.id}, a question for you$`,
      ),
      new RegExp(
        `^CHECKS_HELD: the checks gate held the spec's tree: .*; it waits on ${question.id}`,
      ),
    ])
    expect(gateRecords(ran)).toMatchObject([
      { detail: "empty", ticket: "s-1.1", ran: [], question: question.id },
    ])
    expect(issue(ran, "s-1")?.metadata[gateKey]).toBeUndefined()
  })

  test("a failed run holds the tree, the output's file named", async () => {
    const output = "SUITE: unit\nFAIL: flaky test\n"
    const ran = await specRun({
      onMain: emptyRunners,
      checks: {
        fast: [
          { _tag: "CheckPassed", check: "fast", command: fast, ...saidOf("") },
          (run: CheckRun) =>
            Effect.suspend(() => {
              if (run.outputFd !== undefined) writeSync(run.outputFd, output)
              return Effect.fail(
                new CheckFailed({
                  check: "fast",
                  command: fast,
                  exitCode: 1,
                  outputFile: run.outputFile,
                  ...saidOf(output),
                }),
              )
            }),
        ],
      },
    })
    expectExitCode(ran, 2)
    expect(started(ran)).toEqual(["s-1.1"])
    expect(kinds(ran.checkRuns)).toEqual(["fast", "fast"])
    const [record] = gateRecords(ran)
    expect(record).toMatchObject({
      detail: "failed",
      ran: [{ check: "fast", outcome: "failed" }],
    })
    const kept = record?.output ?? ""
    expect(kept).toEndWith(".tutti/run/checks-gate-fast-2-3.log")
    expect(existsSync(kept) && readFileSync(kept, "utf8")).toBe(output)
    expectLog(ran, [
      new RegExp(
        `^CHECKS_HELD: the checks gate held the spec's tree: scripts/check-fast\\.sh fails \\(run 2 of 3, on \\w+\\); the whole output is in ${kept.replaceAll(".", "\\.")}; it waits on `,
      ),
    ])
  })

  test("runs once per spec: not again for runners it passed, the environment merged before", async () => {
    const passedFor = fingerprint([
      { check: "fast", command: fast, path: fast, script: realRunners[fast] ?? null },
      { check: "full", command: full, path: full, script: realRunners[full] ?? null },
    ])
    const ran = await specRun({
      onMain: realRunners,
      backlog: tree({ status: "closed" }, { metadata: { spec, [gateKey]: passedFor } }),
    })
    expectExitCode(ran, 0)
    expect(started(ran)).toEqual(["s-1.2"])
    expect(kinds(ran.checkRuns)).toEqual(["fast", "full"])
    expect(gateRecords(ran)).toEqual([])
    expectLog(ran, ["CHECKS_GATE: the checks on main passed it for shop.md already; not run again"])
  })

  test("a spec update's environment ticket that left the runners as they were: not run again", async () => {
    const passedFor = fingerprint([
      { check: "fast", command: fast, path: fast, script: realRunners[fast] ?? null },
      { check: "full", command: full, path: full, script: realRunners[full] ?? null },
    ])
    const ran = await specRun({
      onMain: realRunners,
      backlog: backlog()
        .ticket("s-1", { type: "epic", metadata: { spec, [gateKey]: passedFor } })
        .ticket("s-1.1", {
          parent: "s-1",
          status: "closed",
          priority: 0,
          labels: ["solo"],
          metadata: { spec },
        })
        .ticket("s-1.3", { parent: "s-1", priority: 0, labels: ["solo"], metadata: { spec } })
        .ticket("s-1.2", { parent: "s-1", blockedBy: ["s-1.3"], metadata: { spec } }).seeds,
      updateWrites: { "docs/update.md": "# Update\n" },
    })
    expectExitCode(ran, 0)
    expect(started(ran)).toEqual(["s-1.3", "s-1.2"])
    expect(kinds(ran.checkRuns)).toEqual(["fast", "fast", "full"])
    expect(gateRecords(ran)).toEqual([])
    expectLog(ran, [
      /s-1\.3 dispatching/,
      "CHECKS_GATE: the checks on main passed it for shop.md already; not run again",
      /s-1\.2 dispatching/,
    ])
  })

  test("runs for an environment ticket merged in an earlier run whose runners it hasn't passed", async () => {
    const ran = await specRun({ onMain: realRunners, backlog: tree({ status: "closed" }) })
    expectExitCode(ran, 0)
    expect(started(ran)).toEqual(["s-1.2"])
    expect(kinds(ran.checkRuns)).toEqual(["fast", "fast", "full", "fast", "full"])
    expect(gateRecords(ran)).toMatchObject([{ detail: "passed" }])
  })

  test("a question answered for the runners as they are lets the tree go on with them", async () => {
    const print = fingerprint([
      { check: "fast", command: fast, path: fast, script: emptyRunners[fast] ?? null },
      { check: "full", command: full, path: full, script: emptyRunners[full] ?? null },
    ])
    const ran = await specRun({
      onMain: emptyRunners,
      backlog: [
        ...tree({ status: "closed" }),
        {
          id: "s-9",
          title: gateQuestionTitle,
          status: "closed",
          labels: [HumanLabel],
          metadata: { [gateSpecKey]: spec, [gateKey]: print },
        },
      ],
    })
    expectExitCode(ran, 0)
    expect(started(ran)).toEqual(["s-1.2"])
    expect(gateRecords(ran)).toMatchObject([{ detail: "answered", question: "s-9" }])
    expectLog(ran, [
      "CHECKS_GATE: s-9 was answered for these checks: the tree goes on with them as they are",
    ])
  })

  test("never runs in a run that isn't a spec run", async () => {
    const ran = await specRun({ onMain: emptyRunners, specRun: false })
    expect(gateRecords(ran)).toEqual([])
    expect(ran.log.some((each) => each.startsWith("CHECKS_GATE"))).toBe(false)
  })
})

describe("what the gate reads of the runners", () => {
  const read = (check: "fast" | "full", script: string | null): RunnerRead => ({
    check,
    command: check === "fast" ? fast : full,
    path: check === "fast" ? fast : full,
    script,
  })

  test("a runner that runs nothing, a missing one or a check turned off checks nothing", () => {
    expect(emptyWhy(read("fast", fastScript([])))).toBe(`${fast} checks nothing`)
    expect(emptyWhy(read("full", null))).toBe(`${full} is not on the base`)
    expect(emptyWhy({ check: "full", command: null, path: null, script: null })).toBe(
      "checks.full.command is null: nothing runs it",
    )
    expect(emptyWhy(read("fast", realRunners[fast] ?? ""))).toBeNull()
    expect(emptyWhy({ check: "fast", command: "make check", path: null, script: null })).toBeNull()
  })

  test("what a runner runs: its commands, or the settings' own command", () => {
    expect(runsOf(read("fast", realRunners[fast] ?? ""))).toEqual(["bun test"])
    expect(runsOf(read("fast", fastScript([])))).toEqual([])
    expect(runsOf({ check: "fast", command: "make check", path: null, script: null })).toEqual([
      "make check",
    ])
  })

  test("the fingerprint changes with a runner's script", () => {
    const a = fingerprint([read("fast", "a\n"), read("full", "b\n")])
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprint([read("fast", "a\n"), read("full", "b\n")])).toBe(a)
    expect(fingerprint([read("fast", "a\n"), read("full", "c\n")])).not.toBe(a)
  })

  test("the environment ticket: the solo P0 ticket with the spec's metadata, the last filed", () => {
    const of = (id: string, fields: Partial<Issue>): Issue =>
      ({
        id: id as TicketId,
        type: "task",
        priority: 0,
        labels: ["solo"],
        metadata: { spec },
        createdAt: "2026-10-29T10:00:00Z",
        ...fields,
      }) as Issue
    expect(environmentOf([of("a", { priority: 1 }), of("b", { labels: [] })], spec)).toBeNull()
    expect(environmentOf([of("c", { metadata: { spec: "other.md" } })], spec)).toBeNull()
    // A spec update's environment ticket, filed after the first, is the one the gate waits for.
    const last = environmentOf(
      [
        of("e", { createdAt: "2026-10-29T11:00:00Z" }),
        of("d", {}),
        of("f", { type: "epic", createdAt: "2026-10-29T12:00:00Z" }),
      ],
      spec,
    )
    expect(String(last?.id)).toBe("e")
  })
})

describe("the summary's line on the gate", () => {
  const ended: Summary = {
    version: "0.1.0",
    branch: "main",
    scope: "s-1",
    spec,
    took: 1000,
    totals: { ...emptyView.totals, slots: 1 },
    figures: [],
    rows: [],
  }
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

  test("says how it went, styled and plain; nothing where it didn't run", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is stripped
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")
    const styled = strip(summary({ ...ended, checksGate: "passed in 4m12s" }, theme, 80)).split(
      "\n",
    )
    expect(styled).toContain("  Checks gate  passed in 4m12s")
    expect(summary(ended, theme, 80)).not.toContain("Checks gate")
    const plain = summaryLines({ ...ended, base: "main", checksGate: "passed in 4m12s" })
    expect(plain.map(String)).toContain("  Checks gate: passed in 4m12s")
    expect(summaryLines({ ...ended, base: "main" }).join("\n")).not.toContain("Checks gate")
  })
})

describe("the gate while the run winds down", () => {
  test("isn't run: the next run runs it", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const drains = Effect.runSync(Queue.unbounded<DrainRequest>())
    const ran = await scenario(
      {
        config: config(repo),
        git: { dir: repo },
        worktrees: { root },
        backlog: tree(),
        scripts: (world) => ({
          // Its worker asks the run to wind down as it claims the ticket, as SIGUSR1 does.
          "s-1.1": [
            claimsAndCloses("s-1.1" as TicketId, {
              claim: Effect.andThen(
                Queue.offer(drains, { on: true, how: "by SIGUSR1" }),
                Effect.asVoid(
                  Effect.orDie(world.beads.update("s-1.1" as TicketId, { claim: true })),
                ),
              ),
              commit: Effect.asVoid(
                Effect.orDie(world.repository.commit(join(root, "s-1.1"), "Change", realRunners)),
              ),
              close: Effect.asVoid(Effect.orDie(world.beads.close("s-1.1" as TicketId, "done"))),
            }),
          ],
        }),
      },
      Effect.gen(function* () {
        yield* (yield* Repository).commit(repo, "tutti: set up for spec shop.md", emptyRunners)
        yield* (yield* Git).addWorktree(repo, join(root, "s-1.1"), {
          branch: "tutti/s-1.1",
          base: "main",
        })
        return yield* run({ version: "0.1.0-test", base: "main", drains })
      }),
    )
    expectExitCode(ran, 0)
    expect(started(ran)).toEqual(["s-1.1"])
    expect(gateRecords(ran)).toEqual([])
    expect(ran.log.some((each) => each.startsWith("CHECKS_GATE"))).toBe(false)
    expect(issue(ran, "s-1")?.metadata[gateKey]).toBeUndefined()
  })
})
