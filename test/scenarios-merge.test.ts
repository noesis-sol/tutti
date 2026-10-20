// Merge and hold scenarios (§ 14 M5): each of orchestra v0.7.7's, and the usage-limit fixtures, as
// a whole run under TestClock. Each asserts the run's log lines, its event records, the phases its
// tickets went through and ended in (with no PHASE_BUG), that it left no fiber or process behind
// it, and its exit code.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { Attention, type Policy } from "../src/agent/Attention.ts"
import { probeFile, probeWorker } from "../src/run/environment.ts"
import { fullCheckLabel } from "../src/run/fullcheck.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { clock } from "../src/run/runView.ts"
import { carryOnText } from "../src/run/usageLimit.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { writeRunFile } from "../src/services/Worktrees.ts"
import {
  bash,
  canUseTool,
  emit,
  result,
  type SessionScript,
  sleep,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import type { Script as ChecksScript } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-scenarios-merge-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings
type Settings = typeof defaults

/** Where the run's main checkout and worktrees are, for the workers' scripts. */
interface Places {
  readonly repo: string
  readonly root: string
}

// The workers.

/**
 * Claims its ticket, does `first` (`takes` passing by default), commits `files` and closes it, as
 * a worker does.
 */
const works = (
  world: World,
  places: Places,
  id: string,
  options: {
    readonly files?: Files
    readonly takes?: Duration.Input
    readonly first?: SessionScript
  } = {},
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...(options.first ?? [sleep(options.takes ?? 0)]),
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

/** A hand-back turn: after `takes`, the worker resolves its rebase's conflicts, writing `files`. */
const resolves = (
  world: World,
  places: Places,
  id: string,
  files: Files,
  takes: Duration.Input = 0,
): SessionScript =>
  turn([
    sleep(takes),
    ...bash(
      "git add -A && git rebase --continue",
      Effect.asVoid(world.repository.continueRebase(join(places.root, id), files)),
    ),
  ])

/** A hand-back turn in which the worker ends without finishing the rebase. */
const leavesTheRebase: SessionScript = turn([], result("I can't tell which side to keep."))

/** A hand-back turn in which the worker commits a fix naming its ticket. */
const fixes = (world: World, places: Places, id: string, files: Files): SessionScript =>
  turn([
    ...bash(check),
    ...bash(
      `git commit -am "Fix the check (${id})"`,
      Effect.asVoid(
        Effect.orDie(
          world.repository.commit(join(places.root, id), `Fix the check (${id})`, files),
        ),
      ),
    ),
  ])

/** A worker its environment fails: it ends its turn at once, claiming and changing nothing. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** The probe's session running its command, which writes `.tutti/run/probe` in the checkout. */
const probeRuns = (places: Places): SessionScript =>
  turn(
    bash("echo ok > .tutti/run/probe", Effect.orDie(writeRunFile(places.repo, probeFile, "ok\n"))),
  )

/** A recorded turn ending on the usage limit (test/fixtures/usage-limit/README.md). */
const fixture = (name: string): SessionScript => [
  wait,
  ...readFileSync(resolve(import.meta.dir, "fixtures/usage-limit", name), "utf8")
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as { readonly type: string; user_message_uuids?: unknown })
    // The scripted host speaks for the CLI's lifecycle of its own sends.
    .filter((message) => message.type !== "command_lifecycle")
    .map(({ user_message_uuids: _, ...message }) => emit(message)),
]

/** When the five-hour limit of rejected.jsonl resets, in milliseconds since the epoch. */
const fixtureReset = 1_792_222_200_000

// The checks.

/** A check failing, its lines saying what failed: the fast check, or the full one in `suite`. */
const fails = (kind: "fast" | "full" = "fast", suite: string | null = null) =>
  new CheckFailed({
    check: kind,
    command: kind === "fast" ? check : "scripts/check-full.sh",
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: ["error: a.test.ts: expected 1"],
    lastLines: ["1 fail"],
    suites: suite === null ? [] : [suite],
    suite,
    flaky: [],
    flakyCount: 0,
  })

// The run.

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** Moves TestClock on by `total`, a minute at a time, letting the run catch up after each. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const minutes = Duration.toMinutes(Duration.fromInputUnsafe(total))
    for (let i = 0; i < minutes; i++) {
      yield* advance("1 minute")
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

interface Plan {
  readonly tickets: ReadonlyArray<string>
  /** Laid over the settings: the defaults with the check command `check` and 2 workers. */
  readonly settings?: (settings: Settings) => Partial<Settings>
  readonly checks?: ChecksScript
  /** How Attention answers requests as they open; it allows everything by default. */
  readonly policy?: Policy
  readonly scripts: (world: World, places: Places) => Scripts
  /** Runs before the run starts. */
  readonly before?: Effect.Effect<void, unknown, Env>
  /** Runs beside the run, before it is joined. */
  readonly during?: (places: Places) => Effect.Effect<void, unknown, Env>
}

/** A whole run on main, each ticket's worktree made in git first, and where it ran. */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const base: Settings = {
    ...defaults,
    concurrent: 2,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  }
  return scenario(
    {
      config: { repo: places.repo, settings: { ...base, ...plan.settings?.(base) } },
      backlog: plan.tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      ...(plan.policy === undefined ? {} : { policy: plan.policy }),
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
      yield* plan.before ?? Effect.void
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      if (plan.during !== undefined) yield* plan.during(places)
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

// What each scenario asserts.

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** The tickets in the order they merged, from their `phase` records. */
const mergeOrder = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.to === "Done" ? [record.ticket] : [],
  )

/**
 * The run ended with `code` and its end record, with no PHASE_BUG logged and nothing left behind:
 * no fiber in a FiberSet of the run's, and no process group.
 */
const expectClean = (ran: Ran<Outcome>, code: number) => {
  expectExitCode(ran, code)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
  expect(ran.events.at(-1)).toMatchObject({ kind: "end", code })
}

/** The client_composed messages the ticket's worker was sent after its ticket's prompt. */
const composed = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.sent
    .flatMap((item) =>
      item._tag === "Message" && item.ticket === id && item.message.client_composed === true
        ? [String(item.message.message.content)]
        : [],
    )
    .slice(1)

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

const resolvingLine = (id: string, files: string) =>
  `  RESOLVING: tutti/${id} conflicts with main in ${files}; handed back to its worker to resolve (up to 20m)`

const fixingLine = (id: string, attempt: number) =>
  `  FIXING: '${check}' fails on tutti/${id} rebased onto main; handed back to its worker to fix (${attempt} of 2, up to 20m)`

describe("conflicts handed back", () => {
  test("a conflict resolved and merged: Merging → Resolving → ToMerge → Merging → Done", async () => {
    // a lands first; b, a minute later, conflicts with it in shared.txt.
    const ran = await runs({
      tickets: ["a", "b"],
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: { "shared.txt": "a\n" } })],
        b: [
          [
            ...works(world, places, "b", { files: { "shared.txt": "b\n" }, takes: "1 minute" }),
            ...resolves(world, places, "b", { "shared.txt": "a and b\n" }),
          ],
        ],
      }),
      during: () => passes("2 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(pathOf(ran, "b")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expect(mergeOrder(ran)).toEqual(["a", "b"])
    expectLog(ran, [
      "[1/40] a dispatching: a",
      "[2/40] b dispatching: b",
      closedLine("a"),
      resolvingLine("b", "shared.txt"),
      `  b's worker finished the rebase; checking it with '${check}'`,
      closedLine("b"),
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "closed", "end"])
    const resolving = ran.events.find((r) => r.kind === "phase" && r.to === "Resolving")
    expect(resolving).toMatchObject({ ticket: "b", cause: "ConflictsHandedBack", attempt: 1 })
    expect(composed(ran, "b")).toEqual([
      expect.stringContaining("rebasing tutti/b onto it stopped on conflicts in shared.txt"),
    ])
    // The resolution was checked once, in b's worktree.
    expect(ran.checkRuns.map((each) => each.cwd)).toEqual([join(ran.root, "b")])
  })

  test("a conflict rejected: the rebase left unfinished, b Blocked MERGE_CONFLICT", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: { "shared.txt": "a\n" } })],
        b: [
          [
            ...works(world, places, "b", { files: { "shared.txt": "b\n" }, takes: "1 minute" }),
            ...leavesTheRebase,
          ],
        ],
      }),
      during: () => passes("2 minutes"),
    })
    // A ticket set aside doesn't stop the run: it ends READY_EMPTY, exit 0.
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Blocked" })
    expect(pathOf(ran, "b").slice(-3)).toEqual(["Merging", "Resolving", "Blocked"])
    expectLog(ran, [
      closedLine("a"),
      resolvingLine("b", "shared.txt"),
      /^ {2}MERGE_CONFLICT: b closed, but tutti\/b conflicts with main in shared.txt, which moved on while it ran \(handed back to its worker, but its worker left the rebase unfinished; the rebase was aborted\); worktree .*\/b left for review/,
      "  b is closed but not merged, labelled 'unmerged': tickets it blocks wait until tutti/b is merged into main, in later runs too",
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "warn", "end"])
    expect(ran.events.find((r) => r.kind === "warn")).toMatchObject({
      ticket: "b",
      aside: true,
      blocked: "merge conflict in shared.txt",
      text: expect.stringMatching(/^ {2}MERGE_CONFLICT: /),
    })
    expect(ran.events.find((r) => r.kind === "phase" && r.to === "Blocked")).toMatchObject({
      ticket: "b",
      why: "MERGE_CONFLICT",
    })
    // Nothing was checked, and the branch is back where b's worker left it.
    expect(ran.checkRuns).toEqual([])
    expect(ran.issues.find((issue) => issue.id === "b")?.labels).toContain("unmerged")
  })
})

