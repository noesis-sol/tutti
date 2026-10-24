// A hand-back due to a worker at the account's usage limit already, as whole runs under TestClock:
// a check failing on what it left, taken from git as the limit hit, or a conflict at its merge, is
// handed back once the limit lifts, sent at the reset as its carry-on, rather than set aside, the
// wait not counting toward resolve_timeout (handback.ts's give, usageLimit.ts). A worker you steer
// while it waits is sent nothing, and the hand-back is over.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Queue } from "effect"
import { UiCommand } from "../src/run/commands.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { ScreenInputs } from "../src/run/screen.ts"
import { resetHandBackText, resetText } from "../src/run/told.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import {
  apiErrorResult,
  apiRetry,
  assistantText,
  bash,
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
import type { Files } from "../src/testing/Git.ts"
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
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-handback-at-limit-${name}-`)))

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
const continues = (world: World, places: Places, id: string, files: Files) =>
  bash(
    "git add -A && git rebase --continue",
    Effect.asVoid(world.repository.continueRebase(join(places.root, id), files)),
  )

/** The worker committing a fix naming its ticket. */
const commitsFix = (world: World, places: Places, id: string, files: Files) =>
  bash(
    `git commit -am "Fix the check (${id})"`,
    Effect.asVoid(
      Effect.orDie(world.repository.commit(join(places.root, id), `Fix the check (${id})`, files)),
    ),
  )

/** A turn that does `steps`, then ends on the usage limit, resetting an hour in. */
const limitedTurn = (steps: ReadonlyArray<Step>): SessionScript => [
  wait,
  init(),
  sessionState("running"),
  ...steps,
  rateLimit("rejected", hour, 1),
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

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly scripts: (world: World, places: Places) => Scripts
  readonly checks: { readonly fast: ReadonlyArray<CheckFailed | ReturnType<typeof passed>> }
  /** Runs beside the run, before it is joined; `screen` has the dashboard's inputs, once shown. */
  readonly during: (screen: () => ScreenInputs | undefined) => Effect.Effect<void, unknown, Env>
  /** Whether the run has a dashboard, for `during` to steer workers from. */
  readonly dashboard?: boolean
}

/** A whole run of `plan.tickets` on main, all at once, each worktree made in git first. */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const seeds = plan.tickets.reduce((each, id) => each.ticket(id), backlog()).seeds
  return scenario(
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
      yield* plan.during(() => shown)
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
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

/** Whether b's worker was interrupted. */
const interrupted = (ran: Ran<unknown>): boolean =>
  ran.sent.some((item) => item._tag === "Interrupted" && item.ticket === "b")

const expectClean = (ran: Ran<Outcome>) => {
  expectExitCode(ran, 0)
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

/**
 * Waits for b's hand-back to wait for the reset, then lets two hours, six resolve_timeouts, pass. The
 * run may wait for the reset alone before it, while it checks what b's worker left.
 */
const pastTheReset = (what: string) => () =>
  Effect.gen(function* () {
    yield* untilLogged(
      new RegExp(`^ {2}b's worker is at the usage limit: it is handed its ${what}`),
    )
    yield* advance("2 hours")
  })

