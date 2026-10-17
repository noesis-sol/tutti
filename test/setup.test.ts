import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Duration, Effect, Exit, type Scope, Stream } from "effect"
import fc from "fast-check"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project } from "../src/run/runView.ts"
import { fileList, setupFilesIn } from "../src/run/setup.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed, CheckTimedOut } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Script } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

const setupCommand = "bun install --frozen-lockfile"

/** The settings with `command` as the setup, for `bun.lock` and `package.json` by default. */
const withSetup = (
  command: string | null = setupCommand,
  files: ReadonlyArray<string> = ["bun.lock", "package.json"],
) => {
  const settings = appConfig().settings
  return {
    settings: { ...settings, checks: { ...settings.checks, setup: { command, files } } },
  }
}

const saidNothing = {
  lastLines: ["error: could not resolve left-pad"],
  failingLines: ["error: could not resolve left-pad"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
}

const setupFailed = new CheckFailed({
  check: "setup",
  command: setupCommand,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  ...saidNothing,
})

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

/** Another ticket's merge landing on main, changing `files`. */
const moveMain = (files: Files) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

const phaseOf = (state: State, id: string) => state.tickets.get(id)?.phase

/** What a setup scenario hands back: each ticket's phase, and every state the ledger had. */
interface SetUpRun {
  readonly phases: Readonly<Record<string, TicketPhase>>
  readonly states: ReadonlyArray<State>
}

/** Runs `body` with a merge queue, noting each state the ledger has, until the queue settles. */
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
    yield* queue.settled
    const state = yield* ledger.current
    return {
      phases: Object.fromEntries([...state.tickets.values()].map((e) => [e.ticket, e.phase])),
      states,
    } satisfies SetUpRun
  }).pipe(Effect.provide(Ledger.layer))

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Waits until the ticket's phase is `tag`. */
const until = (id: string, tag: TicketPhase["_tag"]) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) => phaseOf(state, id)?._tag === tag),
      Stream.runHead,
    )
  })

/**
 * `a` finishes with `own` committed, main moves on changing `landed`, and `a` merges with the
 * setup `config` sets and the checks `script` plays.
 */
const mergeA = (
  own: Files,
  landed: Files,
  setup: { readonly config?: ReturnType<typeof withSetup>; readonly checks?: Script } = {},
) =>
  scenario(
    {
      backlog: backlog().ticket("a").seeds,
      config: setup.config ?? withSetup(),
      ...(setup.checks === undefined ? {} : { checks: setup.checks }),
    },
    withQueue((queue) =>
      Effect.gen(function* () {
        const a = yield* finished("a", own)
        yield* moveMain(landed)
        yield* queue.offer(a)
      }),
    ),
  )