describe("a check handed back", () => {
  test("a check fixed: Merging → Fixing → ToMerge → Merging → Done, the fix merged", async () => {
    // a lands first; b, rebased onto it, fails the check once, and its worker fixes it.
    let landed: ReadonlyMap<string, string> = new Map()
    const ran = await runs({
      tickets: ["a", "b"],
      checks: { fast: [fails()] },
      scripts: (world, places) => ({
        a: [works(world, places, "a")],
        b: [
          [
            ...works(world, places, "b", { takes: "1 minute" }),
            ...fixes(world, places, "b", { "fix.txt": "fixed\n" }),
          ],
        ],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* passes("2 minutes")
          yield* untilLogged(closedLine("b"))
          landed = yield* (yield* Repository).tree("main")
        }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(pathOf(ran, "b")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Fixing",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expectLog(ran, [
      closedLine("a"),
      "  rebased tutti/b onto main, which moved on while it ran",
      fixingLine("b", 1),
      `  '${check}' passes on tutti/b as its worker fixed it`,
      closedLine("b"),
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "closed", "end"])
    const fixing = ran.events.filter((r) => r.kind === "phase" && r.to === "Fixing")
    expect(fixing).toEqual([
      expect.objectContaining({ ticket: "b", cause: "CheckHandedBack", attempt: 1 }),
    ])
    const [handBack, ...others] = composed(ran, "b")
    expect(others).toEqual([])
    expect(handBack).toContain(`tutti/b was rebased onto it; now '${check}' fails on it.`)
    expect(handBack).toContain("these lines say what failed:\nerror: a.test.ts: expected 1")
    // The check ran on b's rebased branch, then on its fix; a fast-forwarded unchecked.
    expect(ran.checkRuns.map((each) => each.cwd)).toEqual([
      join(ran.root, "b"),
      join(ran.root, "b"),
    ])
    expect(landed.get("fix.txt")).toBe("fixed\n")
  })

  test("a fix that fails twice: Fixing → Fixing → Review, CHECKS_FAILED, the worktree kept", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      checks: { fast: [fails(), fails(), fails()] },
      scripts: (world, places) => ({
        a: [works(world, places, "a")],
        b: [
          [
            ...works(world, places, "b", { takes: "1 minute" }),
            ...fixes(world, places, "b", { "fix.txt": "one\n" }),
            ...fixes(world, places, "b", { "fix.txt": "two\n" }),
          ],
        ],
      }),
      during: () => passes("2 minutes"),
    })
    // A ticket set aside doesn't stop the run.
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Review" })
    expect(pathOf(ran, "b").slice(-4)).toEqual(["Merging", "Fixing", "Fixing", "Review"])
    expect(ran.events.find((r) => r.kind === "phase" && r.to === "Review")).toMatchObject({
      ticket: "b",
      why: "CHECKS_FAILED",
    })
    expectLog(ran, [
      closedLine("a"),
      fixingLine("b", 1),
      fixingLine("b", 2),
      new RegExp(
        `^ {2}CHECKS_FAILED: b closed, but '${check}' fails on tutti/b rebased onto main, after it was handed back to its worker to fix twice \\(see its notes\\); worktree .*/b left for review`,
      ),
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "warn", "end"])
    expect(ran.events.find((r) => r.kind === "warn")).toMatchObject({ ticket: "b", aside: true })
    expect(composed(ran, "b")).toHaveLength(2)
    expect(ran.checkRuns).toHaveLength(3)
    const notes = ran.issues.find((issue) => issue.id === "b")?.notes ?? ""
    expect(notes).toContain("it was handed back to its worker to fix twice")
    expect(notes).toContain("not handed back again: it was handed back to its worker twice already")
  })
})

