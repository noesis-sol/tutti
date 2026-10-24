// What a hand-back makes of untracked files its worker left in the worktree: the check runs there
// and sees them, but the merge brings in only the branch, so a fix or resolution that needs a file
// its worker never git-added is rejected rather than checked and merged without it. Files under
// .tutti/run/, tutti's own, don't count.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { type CheckStop, verifyFixed } from "../src/run/checkback.ts"
import { type RebaseStop, verifyResolved } from "../src/run/handback.ts"
import { Ledger } from "../src/run/ledger.ts"
import { type FinishedTicket, someFiles } from "../src/run/merge.ts"
import { Move } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

const failing = () =>
  new CheckFailed({
    check: "fast",
    command: "scripts/check-fast.sh",
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: ["error: a.test.ts: expected 1"],
    lastLines: ["1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Where a's branch was before its worker's commit, and where main is. */
interface Points {
  readonly first: string
  readonly main: string
}

/**
 * Finishes a with a commit on its branch, then its worker's commit of src/a.ts, with `left` written
 * into its worktree and never added, and runs `body` on it.
 */
const leaves = <A>(
  left: Files,
  body: (a: FinishedTicket, points: Points) => Effect.Effect<A, unknown, Env | Ledger>,
) =>
  scenario(
    { backlog: backlog().ticket("a").seeds },
    Effect.gen(function* () {
      const repository = yield* Repository
      const worktree = yield* (yield* Worktrees).prepare("a")
      yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
        branch: worktree.branch,
        base: "main",
      })
      yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
      yield* (yield* Beads).close("a", "done")
      const ledger = yield* Ledger
      yield* ledger.transition("a", Move.Ready(), { title: "Ticket a" })
      yield* ledger.transition("a", Move.Dispatched())
      const first = yield* repository.head(worktree.branch)
      yield* repository.commit(worktree.path, "Fix the check (a)", {
        "src/a.ts": 'import { util } from "./util.ts"\n',
      })
      yield* repository.write(worktree.path, left)
      const a = {
        id: "a",
        title: "Ticket a",
        branch: worktree.branch,
        worktree: worktree.path,
      } satisfies FinishedTicket
      return yield* body(a, { first, main: yield* repository.head("main") })
    }).pipe(Effect.provide(Ledger.layer)),
  )

const checkStop = (ticket: FinishedTicket, at: string): CheckStop => ({
  ticket,
  onto: "",
  fork: "",
  head: at,
  at,
  error: failing(),
  output: "/dev/fd/9",
})

const rebaseStop = (ticket: FinishedTicket, onto: string): RebaseStop => ({
  ticket,
  onto,
  fork: onto,
  head: onto,
  own: 2,
  files: ["a.txt"],
})

describe("a fix whose worker left a file untracked", () => {
  test("is rejected, naming the file, though the check would pass on it", async () => {
    const ran = await leaves({ "src/util.ts": "export const util = 1\n" }, (a, { first }) =>
      verifyFixed(checkStop(a, first), options),
    )
    expect(resultOf(ran)).toEqual({
      _tag: "Rejected",
      why: expect.stringMatching(/^its worker left untracked files in \S+: src\/util\.ts$/),
    })
  })

  test("with nothing untracked but under .tutti/run/, is the fix", async () => {
    const ran = await leaves({ ".tutti/run/worker-check.log": "ok\n" }, (a, { first }) =>
      verifyFixed(checkStop(a, first), options),
    )
    expect(resultOf(ran)).toEqual({ _tag: "Fixed", commits: "1 commit" })
  })
})

describe("a resolution whose worker left a file untracked", () => {
  test("is rejected, naming the file", async () => {
    const ran = await leaves({ "src/util.ts": "export const util = 1\n" }, (a, { main }) =>
      verifyResolved(rebaseStop(a, main), options),
    )
    expect(resultOf(ran)).toMatch(/^its worker left untracked files in \S+: src\/util\.ts$/)
  })

  test("with nothing untracked but under .tutti/run/, passes", async () => {
    const ran = await leaves({ ".tutti/run/worker-check.log": "ok\n" }, (a, { main }) =>
      verifyResolved(rebaseStop(a, main), options),
    )
    expect(resultOf(ran)).toBeUndefined()
  })
})

describe("someFiles", () => {
  test("names five files, then how many more", () => {
    expect(someFiles(["a"])).toBe("a")
    expect(someFiles(["a", "b", "c", "d", "e"])).toBe("a, b, c, d, e")
    expect(someFiles(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e and 2 more")
  })
})
