// A rebase a killed run's merge left in progress (check.ts's `rebased_unchecked` mark): the next
// run's carry-over aborts it, the branch back as its worker left it, and the ticket goes back in
// line to merge, rather than set aside OFF_BRANCH mid-rebase. One whose conflicts were handed back
// to its worker is its worker's resolution, left as it is.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import fc from "fast-check"
import { handedBackOf, markHandedBack, uncheckedKey, uncheckedOf } from "../src/run/check.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { type RunStamp, type State, Store, type TicketRecord } from "../src/services/Store.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, expectExitCode, expectLog, expectPhases, type Ran, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-killed-rebase-${name}-`)))

/** A process that has ended, for the run that wrote state.json last: it was killed. */
const endedPid = (): number => Bun.spawnSync(["true"]).pid

const killedRun = (): RunStamp => ({
  pid: endedPid(),
  started: "2026-10-22T08:00:00Z",
  version: "0.1.0-test",
})

/** What a killed run left of b, closed, merging: no suspension, no phase. */
const crashRecord = (root: string): TicketRecord => ({
  session: "session-b",
  worktree: join(root, "b"),
  branch: "tutti/b",
  resumes: 0,
  metadata: {},
})

interface Ended {
  readonly ran: Ran<Outcome>
  /** b's branch as its worker left it. */
  readonly orig: string
  /** Whether b's worktree is mid-rebase as the run ended. */
  readonly rebasing: boolean
  readonly main: ReadonlyMap<string, string>
  readonly state: State
}

/**
 * A whole run after one killed while its merge rebased b, closed: b's worktree left mid-rebase,
 * its branch marked rebased and unchecked, the mark holding `extra` besides where it was. main
 * moved on meanwhile, apart from b's change, so b merges once its branch is rebased again.
 */
const afterKill = async (extra: Record<string, boolean> = {}): Promise<Ended> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let ended: Omit<Ended, "ran"> | undefined
  const ran = await scenario(
    {
      backlog: backlog().ticket("b", { status: "closed" }).seeds,
      config: { repo },
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, run: killedRun(), tickets: { b: crashRecord(root) } },
    },
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      const store = yield* Store
      const worktree = join(root, "b")
      mkdirSync(worktree, { recursive: true })
      yield* git.addWorktree(repo, worktree, { branch: "tutti/b", base: "main" })
      yield* repository.commit(worktree, "Do b (b)", { "b.txt": "b\n" })
      const orig = yield* repository.head("tutti/b")
      const fork = yield* git.mergeBase(repo, "main", "tutti/b")
      // The rebase the killed run's merge began: stopped in b's worktree, which a side branch's
      // commit conflicts with, as git would be on any commit mid-rebase.
      yield* git.addWorktree(repo, join(root, "side"), { branch: "side", base: "main" })
      yield* repository.commit(join(root, "side"), "Side", { "b.txt": "side\n" })
      yield* Effect.flip(git.rebase(worktree, yield* repository.head("side")))
      yield* store.setMetadata("b", uncheckedKey, { fork, head: orig, ...extra })
      yield* repository.commit(repo, "Land something else", { "main.txt": "moved\n" })
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      const outcome = yield* Fiber.join(fiber)
      ended = {
        orig,
        rebasing: yield* git.rebaseInProgress(worktree),
        main: yield* repository.tree("main"),
        state: yield* store.state,
      }
      return outcome
    }),
  )
  if (ended === undefined) throw new Error(`the run failed: ${ran.exit}`)
  return { ran, ...ended }
}

const abortedLine =
  "  b, carried over from the last run, was left mid-rebase as the last run ended: the rebase is aborted, tutti/b back as its worker left it"

describe("a rebase a killed run's merge left in progress", () => {
  test("is aborted as the next run starts, and the ticket goes back in line and merges", async () => {
    const ended = await afterKill()
    expectExitCode(ended.ran, 0)
    expectPhases(ended.ran, { b: "Done" })
    expect(ended.rebasing).toBe(false)
    expect(ended.main.get("b.txt")).toBe("b\n")
    expect(ended.main.get("main.txt")).toBe("moved\n")
    expectLog(ended.ran, [
      abortedLine,
      "  b, carried over from the last run, is closed, so it waits to merge",
      /^ {2}b closed .*; merged into main/,
    ])
    expect(ended.ran.log.some((text) => text.includes("OFF_BRANCH"))).toBe(false)
  })

  test("whose conflicts were handed back to its worker, is left as it is", async () => {
    const ended = await afterKill({ handed_back: true })
    expect(ended.rebasing).toBe(true)
    expect(ended.ran.log.some((text) => text.includes("left mid-rebase as the last run"))).toBe(
      false,
    )
    expect(ended.main.has("b.txt")).toBe(false)
    expect(ended.ran.log.some((text) => text.includes("OFF_BRANCH"))).toBe(true)
  })
})

describe("the hand-back on the mark", () => {
  const markIn = (value: Parameters<typeof handedBackOf>[0], id = "b") =>
    Effect.gen(function* () {
      const store = yield* Store
      if (value !== undefined) yield* store.setMetadata(id, uncheckedKey, value)
      yield* markHandedBack(id)
      const metadata = yield* store.metadata(id)
      return Object.hasOwn(metadata, uncheckedKey) ? metadata[uncheckedKey] : undefined
    })

  const marked = async (value: Parameters<typeof handedBackOf>[0]) => {
    const ran = await scenario({ backlog: backlog().ticket("b").seeds }, markIn(value))
    if (ran.exit._tag === "Failure") throw new Error(`the scenario failed: ${ran.exit.cause}`)
    return ran.exit.value
  }

  test("is noted on a mark, which keeps where the branch was", async () => {
    const mark = await marked({ fork: "abc1234", head: "def5678" })
    expect(handedBackOf(mark)).toBe(true)
    expect(uncheckedOf(mark)).toEqual({ fork: "abc1234", head: "def5678" })
  })

  test("leaves no mark where there was none", async () => {
    expect(await marked(undefined)).toBeUndefined()
  })

  test("is read only as true on a mark", () => {
    expect(handedBackOf(undefined)).toBe(false)
    expect(handedBackOf({ fork: "abc1234", head: "def5678" })).toBe(false)
    expect(handedBackOf({ handed_back: "yes" })).toBe(false)
    expect(handedBackOf([true])).toBe(false)
    expect(handedBackOf({ handed_back: true })).toBe(true)
  })

  test("is read as a boolean of any JSON a hand left there", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const read = handedBackOf(value as Parameters<typeof handedBackOf>[0])
        return typeof read === "boolean"
      }),
    )
  })
})
