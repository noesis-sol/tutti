// A branch a run killed outright left rebased ahead of its turn (mergetrain.ts's `checked_ahead`
// mark): the next run puts it back as its worker left it before it merges, so the commits of the
// branch ahead, which didn't merge, don't merge with it. And the setups' mark of dependencies set
// up off the base (setup.ts's offBaseKey), kept in state.json for the next run.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import fc from "fast-check"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { aheadJson, aheadKey, type RebasedAhead, rebasedAheadOf } from "../src/run/mergetrain.ts"
import { Move } from "../src/run/phase.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { makeSetUps, offBaseKey } from "../src/run/setup.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git, type Sha } from "../src/services/Git.ts"
import { type RunStamp, type State, Store, type TicketRecord } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Scripted } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import {
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
} from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** A check command, failed checks set aside at once, the setup run when deps.txt changes. */
const settings = {
  ...defaults,
  checks: {
    ...defaults.checks,
    fast: { ...defaults.checks.fast, command: check },
    setup: { command: "install.sh", files: ["deps.txt"] },
  },
  merge: { ...defaults.merge, check_hand_backs: 0 },
}

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-train-killed-${name}-`)))

/** A process that has ended, for the run that wrote state.json last: it was killed. */
const endedPid = (): number => Bun.spawnSync(["true"]).pid

const killedRun = (): RunStamp => ({
  pid: endedPid(),
  started: "2026-10-21T08:00:00Z",
  version: "0.1.0-test",
})

/** What a killed run left of b, closed, waiting to merge: no suspension, no phase. */
const crashRecord = (root: string): TicketRecord => ({
  session: "session-b",
  worktree: join(root, "b"),
  branch: "tutti/b",
  resumes: 0,
  metadata: {},
})

interface Left {
  /** b's branch as its worker left it, and as the train rebased it. */
  readonly orig: Sha
  readonly head: Sha
  /** tutti/a as b was rebased onto it. */
  readonly onto: Sha
}

interface Ended {
  readonly ran: Ran<Outcome>
  readonly left: Left
  /** b's branch as the run ended; "" once it is gone. */
  readonly after: string
  readonly main: ReadonlyMap<string, string>
  readonly state: State
}

/**
 * A whole run after one killed while b, closed, was checked ahead of its turn on top of tutti/a,
 * whose ticket didn't merge: b's branch rebased onto tutti/a, and state.json marked as `mark` says
 * of where it was (and `before`, then, moves it). The run carries b over and merges it.
 */
const afterKill = async (
  mark: (left: Left) => RebasedAhead,
  before: (worktree: string) => Effect.Effect<void, unknown, Env> = () => Effect.void,
  checks: { readonly setup?: ReadonlyArray<Scripted> } = {},
): Promise<Ended> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let ended: Omit<Ended, "ran"> | undefined
  const ran = await scenario(
    {
      backlog: backlog().ticket("b", { status: "closed" }).seeds,
      config: { repo, settings },
      git: { dir: repo },
      worktrees: { root },
      checks: { fast: [passed("fast")], ...checks },
      state: { version: 1, run: killedRun(), tickets: { b: crashRecord(root) } },
    },
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      const store = yield* Store
      for (const id of ["a", "b"]) {
        mkdirSync(join(root, id), { recursive: true })
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        yield* repository.commit(join(root, id), `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
      }
      yield* repository.commit(repo, "Land something else", { "main.txt": "moved\n" })
      const orig = yield* repository.head("tutti/b")
      const onto = yield* repository.head("tutti/a")
      yield* git.rebase(join(root, "b"), onto)
      const left = { orig, onto, head: yield* repository.head("tutti/b") }
      yield* store.setMetadata("b" as TicketId, aheadKey, aheadJson(mark(left)))
      yield* before(join(root, "b"))
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      const outcome = yield* Fiber.join(fiber)
      ended = {
        left,
        after: yield* repository.head("tutti/b").pipe(Effect.orElseSucceed(() => "")),
        main: yield* repository.tree("main"),
        state: yield* store.state,
      }
      return outcome
    }),
  )
  if (ended === undefined) throw new Error(`the run failed: ${ran.exit}`)
  return { ran, ...ended }
}