describe("the base moving on", () => {
  test("Merging → Resolving → ToMerge → Merging again: the resolution rebased onto c's merge", async () => {
    // a lands at once; b conflicts with it at 1m and takes 5m to resolve; c lands at 3m, while b
    // resolves, so b's resolution goes back in line and is rebased onto c and checked again.
    const ran = await runs({
      tickets: ["a", "b", "c"],
      settings: () => ({ concurrent: 3 }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: { "shared.txt": "a\n" } })],
        b: [
          [
            ...works(world, places, "b", { files: { "shared.txt": "b\n" }, takes: "1 minute" }),
            ...resolves(world, places, "b", { "shared.txt": "a and b\n" }, "5 minutes"),
          ],
        ],
        c: [works(world, places, "c", { takes: "3 minutes" })],
      }),
      during: () => passes("8 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expect(pathOf(ran, "b")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expect(mergeOrder(ran)).toEqual(["a", "c", "b"])
    expectLog(ran, [
      closedLine("a"),
      resolvingLine("b", "shared.txt"),
      closedLine("c"),
      `  b's worker finished the rebase; checking it with '${check}'`,
      "  rebased tutti/b onto main, which moved on while it ran",
      closedLine("b"),
      "READY_EMPTY after 3 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "dispatch", "closed", "closed", "closed", "end"])
    // c was rebased and checked; b's resolution was checked, then checked again once rebased.
    expect(ran.checkRuns.map((each) => each.cwd)).toEqual([
      join(ran.root, "c"),
      join(ran.root, "b"),
      join(ran.root, "b"),
    ])
  })
})

describe("the setup command", () => {
  test("runs before the check when the rebase brought a dependency change", async () => {
    const setup = "bun install --frozen-lockfile"
    const ran = await runs({
      tickets: ["a", "b"],
      settings: (settings) => ({
        checks: { ...settings.checks, setup: { command: setup, files: ["bun.lock"] } },
      }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: { "bun.lock": "left-pad 2\n" } })],
        b: [works(world, places, "b", { takes: "1 minute" })],
      }),
      during: () => passes("2 minutes"),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expectLog(ran, [
      closedLine("a"),
      "  rebased tutti/b onto main, which moved on while it ran",
      `  b: bun.lock changed in the rebase; running '${setup}' before the check`,
      closedLine("b"),
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "closed", "end"])
    expect(pathOf(ran, "b")).toEqual(["Queued", "Working", "ToMerge", "Merging", "Done"])
    // The setup ran in b's worktree, before the check there.
    expect(ran.checkRuns.map((each) => [each.check, each.cwd])).toEqual([
      ["setup", join(ran.root, "b")],
      ["fast", join(ran.root, "b")],
    ])
  })
})

