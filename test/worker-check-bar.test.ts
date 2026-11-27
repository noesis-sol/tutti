// A worker's own check on its card (§ 7.2, tutti-r3az): a testing Bash call its hooks show begin
// and end (hooks.ts' testRunEvent, AgentHost's testRuns) is watched in Checking under ownCheckKey
// while it runs (src/run/ownCheck.ts), estimated from that command's last runs, or the merge check's
// passes where it is that check's, and counted from the SUITE: and PROGRESS: lines its command copies
// to the file the worker's TUTTI_PROGRESS_FILE names, as the runners tutti init writes do.

import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookInput } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { makeWorkers, type TestRun } from "../src/agent/AgentHost.ts"
import { TestRunEvent, testRunEvent } from "../src/agent/hooks.ts"
import { WorkerEvent, WorkerState } from "../src/agent/WorkerState.ts"
import { progressVariable, sharedEnv } from "../src/core/env.ts"
import { fastScript, fullScript, runnerCommands } from "../src/project/runners.ts"
import {
  type Checking,
  type CheckShown,
  makeChecking,
  ownCheckKey,
  showEvery,
} from "../src/run/checking.ts"
import { emptyTallies, type State } from "../src/run/ledger.ts"
import { followOwnChecks, ownKindOf } from "../src/run/ownCheck.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { progressFileOf, progressLogName } from "../src/services/Checks.ts"
import { runFolder } from "../src/services/Worktrees.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { advance } from "./harness.ts"

const t1 = "t-1" as TicketId

const checks = ["scripts/check-fast.sh", "scripts/check-full.sh", "scripts/check-own.sh"]

const settle = Effect.gen(function* () {
  for (let turns = 0; turns < 200; turns++) yield* Effect.yieldNow
})

/** A hook's input of `event` for the Bash call `call`, with `input` and the rest it may carry. */
const bash = (
  event: string,
  call: string,
  input: Record<string, unknown> = { command: "scripts/check-fast.sh" },
  more: Record<string, unknown> = {},
): HookInput =>
  ({
    hook_event_name: event,
    session_id: "s-1",
    transcript_path: "/t",
    cwd: "/w",
    tool_name: "Bash",
    tool_input: input,
    tool_use_id: call,
    ...more,
  }) as unknown as HookInput

describe("a test run as the hooks show it", () => {
  test("a testing Bash call in the foreground begins one, its command trimmed", () => {
    expect(
      testRunEvent(bash("PreToolUse", "c1", { command: " scripts/check-fast.sh " }), checks),
    ).toEqual(TestRunEvent.Began({ call: "c1", command: "scripts/check-fast.sh" }))
    expect(
      testRunEvent(bash("PreToolUse", "c2", { command: "bun test x.test.ts" }), checks),
    ).toEqual(TestRunEvent.Began({ call: "c2", command: "bun test x.test.ts" }))
  })

  test("nothing else begins one: another command, another tool, a run in the background", () => {
    expect(
      testRunEvent(bash("PreToolUse", "c1", { command: "git status" }), checks),
    ).toBeUndefined()
    const background = { command: "scripts/check-fast.sh", run_in_background: true }
    expect(testRunEvent(bash("PreToolUse", "c1", background), checks)).toBeUndefined()
    const read = { ...bash("PreToolUse", "c1"), tool_name: "Read" } as HookInput
    expect(testRunEvent(read, checks)).toBeUndefined()
    expect(testRunEvent(bash("PreToolUse", "c1", { command: 3 }), checks)).toBeUndefined()
  })

  test("its PostToolUse ends it passed, with the time the hook gives; a failure, not passed", () => {
    expect(
      testRunEvent(bash("PostToolUse", "c1", undefined, { duration_ms: 4200 }), checks),
    ).toEqual(TestRunEvent.Ended({ call: "c1", passed: true, ms: 4200 }))
    expect(
      testRunEvent(bash("PostToolUse", "c1", undefined, { duration_ms: "x" }), checks),
    ).toEqual(TestRunEvent.Ended({ call: "c1", passed: true }))
    expect(testRunEvent(bash("PostToolUseFailure", "c1"), checks)).toEqual(
      TestRunEvent.Ended({ call: "c1", passed: false }),
    )
    expect(testRunEvent(bash("PermissionDenied", "c1"), checks)).toEqual(
      TestRunEvent.Ended({ call: "c1", passed: false }),
    )
  })

  test("any input reads without throwing, and only a Bash call's PreToolUse begins a run", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied"),
        fc.constantFrom("Bash", "Read", "Agent"),
        fc.anything(),
        (event, tool, input) => {
          const run = testRunEvent(
            { ...bash(event, "c1"), tool_name: tool, tool_input: input } as HookInput,
            checks,
          )
          if (run?._tag === "Began") {
            expect([event, tool]).toEqual(["PreToolUse", "Bash"])
          }
        },
      ),
    )
  })

  test("a worker's command is the merge check's or the full check's where it runs it", () => {
    const commands = { fast: "scripts/check.sh", full: "TUTTI_SLOW=1 scripts/check.sh" }
    expect(ownKindOf("scripts/check.sh > .tutti/run/c.log 2>&1", commands)).toBe("fast")
    expect(ownKindOf("TUTTI_SLOW=1 scripts/check.sh", commands)).toBe("full")
    expect(ownKindOf("bun test x.test.ts", commands)).toBeNull()
    expect(ownKindOf("scripts/check.sh", { fast: null, full: null })).toBeNull()
  })
})

