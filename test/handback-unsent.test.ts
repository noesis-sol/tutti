// A hand-back kept for the usage limit's reset (usageLimit.ts) that the run's end overtakes: the run
// ends USAGE_LIMIT, the reset unknown or later than --usage-limit-wait, or is quit, before it is
// sent. Its rebase
// is aborted, so that the next run merges its ticket again and hands its conflicts back, and the
// closing line says it was never sent. Also give's path where the worker leaves the limit without its
// hand-back as its session ends, and the hold's keep with the hold off.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Option, Queue } from "effect"
import { reportOf, UsageLimits } from "../src/agent/UsageLimits.ts"
import { UiCommand } from "../src/run/commands.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { ScreenInputs } from "../src/run/screen.ts"
import { make as makeUsageHold, neverHanded } from "../src/run/usageLimit.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store } from "../src/services/Store.ts"
import {
  apiErrorResult,
  apiRetry,
  assistantText,
  bash,
  gone,
  init,
  rateLimit,
  result,
  type SessionScript,
  type Step,
  sessionState,
  run as step,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
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

// Whole runs waiting out a hold take up to a second on an idle machine.
setDefaultTimeout(30_000)

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

// TestClock starts at the epoch, so a limit resetting at 3600 (seconds) resets an hour in.
const hour = 3600

interface Places {
  readonly repo: string
  readonly root: string
}

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-handback-unsent-${name}-`)))

/** Claims its ticket, does `first`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  places: Places,
  id: string,
  files: Files,
  first: ReadonlyArray<Step> = [],
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...first,
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(world.repository.commit(join(places.root, id), `Change (${id})`, files)),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** The worker resolving its rebase's conflicts, writing `files`. */
const continues = (repository: Repository["Service"], worktree: string, files: Files) =>
  bash(
    "git add -A && git rebase --continue",
    Effect.asVoid(repository.continueRebase(worktree, files)),
  )

/** The worker committing a fix naming its ticket. */
const commitsFix = (world: World, places: Places, id: string, files: Files) =>
  bash(
    `git commit -am "Fix the check (${id})"`,
    Effect.asVoid(
      Effect.orDie(world.repository.commit(join(places.root, id), `Fix the check (${id})`, files)),
    ),
  )

/** A turn that does `steps`, then ends on the usage limit, resetting at `resets` (unknown: none). */
const limitedTurn = (steps: ReadonlyArray<Step>, resets?: number): SessionScript => [
  wait,
  init(),
  sessionState("running"),
  ...steps,
  rateLimit("rejected", resets, 1),
  apiRetry(1, 429),
  assistantText("API Error: usage limit reached", { error: "rate_limit" }),
  apiErrorResult("API Error: usage limit reached", 429),
  sessionState("idle"),
]

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** Waits, in real time, until `id` is claimed: the run has dispatched it. */
const untilClaimed = (world: World, id: string) =>
  Effect.orDie(
    Effect.gen(function* () {
      for (let i = 0; i < 2000; i++) {
        if ((yield* world.beads.show(id)).status === "in_progress") return
        yield* Effect.promise(() => Bun.sleep(2))
      }
      throw new Error(`${id} was never claimed`)
    }),
  )

/** Waits, in real time, until main holds `files`. */
const untilOnMain = (world: World, files: Files) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const tree = yield* world.repository.tree("main")
      if (Object.entries(files).every(([path, text]) => tree.get(path) === text)) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`main never held ${Object.keys(files).join(", ")}`)
  }).pipe(Effect.orDie)

/** What git shows of b's worktree once the run is over. */
interface Left {
  readonly rebasing: boolean
  readonly on: string | null
  readonly state: State
}

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly scripts: (world: World, places: Places) => Scripts
  readonly checks: { readonly fast: ReadonlyArray<CheckFailed | ReturnType<typeof passed>> }
  /** Runs beside the run, before it is joined; `screen` has the dashboard's inputs, once shown. */
  readonly during?: (screen: () => ScreenInputs | undefined) => Effect.Effect<void, unknown, Env>
  /** Whether the run has a dashboard, for `during` to quit it from. */
  readonly dashboard?: boolean
}

/** A whole run of `plan.tickets` on main, all at once, each worktree made in git first. */
const runs = async (plan: Plan): Promise<Ran<Outcome> & Places & Left> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const seeds = plan.tickets.reduce((each, id) => each.ticket(id), backlog()).seeds
  let left: Left | undefined
  const ran = await scenario(
    {
      config: {
        repo: places.repo,
        settings: {
          ...defaults,
          concurrent: plan.tickets.length,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      checks: plan.checks,
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
      let shown: ScreenInputs | undefined
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          ...(plan.dashboard === true
            ? {
                dashboard: (inputs: ScreenInputs) =>
                  Effect.sync(() => {
                    shown = inputs
                  }),
              }
            : {}),
        }),
      )
      if (plan.during !== undefined) yield* plan.during(() => shown)
      const outcome = yield* Fiber.join(fiber)
      const worktree = join(places.root, "b")
      left = {
        rebasing: yield* Effect.orDie(git.rebaseInProgress(worktree)),
        on: Option.getOrNull(yield* Effect.orDie(git.currentBranch(worktree))),
        state: yield* (yield* Store).state,
      }
      return outcome
    }),
  )
  if (left === undefined) throw new Error(`the run failed: ${ran.exit}`)
  return { ...ran, ...places, ...left }
}

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** The client_composed messages b's worker was sent after its ticket's prompt. */
const composed = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.sent
    .flatMap((item) =>
      item._tag === "Message" && item.ticket === "b" && item.message.client_composed === true
        ? [String(item.message.message.content)]
        : [],
    )
    .slice(1)

const expectClean = (ran: Ran<Outcome>, code: number) => {
  expectExitCode(ran, code)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
}

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

const failing = new CheckFailed({
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

/** The run's closing line: its last line starting with USAGE_LIMIT. */
const closing = (ran: Ran<unknown>): string =>
  ran.log.filter((text) => text.startsWith("USAGE_LIMIT: ")).at(-1) ?? ""

describe("a run that ends before a hand-back kept for the reset is sent", () => {
  test("aborts the rebase whose conflicts its worker never saw, and says so as it ends", async () => {
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const ran = await runs({
      tickets: ["a", "b", "c"],
      // a's check passes; the one on b rebased onto a fails; c's passes.
      checks: { fast: [passed("fast"), failing] },
      scripts: (world, places) => ({
        a: [works(world, places, "a", { "a.txt": "a\n" }, [step(untilClaimed(world, "b"))])],
        b: [
          [
            ...works(world, places, "b", { "b.txt": "b\n" }, [
              step(untilOnMain(world, { "a.txt": "a\n" })),
            ]),
            // c lands while b fixes its check, in the file b's fix commits as the limit hits, when
            // it resets unknown.
            ...limitedTurn([
              step(Effect.sync(() => release())),
              step(untilOnMain(world, { "fix.txt": "c\n" })),
              ...commitsFix(world, places, "b", { "fix.txt": "b\n" }),
            ]),
          ],
        ],
        c: [
          works(world, places, "c", { "fix.txt": "c\n" }, [step(Effect.promise(() => released))]),
        ],
      }),
    })
    expectClean(ran, 8)
    expectPhases(ran, { a: "Done", b: "Stopped", c: "Done" })
    expect(pathOf(ran, "b").slice(-3)).toEqual(["Merging", "Resolving", "Stopped"])
    expectLog(ran, [
      closedLine("c"),
      "  RESOLVING: tutti/b conflicts with main in fix.txt; handed back to its worker to resolve (up to 20m)",
      "  b's worker is at the usage limit: it is handed its conflicts to resolve once the limit lifts, the wait not counting toward the 20m",
    ])
    expect(closing(ran)).toBe(
      `USAGE_LIMIT: the five-hour limit is reached and when it resets is unknown; 1 worker waits for it; run tutti again once it resets; ${neverHanded("b", "resolving")}`,
    )
    // Only the fix was sent: the conflicts never were, and the rebase is undone for the next run.
    expect(composed(ran)).toHaveLength(1)
    expect(ran.rebasing).toBe(false)
    expect(ran.on).toBe("tutti/b")
    expect(ran.state.tickets.b?.phase).toBe("Stopped")
  })

  test("names a check hand-back never sent, its branch left as the check failed on it", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      // a's check passes; the one on b's resolution fails.
      checks: { fast: [passed("fast"), failing] },
      scripts: (world, places) => ({
        a: [works(world, places, "a", { "shared.txt": "a\n" }, [step(untilClaimed(world, "b"))])],
        b: [
          [
            ...works(world, places, "b", { "shared.txt": "b\n" }, [
              step(untilOnMain(world, { "shared.txt": "a\n" })),
            ]),
            // The limit resets in seven hours, later than --usage-limit-wait's six.
            ...limitedTurn(
              continues(world.repository, join(places.root, "b"), { "shared.txt": "a and b\n" }),
              7 * hour,
            ),
          ],
        ],
      }),
    })
    expectClean(ran, 8)
    expectPhases(ran, { a: "Done", b: "Stopped" })
    expect(pathOf(ran, "b").slice(-4)).toEqual(["Merging", "Resolving", "Fixing", "Stopped"])
    expectLog(ran, [
      /^ {2}FIXING: /,
      "  b's worker is at the usage limit: it is handed its failed check to fix once the limit lifts, the wait not counting toward the 20m",
    ])
    expect(closing(ran)).toEndWith(`; ${neverHanded("b", "fixing")}`)
    expect(composed(ran)).toHaveLength(1)
    expect(ran.rebasing).toBe(false)
    expect(ran.on).toBe("tutti/b")
  })

  test("quit meanwhile, names it apart from the hand-backs left as they are", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      checks: { fast: [passed("fast"), failing] },
      dashboard: true,
      scripts: (world, places) => ({
        a: [works(world, places, "a", { "shared.txt": "a\n" }, [step(untilClaimed(world, "b"))])],
        b: [
          [
            ...works(world, places, "b", { "shared.txt": "b\n" }, [
              step(untilOnMain(world, { "shared.txt": "a\n" })),
            ]),
            ...limitedTurn(
              continues(world.repository, join(places.root, "b"), { "shared.txt": "a and b\n" }),
              hour,
            ),
          ],
        ],
      }),
      during: (screen) =>
        Effect.gen(function* () {
          yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
          const inputs = screen()
          if (inputs === undefined) throw new Error("the run showed no dashboard")
          yield* Queue.offer(inputs.commands, UiCommand.Quit({ now: true }))
        }),
    })
    expectClean(ran, 130)
    expectPhases(ran, { a: "Done", b: "Stopped" })
    expectLog(ran, [
      "  b's worker is at the usage limit: it is handed its failed check to fix once the limit lifts, the wait not counting toward the 20m",
      /^USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at /,
      `INTERRUPTED: quit from the dashboard; b's session is saved for the next run; ${neverHanded("b", "fixing")}`,
    ])
    expect(composed(ran)).toHaveLength(1)
    expect(ran.log).not.toContain("USAGE_LIMIT lifted")
  })

  test("the next run merges its ticket again and hands the conflicts back", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const worktree = join(root, "b")
    const ran = await scenario(
      {
        backlog: backlog().ticket("b", { status: "closed" }).seeds,
        config: {
          repo,
          settings: {
            ...defaults,
            checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
          },
        },
        git: { dir: repo },
        worktrees: { root },
        // As the last run's end left b: Stopped, its session saved, its rebase aborted.
        state: {
          version: 1,
          tickets: {
            b: {
              session: "session-b",
              worktree,
              branch: "tutti/b",
              suspended: "USAGE_LIMIT",
              phase: "Stopped",
              resumes: 0,
              metadata: {},
            },
          },
        },
        scripts: (world: World) => ({
          b: [turn(continues(world.repository, worktree, { "fix.txt": "b and c\n" }))],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        mkdirSync(worktree, { recursive: true })
        yield* git.addWorktree(repo, worktree, { branch: "tutti/b", base: "main" })
        yield* repository.commit(worktree, "Fix the check (b)", { "fix.txt": "b\n" })
        yield* repository.commit(repo, "Change (c)", { "fix.txt": "c\n" })
        return yield* Effect.scoped(run({ version: "0.1.0-test", base: "main" }))
      }),
    )
    expectClean(ran, 0)
    expectPhases(ran, { b: "Done" })
    expect(pathOf(ran, "b")).toEqual([
      "ToMerge",
      "Merging",
      "Resolving",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expectLog(ran, [
      "  b, carried over from the last run, is closed, so it waits to merge",
      "  RESOLVING: tutti/b conflicts with main in fix.txt; handed back to its worker to resolve (up to 20m)",
      /^ {2}RESUMED: /,
      closedLine("b"),
    ])
  })
})