const markOf = (state: State, id: string, key: string) => state.tickets[id]?.metadata[key]

const putBackLine = (orig: string) =>
  `  tutti/b was rebased onto tutti/a to be checked ahead of its turn by a run that was killed before its turn: put back as its worker left it, at ${orig.slice(0, 7)}`

describe("a branch a killed run left rebased ahead of its turn", () => {
  test("is put back as its worker left it as the next run starts, and merges without the branch ahead", async () => {
    const ended = await afterKill((left) => ({ ...left, behind: "tutti/a", setUp: false }))
    expectExitCode(ended.ran, 0)
    expectPhases(ended.ran, { b: "Done" })
    expect(ended.main.get("b.txt")).toBe("b\n")
    expect(ended.main.has("a.txt")).toBe(false)
    expectLog(ended.ran, [putBackLine(ended.left.orig), /^ {2}b closed .*; merged into main/])
    expect(markOf(ended.state, "b", aheadKey)).toBeUndefined()
  })

  test("killed before the rebase's end was marked, is put back as on top of the branch ahead", async () => {
    const ended = await afterKill((left) => ({
      orig: left.orig,
      onto: left.onto,
      head: undefined,
      behind: "tutti/a",
      setUp: false,
    }))
    expectPhases(ended.ran, { b: "Done" })
    expect(ended.main.has("a.txt")).toBe(false)
    expectLog(ended.ran, [putBackLine(ended.left.orig)])
  })

  test("whose setup ran on top of the branch ahead, is set up again before its check", async () => {
    const ended = await afterKill(
      (left) => ({ ...left, behind: "tutti/a", setUp: true }),
      () => Effect.void,
      { setup: [passed("setup")] },
    )
    expectPhases(ended.ran, { b: "Done" })
    expect(ended.ran.checkRuns.map((each: CheckRun) => each.check)).toEqual(["setup", "fast"])
    expectLog(ended.ran, [
      putBackLine(ended.left.orig),
      "  b: its dependencies were set up on top of tutti/a, ahead of its turn; running 'install.sh' before the check",
    ])
    expect(markOf(ended.state, "b", offBaseKey)).toBeUndefined()
  })

  test("that moved since, is left as it is, saying so", async () => {
    const ended = await afterKill(
      (left) => ({ ...left, behind: "tutti/a", setUp: false }),
      (worktree) =>
        Effect.flatMap(Repository, (repository) =>
          Effect.asVoid(repository.commit(worktree, "More of b (b)", { "b2.txt": "b2\n" })),
        ),
    )
    expectLog(ended.ran, [
      "  tutti/b was rebased onto tutti/a to be checked ahead of its turn by a run that was killed before its turn, but has moved since: left as it is",
    ])
    expect(ended.ran.log.some((text) => text.includes("put back as its worker left it"))).toBe(
      false,
    )
  })

  test("already where its worker left it, is left so, its mark cleared", async () => {
    const ended = await afterKill(
      (left) => ({ ...left, behind: "tutti/a", setUp: false }),
      (worktree) =>
        Effect.gen(function* () {
          const git = yield* Git
          const record = yield* (yield* Store).metadata("b" as TicketId)
          const mark = rebasedAheadOf(record[aheadKey])
          if (mark !== undefined) yield* git.resetBranch(worktree, mark.orig)
        }),
    )
    expectPhases(ended.ran, { b: "Done" })
    expect(ended.main.has("a.txt")).toBe(false)
    expect(ended.ran.log.some((text) => text.includes("killed"))).toBe(false)
  })
})

/** A ticket its worker finished: a commit naming it on tutti/<id>, closed, Working. */
const finished = (id: TicketId) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

