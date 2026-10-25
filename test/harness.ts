// Whole-run scenarios (§ 13), as orchestra's newTimedHarness: every test layer, under TestClock.
// `scenario` builds the environment from `Setup`, runs the scenario's Effect in a scope of its own
// (the run's scope), closes it, and reads back what the run left: the log lines, the event records,
// what the workers were sent, the checks run, the backlog. Leaks fail the scenario, as goleak does
// in orchestra: once the run's scope has closed, every FiberSet the run registered must be empty
// and every process group exec started must be gone. A leak is cleaned up (its fibers interrupted,
// its process groups killed) before the scenario fails, so it can't hold up the tests after it.
//
// Spinners and animations take their clock from Effect's Clock, which TestClock provides: a
// scenario's frames move only as `advance` moves the clock.
import { expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Account, AccountProbeFailed, Billing, Initialization } from "../src/agent/Account.ts"
import type { AgentHost } from "../src/agent/AgentHost.ts"
import type { Attention, Policy } from "../src/agent/Attention.ts"
import { AttentionPoll } from "../src/agent/attentionFiles.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import type { UsageLimits } from "../src/agent/UsageLimits.ts"
import type { UsageProbe } from "../src/agent/UsageProbe.ts"
import type { AppConfig, AppConfigValue } from "../src/cli/AppConfig.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { layer as fibersLayer, type Left, RunFibers } from "../src/run/fibers.ts"
import type { Log } from "../src/run/log.ts"
import { notifying } from "../src/run/notices.ts"
import type { PhaseTag, TicketPhase } from "../src/run/phase.ts"
import type { Spending } from "../src/run/spending.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import type { Checks } from "../src/services/Checks.ts"
import { ProcessGroups } from "../src/services/exec.ts"
import type { Git, GitWriter } from "../src/services/Git.ts"
import type { Notifier } from "../src/services/Notifier.ts"
import type { RunLock } from "../src/services/RunLock.ts"
import type { State, Store } from "../src/services/Store.ts"
import type { Tty, TtyValue } from "../src/services/Tty.ts"
import type { Worktrees } from "../src/services/Worktrees.ts"
import { layer as accountLayer, accountProbe, initialization } from "../src/testing/Account.ts"
import {
  checkCommand,
  layer as hostLayer,
  Recording,
  type Script,
  type Sent,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { allowAll, layer as attentionLayer } from "../src/testing/Attention.ts"
import { Backlog, layer as backlogLayer, type Seed } from "../src/testing/Beads.ts"
import {
  type CheckRun,
  type Script as ChecksScript,
  layer as checksLayer,
} from "../src/testing/Checks.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { type Seed as GitSeed, layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { Captured as Notices, layer as notifierLayer } from "../src/testing/Notifier.ts"
import { type Held, layer as lockLayer } from "../src/testing/RunLock.ts"
import { layer as spendingLayer } from "../src/testing/Spending.ts"
import { layer as storeLayer } from "../src/testing/Store.ts"
import { type Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { layer as ttyLayer } from "../src/testing/Tty.ts"
import { type Reported, layer as usageLayer } from "../src/testing/UsageLimits.ts"
import { type Probed, type Scripted, layer as usageProbeLayer } from "../src/testing/UsageProbe.ts"
import {
  type WorktreeCall,
  type Options as WorktreesOptions,
  layer as worktreesLayer,
} from "../src/testing/Worktrees.ts"

/** Everything a scenario's Effect can use. */
export type Env =
  | AppConfig
  | Account
  | Beads
  | Backlog
  | Git
  | GitWriter
  | Repository
  | AgentHost
  | Recording
  | Attention
  | Transcripts
  | Files
  | Checks
  | Store
  | Log
  | EventStream
  | Captured
  | Worktrees
  | RunLock
  | Tty
  | Notifier
  | Notices
  | UsageLimits
  | Reported
  | UsageProbe
  | Probed
  | OrganCost
  | Spending
  | RunFibers
  | TestClock.TestClock
  | BunServices.BunServices

/** Each ticket's worker sessions. */
export type Scripts = Readonly<Record<string, Script>>

/** What a worker's commands change: the in-memory Beads and Git. */
export interface World {
  readonly beads: Beads["Service"]
  readonly backlog: Backlog["Service"]
  readonly repository: Repository["Service"]
}

/** How a scenario's environment starts; what it leaves out takes the test layers' defaults. */
export interface Setup {
  /** Laid over the configuration a run with no flags, variables or config files resolves. */
  readonly config?: Partial<AppConfigValue>
  /** What the probe session says of itself, or how it fails to start. */
  readonly account?: Initialization | AccountProbeFailed
  /** The backlog's issues: `backlog()`'s builder makes them. */
  readonly backlog?: ReadonlyArray<Seed>
  /**
   * Each ticket's worker sessions, in the order they start or resume; given as a function, the
   * scripts can change the in-memory Beads and Git as the worker's commands would.
   */
  readonly scripts?: Scripts | ((world: World) => Scripts)
  /** The process each ticket's Claude Code has while its session is open: none by default. */
  readonly processes?: ReadonlyMap<TicketId, number>
  /** How long a closed session's Claude Code takes to exit: no time by default. */
  readonly closeTakes?: Duration.Input
  /** How Attention answers requests as they open; it allows everything by default. */
  readonly policy?: Policy
  readonly checks?: ChecksScript
  readonly git?: GitSeed
  /** state.json as an earlier run left it. */
  readonly state?: State
  /** Locks other processes hold. */
  readonly locks?: ReadonlyArray<Held>
  readonly worktrees?: WorktreesOptions
  /** The terminal: `tty()`'s builder makes one; an 80×24 256-colour TTY by default. */
  readonly tty?: TtyValue
  /** What the usage-limit hold's probes are answered, in order; Allowed once they run out. */
  readonly usageProbe?: ReadonlyArray<Scripted>
}

/** What a run gives back: its exit code and each ticket's phase at the end. */
export interface Outcome {
  readonly exitCode: number
  readonly phases: Readonly<Record<string, TicketPhase>>
}

/** What was left once the run's scope had closed. */
export interface Leaks {
  /** The registered FiberSets still holding fibers. */
  readonly fibers: ReadonlyArray<Left>
  /** The process groups exec started and never saw killed, by their leader's PID. */
  readonly processes: ReadonlyArray<number>
}

/** What a scenario left behind, for its assertions. */
export interface Ran<A> {
  /** How the scenario's Effect ended. */
  readonly exit: Exit.Exit<A, unknown>
  /** The log's lines, without their time. */
  readonly log: ReadonlyArray<string>
  readonly events: ReadonlyArray<EventRecord>
  /** What the workers were sent, in order. */
  readonly sent: ReadonlyArray<Sent>
  readonly checkRuns: ReadonlyArray<CheckRun>
  readonly worktreeCalls: ReadonlyArray<WorktreeCall>
  /** The backlog at the end, closed issues included. */
  readonly issues: ReadonlyArray<Issue>
  /** The comments bd human respond left, by issue, for those it left any on. */
  readonly comments: Readonly<Record<string, ReadonlyArray<string>>>
  /** The notifications shown, sanitised, in order. */
  readonly notices: ReadonlyArray<string>
  readonly leaks: Leaks
}

/** The scenario left a fiber or a process behind it. */
export class Leaked extends Error {
  constructor(readonly leaks: Leaks) {
    const fibers = leaks.fibers.map((set) => `${set.fibers} fiber(s) in the FiberSet ${set.name}`)
    const processes = leaks.processes.map((pid) => `the process group ${pid}`)
    super(`the run's scope closed and left ${[...fibers, ...processes].join(", ")}`)
    this.name = "Leaked"
  }
}

/** How the account probe finds workers billed from `found` under `config`; none where it fails. */
const billingOf = (
  config: AppConfigValue,
  found: Initialization | AccountProbeFailed,
): Billing | undefined => {
  if ("_tag" in found) return undefined
  try {
    return accountProbe(config, found).billing
  } catch {
    return undefined
  }
}

/** Every test layer, set up as `setup` says, under TestClock. */
export const environment = (
  setup: Setup = {},
  checkRuns: Array<CheckRun> = [],
  worktreeCalls: Array<WorktreeCall> = [],
): Layer.Layer<Env> => {
  const config = appConfig(setup.config)
  // A worker's tool calls running a check command are `testing`.
  const checks = [
    config.settings.checks.fast.command,
    config.settings.checks.full.command,
    checkCommand,
  ].flatMap((command) => (command === null ? [] : [command]))
  const scripts = setup.scripts ?? {}
  // Its sessions' starts are checked against the run's permission mode and the billing the account
  // probe finds, where it finds one.
  const billing = billingOf(config, setup.account ?? initialization())
  const hostOptions = {
    checks,
    permissionMode: config.settings.workers.permission_mode,
    ...(billing === undefined ? {} : { billing }),
    ...(setup.processes === undefined ? {} : { processes: setup.processes }),
    ...(setup.closeTakes === undefined ? {} : { closeTakes: setup.closeTakes }),
  }
  const host =
    typeof scripts === "function"
      ? Layer.unwrap(
          Effect.gen(function* () {
            const world = {
              beads: yield* Beads,
              backlog: yield* Backlog,
              repository: yield* Repository,
            }
            return hostLayer(scripts(world), hostOptions)
          }),
        )
      : hostLayer(scripts, hostOptions)
  return host.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        // --auto-answer's, as main.ts gives the live layer it.
        attentionLayer(
          setup.policy ?? allowAll,
          config.autoAnswer === null ? undefined : { after: config.autoAnswer },
        ),
        transcriptsLayer(),
        usageLayer,
        usageProbeLayer(setup.usageProbe),
        spendingLayer(),
      ),
    ),
    // One OrganCost, as the run's (main.ts): the probe's costs and those of the organs a scenario
    // adds (testing/Organs.ts) add up in it.
    Layer.provideMerge(OrganCost.layer),
    Layer.provideMerge(notifying),
    Layer.provideMerge(notifierLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        configLayer(config),
        accountLayer(setup.account).pipe(Layer.provide(configLayer(config))),
        backlogLayer(setup.backlog),
        gitLayer(setup.git),
        checksLayer(setup.checks, checkRuns).pipe(Layer.provide(configLayer(config))),
        storeLayer(setup.state),
        logLayer(),
        eventsLayer(),
        worktreesLayer(setup.worktrees, worktreeCalls),
        lockLayer(setup.locks),
        ttyLayer(setup.tty),
        fibersLayer,
        BunServices.layer,
      ),
    ),
    // The attention folder's poll never wakes: an hour's advance would wake its 2 seconds 1800
    // times, each a few scheduler turns and a readdir. fs.watch's events still wake the scan.
    Layer.provideMerge(Layer.succeed(AttentionPoll, Duration.infinity)),
    Layer.provideMerge(TestClock.layer()),
  )
}

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // It has gone already.
  }
}