describe("the host's test runs", () => {
  const runs = (
    steps: (workers: Effect.Success<ReturnType<typeof makeWorkers>>) => Effect.Effect<void>,
    count: number,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* makeWorkers(Effect.succeed(checks))
          const seen = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(workers.testRuns, count)),
          )
          yield* settle
          yield* steps(workers)
          return [...(yield* Fiber.join(seen))]
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
        Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
      ),
    )

  const hook = (input: HookInput, session = "s-1") => WorkerEvent.Hook({ session, input })

  test("a testing call's start and end, with the worktree; another call's end is none of them", async () => {
    const seen = await runs(
      (workers) =>
        Effect.gen(function* () {
          const entry = yield* workers.open(t1, { session: "s-1", resumed: false, worktree: "/w" })
          yield* workers.fold(entry, hook(bash("PreToolUse", "c1")))
          // Its PreToolUse again begins nothing; a call that isn't testing ends nothing.
          yield* workers.fold(entry, hook(bash("PreToolUse", "c1")))
          yield* workers.fold(entry, hook(bash("PreToolUse", "c2", { command: "ls" })))
          yield* workers.fold(entry, hook(bash("PostToolUse", "c2")))
          yield* workers.fold(
            entry,
            hook(bash("PostToolUse", "c1", undefined, { duration_ms: 9000 })),
          )
        }),
      2,
    )
    expect(seen).toEqual([
      {
        ticket: t1,
        worktree: "/w",
        event: TestRunEvent.Began({ call: "c1", command: "scripts/check-fast.sh" }),
      },
      { ticket: t1, event: TestRunEvent.Ended({ call: "c1", passed: true, ms: 9000 }) },
    ])
  })

  test("a call still running ends, not passed, as its session closes or another begins", async () => {
    const seen = await runs(
      (workers) =>
        Effect.gen(function* () {
          const entry = yield* workers.open(t1, { session: "s-1", resumed: false })
          yield* workers.fold(entry, hook(bash("PreToolUse", "c1")))
          yield* workers.open(t1, { session: "s-2", resumed: true })
          yield* workers.fold(entry, hook(bash("PreToolUse", "c2"), "s-2"))
          yield* workers.fold(entry, WorkerEvent.Closed({ session: "s-2" }))
        }),
      4,
    )
    expect(seen.map((run) => run.event)).toEqual([
      TestRunEvent.Began({ call: "c1", command: "scripts/check-fast.sh" }),
      TestRunEvent.Ended({ call: "c1", passed: false }),
      TestRunEvent.Began({ call: "c2", command: "scripts/check-fast.sh" }),
      TestRunEvent.Ended({ call: "c2", passed: false }),
    ])
  })
})