describe("a hand-back kept for the reset", () => {
  test("whose worker's session ends as it waits is given as to any worker: its session resumed", async () => {
    let keep = () => {}
    const kept = new Promise<void>((resolve) => {
      keep = resolve
    })
    const ran = await runs({
      tickets: ["a", "b"],
      // a's check passes; the one on b's resolution fails; the one on b's fix passes.
      checks: { fast: [passed("fast"), failing] },
      scripts: (world, places) => ({
        a: [works(world, places, "a", { "shared.txt": "a\n" }, [step(untilClaimed(world, "b"))])],
        b: [
          [
            ...works(world, places, "b", { "shared.txt": "b\n" }, [
              step(untilOnMain(world, { "shared.txt": "a\n" })),
            ]),
            ...limitedTurn(
              continues(world.repository, join(places.root, "b"), { "shared.txt": "a and b\n" }),
              hour,
            ),
            step(Effect.promise(() => kept)),
            gone("its process exited"),
          ],
          // The session resumed for the hand-back.
          turn(commitsFix(world, places, "b", { "fix.txt": "fixed\n" })),
        ],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* untilLogged(/^ {2}b's worker is at the usage limit: it is handed its failed check/)
          keep()
          yield* untilLogged(closedLine("b"))
          yield* advance("2 hours")
        }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expectLog(ran, [
      "  b's worker is at the usage limit: it is handed its failed check to fix once the limit lifts, the wait not counting toward the 20m",
      /^ {2}RESUMED: b's failed check is handed back to its worker, which is gone \(its process exited\)/,
      `  '${check}' passes on tutti/b as its worker fixed it`,
      closedLine("b"),
      "USAGE_LIMIT lifted",
    ])
    // Sent once, as the session resumed, not again at the reset.
    const [, fix, ...rest] = composed(ran)
    expect(fix).toStartWith(
      "tutti: main moved on while you worked, and tutti/b was rebased onto it",
    )
    expect(rest).toEqual([])
    expect(ran.log.some((text) => text.startsWith("  b: the usage limit has reset"))).toBe(false)
  })
})

describe("the usage-limit hold's keep", () => {
  test("with the hold off, keeps nothing; with it on, keeps it until the run's end takes it back", async () => {
    const ran = await scenario(
      {},
      Effect.gen(function* () {
        const hold = yield* makeUsageHold({
          base: "main",
          wakeUp: Effect.void,
          show: () => Effect.void,
        })
        expect(yield* hold.atReset.keep("b", "fixing", "fix it")).toBeNull()
        expect(yield* hold.handBacks).toEqual(new Set())
        const usage = yield* UsageLimits
        yield* usage.report(
          reportOf({ status: "rejected", rateLimitType: "five_hour", resetsAt: hour }),
        )
        for (let i = 0; i < 2000 && !(yield* hold.held); i++) {
          yield* Effect.promise(() => Bun.sleep(2))
        }
        expect(yield* hold.held).toBe(true)
        expect(yield* hold.atReset.keep("b", "resolving", "resolve it")).not.toBeNull()
        expect(yield* hold.handBacks).toEqual(new Set(["b"]))
        expect(yield* hold.unsent).toEqual(new Map([["b", "resolving"]]))
        expect(yield* hold.handBacks).toEqual(new Set())
        // Taken back, it is neither sent at the reset nor taken back again.
        yield* advance("2 hours")
        yield* untilLogged(/^USAGE_LIMIT lifted$/)
        expect(yield* hold.atReset.takeBack("b")).toBe(false)
      }).pipe(Effect.provide(Ledger.layer)),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(ran.sent.filter((item) => item._tag === "Message")).toEqual([])
  })

  test("names each hand-back never sent, and a rebase that could not be aborted", () => {
    expect(neverHanded("b", "resolving")).toBe(
      "b's worker, at the usage limit, was never handed its conflicts to resolve: its rebase is aborted, for the next run to merge b again",
    )
    expect(neverHanded("b", "fixing")).toBe(
      "b's worker, at the usage limit, was never handed its failed check to fix: the next run merges b again",
    )
    expect(neverHanded("b", "resolving", "/w/b")).toBe(
      "b's worker, at the usage limit, was never handed its conflicts to resolve, and its rebase could not be aborted, so /w/b is left mid-rebase",
    )
  })
})