describe("the full check", () => {
  test("failing at the end of the run files a ticket for its suite", async () => {
    const full = "scripts/check-full.sh"
    const ran = await runs({
      tickets: ["a"],
      settings: (settings) => ({
        checks: { ...settings.checks, full: { command: full, timeout: Duration.minutes(60) } },
      }),
      checks: { full: [fails("full", "e2e")] },
      scripts: (world, places) => ({ a: [works(world, places, "a")] }),
    })
    // A failing full check files a ticket and changes no exit code.
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done" })
    const filed = ran.issues.filter((issue) => issue.labels.includes(fullCheckLabel))
    expect(filed).toEqual([
      expect.objectContaining({
        title: "Full check fails: e2e",
        type: "bug",
        priority: 2,
        status: "open",
      }),
    ])
    const id = filed[0]?.id ?? ""
    expectLog(ran, [
      closedLine("a"),
      "READY_EMPTY after 1 tickets",
      new RegExp(
        `^ {2}FULL_CHECK_FAILED: '${full}' fails on main at [0-9a-f]{7}, in the suite e2e; the whole output is in .*check-full\\.log; filed ${id}`,
      ),
    ])
    expectEvents(ran, ["dispatch", "closed", "full_check", "end"])
    expect(ran.events.find((r) => r.kind === "full_check")).toMatchObject({
      detail: "failed",
      suite: "e2e",
      ticket: id,
    })
    expect(ran.checkRuns.map((each) => each.check)).toEqual(["full"])
  })
})

