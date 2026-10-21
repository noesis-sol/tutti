// A handed-back ticket is checked once, as orchestra 0.8.5 has it: when another ticket merges while
// its worker fixes its failing check, what the worker left isn't checked where the branch was, then
// rebased and checked again; it is rebased onto the moved base first and checked there, its fix
// carried to that check. Each scenario is a whole run under TestClock: a lands at once, b's check
// fails after its rebase onto a and is handed back, and c merges while b's worker works on it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  result,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Script as ChecksScript, passed } from "../src/testing/Checks.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-check-once-${name}-`)))

interface Places {
  readonly repo: string
  readonly root: string
}

/** Claims its ticket, does `first`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  places: Places,
  id: string,
  files: Files,
  first: SessionScript,
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

/** A check hand-back's turn: after `takes`, the worker commits a fix naming its ticket. */
const fixes = (
  world: World,
  places: Places,
  id: string,
  files: Files,
  takes: Duration.Input = 0,
): SessionScript =>
  turn([
    sleep(takes),
    ...bash(
      `git commit -am "Fix the check (${id})"`,
      Effect.asVoid(
        Effect.orDie(
          world.repository.commit(join(places.root, id), `Fix the check (${id})`, files),
        ),
      ),
    ),
  ])

/** A conflict hand-back's turn: the worker resolves its rebase's conflicts, writing `files`. */
const resolves = (world: World, places: Places, id: string, files: Files): SessionScript =>
  turn(
    bash(
      "git add -A && git rebase --continue",
      Effect.asVoid(world.repository.continueRebase(join(places.root, id), files)),
    ),
  )

/** A check hand-back's turn: after `takes`, the worker finds nothing to fix and commits nothing. */
const findsNothing = (takes: Duration.Input): SessionScript =>
  turn([sleep(takes)], result("What failed passes without a change."))