describe("the setup before the merge check", () => {
  test("runs in the worktree when the rebase changed a setup file, and the log says so", async () => {
    const ran = await mergeA({ "a.ts": "a\n" }, { "bun.lock": "v2\n" })
    const { phases, states } = resultOf(ran)
    expect(phases.a?._tag).toBe("Done")
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["setup", "fast"])
    const [setup, check] = ran.checkRuns
    expect(setup?.before).toBe("fast")
    expect(setup?.cwd).toBe(check?.cwd as string)
    expect(setup?.cwd).toEqual(expect.stringMatching(/\/a$/))
    expect(setup?.outputFile).toMatch(/^\/dev\/fd\/\d+$/)
    expectLog(ran, [
      "  rebased tutti/a onto main, which moved on while it ran",
      `  a: bun.lock changed in the rebase; running '${setupCommand}' before the check`,
      /^ {2}a closed \(.*\); merged into main, worktree and branch removed$/,
    ])
    // Merging{setup} while it runs, between the rebase and the check.
    const steps = states
      .map((state) => phaseOf(state, "a"))
      .flatMap((phase) => (phase?._tag === "Merging" ? [phase.step] : []))
    expect([...new Set(steps)]).toEqual(["rebase", "setup", "check", "fast-forward"])
  })

  test("its step shows on the card as the setup running", async () => {
    const ran = await mergeA({ "a.ts": "a\n" }, { "bun.lock": "v2\n" })
    const during = resultOf(ran).states.find((state) => {
      const phase = phaseOf(state, "a")
      return phase?._tag === "Merging" && phase.step === "setup"
    })
    expect(during).toBeDefined()
    const view = project({
      ledger: during as State,
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, branch: "main" },
    })
    const card = view.cards.find((each) => each.ticket === "a")
    expect(card?.action).toBe("running the setup")
    expect(card?.motion).toBe("◆")
  })

  test("doesn't run when the rebase changed no setup file", async () => {
    const ran = await mergeA({ "a.ts": "a\n" }, { "src/lock.ts": "x\n", "docs/bun.lock.md": "x\n" })
    expect(resultOf(ran).phases.a?._tag).toBe("Done")
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast"])
    expect(ran.log.some((line) => line.includes("before the check"))).toBe(false)
    const steps = resultOf(ran).states.map((state) => phaseOf(state, "a"))
    expect(steps.some((phase) => phase?._tag === "Merging" && phase.step === "setup")).toBe(false)
  })

  test("doesn't run for a setup file only the ticket's own commits change", async () => {
    const ran = await mergeA({ "bun.lock": "a's\n" }, { "main.txt": "moved\n" })
    expect(resultOf(ran).phases.a?._tag).toBe("Done")
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast"])
  })

  test("doesn't run without a setup command", async () => {
    const ran = await mergeA({ "a.ts": "a\n" }, { "bun.lock": "v2\n" }, { config: withSetup(null) })
    expect(resultOf(ran).phases.a?._tag).toBe("Done")
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["fast"])
  })

  test("doesn't run for a ticket on top of the base: nothing was rebased", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, config: withSetup() },
      withQueue((queue) =>
        Effect.gen(function* () {
          yield* queue.offer(yield* finished("a", { "bun.lock": "a's\n" }))
        }),
      ),
    )
    expect(resultOf(ran).phases.a?._tag).toBe("Done")
    expect(ran.checkRuns).toEqual([])
  })

  test("names at most five of the files that changed, then how many more", async () => {
    const landed = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f", "g"].map((name) => [`${name}/package.json`, "{}\n"]),
    )
    const ran = await mergeA({ "a.ts": "a\n" }, landed)
    expectLog(ran, [
      `  a: a/package.json, b/package.json, c/package.json, d/package.json, e/package.json and 2 more changed in the rebase; running '${setupCommand}' before the check`,
    ])
  })

  test("runs anyway when git can't say what the rebase changed", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, config: withSetup() },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.ts": "a\n" })
          yield* moveMain({ "main.txt": "moved\n" })
          yield* (yield* Repository).fail("diff --name-only")
          yield* queue.offer(a)
        }),
      ),
    )
    expect(resultOf(ran).phases.a?._tag).toBe("Done")
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["setup", "fast"])
    expectLog(ran, [
      `  a: git could not say what the rebase changed; running '${setupCommand}' before the check`,
    ])
  })
})