/** The comments bd human respond left in the backlog, by issue. */
const commentsOf = Effect.gen(function* () {
  const backlog = yield* Backlog
  const all: Record<string, ReadonlyArray<string>> = {}
  for (const issue of yield* backlog.issues) {
    const comments = yield* backlog.comments(issue.id)
    if (comments.length > 0) all[issue.id] = comments
  }
  return all
})

/**
 * Runs `run` as a whole run in the environment `setup` describes, closes its scope, and gives back
 * what it left. Rejects with Leaked when a FiberSet still holds fibers or a process group is left.
 */
export const scenario = async <A, E>(
  setup: Setup,
  run: Effect.Effect<A, E, Env | Scope.Scope>,
): Promise<Ran<A>> => {
  const checkRuns: Array<CheckRun> = []
  const worktreeCalls: Array<WorktreeCall> = []
  const groups = new Set<number>()
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const exit: Exit.Exit<A, unknown> = yield* Effect.exit(Effect.scoped(run))
      const fibers = yield* RunFibers
      const leaks: Leaks = { fibers: yield* fibers.left, processes: [...groups] }
      yield* fibers.interruptAll
      leaks.processes.forEach(killGroup)
      return {
        exit,
        log: yield* texts,
        events: yield* (yield* Captured).records,
        sent: yield* (yield* Recording).all,
        checkRuns: [...checkRuns],
        worktreeCalls: [...worktreeCalls],
        issues: yield* (yield* Backlog).issues,
        comments: yield* commentsOf,
        notices: yield* (yield* Notices).notices,
        leaks,
      } satisfies Ran<A>
    }).pipe(
      Effect.provideService(ProcessGroups, groups),
      Effect.provide(environment(setup, checkRuns, worktreeCalls)),
    ),
  )
  if (ran.leaks.fibers.length > 0 || ran.leaks.processes.length > 0) throw new Leaked(ran.leaks)
  return ran
}