const fails = () =>
  new CheckFailed({
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

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** Waits, in real time, until `id`'s worker has claimed it: the run has dispatched it. */
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

/** Moves TestClock on by `total`, a minute at a time, letting the run catch up after each. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const minutes = Duration.toMinutes(Duration.fromInputUnsafe(total))
    for (let i = 0; i < minutes; i++) {
      yield* advance("1 minute")
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

const fixingLine = (attempt: number) =>
  `  FIXING: '${check}' fails on tutti/b rebased onto main; handed back to its worker to fix (${attempt} of 2, up to 20m)`

const movedLine = (committed: string) =>
  `  b's worker committed ${committed}, but main moved on meanwhile: rebasing tutti/b onto it before checking it`

/**
 * A whole run of a, b and c, three at a time: a lands once all three are dispatched; b closes at
 * 1m, after a, so that its check runs on it rebased onto a, failing as `checks` says, and its
 * hand-back turns are `rest`; c closes at 3m and merges while b's worker works on its hand-back.
 */
const runs = (
  checks: ChecksScript,
  rest: (world: World, places: Places) => SessionScript,
  cFiles: Files = { "c.txt": "c\n" },
): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const tickets = ["a", "b", "c"]
  const scripts = (world: World): Scripts => ({
    a: [works(world, places, "a", { "a.txt": "a\n" }, [step(untilClaimed(world, "c"))])],
    b: [
      [
        ...works(world, places, "b", { "b.txt": "b\n" }, [sleep("1 minute")]),
        ...rest(world, places),
      ],
    ],
    c: [works(world, places, "c", cFiles, [sleep("3 minutes")])],
  })
  return scenario(
    {
      config: {
        repo: places.repo,
        settings: {
          ...defaults,
          concurrent: 3,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      checks,
      scripts,
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      // The clock starts once a has landed, so that b's check fails at 1m.
      yield* untilLogged(closedLine("a"))
      yield* passes("15 minutes")
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** The worktrees the merge check ran in, in turn, by ticket. */
const checkedIn = (ran: Ran<unknown> & Places): ReadonlyArray<string> =>
  ran.checkRuns.flatMap((each) =>
    each.check === "fast" ? [each.cwd.slice(ran.root.length + 1)] : [],
  )

const expectClean = (ran: Ran<Outcome>) => {
  expectExitCode(ran, 0)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
}

describe("a fix handed back while another ticket merges", () => {
  test("is rebased onto the moved base and checked once there, then merges", async () => {
    const ran = await runs({ fast: [passed("fast"), fails()] }, (world, places) =>
      fixes(world, places, "b", { "fix.txt": "fixed\n" }, "5 minutes"),
    )
    expectClean(ran)
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
      fixingLine(1),
      closedLine("c"),
      movedLine("1 commit"),
      "  rebased tutti/b onto main, which moved on while it ran",
      `  '${check}' passes on tutti/b as its worker fixed it`,
      closedLine("b"),
      "READY_EMPTY after 3 tickets",
    ])
    // One check for the hand-back: b's fix isn't checked before its rebase onto c's merge.
    expect(checkedIn(ran)).toEqual(["a", "b", "c", "b"])
  })

  test("failing once rebased, it is handed back again, each attempt in the notes", async () => {
    const ran = await runs(
      { fast: [passed("fast"), fails(), passed("fast"), fails(), fails()] },
      (world, places) => [
        ...fixes(world, places, "b", { "fix.txt": "one\n" }, "5 minutes"),
        ...fixes(world, places, "b", { "fix.txt": "two\n" }),
      ],
    )
    expectClean(ran)
    expect(pathOf(ran, "b").slice(3)).toEqual([
      "Merging",
      "Fixing",
      "ToMerge",
      "Merging",
      "Fixing",
      "Review",
    ])
    expectLog(ran, [
      fixingLine(1),
      closedLine("c"),
      movedLine("1 commit"),
      "  rebased tutti/b onto main, which moved on while it ran",
      fixingLine(2),
      new RegExp(
        `^ {2}CHECKS_FAILED: b closed, but '${check}' fails on tutti/b rebased onto main, after it was handed back to its worker to fix twice \\(see its notes\\)`,
      ),
    ])
    expect(checkedIn(ran)).toEqual(["a", "b", "c", "b", "b"])
    const notes = ran.issues.find((issue) => issue.id === "b")?.notes ?? ""
    expect(notes).toContain(
      `it was handed back to its worker to fix twice: (1) its worker committed 1 commit, but '${check}' fails still`,
    )
    expect(notes).toContain(`(2) its worker committed 1 commit, but '${check}' fails still`)
    expect(notes).toContain("not handed back again: it was handed back to its worker twice already")
  })

  test("committing nothing, it is checked once there, and set aside when it fails again", async () => {
    const ran = await runs({ fast: [passed("fast"), fails(), passed("fast"), fails()] }, () =>
      findsNothing("5 minutes"),
    )
    expectClean(ran)
    expect(pathOf(ran, "b").slice(-4)).toEqual(["Fixing", "ToMerge", "Merging", "Review"])
    expectLog(ran, [
      fixingLine(1),
      closedLine("c"),
      movedLine("nothing"),
      "  rebased tutti/b onto main, which moved on while it ran",
      /^ {2}CHECKS_FAILED: b closed, but .* after it was handed back to its worker to fix once/,
    ])
    expect(checkedIn(ran)).toEqual(["a", "b", "c", "b"])
    const notes = ran.issues.find((issue) => issue.id === "b")?.notes ?? ""
    expect(notes).toContain(`(1) its worker committed nothing, and '${check}' fails again`)
    expect(notes).toContain("not handed back again: its worker found nothing to fix")
  })

  test("its rebase stopping on conflicts, the resolution is checked, the fix's attempt noted", async () => {
    const ran = await runs(
      { fast: [passed("fast"), fails(), passed("fast"), fails(), fails()] },
      (world, places) => [
        ...fixes(world, places, "b", { "shared.txt": "fixed\n" }, "5 minutes"),
        ...resolves(world, places, "b", { "shared.txt": "c and fixed\n" }),
        ...fixes(world, places, "b", { "fix.txt": "two\n" }),
      ],
      { "shared.txt": "c\n" },
    )
    expectClean(ran)
    expect(pathOf(ran, "b").slice(3)).toEqual([
      "Merging",
      "Fixing",
      "ToMerge",
      "Merging",
      "Resolving",
      "Fixing",
      "Blocked",
    ])
    expectLog(ran, [
      fixingLine(1),
      closedLine("c"),
      movedLine("1 commit"),
      "  RESOLVING: tutti/b conflicts with main in shared.txt; handed back to its worker to resolve (up to 20m)",
      `  b's worker finished the rebase; checking it with '${check}'`,
      /^ {2}MERGE_CONFLICT: b closed, but tutti\/b conflicts with main/,
    ])
    // b's fix wasn't checked before the rebase that stopped; its resolution was, and the fix of it.
    expect(checkedIn(ran)).toEqual(["a", "b", "c", "b", "b"])
    const notes = ran.issues.find((issue) => issue.id === "b")?.notes ?? ""
    expect(notes).toContain(
      "handed back to its worker to fix twice: (1) its worker committed 1 commit, but rebasing it onto main, which moved on meanwhile, stopped on conflicts; (2) its worker committed 1 commit, but",
    )
  })
})