describe("a setup that fails", () => {
  test("sets the ticket aside as a failing check does, the check not run", async () => {
    const ran = await mergeA(
      { "a.ts": "a\n" },
      { "bun.lock": "v2\n" },
      { checks: { setup: [setupFailed] } },
    )
    const a = resultOf(ran).phases.a
    expect(a).toEqual(expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }))
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["setup"])
    const worktree = ran.checkRuns[0]?.cwd as string
    const output = join(worktree, ".tutti/run/setup.log")
    expectLog(ran, [
      `  a: bun.lock changed in the rebase; running '${setupCommand}' before the check`,
      `  CHECKS_FAILED: a closed, but the setup '${setupCommand}', run before the check, fails on tutti/a rebased onto main; worktree ${worktree} left for review (output is in ${output}); checked once more if main moves on in this run`,
      "    error: could not resolve left-pad",
    ])
    expect(ran.events.find((record) => record.kind === "warn")).toMatchObject({
      ticket: "a",
      aside: true,
      detail: "setup failed",
    })
    expect(existsSync(output)).toBe(true)
  })

  test("past its time limit, says so", async () => {
    const timedOut = new CheckTimedOut({
      check: "setup",
      command: setupCommand,
      timeLimit: Duration.minutes(30),
      outputFile: "/dev/fd/9",
      ...saidNothing,
    })
    const ran = await mergeA(
      { "a.ts": "a\n" },
      { "bun.lock": "v2\n" },
      { checks: { setup: [timedOut] } },
    )
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, but the setup 'bun install --frozen-lockfile', run before the check, did not finish within 30m on tutti\/a rebased onto main; /,
    ])
    expect(ran.events.find((record) => record.kind === "warn")).toMatchObject({
      detail: "setup timed out",
    })
  })

  test("is run again on the recheck, though the base since brought no setup file", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        config: withSetup(),
        checks: { setup: [setupFailed] },
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.ts": "a\n" })
          yield* moveMain({ "bun.lock": "v2\n" })
          yield* queue.offer(a)
          yield* until("a", "Review")
          yield* queue.offer(yield* finished("b", { "b.ts": "b\n" }))
          yield* until("a", "Done")
        }),
      ),
    )
    expect(resultOf(ran).phases.a?._tag).toBe("Done")
    // a's setup failed; b merged unchecked on top of main; a's setup ran again, then its check.
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["setup", "setup", "fast"])
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, but the setup .*; checked once more if main moves on in this run$/,
      /^ {2}RECHECK: a's check failed/,
      `  a: bun.lock changed in the rebase; running '${setupCommand}' before the check`,
      /^ {2}a closed/,
    ])
  })

  test("is checked once more though its output names a file the ticket's commits change", async () => {
    const naming = new CheckFailed({
      check: "setup",
      command: setupCommand,
      exitCode: 1,
      outputFile: "/dev/fd/9",
      ...saidNothing,
      failingLines: ["a.ts:1:1: cannot resolve left-pad"],
    })
    const ran = await mergeA(
      { "a.ts": "a\n" },
      { "bun.lock": "v2\n" },
      { checks: { setup: [naming] } },
    )
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, but the setup .*; checked once more if main moves on in this run$/,
    ])
  })

  test("one that passed isn't run again on the recheck when no setup file changed since", async () => {
    const checkFailed = new CheckFailed({
      check: "fast",
      command: "scripts/check-fast.sh",
      exitCode: 1,
      outputFile: "/dev/fd/9",
      ...saidNothing,
      failingLines: ["shared/b.go:12: expected 1"],
    })
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        config: withSetup(),
        checks: { fast: [checkFailed] },
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.ts": "a\n" })
          yield* moveMain({ "bun.lock": "v2\n" })
          yield* queue.offer(a)
          yield* until("a", "Review")
          yield* queue.offer(yield* finished("b", { "b.ts": "b\n" }))
          yield* until("a", "Done")
        }),
      ),
    )
    expect(resultOf(ran).phases.a?._tag).toBe("Done")
    expect(ran.checkRuns.map((run) => run.check)).toEqual(["setup", "fast", "fast"])
  })
})

describe("setupFilesIn", () => {
  test("a glob without a slash matches a file's name, in any folder", () => {
    expect(
      setupFilesIn(
        ["bun.lock", "web/bun.lock", "requirements-dev.txt", "py/requirements.txt", "src/a.ts"],
        ["bun.lock", "requirements*.txt"],
      ),
    ).toEqual(["bun.lock", "web/bun.lock", "requirements-dev.txt", "py/requirements.txt"])
  })

  test("a glob with a slash matches the path from the top, a leading slash aside", () => {
    const files = ["web/package.json", "package.json", "web/sub/package.json"]
    expect(setupFilesIn(files, ["web/package.json"])).toEqual(["web/package.json"])
    expect(setupFilesIn(files, ["/package.json"])).toEqual(["package.json"])
    expect(setupFilesIn(files, ["web/*/package.json"])).toEqual(["web/sub/package.json"])
    expect(setupFilesIn(files, ["**/package.json"])).toEqual(files)
  })

  test("no globs match nothing; a malformed one matches nothing", () => {
    expect(setupFilesIn(["bun.lock"], [])).toEqual([])
    expect(setupFilesIn(["[bun.lock"], ["[bun.lock"])).toEqual([])
  })

  const name = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/)
  const path = fc.array(name, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"))

  test("matches only files it was given, in their order (property)", () => {
    fc.assert(
      fc.property(fc.array(path), fc.array(fc.string()), (files, globs) => {
        const hit = setupFilesIn(files, globs)
        expect(hit.every((file) => files.includes(file))).toBe(true)
        expect(hit).toEqual(files.filter((file) => hit.includes(file)))
      }),
    )
  })

  test("a file's own name, as a glob, matches it wherever it is (property)", () => {
    fc.assert(
      fc.property(path, (file) => {
        const own = file.split("/").at(-1) as string
        expect(setupFilesIn([file], [own])).toEqual([file])
        expect(setupFilesIn([file], [file])).toEqual([file])
      }),
    )
  })
})

describe("fileList", () => {
  test("names up to five files, then how many more", () => {
    expect(fileList(["a", "b"])).toBe("a, b")
    expect(fileList(["1", "2", "3", "4", "5"])).toBe("1, 2, 3, 4, 5")
    expect(fileList(["1", "2", "3", "4", "5", "6"])).toBe("1, 2, 3, 4, 5 and 1 more")
  })
})