// Scenario helpers.

/** Builds a backlog: each ticket open, a task of priority 2, unless its fields say otherwise. */
export class BacklogBuilder {
  private readonly built: Array<Seed> = []

  /** A ticket. */
  ticket(id: string, fields: Omit<Seed, "id"> = {}): this {
    this.built.push({ id, ...fields })
    return this
  }

  /** An epic and its children, each a ticket under it. */
  epic(id: string, children: ReadonlyArray<string>, fields: Omit<Seed, "id"> = {}): this {
    this.ticket(id, { type: "epic", ...fields })
    for (const child of children) this.ticket(child, { parent: id })
    return this
  }

  /** Tickets each blocked by the one before it. */
  chain(...ids: ReadonlyArray<string>): this {
    ids.forEach((id, i) => {
      const before = ids[i - 1]
      this.ticket(id, before === undefined ? {} : { blockedBy: [before] })
    })
    return this
  }

  get seeds(): ReadonlyArray<Seed> {
    return [...this.built]
  }
}

export const backlog = (): BacklogBuilder => new BacklogBuilder()

/** A terminal for `Setup.tty`: an 80×24 256-colour TTY, with `overrides` over it. */
export { tty } from "../src/testing/Tty.ts"

/** Moves TestClock on by `duration`, running whatever was waiting for that time. */
export const advance = (duration: Duration.Input): Effect.Effect<void> => TestClock.adjust(duration)

