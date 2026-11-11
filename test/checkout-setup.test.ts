// The setup in the main checkout after a merge (§ 5 item 7): the merges fast-forward the base there,
// so after one whose commits change a file checks.setup.files names, the setup runs there too, its
// whole output in the main checkout's .tutti/run/setup.log, so that its dependencies match the base.
// A failure warns that they are behind (SETUP), the ticket merged all the same; so do uncommitted
// changes to tracked files the setup leaves, on which the next merge would stop, DIRTY_TREE.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, type Scope } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { runFolder, Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Script } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const setupCommand = "bun install --frozen-lockfile"

/** The settings with `command` as the setup, for `bun.lock` and `package.json`. */
const withSetup = (command: string | null = setupCommand) => {
  const settings = appConfig().settings
  return {
    settings: {
      ...settings,
      checks: { ...settings.checks, setup: { command, files: ["bun.lock", "package.json"] } },
    },
  }
}

/** A main checkout with its .tutti/run/, where the setup's output goes. */
const mainCheckout = (): string => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-checkout-setup-")))
  mkdirSync(join(repo, runFolder), { recursive: true })
  return repo
}

/** The setup failing, its output in the file it was given. */
const setupFails = (run: CheckRun) =>
  Effect.fail(
    new CheckFailed({
      check: "setup",
      command: run.command,
      exitCode: 1,
      outputFile: run.outputFile ?? "/dev/null",
      failingLines: ["error: lockfile had changes, but lockfile is frozen"],
      lastLines: ["error: lockfile had changes, but lockfile is frozen"],
      suites: [],
      suite: null,
      flaky: [],
      flakyCount: 0,
    }),
  )

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, Working. */
const finished = (id: TicketId, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
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

/** Another ticket's merge landing on main, changing `files`. */
const moveMain = (files: Files) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

/** Runs `body` with a merge queue on `repo` until the queue settles: each ticket's phase. */
const withQueue = (
  repo: string,
  body: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const queue = yield* makeQueue({ repo, base: "main" })
    yield* body(queue)
    yield* queue.settled
    const state: State = yield* (yield* Ledger).current
    return Object.fromEntries([...state.tickets.values()].map((e) => [e.ticket, e.phase]))
  }).pipe(Effect.provide(Ledger.layer))

const phasesOf = (ran: Ran<Readonly<Record<string, TicketPhase>>>) => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/**
 * `a` finishes with `own` committed, main moves on changing `landed` (nothing by default), and `a`
 * merges into the main checkout `repo` with the setup `config` sets and the checks `script` plays.
 */
const mergeA = (
  repo: string,
  own: Files,
  options: {
    readonly landed?: Files
    readonly config?: ReturnType<typeof withSetup>
    readonly checks?: Script
    readonly before?: (repository: Repository["Service"]) => void
  } = {},
) =>
  scenario(
    {
      backlog: backlog().ticket("a").seeds,
      config: { repo, ...(options.config ?? withSetup()) },
      git: { dir: repo },
      ...(options.checks === undefined ? {} : { checks: options.checks }),
    },
    withQueue(repo, (queue) =>
      Effect.gen(function* () {
        options.before?.(yield* Repository)
        const a = yield* finished("a" as TicketId, own)
        if (options.landed !== undefined) yield* moveMain(options.landed)
        yield* queue.offer(a)
      }),
    ),
  )

const merged = (phase: TicketPhase | undefined) =>
  phase?._tag === "Done" && phase.outcome._tag === "Merged"