/** A worktree of its own: reading or emptying its progress file makes its .tutti/run/. */
const worktree = (): string => realpathSync(mkdtempSync(join(tmpdir(), "worker-check-bar-")))

/**
 * Follows the test runs `body` offers in a Checking of `passes`, on TestClock, the merge check's
 * command scripts/check-fast.sh; what `body` returns.
 */
const following = <A>(
  body: (
    offer: (run: TestRun) => Effect.Effect<void>,
    checking: Checking["Service"],
  ) => Effect.Effect<A>,
  passes: Parameters<typeof makeChecking>[0] = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<TestRun>()
        const checking = makeChecking(passes)
        yield* Effect.forkScoped(
          followOwnChecks(
            Stream.fromQueue(queue),
            checking,
            Effect.succeed({ fast: "scripts/check-fast.sh", full: "scripts/check-full.sh" }),
          ),
        )
        const offer = (run: TestRun) => Effect.andThen(Queue.offer(queue, run), settle)
        return yield* body(offer, checking)
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )

const began = (call: string, command: string, where?: string): TestRun => ({
  ticket: t1,
  ...(where === undefined ? {} : { worktree: where }),
  event: TestRunEvent.Began({ call, command }),
})

const ended = (call: string, passed: boolean, ms?: number): TestRun => ({
  ticket: t1,
  event: TestRunEvent.Ended(ms === undefined ? { call, passed } : { call, passed, ms }),
})

/** The worker's own check as Checking has it now. */
const ownNow = (checking: Checking["Service"]) =>
  Effect.map(checking.now, (now) => now.get(ownCheckKey(t1)))

/** One read of the progress file, and the follower's turn after it. */
const aRead = Effect.andThen(advance(showEvery), settle)