describe("a worker at the usage limit already", () => {
  test("is handed the check failing on its resolution, taken from git, once the limit lifts", async () => {
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
            ...limitedTurn(continues(world, places, "b", { "shared.txt": "a and b\n" })),
            ...turn(commitsFix(world, places, "b", { "fix.txt": "fixed\n" })),
          ],
        ],
      }),
      during: pastTheReset("failed check to fix"),
    })
    expectClean(ran)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(pathOf(ran, "b").slice(-6)).toEqual([
      "Merging",
      "Resolving",
      "Fixing",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expectLog(ran, [
      "  b's worker is at the usage limit, but its rebase has finished: tutti/b is taken as it is, without waiting for the limit to lift",
      `  b's worker finished the rebase; checking it with '${check}'`,
      /^ {2}FIXING: /,
      "  b's worker is at the usage limit: it is handed its failed check to fix once the limit lifts, the wait not counting toward the 20m",
      "USAGE_LIMIT lifted",
      "  b: the usage limit has reset; its worker is handed its failed check to fix",
      `  '${check}' passes on tutti/b as its worker fixed it`,
      closedLine("b"),
      "READY_EMPTY after 2 tickets",
    ])
    expect(ran.log.some((text) => text.includes("not handed back to its worker"))).toBe(false)
    const [resolve, fix, ...rest] = composed(ran)
    expect(resolve).toContain("rebasing tutti/b onto it stopped on conflicts in shared.txt")
    // The hand-back itself is its carry-on: sent once, at the reset.
    expect(fix).toStartWith(
      "tutti: main moved on while you worked, and tutti/b was rebased onto it",
    )
    expect(rest).toEqual([])
    expect(composed(ran)).not.toContain(resetHandBackText("b", "tutti/b", "fixing", "main"))
    expect(composed(ran)).not.toContain(resetText("b"))
    expect(interrupted(ran)).toBe(false)
  })

  test("steered while it waits for the reset, is handed nothing, and the hand-back is over", async () => {
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
            ...limitedTurn(continues(world, places, "b", { "shared.txt": "a and b\n" })),
          ],
        ],
      }),
      during: (screen) =>
        Effect.gen(function* () {
          yield* untilLogged(/^ {2}b's worker is at the usage limit: it is handed its failed check/)
          const inputs = screen()
          if (inputs === undefined) throw new Error("the run showed no dashboard")
          // You stop b's worker from its view: it is steered, and still at the limit.
          yield* Queue.offer(inputs.commands, UiCommand.Interrupt({ ticket: "b" }))
          yield* untilLogged(/^ {2}STEERED: /)
          yield* advance("2 hours")
        }),
    })
    expectClean(ran)
    expectPhases(ran, { a: "Done", b: "Blocked" })
    expectLog(ran, [
      /^ {2}FIXING: /,
      "  b's worker is at the usage limit: it is handed its failed check to fix once the limit lifts, the wait not counting toward the 20m",
      /^ {2}STEERED: /,
      "USAGE_LIMIT lifted",
      "  b: the usage limit has reset; you steer its worker, so tutti doesn't hand it its failed check to fix",
      /^ {2}MERGE_CONFLICT: b closed, .*\(1\) you steered its worker while it waited for the usage limit/,
    ])
    const [resolve, ...rest] = composed(ran)
    expect(resolve).toContain("rebasing tutti/b onto it stopped on conflicts in shared.txt")
    expect(rest).toEqual([])
  })

  test("is handed the conflicts its fix, taken from git, meets at its merge, once the limit lifts", async () => {
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const ran = await runs({
      tickets: ["a", "b", "c"],
      // a's check passes; the one on b rebased onto a fails; c's and the one on b's resolution pass.
      checks: { fast: [passed("fast"), failing] },
      scripts: (world, places) => ({
        a: [works(world, places, "a", { "a.txt": "a\n" }, [step(untilClaimed(world, "b"))])],
        b: [
          [
            ...works(world, places, "b", { "b.txt": "b\n" }, [
              step(untilOnMain(world, { "a.txt": "a\n" })),
            ]),
            // c lands while b fixes its check, in the file b's fix commits as the limit hits.
            ...limitedTurn([
              step(Effect.sync(() => release())),
              step(untilOnMain(world, { "fix.txt": "c\n" })),
              ...commitsFix(world, places, "b", { "fix.txt": "b\n" }),
            ]),
            ...turn(continues(world, places, "b", { "fix.txt": "b and c\n" })),
          ],
        ],
        c: [
          works(world, places, "c", { "fix.txt": "c\n" }, [step(Effect.promise(() => released))]),
        ],
      }),
      during: pastTheReset("conflicts to resolve"),
    })
    expectClean(ran)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expect(pathOf(ran, "b").slice(-8)).toEqual([
      "Merging",
      "Fixing",
      "ToMerge",
      "Merging",
      "Resolving",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expectLog(ran, [
      /^ {2}FIXING: /,
      closedLine("c"),
      "  b's worker is at the usage limit, but its fix is committed: tutti/b is taken as it is, without waiting for the limit to lift",
      "  RESOLVING: tutti/b conflicts with main in fix.txt; handed back to its worker to resolve (up to 20m)",
      "  b's worker is at the usage limit: it is handed its conflicts to resolve once the limit lifts, the wait not counting toward the 20m",
      "USAGE_LIMIT lifted",
      "  b: the usage limit has reset; its worker is handed its conflicts to resolve",
      `  b's worker finished the rebase; checking it with '${check}'`,
      closedLine("b"),
      "READY_EMPTY after 3 tickets",
    ])
    expect(ran.log.some((text) => text.includes("MERGE_CONFLICT"))).toBe(false)
    const [fix, resolve, ...rest] = composed(ran)
    expect(fix).toStartWith(
      "tutti: main moved on while you worked, and tutti/b was rebased onto it",
    )
    expect(resolve).toContain("rebasing tutti/b onto it stopped on conflicts in fix.txt")
    expect(rest).toEqual([])
    expect(interrupted(ran)).toBe(false)
  })
})
