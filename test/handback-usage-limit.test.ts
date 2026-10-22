// A hand-back's clock and end (handback.ts's give), as whole runs under TestClock: the time its
// worker waits at the account's usage limit doesn't count toward resolve_timeout, and the worker is
// told after the reset to carry on with the hand-back, not its ticket; a rebase or fix finished as
// the limit hits is taken from git; past the limit, a finished result is taken from git, else the
// worker is stopped and told the hand-back is over before its branch is put back.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { type HandBack, handBackOver, handBackTaken } from "../src/run/handback.ts"
import { resetLabel } from "../src/run/localTime.ts"
import { line } from "../src/run/log.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { carryOnHandBack, carryOnText } from "../src/run/usageLimit.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import {
  apiErrorResult,
  apiRetry,
  assistantText,
  awaitInterrupt,
  bash,
  init,
  interruptedResult,
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
const resets = resetLabel(hour * 1000, 0)

interface Places {
  readonly repo: string
  readonly root: string
}

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-handback-limit-${name}-`)))

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

/** A turn that does `steps`, then ends on the usage limit, resetting at `resetsAt` (seconds). */
const limitedTurn = (steps: ReadonlyArray<Step>, resetsAt: number | null = hour): SessionScript => [
  wait,
  init(),
  sessionState("running"),
  ...steps,
  rateLimit("rejected", resetsAt ?? undefined, 1),
  apiRetry(1, 429),
  assistantText("API Error: usage limit reached", { error: "rate_limit" }),
  apiErrorResult("API Error: usage limit reached", 429),
  sessionState("idle"),
]

/** A turn that does `steps`, then works on until tutti interrupts it. */
const interruptedTurn = (steps: ReadonlyArray<Step>): SessionScript => [
  wait,
  init(),
  sessionState("running"),
  ...steps,
  awaitInterrupt,
  interruptedResult,
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

/**
 * a lands first, b after it, writing `aFiles` and `bFiles`; `rest` is b's turns after its first,
 * its hand-backs'.
 */
const aThenB = (
  world: World,
  places: Places,
  aFiles: Files,
  bFiles: Files,
  rest: SessionScript,
): Scripts => ({
  a: [works(world, places, "a", aFiles, [step(untilClaimed(world, "b"))])],
  b: [[...works(world, places, "b", bFiles, [step(untilOnMain(world, aFiles))]), ...rest]],
})

/** a and b conflicting in shared.txt: b's rebase onto a's merge stops, and is handed back. */
const conflicting = (world: World, places: Places, rest: SessionScript): Scripts =>
  aThenB(world, places, { "shared.txt": "a\n" }, { "shared.txt": "b\n" }, rest)

interface Plan {
  readonly scripts: (world: World, places: Places) => Scripts
  readonly checks?: { readonly fast: ReadonlyArray<CheckFailed | ReturnType<typeof passed>> }
  /** Runs beside the run, before it is joined. */
  readonly during?: Effect.Effect<void, unknown, Env>
}

/** A whole run of a and b on main, two at a time, each worktree made in git first. */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  return scenario(
    {
      config: {
        repo: places.repo,
        settings: {
          ...defaults,
          concurrent: 2,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: backlog().ticket("a").ticket("b").seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) => plan.scripts(world, places),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["a", "b"]) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* plan.during ?? Effect.void
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

const expectClean = (ran: Ran<Outcome>, code: number) => {
  expectExitCode(ran, code)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
}

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

const resolvingLine =
  "  RESOLVING: tutti/b conflicts with main in shared.txt; handed back to its worker to resolve (up to 20m)"

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

describe("the usage limit during a hand-back", () => {
  test("its wait doesn't count toward resolve_timeout, and the reset has it carry on with the hand-back", async () => {
    const ran = await runs({
      scripts: (world, places) =>
        conflicting(world, places, [
          ...limitedTurn([]),
          ...turn(continues(world, places, "b", { "shared.txt": "a and b\n" })),
        ]),
      during: Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        // Two hours at the limit, six times resolve_timeout.
        yield* advance("2 hours")
      }),
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
    expectLog(ran, [
      closedLine("a"),
      resolvingLine,
      `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at ${resets}`,
      "  b's worker is at the usage limit on its hand-back: it carries on once the limit lifts, the wait not counting toward the 20m",
      `USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at ${resets}, in 1h`,
      "USAGE_LIMIT lifted",
      "  b: the usage limit has reset; its worker carries on with its hand-back",
      `  b's worker finished the rebase; checking it with '${check}'`,
      closedLine("b"),
      "READY_EMPTY after 2 tickets",
    ])
    const [handBack, ...after] = composed(ran)
    expect(handBack).toContain("rebasing tutti/b onto it stopped on conflicts in shared.txt")
    expect(after).toEqual([carryOnHandBack("b", "tutti/b", "resolving", "main")])
    expect(after).not.toContain(carryOnText("b"))
    expect(interrupted(ran)).toBe(false)
  })

  test("a rebase finished as the limit hits is taken from git, without waiting for the reset", async () => {
    const ran = await runs({
      scripts: (world, places) =>
        conflicting(
          world,
          places,
          limitedTurn(continues(world, places, "b", { "shared.txt": "a and b\n" })),
        ),
      during: Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        yield* advance("2 hours")
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expectLog(ran, [
      resolvingLine,
      "  b's worker is at the usage limit, but its rebase has finished: tutti/b is taken as it is, without waiting for the limit to lift",
      `  b's worker finished the rebase; checking it with '${check}'`,
      closedLine("b"),
      `USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at ${resets}, in 1h`,
      "USAGE_LIMIT lifted",
      "READY_EMPTY after 2 tickets",
    ])
    // Merged before the reset: its worker, its session closed, is told nothing after it.
    expect(composed(ran)).toHaveLength(1)
  })

  test("a fix committed as the limit hits is taken from git, checked and merged", async () => {
    const ran = await runs({
      checks: { fast: [passed("fast"), failing] },
      scripts: (world, places) =>
        aThenB(
          world,
          places,
          { "a.txt": "a\n" },
          { "b.txt": "b\n" },
          limitedTurn(commitsFix(world, places, "b", { "fix.txt": "fixed\n" })),
        ),
      during: Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        yield* advance("2 hours")
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(pathOf(ran, "b").slice(-5)).toEqual(["Merging", "Fixing", "ToMerge", "Merging", "Done"])
    expectLog(ran, [
      /^ {2}FIXING: /,
      "  b's worker is at the usage limit, but its fix is committed: tutti/b is taken as it is, without waiting for the limit to lift",
      `  '${check}' passes on tutti/b as its worker fixed it`,
      closedLine("b"),
      "USAGE_LIMIT lifted",
    ])
  })

  test("with the reset unknown, a run with only the hand-back left ends USAGE_LIMIT, exit 8", async () => {
    const ran = await runs({
      scripts: (world, places) => conflicting(world, places, limitedTurn([], null)),
    })
    expectClean(ran, 8)
    expect(pathOf(ran, "b")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "Stopped",
    ])
    expectLog(ran, [
      resolvingLine,
      "USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets",
      "  b's worker is at the usage limit on its hand-back: it carries on once the limit lifts, the wait not counting toward the 20m",
      "USAGE_LIMIT: the five-hour limit is reached and when it resets is unknown; 1 worker waits for it; run tutti again once it resets",
    ])
    expect(interrupted(ran)).toBe(false)
  })
})

describe("a hand-back past resolve_timeout", () => {
  test("with work in progress: its worker stopped and told the hand-back is over, then the branch put back", async () => {
    const ran = await runs({
      scripts: (world, places) => conflicting(world, places, [...interruptedTurn([]), ...turn([])]),
      during: Effect.gen(function* () {
        yield* untilLogged(/^ {2}RESOLVING: /)
        yield* advance("20 minutes")
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Blocked" })
    expectLog(ran, [
      resolvingLine,
      "  b's worker was stopped and told its hand-back is over",
      /^ {2}MERGE_CONFLICT: b closed, but tutti\/b conflicts with main in shared.txt, which moved on while it ran \(handed back to its worker, but its worker is working after 20m, with the hand-back not done; the rebase was aborted\)/,
    ])
    expect(interrupted(ran)).toBe(true)
    const [, over, ...rest] = composed(ran)
    expect(rest).toEqual([])
    expect(over).toStartWith(
      "tutti: the 20m for this hand-back is up, so tutti has stopped you and ends it: it aborts the rebase if it is still in progress, puts tutti/b back at ",
    )
    expect(over).toContain(
      "and sets b aside for review. Nothing of your attempt was committed, so none of it is kept.",
    )
  })

  test("with the rebase finished, its tests still running: taken as it is, checked and merged", async () => {
    const ran = await runs({
      scripts: (world, places) =>
        conflicting(world, places, [
          ...interruptedTurn(continues(world, places, "b", { "shared.txt": "a and b\n" })),
          ...turn([]),
        ]),
      during: Effect.gen(function* () {
        yield* untilLogged(/^ {2}RESOLVING: /)
        yield* advance("20 minutes")
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expectLog(ran, [
      resolvingLine,
      "  b's worker was still at its hand-back after 20m, but its rebase has finished: tutti/b is taken as it is",
      `  b's worker finished the rebase; checking it with '${check}'`,
      closedLine("b"),
    ])
    expect(interrupted(ran)).toBe(true)
    const [, taken] = composed(ran)
    expect(taken).toMatch(
      /^tutti: the 20m for this hand-back is up, and your rebase has finished, so tutti has stopped you and takes tutti\/b as it is now, at [0-9a-f]{10}, to check with 'scripts\/check-fast\.sh' and merge\./,
    )
  })
  test("a fix half done: its worker told where its attempt is kept, then the branch reset", async () => {
    let attempt = ""
    const ran = await runs({
      checks: { fast: [passed("fast"), failing] },
      scripts: (world, places) =>
        aThenB(world, places, { "a.txt": "a\n" }, { "b.txt": "b\n" }, [
          ...interruptedTurn([
            ...bash(
              'git commit -am "WIP"',
              Effect.asVoid(
                Effect.orDie(
                  world.repository.commit(join(places.root, "b"), "WIP", { "fix.txt": "half\n" }),
                ),
              ),
            ),
            step(
              Effect.orDie(
                Effect.map(world.repository.head("tutti/b"), (head) => {
                  attempt = head
                }),
              ),
            ),
          ]),
          ...turn([]),
        ]),
      during: Effect.gen(function* () {
        yield* untilLogged(/^ {2}FIXING: /)
        yield* advance("20 minutes")
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Review" })
    expectLog(ran, [
      /^ {2}FIXING: /,
      "  b's worker was stopped and told its hand-back is over",
      /^ {2}CHECKS_FAILED: /,
    ])
    expect(interrupted(ran)).toBe(true)
    const [, over] = composed(ran)
    expect(over).toContain(", where the check failed, and sets b aside for review.")
    expect(over).toContain(
      `Your attempt so far is commit ${attempt.slice(0, 10)}, which git keeps (git show ${attempt.slice(0, 10)}).`,
    )
    const notes = ran.issues.find((issue) => issue.id === "b")?.notes ?? ""
    expect(notes).toContain(`its worker's attempt is ${attempt.slice(0, 10)}`)
  })
})

describe("what the worker is told", () => {
  const ticket: FinishedTicket = {
    id: "b",
    title: "Ticket b",
    branch: "tutti/b",
    worktree: "/w/b",
  }
  const handBack = (mode: HandBack["mode"]): HandBack => ({
    ticket,
    mode,
    prompt: "",
    what: line``,
    onto: "1111111111aaaa",
    to: "2222222222bbbb",
    done: Effect.succeed(false),
  })

  test("the hand-back over names the commit its attempt got to, which git keeps", () => {
    expect(handBackOver(handBack("fixing"), "20m", "3333333333cccc")).toBe(
      "tutti: the 20m for this hand-back is up, so tutti has stopped you and ends it: it puts tutti/b back at 2222222222, where the check failed, and sets b aside for review. Your attempt so far is commit 3333333333, which git keeps (git show 3333333333). Don't work on it any more: no git commands in /w/b, no ticket changes. Say DONE.",
    )
  })

  test("a hand-back taken as it is says where, and what checks it", () => {
    expect(handBackTaken(handBack("fixing"), "20m", "4444444444dddd", check)).toBe(
      "tutti: the 20m for this hand-back is up, and your fix is committed, so tutti has stopped you and takes tutti/b as it is now, at 4444444444, to check with 'scripts/check-fast.sh' and merge. Leave /w/b as it is: no more commits, no amending, no git commands in it, no ticket changes. Say DONE.",
    )
  })

  test("the carry-on after the reset names the hand-back, not the ticket", () => {
    expect(carryOnHandBack("b", "tutti/b", "fixing", "main")).toBe(
      "tutti: the account's usage limit has reset. Carry on where you left off with the failing check tutti handed back to you, fixing tutti/b so that it passes and committing the fix, as tutti's message asked, not with b itself, which you closed already. If you had finished that before the limit, check that git shows it done and say DONE.",
    )
    expect(carryOnHandBack("b", "tutti/b", "resolving", "main")).toContain(
      "with the rebase of tutti/b onto main tutti handed back to you, resolving its conflicts",
    )
  })
})