describe("a worker's own check in Checking", () => {
  test("a command never timed shows no bar; timed twice, the third run has the estimate", async () => {
    const seen = await following((offer, checking) =>
      Effect.gen(function* () {
        const fills: Array<CheckShown["fill"] | undefined> = []
        yield* offer(began("c1", "bun test a.test.ts"))
        fills.push((yield* ownNow(checking))?.fill)
        yield* advance("10 seconds")
        // Its hook's time, where it gives one, counts over the clock's.
        yield* offer(ended("c1", true, 20_000))
        yield* offer(began("c2", "bun test a.test.ts"))
        yield* advance("20 seconds")
        yield* offer(ended("c2", true))
        // A run that didn't pass counts for nothing.
        yield* offer(began("c3", "bun test a.test.ts"))
        yield* advance("2 seconds")
        yield* offer(ended("c3", false))
        yield* offer(began("c4", "bun test a.test.ts"))
        yield* advance("10 seconds")
        fills.push((yield* ownNow(checking))?.fill)
        yield* offer(ended("c4", true))
        // The bar goes as the call ends.
        fills.push((yield* ownNow(checking))?.fill)
        return fills
      }),
    )
    expect(seen).toEqual([null, { filled: 0.5, count: "≈50%", estimate: true }, undefined])
  })

  test("the merge check's command has the merge check's passes from the first run", async () => {
    const shown = await following(
      (offer, checking) =>
        Effect.gen(function* () {
          yield* offer(began("c1", "scripts/check-fast.sh > .tutti/run/check.log 2>&1"))
          yield* advance("25 seconds")
          return yield* ownNow(checking)
        }),
      { fast: [100] },
    )
    expect(shown?.name).toBe("own check")
    expect(shown?.usual).toBe(100)
    expect(shown?.fill).toEqual({ filled: 0.25, count: "≈25%", estimate: true })
  })

  test("the PROGRESS: lines copied to the file move the count while the command runs", async () => {
    const where = worktree()
    const file = progressFileOf(where)
    const seen = await following((offer, checking) =>
      Effect.gen(function* () {
        const counts: Array<string | null | undefined> = []
        yield* offer(began("c1", "scripts/check-fast.sh", where))
        yield* aRead
        appendFileSync(file, "SUITE: test\nPROGRESS: 3/10\n")
        yield* aRead
        counts.push((yield* ownNow(checking))?.fill?.count)
        expect((yield* ownNow(checking))?.suite).toBe("test")
        // A line still being written waits for its newline.
        appendFileSync(file, "PROGRESS: 7/1")
        yield* aRead
        counts.push((yield* ownNow(checking))?.fill?.count)
        appendFileSync(file, "0\n")
        yield* aRead
        counts.push((yield* ownNow(checking))?.fill?.count)
        yield* offer(ended("c1", true))
        counts.push((yield* ownNow(checking))?.fill?.count)
        return counts
      }),
    )
    expect(seen).toEqual(["3/10", "3/10", "7/10", undefined])
  })

  test("what a killed command left in the file isn't read for the next one", async () => {
    const where = worktree()
    const file = progressFileOf(where)
    const seen = await following((offer, checking) =>
      Effect.gen(function* () {
        yield* offer(began("c1", "scripts/check-fast.sh", where))
        yield* aRead
        appendFileSync(file, "SUITE: old\nPROGRESS: 9/10\n")
        yield* aRead
        const before = yield* ownNow(checking)
        // Killed: its session ended it, not passed, and the file kept its lines.
        yield* offer(ended("c1", false))
        yield* offer(began("c2", "scripts/check-fast.sh", where))
        yield* aRead
        const after = yield* ownNow(checking)
        appendFileSync(file, "SUITE: new\nPROGRESS: 1/4\n")
        yield* aRead
        return [before, after, yield* ownNow(checking)] as const
      }),
    )
    expect(seen[0]?.suite).toBe("old")
    expect([seen[1]?.suite, seen[1]?.progress, seen[1]?.fill]).toEqual([null, null, null])
    expect([seen[2]?.suite, seen[2]?.fill?.count]).toEqual(["new", "1/4"])
    expect(readFileSync(file, "utf8")).toBe("SUITE: new\nPROGRESS: 1/4\n")
  })

  test("a command that copies nothing, or a session with no file, has the estimate alone", async () => {
    const where = worktree()
    const seen = await following(
      (offer, checking) =>
        Effect.gen(function* () {
          yield* offer(began("c1", "scripts/check-fast.sh", where))
          for (let i = 0; i < 40; i++) yield* aRead
          const copiedNothing = (yield* ownNow(checking))?.fill
          yield* offer(ended("c1", false))
          yield* offer(began("c2", "scripts/check-fast.sh"))
          yield* advance("10 seconds")
          return [copiedNothing, (yield* ownNow(checking))?.fill]
        }),
      { fast: [100] },
    )
    expect(seen).toEqual([
      { filled: 0.1, count: "≈10%", estimate: true },
      { filled: 0.1, count: "≈10%", estimate: true },
    ])
  })

  test("a run begun while another runs takes its place; the first one's end ends nothing", async () => {
    const seen = await following(
      (offer, checking) =>
        Effect.gen(function* () {
          yield* offer(began("c1", "scripts/check-fast.sh"))
          yield* advance("50 seconds")
          yield* offer(began("c2", "scripts/check-fast.sh"))
          yield* offer(ended("c1", true))
          return (yield* ownNow(checking))?.fill
        }),
      { fast: [100] },
    )
    expect(seen).toEqual({ filled: 0, count: "≈0%", estimate: true })
  })
})