describe("a train's mark in state.json", () => {
  test("holds where the branch was while it is checked ahead, and is cleared as it boards", async () => {
    // a's check passes once b's mark has been read, b's check ahead under way.
    const read = Deferred.makeUnsafe<void>()
    let during: unknown
    let store: Store["Service"] | undefined
    const whose = (each: CheckRun) => each.cwd.split("/").at(-1)
    const one: Scripted = (each) =>
      Effect.gen(function* () {
        if (whose(each) === "a") yield* Deferred.await(read)
        else {
          if (store !== undefined) during = (yield* store.metadata("b" as TicketId))[aheadKey]
          yield* Deferred.succeed(read, undefined)
        }
        return { ...passed("fast"), command: check }
      })
    let orig: Sha | undefined
    const ran = await scenario(
      {
        config: { settings: { ...settings, merge: { ...settings.merge, train: 1 } } },
        backlog: backlog().ticket("a").ticket("b").seeds,
        checks: { fast: [one, one, one, one] },
      },
      Effect.gen(function* () {
        store = yield* Store
        const queue = yield* makeQueue({ repo: "/repo", base: "main" })
        const repository = yield* Repository
        const a = yield* finished("a" as TicketId)
        const b = yield* finished("b" as TicketId)
        orig = yield* repository.head(b.branch)
        yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        yield* queue.offer(a)
        yield* queue.offer(b)
        yield* queue.settled
        return (yield* (yield* Store).metadata("b" as TicketId))[aheadKey]
      }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const mark = rebasedAheadOf(during as Parameters<typeof rebasedAheadOf>[0])
    expect(mark?.orig).toBe(orig)
    expect(mark?.behind).toBe("tutti/a")
    expect(mark?.head).toBeDefined()
    expect(mark?.head).not.toBe(orig)
    expect(ran.exit.value).toBeUndefined()
  })
})

describe("the setups' mark of dependencies set up off the base", () => {
  test("is kept in state.json for the next run's setups, until a setup runs", async () => {
    const program = Effect.gen(function* () {
      const store = yield* Store
      const first = yield* makeSetUps
      yield* first.offBase("b" as TicketId, "its dependencies were set up on top of tutti/a")
      const saved = (yield* store.metadata("b" as TicketId))[offBaseKey]
      const next = yield* makeSetUps
      const carried = yield* next.off("b" as TicketId)
      yield* next.set("b" as TicketId, "abc1234" as Sha, "def5678" as Sha)
      return {
        saved,
        carried,
        after: yield* next.off("b" as TicketId),
        left: (yield* store.metadata("b" as TicketId))[offBaseKey],
      }
    })
    const ran = await scenario(
      { state: { version: 1, tickets: { b: { resumes: 0, metadata: {} } } } },
      program,
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const result = ran.exit.value
    expect(result).toEqual({
      saved: "its dependencies were set up on top of tutti/a",
      carried: "its dependencies were set up on top of tutti/a",
      after: undefined,
      left: undefined,
    })
  })
})

describe("rebasedAheadOf", () => {
  test("reads a mark, and nothing without the commit to put the branch back to", () => {
    expect(
      rebasedAheadOf({
        orig: "abc1234",
        onto: "bcd2345",
        head: "cde3456",
        behind: "tutti/a",
        setUp: true,
      }),
    ).toEqual({
      orig: "abc1234" as Sha,
      onto: "bcd2345" as Sha,
      head: "cde3456" as Sha,
      behind: "tutti/a",
      setUp: true,
    })
    expect(rebasedAheadOf(undefined)).toBeUndefined()
    expect(rebasedAheadOf(null)).toBeUndefined()
    expect(rebasedAheadOf({ head: "cde3456" })).toBeUndefined()
    expect(rebasedAheadOf({ orig: "--upload-pack=x" })).toBeUndefined()
    expect(rebasedAheadOf({ orig: "abc1234", head: 7, setUp: "yes" })).toEqual({
      orig: "abc1234" as Sha,
      onto: undefined,
      head: undefined,
      behind: "the branch ahead of it",
      setUp: false,
    })
  })

  test("takes only commit hashes for commits, whatever state.json holds", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const mark = rebasedAheadOf(value as Parameters<typeof rebasedAheadOf>[0])
        if (mark === undefined) return
        for (const hash of [mark.orig, mark.onto, mark.head]) {
          expect(hash === undefined || /^[0-9a-f]{7,64}$/.test(hash)).toBe(true)
        }
        expect(mark.orig).toBeDefined()
      }),
    )
  })
})
