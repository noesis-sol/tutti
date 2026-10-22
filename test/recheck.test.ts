import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope, Stream } from "effect"
import fc from "fast-check"
import type { EventRecord } from "../src/run/events.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag } from "../src/run/phase.ts"
import { foldersOf, ownFailures } from "../src/run/recheck.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** A check that fails, its output saying `said`. */
const failing = (said: ReadonlyArray<string>) =>
  new CheckFailed({
    check: "fast",
    command: "scripts/check-fast.sh",
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: said,
    lastLines: [...said, "1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

/** A failure in a file no ticket here changes. */
const elsewhere = failing(["shared/b.go:12: expected 1"])

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, Working. */
const finished = (id: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Cause.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Cause.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Something landing on main by hand, so the next merge rebases and checks. */
const moveMain = Effect.gen(function* () {
  const repository = yield* Repository
  yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
})

const phaseOf = (state: State, id: string) => state.tickets.get(id)?.phase._tag

/** Waits until every ticket named is in its phase. */
const until = (phases: Readonly<Record<string, PhaseTag>>) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) =>
        Object.entries(phases).every(([id, phase]) => phaseOf(state, id) === phase),
      ),
      Stream.runHead,
    )
  })

/** What a recheck scenario hands back: each ticket's phase, and every state the ledger had. */
interface Rechecked {
  readonly phases: Readonly<Record<string, PhaseTag | undefined>>
  readonly states: ReadonlyArray<State>
}

/** Runs `body` with a merge queue, noting each state the ledger has. */
const withQueue = (
  body: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const states: Array<State> = []
    yield* Effect.forkScoped(
      Stream.runForEach(ledger.changes, (state) => Effect.sync(() => states.push(state))),
    )
    const queue = yield* makeQueue(options)
    yield* body(queue)
    const state = yield* ledger.current
    return {
      phases: Object.fromEntries(
        [...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]),
      ),
      states,
    } satisfies Rechecked
  }).pipe(Effect.provide(Ledger.layer))

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const records = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

/**
 * `a` finishes after main moved and its check fails as `checks` says, then `b` finishes and merges
 * on top of main; then `after` runs, before the scenario waits for `phases`.
 */
const aThenB = (
  checks: ReadonlyArray<CheckFailed>,
  phases: Readonly<Record<string, PhaseTag>>,
  options: {
    readonly aFiles?: Files
    readonly between?: Effect.Effect<void, unknown, Env | Ledger>
    readonly after?: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger>
  } = {},
) =>
  scenario(
    { backlog: backlog().ticket("a").ticket("b").ticket("c").seeds, checks: { fast: checks } },
    withQueue((queue) =>
      Effect.gen(function* () {
        const a = yield* finished("a", options.aFiles ?? { "a/a.go": "a\n" })
        yield* moveMain
        yield* queue.offer(a)
        yield* until({ a: "Review" })
        yield* options.between ?? Effect.void
        yield* queue.offer(yield* finished("b", { "b/b.go": "b\n" }))
        yield* until({ b: "Done" })
        yield* options.after?.(queue) ?? Effect.void
        yield* until(phases)
        yield* queue.settled
      }),
    ),
  )