/** The run's outcome, or a test failure showing why the scenario's Effect didn't give one. */
const outcomeOf = (ran: Ran<Outcome>): Outcome => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the run failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The run ended with `code`. */
export const expectExitCode = (ran: Ran<Outcome>, code: number): void => {
  expect(outcomeOf(ran).exitCode).toBe(code)
}

/** Each ticket ended in the phase named, and no other ticket has a phase. */
export const expectPhases = (
  ran: Ran<Outcome>,
  phases: Readonly<Record<string, PhaseTag>>,
): void => {
  const ended = Object.fromEntries(
    Object.entries(outcomeOf(ran).phases).map(([id, phase]) => [id, phase._tag]),
  )
  expect(ended).toEqual({ ...phases })
}

/** Is `wanted` found in `all`, in its order, with anything between? */
const inOrder = <A>(
  all: ReadonlyArray<A>,
  wanted: ReadonlyArray<A>,
  same: (a: A, b: A) => boolean,
) => {
  let at = 0
  for (const each of all) if (at < wanted.length && same(each, wanted[at] as A)) at++
  return at === wanted.length
}

/** The log has these lines (without their time) in this order, with any others between them. */
export const expectLog = (ran: Ran<unknown>, lines: ReadonlyArray<string | RegExp>): void => {
  const matches = (line: string, want: string | RegExp) =>
    typeof want === "string" ? line === want : want.test(line)
  if (!inOrder<string | RegExp>(ran.log, lines, (line, want) => matches(line as string, want))) {
    expect(ran.log).toEqual([...lines.map(String)])
  }
}

/** The event stream has records of these kinds in this order, with any others between them. */
export const expectEvents = (
  ran: Ran<unknown>,
  kinds: ReadonlyArray<EventRecord["kind"]>,
): void => {
  const all = ran.events.map((record) => record.kind)
  if (!inOrder(all, kinds, (a, b) => a === b)) expect(all).toEqual([...kinds])
}