describe("on the card", () => {
  const ledger: State = {
    tickets: new Map([
      [
        t1,
        {
          ticket: t1,
          title: "Title of t-1",
          phase: TicketPhase.Working(),
          since: 0,
          worker: 1,
          row: 0,
          rechecking: false,
          steered: false,
          lastMessage: null,
          tallies: emptyTallies,
        },
      ],
    ]),
    rows: 1,
    windDown: null,
    bugs: [],
  }

  const shown = (name: CheckShown["name"], count: string): CheckShown => ({
    name,
    began: 0,
    suite: null,
    progress: null,
    usual: 100,
    fill: { filled: 0.5, count, estimate: true },
  })

  test("its worker's own check, its merge check before it", () => {
    const cardOf = (checking: ReadonlyMap<string, CheckShown>) =>
      project({
        ledger,
        workers: new Map([[t1, WorkerState.Working({ doing: "testing" })]]),
        requests: [],
        status: { ...emptyStatus, concurrency: 1, checking },
      }).cards[0]?.check
    const own = shown("own check", "≈50%")
    const merge = shown("merge check", "3/6")
    expect(cardOf(new Map([[ownCheckKey(t1), own]]))).toEqual(own)
    expect(
      cardOf(
        new Map([
          [ownCheckKey(t1), own],
          [t1, merge],
        ]),
      ),
    ).toEqual(merge)
    expect(cardOf(new Map())).toBeUndefined()
  })
})

describe("the worker's environment and the runners", () => {
  test("a worker's session names its progress file in TUTTI_PROGRESS_FILE", () => {
    const share = { cores: 2, checkTimeout: Duration.minutes(30) }
    const file = progressFileOf("/w")
    expect(file).toBe(join("/w", runFolder, progressLogName))
    expect(sharedEnv({}, { ...share, progress: file })[progressVariable]).toBe(file)
    expect(sharedEnv({}, share)[progressVariable]).toBeUndefined()
  })

  /** Runs `script` with sh in `dir`, with `env` beside the tests'. */
  const sh = (dir: string, script: string, env: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["sh", join(dir, "scripts", script)], {
      cwd: dir,
      env: { ...testEnv, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  }

  const project = (): string => {
    const dir = worktree()
    const suites = [
      {
        name: "unit",
        command:
          "printf 'PROGRESS: 1/2\\nplain\\n'; echo PROGRESS: 9/9 >&2; printf '  PROGRESS: 2/2\\n'; exit 3",
        foundIn: "package.json:7",
        serial: false,
      },
    ]
    Bun.spawnSync(["mkdir", "-p", join(dir, "scripts")])
    writeFileSync(join(dir, "scripts", "check-fast.sh"), fastScript(suites), { mode: 0o755 })
    writeFileSync(join(dir, "scripts", "check-full.sh"), fullScript([], false), { mode: 0o755 })
    return dir
  }

  test("with the variable set, a runner copies its SUITE: and PROGRESS: lines on stdout there", () => {
    const dir = project()
    const file = join(dir, "progress.log")
    const plain = sh(dir, "check-full.sh")
    const copied = sh(dir, "check-full.sh", { [progressVariable]: file })
    // Its output and its status are the same.
    expect(copied).toEqual(plain)
    expect(plain.code).toBe(3)
    expect(plain.stdout).toBe(
      "SUITE: scripts/check-fast.sh\nSUITE: unit\nPROGRESS: 1/2\nplain\n  PROGRESS: 2/2\n",
    )
    // Once, though check-full.sh runs check-fast.sh.
    expect(readFileSync(file, "utf8")).toBe(
      "SUITE: scripts/check-fast.sh\nSUITE: unit\nPROGRESS: 1/2\n  PROGRESS: 2/2\n",
    )
  })

  test("the lines that copy them are none of the runner's commands", () => {
    expect(
      runnerCommands(
        fastScript([{ name: "unit", command: "bun test", foundIn: "x", serial: false }]),
      ),
    ).toEqual(["bun test"])
  })
})