describe("the environment hold", () => {
  const holdLine =
    "ENVIRONMENT: the last 2 tickets (a, b) each settled within 2m of starting without being claimed or changed; check the machine, then restart"

  test("the probe passing: the tickets reopened are taken again and merge", async () => {
    const ran = await runs({
      tickets: ["a", "b", "c"],
      settings: () => ({ concurrent: 1 }),
      scripts: (world, places) => ({
        a: [givesUp, works(world, places, "a")],
        b: [givesUp, works(world, places, "b")],
        c: [works(world, places, "c")],
        [probeWorker]: [probeRuns(places)],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* untilLogged(/^PROBE: /)
          yield* advance("10 minutes")
        }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expectLog(ran, [
      "[1/40] a dispatching: a",
      "[2/40] b dispatching: b",
      "  a reopened: its worker failed at once, like the tickets before it",
      "  b reopened: its worker failed at once, like the tickets before it",
      /^PROBE: the run holds for the environment; in 10m a session without a ticket runs a command/,
      `  probe session started in ${ran.repo}`,
      "PROBE_OK: a session without a ticket ran a command 10m after the hold; taking tickets again",
      "  a: the probe passed; back in the queue",
      "  b: the probe passed; back in the queue",
      closedLine("a"),
      closedLine("b"),
      closedLine("c"),
      "READY_EMPTY after 5 tickets",
    ])
    expectEvents(ran, ["reopened", "reopened", "probed", "closed", "closed", "closed", "end"])
    // Settled with nothing done, Deferred; reopened by the hold, Waiting; then the probe passes.
    expect(pathOf(ran, "a")).toEqual([
      "Queued",
      "Working",
      "Deferred",
      "Waiting",
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Done",
    ])
  })

  test("the probe failing: the run ends ENVIRONMENT, exit 7, the tickets reopened", async () => {
    const ran = await runs({
      tickets: ["a", "b", "c"],
      settings: () => ({ concurrent: 1 }),
      scripts: () => ({ a: [givesUp], b: [givesUp], [probeWorker]: [turn([])] }),
      during: () =>
        Effect.gen(function* () {
          yield* untilLogged(/^PROBE: /)
          yield* advance("10 minutes")
        }),
    })
    expectClean(ran, 7)
    // c never started; the reopened tickets wait, open in bd, for the next run.
    expectPhases(ran, { a: "Waiting", b: "Waiting", c: "Queued" })
    expectLog(ran, [
      "  a reopened: its worker failed at once, like the tickets before it",
      "  b reopened: its worker failed at once, like the tickets before it",
      /^PROBE: /,
      `${holdLine.replace("; check the machine, then restart", "")}; a session probing the machine 10m later failed too: it stopped without running its command; check the machine, then restart`,
    ])
    expect(ran.log.some((text) => text.includes("c dispatching"))).toBe(false)
    expectEvents(ran, ["reopened", "reopened", "stop", "end"])
    expect(ran.events.find((r) => r.kind === "stop")).toMatchObject({ detail: "ENVIRONMENT" })
    for (const id of ["a", "b"]) {
      expect(ran.issues.find((issue) => issue.id === id)?.status).toBe("open")
    }
  })
})

describe("the usage-limit hold", () => {
  test("a recorded rejection holds the run, and the reset lifts it: its worker carries on", async () => {
    // The clock starts an hour before rejected.jsonl's limit resets.
    const resets = clock(fixtureReset)
    const ran = await runs({
      tickets: ["a", "b"],
      settings: () => ({ concurrent: 1 }),
      before: advance(Duration.millis(fixtureReset - 3_600_000)),
      scripts: (world, places) => ({
        a: [[...fixture("rejected.jsonl"), ...works(world, places, "a")]],
        b: [works(world, places, "b")],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
          yield* advance("2 hours")
        }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expectLog(ran, [
      "[1/40] a dispatching: a",
      `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at ${resets}`,
      `USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at ${resets}, in 1h`,
      "USAGE_LIMIT lifted",
      "  a: the usage limit has reset; its worker carries on",
      "[2/40] b dispatching: b",
      closedLine("a"),
      closedLine("b"),
      "READY_EMPTY after 2 tickets",
    ])
    expectEvents(ran, ["usage_limit", "hold", "usage_limit", "hold", "closed", "closed", "end"])
    const records = ran.events.filter((r) => r.kind === "usage_limit" || r.kind === "hold")
    expect(records.map((r) => (r.kind === "usage_limit" ? r.status : r.text))).toEqual([
      "rejected",
      `HOLD: USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at ${resets}`,
      "lifted",
      "HOLD: USAGE_LIMIT lifted",
    ])
    expect(composed(ran, "a")).toEqual([carryOnText("a")])
    expect(pathOf(ran, "a")).toEqual(["Queued", "Working", "ToMerge", "Merging", "Done"])
  })

  test("a recorded rejection with no reset known ends the run USAGE_LIMIT, exit 8", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      settings: () => ({ concurrent: 1 }),
      scripts: () => ({ a: [fixture("result-429.jsonl")] }),
    })
    expectClean(ran, 8)
    expectPhases(ran, { a: "Stopped", b: "Queued" })
    expectLog(ran, [
      "[1/40] a dispatching: a",
      "USAGE_LIMIT: the account's usage limit is reached; no new tickets until it resets",
      "USAGE_LIMIT: the account's usage limit is reached and when it resets is unknown; 1 worker waits for it; run tutti again once it resets",
    ])
    expectEvents(ran, ["usage_limit", "hold", "suspended", "stop", "end"])
    expect(ran.events.find((r) => r.kind === "stop")).toMatchObject({ detail: "USAGE_LIMIT" })
    expect(pathOf(ran, "a")).toEqual(["Queued", "Working", "Stopped"])
    expect(composed(ran, "a")).toEqual([])
  })
})

describe("the time holds", () => {
  test("TICKET_LIMIT holds the run: its worker goes on, isn't waited for, and is suspended", async () => {
    // a takes 3h with a 1h limit; b finishes at 30m, c starts then and finishes at 75m.
    const ran = await runs({
      tickets: ["a", "b", "c", "d"],
      settings: (settings) => ({
        workers: { ...settings.workers, ticket_limit: Duration.hours(1) },
      }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { takes: "3 hours" })],
        b: [works(world, places, "b", { takes: "30 minutes" })],
        c: [works(world, places, "c", { takes: "45 minutes" })],
        d: [works(world, places, "d")],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* passes("59 minutes")
          expect((yield* texts).some((text) => text.includes("TICKET_LIMIT"))).toBe(false)
          yield* passes("2 minutes")
          yield* untilLogged(/^HOLD: TICKET_LIMIT: /)
          yield* passes("20 minutes")
        }),
    })
    expectClean(ran, 3)
    expectPhases(ran, { a: "Stopped", b: "Done", c: "Done", d: "Queued" })
    const stop =
      /^TICKET_LIMIT: a still working after 1h \(worktree .*\/a\); its worker goes on, and is suspended when the run ends$/
    const hold =
      /^HOLD: TICKET_LIMIT: a still working after 1h .*; no new tickets while the 1 running finish$/
    // c starts as b settles, and b's merge goes on meanwhile: either may be logged first.
    expectLog(ran, [
      "[1/40] a dispatching: a",
      "[2/40] b dispatching: b",
      "[3/40] c dispatching: c",
      hold,
      closedLine("c"),
      stop,
    ])
    expectLog(ran, ["[2/40] b dispatching: b", closedLine("b"), hold])
    expect(ran.log.some((text) => text.includes("d dispatching"))).toBe(false)
    expectEvents(ran, ["hold", "closed", "suspended", "stop", "end"])
    expect(ran.events.find((r) => r.kind === "stop")).toMatchObject({ detail: "TICKET_LIMIT" })
    expect(ran.events.find((r) => r.kind === "suspended")).toMatchObject({
      ticket: "a",
      why: "TICKET_LIMIT",
    })
    expect(pathOf(ran, "a")).toEqual(["Queued", "Working", "Stopped"])
    // Its worker was never interrupted or sent anything; the run's end closed its session.
    expect(ran.sent.filter((s) => s.ticket === "a").map((s) => s._tag)).toEqual([
      "Started",
      "Message",
      "Closed",
    ])
  }, 30_000)

  test("BLOCKED holds the run at 4 minutes, and answering the request lifts it", async () => {
    // a asks at once; b finishes at 10m. Plain, the run would end once b merged, suspending a
    // (D19, end-of-run.test.ts): the request is answered while b still runs.
    const ran = await runs({
      tickets: ["a", "b", "c"],
      policy: waitForTest,
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", { first: [canUseTool("Bash", { command: "rm -rf build" })] }),
        ],
        b: [works(world, places, "b", { takes: "10 minutes" })],
        c: [works(world, places, "c", { takes: "1 minute" })],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* passes("3 minutes")
          expect((yield* texts).some((text) => text.includes("BLOCKED"))).toBe(false)
          yield* passes("2 minutes")
          yield* untilLogged(/^HOLD: BLOCKED/)
          yield* passes("2 minutes")
          expect((yield* texts).some((text) => text.includes("c dispatching"))).toBe(false)
          yield* (yield* Attention).answer("r1", { _tag: "Allow" }, "screen")
          yield* untilLogged(/^HOLD lifted/)
          yield* passes("10 minutes")
        }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expectLog(ran, [
      "HOLD: BLOCKED >4min: a needs you: Bash(rm -rf build); no new tickets while the 2 running finish",
      "HOLD lifted: a's requests were answered",
      "[3/40] c dispatching: c",
      closedLine("b"),
      "READY_EMPTY after 3 tickets",
    ])
    const holds = ran.events.filter((r) => r.kind === "hold")
    expect(holds).toEqual([
      expect.objectContaining({ ticket: "a", text: expect.stringMatching(/^HOLD: BLOCKED/) }),
      expect.objectContaining({ ticket: "a", lifted: true }),
    ])
    expect(ran.events.some((r) => r.kind === "stop")).toBe(false)
    expect(pathOf(ran, "a")).toEqual(["Queued", "Working", "ToMerge", "Merging", "Done"])
  }, 30_000)
})