describe("a ticket set aside as its check failed", () => {
  test("is checked once more after another ticket merges, and merges when it passes", async () => {
    const ran = await aThenB([elsewhere], { a: "Done", b: "Done" })
    const { states } = resultOf(ran)
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, but 'scripts\/check-fast.sh' fails on tutti\/a rebased onto main; .*; checked once more if main moves on in this run$/,
      /^ {2}RECHECK: a's check failed on main at [0-9a-f]{7}, which has moved on since; rebasing tutti\/a and checking it once more$/,
      /^ {2}a closed \([0-9a-f]{7} Do a \(a\)\); merged into main, worktree and branch removed$/,
    ])
    // Its check ran twice; b, on top of main, merged unchecked.
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast", "fast"])
    // Its check records (§ 10): the merge check, then the check once more.
    expect(
      ran.events.flatMap((r) => (r.kind === "check" ? [[r.ticket, r.suite, r.result]] : [])),
    ).toEqual([
      ["a", "merge", "failed"],
      ["a", "recheck", "passed"],
    ])
    expect(records(ran, "phase")).toContainEqual(
      expect.objectContaining({ ticket: "a", from: "Review", to: "ToMerge", cause: "Recheck" }),
    )
    // Its card is back while it is ToMerge and Merging, with the same worker's number.
    const back = states.filter((state) => state.tickets.get("a")?.rechecking === true)
    expect(back.map((state) => phaseOf(state, "a"))).toContain("Merging")
    for (const state of back) expect(state.tickets.get("a")?.worker).toBe(1)
  })

  test("carries its note and its warn record with aside", async () => {
    const ran = await aThenB([elsewhere, elsewhere], { a: "Review", b: "Done" })
    const a = ran.issues.find((issue) => issue.id === "a")
    expect(a?.notes).toMatch(/^tutti: CHECKS_FAILED: a closed, but /m)
    const warns = records(ran, "warn").filter(
      (record) => "ticket" in record && record.ticket === "a",
    )
    expect(warns).toEqual([
      expect.objectContaining({ aside: true, detail: "checks failed" }),
      expect.objectContaining({ aside: true, detail: "checks failed again" }),
    ])
  })

  test("isn't checked again when it failed in a folder its own commits change", async () => {
    const ran = await aThenB([failing(["a/a.go:3: expected 1"])], { a: "Review", b: "Done" })
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: .*; not checked again in this run, as it failed in a, which a's own commits change$/,
    ])
    expect(ran.log.some((line) => line.includes("RECHECK"))).toBe(false)
    expect(ran.checkRuns).toHaveLength(1)
  })

  test("is checked again only once a run", async () => {
    const ran = await aThenB(
      [elsewhere, elsewhere],
      { a: "Review", b: "Done", c: "Done" },
      {
        after: (queue) =>
          Effect.gen(function* () {
            yield* until({ a: "Review" })
            yield* queue.offer(yield* finished("c", { "c/c.go": "c\n" }))
          }),
      },
    )
    expectLog(ran, [
      /^ {2}RECHECK: a's check/,
      /^ {2}CHECKS_FAILED: a closed, but 'scripts\/check-fast.sh' fails again on tutti\/a rebased onto main; not handed back to its worker: its worker has no session to resume; worktree .* left for review \(output is in .*\)$/,
    ])
    expect(ran.log.filter((line) => line.includes("RECHECK"))).toHaveLength(1)
    // a's check, then once more; c, on top of main, merged unchecked.
    expect(ran.checkRuns).toHaveLength(2)
  })

  test("touched since, reopened, stays set aside and the log says why", async () => {
    const reopen = Effect.gen(function* () {
      yield* (yield* Beads).update("a", { status: "open" })
    })
    const ran = await aThenB([elsewhere], { a: "Review", b: "Done" }, { between: reopen })
    expectLog(ran, ["  a is not checked again: it is open now; it stays set aside"])
    expect(ran.log.some((line) => line.includes("RECHECK"))).toBe(false)
    expect(ran.checkRuns).toHaveLength(1)
  })
})

describe("ownFailures", () => {
  const part = fc.stringMatching(/^[a-z][a-z0-9_]{0,5}$/)
  const folder = fc.array(part, { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/"))

  test("a file's position in a folder the ticket changes names that folder", () => {
    fc.assert(
      fc.property(folder, part, fc.nat(), fc.string(), (dir, name, at, rest) => {
        const said = [`${dir}/${name}.ts:${at + 1}:2: ${rest}`]
        expect(ownFailures(said, [dir])).toEqual([dir])
      }),
    )
  })

  test("a failed package whose import path ends with the folder names it", () => {
    fc.assert(
      fc.property(folder, folder, (module, dir) => {
        expect(ownFailures([`FAIL ${module}/${dir} 0.1s`], [dir])).toEqual([dir])
        expect(ownFailures([`=== FAIL: ${dir} TestX`], [dir])).toEqual([dir])
      }),
    )
  })

  test("a line naming no package or file, or another folder, names none", () => {
    fc.assert(
      fc.property(fc.string(), folder, (said, dir) => {
        fc.pre(
          !said.startsWith("FAIL") && !said.startsWith("=== FAIL:") && !/^\S+\.\w+:\d/.test(said),
        )
        expect(ownFailures([said], [dir])).toEqual([])
        expect(ownFailures([`other/${dir}x/a.ts:1: no`], [dir])).toEqual([])
      }),
    )
  })

  test("the top level is `.`, and each folder is named once", () => {
    expect(foldersOf(["a.go", "x/y.go", "x/z.go"])).toEqual([".", "x"])
    expect(ownFailures(["a.go:1: no", "b.go:2: no"], ["."])).toEqual(["."])
  })
})