describe("the setup in the main checkout after a merge", () => {
  test("runs there after the fast-forward when the merge's commits change a setup file", async () => {
    const repo = mainCheckout()
    const ran = await mergeA(repo, { "bun.lock": "v2\n", "a.ts": "a\n" })
    expect(merged(phasesOf(ran).a)).toBe(true)
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast", "setup"])
    const [check, setup] = ran.checkRuns
    expect(check?.cwd).toEqual(expect.stringMatching(/\/a$/))
    expect(setup?.cwd).toBe(repo)
    expect(setup?.before).toBe("fast")
    expect(setup?.command).toBe(setupCommand)
    expect(setup?.outputFile).toBe(`${repo}/.tutti/run/setup.log`)
    expect(setup?.outputFd).toEqual(expect.any(Number))
    // What it leaves running in the main checkout is left: people and tutti's own git run there.
    expect(setup?.leaveStrays).toBe(true)
    expect(check?.leaveStrays).toBeUndefined()
    expect(existsSync(`${repo}/.tutti/run/setup.log`)).toBe(true)
    expectLog(ran, [
      /^ {2}a closed \(.*\); merged into main, worktree and branch removed$/,
      `  a: bun.lock changed in its merge; running '${setupCommand}' in the main checkout ${repo}, so that its dependencies match main`,
    ])
    const records = ran.events.filter((event) => event.kind === "check" && event.suite === "setup")
    expect(records).toEqual([
      expect.objectContaining({ kind: "check", suite: "setup", ticket: "a", result: "passed" }),
    ])
  })

  test("doesn't run when the merge's commits change no setup file", async () => {
    const repo = mainCheckout()
    const ran = await mergeA(repo, { "a.ts": "a\n", "docs/bun.lock.md": "x\n" })
    expect(merged(phasesOf(ran).a)).toBe(true)
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast"])
    expect(ran.log.some((line) => line.includes("in the main checkout"))).toBe(false)
  })

  test("doesn't run without a setup command", async () => {
    const repo = mainCheckout()
    const ran = await mergeA(repo, { "bun.lock": "v2\n" }, { config: withSetup(null) })
    expect(merged(phasesOf(ran).a)).toBe(true)
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast"])
  })

  test("goes by the merge's own commits, not by what the rebase brought in", async () => {
    const repo = mainCheckout()
    // The rebase brings in bun.lock: the setup runs in the worktree before the check, and the
    // merge's own commits change no setup file, so none runs in the main checkout.
    const rebased = await mergeA(repo, { "a.ts": "a\n" }, { landed: { "bun.lock": "v2\n" } })
    expect(merged(phasesOf(rebased).a)).toBe(true)
    expect(rebased.checkRuns.map((run) => [run.check, run.cwd === repo])).toEqual([
      ["setup", false],
      ["fast", false],
    ])
    // Both change one: a setup in the worktree before the check, and one in the main checkout after.
    const other = mainCheckout()
    const both = await mergeA(
      other,
      { "bun.lock": "a's\n" },
      { landed: { "package.json": "v2\n" } },
    )
    expect(merged(phasesOf(both).a)).toBe(true)
    expect(both.checkRuns.map((run) => [run.check, run.cwd === other])).toEqual([
      ["setup", false],
      ["fast", false],
      ["setup", true],
    ])
    expectLog(both, [
      `  a: package.json changed in the rebase; running '${setupCommand}' before the check`,
      `  a: bun.lock changed in its merge; running '${setupCommand}' in the main checkout ${other}, so that its dependencies match main`,
    ])
  })

  test("a failure warns that the main checkout's dependencies are behind; the ticket is merged", async () => {
    const repo = mainCheckout()
    const ran = await mergeA(repo, { "bun.lock": "v2\n" }, { checks: { setup: [setupFails] } })
    expect(merged(phasesOf(ran).a)).toBe(true)
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast", "setup"])
    const kept = `${repo}/.tutti/run/workers/a/checks/setup-1.log`
    expect(existsSync(kept)).toBe(true)
    expectLog(ran, [
      `  SETUP: '${setupCommand}' fails in the main checkout ${repo} after a's merge, so its dependencies are behind main; the whole output is in ${kept}. Run it there by hand`,
    ])
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "check", suite: "setup", ticket: "a", result: "failed" }),
    )
    expect(ran.events).toContainEqual(
      expect.objectContaining({
        kind: "warn",
        ticket: "a",
        text: expect.stringMatching(/^ {2}SETUP: /),
      }),
    )
  })

  test("uncommitted changes it leaves to tracked files are warned of: the next merge stops on them", async () => {
    const repo = mainCheckout()
    let repository: Repository["Service"] | undefined
    const rewritesLockfile = (run: CheckRun) =>
      Effect.andThen(
        Effect.suspend(() =>
          repository === undefined
            ? Effect.void
            : repository.write(run.cwd, { "bun.lock": "rewritten\n" }),
        ),
        Effect.succeed(passed("setup")),
      )
    const ran = await mergeA(
      repo,
      { "bun.lock": "v2\n" },
      {
        checks: { setup: [rewritesLockfile] },
        before: (found) => {
          repository = found
        },
      },
    )
    expect(merged(phasesOf(ran).a)).toBe(true)
    expectLog(ran, [
      `  SETUP: '${setupCommand}' left uncommitted changes to bun.lock in the main checkout ${repo} after a's merge; the next merge stops on them, DIRTY_TREE, until they are committed or undone`,
    ])
  })
})
