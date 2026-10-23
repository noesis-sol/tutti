// The conflict hand-back (§ 4.7, § 5 item 7's MERGE_CONFLICT with hand-back, § 5.1's Merging →
// Resolving and Resolving → ToMerge, Blocked), as orchestra's handback.go has it. A finished
// ticket's rebase that stops on conflicts is handed back to its worker to resolve when it can take
// it: hand-backs on, a check command set to check the resolution with, attempts left, git able to say
// what the rebase stopped on, and its worker Idle or Failed and not steered, or at the account's usage
// limit, handed it once the limit lifts, or its session closed by tutti, which is resumed for it (not
// a Gone resume, so it counts toward no resume limit). A worker
// whose session ended unexpectedly (Gone) takes it too while the ticket's one Gone resume of the run
// is left (§ 4.8): its session is resumed for the hand-back, and one that can't be is WORKER_GONE.
// Either resume is recorded as sessions.ts has it (RESUMED, `resumed`). The rebase is left in
// progress, the ticket moves Merging → Resolving{attempt} with the RESOLVING line, and the merge
// queue goes on with the tickets behind it meanwhile.
//
// The hand-back is a client_composed message with orchestra's instructions. It is under way from
// its push until its send is no longer outstanding and the worker has settled, within
// resolve_timeout from the push, the time its worker waits at the account's usage limit left out, as
// orchestra 0.8.0 has it, and the time the machine is loaded, up to resolve_timeout again, as
// orchestra 0.9.0 has it; the reset tells it to carry on with the hand-back (usageLimit.ts). A worker
// at the limit already is handed it once the limit lifts, as orchestra 0.8.0 has it: the usage-limit
// hold keeps the hand-back and sends it at the reset as the worker's carry-on, the wait not counting
// toward resolve_timeout either. A worker seen at the limit with what it was asked done in git, its
// turn having ended on the limit as it finished, has given its answer, and one past resolve_timeout
// has what git shows done taken as it is, or is stopped and told the hand-back is over before its
// branch is put back, as orchestra's orchestra-nr1v.1 and -nr1v.2 have it. Then tutti looks at what
// the worker left without taking its word
// for it: the rebase finished, the worktree clean and on its branch, the branch on top of the base
// it was rebased onto with only the ticket's own commits, and, set up if need be (setup.ts), the
// check passing. The check runs once, where the branch merges, as orchestra 0.8.5 has it: when the
// base moved on while the worker resolved, the resolution goes back in line unchecked, for the
// merge to rebase it onto the base and check it there. A resolution verified goes back in the merge
// queue, ToMerge; one that leaves the branch changing nothing, its worker having skipped every
// commit the base has already, is closed at once, Done{noChange}, unchecked; one rejected, or not
// done in time, is Blocked (MERGE_CONFLICT), the branch put back as the ticket closed it and the
// ticket's notes saying why. One whose check fails goes on to checkback.ts, which hands the failure
// back too, Fixing{afterResolution}, or blocks it.
//
// A conflict that can't be handed back is Blocked at once, its rebase aborted, and the MERGE_CONFLICT
// line says why. For a worker you have steered, the hand-back due to it waits: it is kept in
// `waiting`, for its view to offer as a notice (§ 4.3).
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Clock, Duration, Effect, Option, Ref, Result, Stream, SubscriptionRef } from "effect"
import { type AgentGone, AgentHost, type SessionMessage } from "../agent/AgentHost.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads } from "../services/Beads.ts"
import type { CheckError } from "../services/Checks.ts"
import { Git } from "../services/Git.ts"
import { trackedChanges, untrackedFiles } from "../services/gitStatus.ts"
import { Store } from "../services/Store.ts"
import { failedHow, markHandedBack, runMergeCheck } from "./check.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { loadEvery } from "./load.ts"
import { detail, type Line, Log, line, resolving, Tag, ticketLine } from "./log.ts"
import {
  abandonRebase,
  baseSince,
  branchHead,
  type FinishedTicket,
  gitWhy,
  type MergeEnv,
  type MergeMemory,
  type MergeOptions,
  notePass,
  onBranch,
  restoreBranch,
  someFiles,
  type Unchanged,
  unchanged,
} from "./merge.ts"
import { Cause } from "./phase.ts"
import { type ResumeWhy, resume } from "./sessions.ts"
import { answers, namesTicket, untilSettled } from "./settle.ts"
import { type SetUps, setUp, setupToResolve } from "./setup.ts"

/** How many times a ticket's rebase conflicts are handed back to its worker in a run. */
export const maxHandBacks = 2

/** A rebase stopped on conflicts in a finished ticket's worktree, as the merge found it. */
export interface RebaseStop {
  readonly ticket: FinishedTicket
  /** The base's commit the branch was being rebased onto. */
  readonly onto: string
  /** Where the branch left the base before the rebase, for the setup (setup.ts). */
  readonly fork: string
  /** The branch's commit before the rebase; "" when git couldn't say. */
  readonly head: string
  /** How many commits of its own the branch had then; -1 when git couldn't say. */
  readonly own: number
  /** The files the rebase stopped on. */
  readonly files: ReadonlyArray<string>
}

/** A run's conflict hand-backs: how many each ticket has had, and those waiting on you. */
export interface HandBacks {
  /** How many times the ticket's conflicts have been handed back to its worker in this run. */
  count(id: string): Effect.Effect<number>
  /** Counts one more hand-back of the ticket's conflicts: this one's number. */
  next(id: string): Effect.Effect<number>
  /**
   * The hand-backs due to workers you have steered, which wait until you hand them over: each
   * ticket's latest, in the order they came.
   */
  readonly waiting: Effect.Effect<ReadonlyArray<RebaseStop>>
  /** The hand-backs waiting now, then on each change: for the worker view's notice (§ 4.3). */
  readonly changes: Stream.Stream<ReadonlyArray<RebaseStop>>
  /** Keeps a hand-back due to a steered worker, in place of any earlier one of its ticket's. */
  wait(stop: RebaseStop): Effect.Effect<void>
  /** Takes the ticket's waiting hand-back out of those waiting; undefined when it has none. */
  take(id: string): Effect.Effect<RebaseStop | undefined>
  /**
   * Waives the steered check for the ticket's next conflict, as you handed it over (§ 4.3): its
   * worker, steered, is handed the conflict all the same.
   */
  waive(id: string): Effect.Effect<void>
  /** Takes the ticket's waiver, as its rebase starts: whether it had one. */
  waived(id: string): Effect.Effect<boolean>
}

/** A run's hand-backs: none yet. */
export const makeHandBacks: Effect.Effect<HandBacks> = Effect.gen(function* () {
  const ref = yield* Ref.make<{
    readonly counts: ReadonlyMap<string, number>
    readonly waived: ReadonlySet<string>
  }>({ counts: new Map(), waived: new Set() })
  // Those waiting apart, so that their changes can be followed.
  const waiting = yield* SubscriptionRef.make<ReadonlyArray<RebaseStop>>([])
  return {
    count: (id) => Effect.map(Ref.get(ref), (state) => state.counts.get(id) ?? 0),
    next: (id) =>
      Ref.modify(ref, (state) => {
        const n = (state.counts.get(id) ?? 0) + 1
        return [n, { ...state, counts: new Map([...state.counts, [id, n]]) }]
      }),
    waiting: SubscriptionRef.get(waiting),
    changes: SubscriptionRef.changes(waiting),
    wait: (stop) =>
      SubscriptionRef.update(waiting, (all) => [
        ...all.filter((each) => each.ticket.id !== stop.ticket.id),
        stop,
      ]),
    take: (id) =>
      SubscriptionRef.modify(waiting, (all) => {
        const found = all.find((each) => each.ticket.id === id)
        if (found === undefined) return [undefined, all]
        return [found, all.filter((each) => each !== found)]
      }),
    waive: (id) =>
      Ref.update(ref, (state) => ({ ...state, waived: new Set([...state.waived, id]) })),
    waived: (id) =>
      Ref.modify(ref, (state) => {
        if (!state.waived.has(id)) return [false, state]
        return [
          true,
          { ...state, waived: new Set([...state.waived].filter((each) => each !== id)) },
        ]
      }),
  } satisfies HandBacks
})

/** Where the branch conflicts with the base, for a line: ` in a.ts, b.ts`, or nothing. */
const inFiles = (files: ReadonlyArray<string>): Line =>
  files.length === 0 ? line`` : line` in ${files}`

/** What a worker that can't take a hand-back is doing, for a line. */
export const away = (state: WorkerState): string | undefined => {
  switch (state._tag) {
    case "Idle":
    case "Failed":
    case "Closed":
      return undefined
    case "Starting":
      return "its worker is starting"
    case "Working":
      return "its worker is working"
    case "Retrying":
      return "its worker is retrying"
    case "NeedsYou":
      return "its worker needs you"
    case "UsageLimited":
      return "its worker is at the account's usage limit"
    case "Gone":
      return `its worker is gone (${state.why})`
  }
}

/** Why the conflicts can't be handed back, and whether the hand-back waits for you. */
export interface NotHandedBack {
  readonly why: string
  /** Its worker is steered: the hand-back waits in its view. */
  readonly waits: boolean
}

/**
 * Why `stop` can't be handed back to the ticket's worker, the `handedBack`th time so far; undefined
 * when it can. `waived`: you handed it over, so a steered worker takes it (§ 4.3).
 */
export const whyNotHandBack = (
  stop: RebaseStop,
  handedBack: number,
  waived = false,
): Effect.Effect<NotHandedBack | undefined, never, AppConfig | AgentHost | Ledger | Store> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ledger = yield* Ledger
    const { id } = stop.ticket
    const not = (why: string, waits = false) => ({ why, waits }) satisfies NotHandedBack
    if (!config.settings.merge.resolve_conflicts) return not("resolving conflicts is turned off")
    if (config.settings.checks.fast.command === null) {
      return not("there is no check command in .tutti/settings.json to check a resolution with")
    }
    if (handedBack >= maxHandBacks) {
      return not(`it was handed back to its worker ${handedBack} times already`)
    }
    if (stop.head === "" || stop.own < 1 || stop.files.length === 0) {
      return not("git could not say what the rebase stopped on")
    }
    if (!waived && (yield* ledger.current).tickets.get(id)?.steered === true) {
      return not("you have steered its worker, so the hand-back waits in its view", true)
    }
    const busy = yield* workerAway(id)
    return busy === undefined ? undefined : not(busy)
  })

/** What a Gone worker whose session was resumed once in this run already is, for a line. */
const goneAgain = (why: string): string =>
  `its worker is gone (${why}) and its session was resumed once in this run already`

/**
 * Why the ticket's worker can't take a hand-back, as it is now: undefined when it is Idle or
 * Failed, at the account's usage limit (handed it once the limit lifts, give), its session, closed by
 * tutti in this run or an earlier one, can be resumed, or it is Gone with the ticket's one Gone
 * resume of the run left (§ 4.8).
 */
export const workerAway = (
  id: string,
): Effect.Effect<string | undefined, never, AgentHost | Ledger | Store> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const ledger = yield* Ledger
    const store = yield* Store
    const state = yield* Effect.result(host.current(id))
    if (Result.isSuccess(state)) {
      const now = state.success
      if (now._tag === "UsageLimited") return undefined
      if (now._tag !== "Gone") return away(now)
      return (yield* ledger.goneResumed(id)) ? goneAgain(now.why) : undefined
    }
    // No worker in this run: its session, closed by an earlier one, is resumed.
    const saved = yield* store.ticket(id)
    return saved?.session === undefined ? "its worker has no session to resume" : undefined
  })

/**
 * What the worker is asked to do with a rebase stopped on conflicts, as orchestra asks it: the
 * tests of its change and of the files that conflicted, the whole check left to tutti's, which
 * follows; `setup` says when to run the project's setup, if it is to (setup.ts's setupToResolve).
 */
export const resolvePrompt = (stop: RebaseStop, base: string, check: string, setup = ""): string =>
  `tutti: ${base} moved on while you worked; rebasing ${stop.ticket.branch} onto it stopped on ` +
  `conflicts in ${stop.files.join(", ")}. ` +
  `Resolve them keeping the intent of both your change and what landed on ${base}, ` +
  "then git add the files and run GIT_EDITOR=true git rebase --continue; " +
  "if the rebase stops on another commit, resolve that one the same way. " +
  `If ${base} has a commit's change already, wholly or as the part that conflicts, run git rebase ` +
  "--skip for that commit instead of resolving it. " +
  setup +
  "Once the rebase has finished, run the tests of the code you changed and of the files that " +
  "conflicted in the foreground until they pass, since the commits that applied cleanly may " +
  "break them too; fold any fix into the branch's last commit with git commit --amend --no-edit. " +
  `Leave the whole check, '${check}', to tutti: it runs it on the branch next. ` +
  "Don't do anything else: no new commits beyond the rebase, no merge, no push, no ticket changes. " +
  "Say DONE when the rebase is complete and those tests pass."

/** The MERGE_CONFLICT line of a ticket whose conflicts aren't resolved, saying why. */
const conflictLine = (stop: RebaseStop, base: string, why: string): Line => {
  const { id, branch, worktree } = stop.ticket
  return ticketLine(
    Tag.mergeConflict,
  )`${id} closed, but ${branch} conflicts with ${base}${inFiles(stop.files)}, which moved on while it ran (${why}); worktree ${worktree} left for review (rebase onto ${base}, check, merge)`
}

/**
 * Blocks the ticket on its conflicts (MERGE_CONFLICT), saying why: by Block from Merging or
 * Resolving, by Aside from Fixing{afterResolution}.
 */
const block = (stop: RebaseStop, base: string, why: string, by: "Block" | "Aside" = "Block") =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const { files } = stop
    const text = conflictLine(stop, base, why)
    const cause =
      by === "Block"
        ? Cause.Block({ why: Tag.mergeConflict })
        : Cause.Aside({ why: Tag.mergeConflict })
    yield* ledger.transition(stop.ticket.id, cause, {
      beside: [
        {
          kind: "warn",
          ticket: stop.ticket.id,
          aside: true,
          detail: `conflicts with ${base}`,
          blocked:
            files.length === 0
              ? `merge conflict with ${base}`
              : `merge conflict in ${files.join(", ")}`,
          text,
        },
      ],
      lines: [text],
    })
  })

/**
 * Sets aside `stop`'s conflicts without handing them back: the rebase aborted, the ticket Blocked,
 * and the MERGE_CONFLICT line saying why. A hand-back due to a steered worker is kept, waiting.
 */
export const notHandedBack = (
  stop: RebaseStop,
  options: MergeOptions,
  not: NotHandedBack,
  handBacks: HandBacks,
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { worktree } = stop.ticket
    yield* abandonRebase(worktree)
    const stuck = yield* Effect.result(git.rebaseInProgress(worktree))
    const left =
      Result.isSuccess(stuck) && !stuck.success
        ? ""
        : line`; its rebase could not be aborted, so ${worktree} is left mid-rebase`
    if (not.waits) {
      yield* handBacks.wait(stop)
      // Blocked on it, the ticket keeps its worker's number and card meanwhile (§ 4.3).
      yield* (yield* Ledger).handBackWaits(stop.ticket.id)
    }
    yield* block(stop, options.base, `not handed back to its worker: ${not.why}${left}`)
  })

/**
 * Hands `stop`'s conflicts back: the ticket Merging → Resolving, its attempt counted, its
 * rebased-and-unchecked mark noting the hand-back (check.ts), and the RESOLVING line. False when
 * the ledger refused (PHASE_BUG): the rebase is then aborted.
 */
export const handOver = (
  stop: RebaseStop,
  options: MergeOptions,
  handBacks: HandBacks,
  setUps: SetUps,
): Effect.Effect<boolean, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { id } = stop.ticket
    const attempt = (yield* handBacks.count(id)) + 1
    // The rebase left in progress is its worker's now: carried over unfinished, it is said so.
    yield* markHandedBack(id)
    const moved = yield* ledger.transition(id, Cause.ConflictsHandedBack({ attempt }))
    if (Result.isFailure(moved)) {
      yield* abandonRebase(stop.ticket.worktree)
      return false
    }
    yield* handBacks.next(id)
    const text = resolving({
      id,
      base: options.base,
      files: stop.files,
      limit: formatDuration(config.settings.merge.resolve_timeout),
      told: (yield* setupToResolve(stop, options, setUps)).told,
    })
    yield* logs.writeWith([text], events.emit({ kind: "info", ticket: id, text }))
    return true
  })

/** How a worker in `state` is described once its time ran out. */
const still = (state: WorkerState): string =>
  away(state) ?? (state._tag === "Closed" ? "its session is closed" : "its worker is idle")

/** What a ticket's worker is handed back: its rebase's conflicts to resolve, or a check to fix. */
export type HandBackMode = "resolving" | "fixing"

/** A hand-back to the ticket's worker, as give gives it and ends it. */
export interface HandBack {
  readonly ticket: FinishedTicket
  readonly mode: HandBackMode
  readonly prompt: string
  /** The RESUMED line's start, should its session be resumed for it. */
  readonly what: Line
  /** The base's commit the branch was rebased onto, or is on top of. */
  readonly onto: string
  /** The commit the branch is put back at should the hand-back fail. */
  readonly to: string
  /**
   * Whether git shows what the worker was asked done, its worker not settled: the rebase finished,
   * with the branch on top of the base, or a fix committed.
   */
  readonly done: Effect.Effect<boolean, never, MergeEnv>
}

/** What a worker on a hand-back has done once git shows it done, for a line. */
const doneWords = (mode: HandBackMode): string =>
  mode === "resolving" ? "its rebase has finished" : "its fix is committed"

const short = (hash: string) => hash.slice(0, 10)

/**
 * What the worker is told when its hand-back is past its time limit, `limit`, with what it was
 * asked done already: its branch, at commit `at`, is taken as it is, to be checked with `check`.
 */
export const handBackTaken = (
  handBack: HandBack,
  limit: string,
  at: string,
  check: string,
): string => {
  const { branch, worktree } = handBack.ticket
  const what = handBack.mode === "resolving" ? "rebase has finished" : "fix is committed"
  return (
    `tutti: the ${limit} for this hand-back is up, and your ${what}, so tutti has stopped you ` +
    `and takes ${branch} as it is now, at ${short(at)}, to check with '${check}' and merge. ` +
    `Leave ${worktree} as it is: no more commits, no amending, no git commands in it, ` +
    "no ticket changes. Say DONE."
  )
}

/**
 * What the worker is told when its hand-back is past its time limit, `limit`, and not done: the
 * hand-back is over, its branch put back at `handBack.to` and its ticket set aside, its attempt, the
 * commit it had got to ("" for none), kept in git.
 */
export const handBackOver = (handBack: HandBack, limit: string, attempt: string): string => {
  const { id, branch, worktree } = handBack.ticket
  const to = short(handBack.to)
  const back =
    handBack.mode === "resolving"
      ? `aborts the rebase if it is still in progress, puts ${branch} back at ${to}, where it was before the rebase,`
      : `puts ${branch} back at ${to}, where the check failed,`
  const kept =
    attempt === ""
      ? "Nothing of your attempt was committed, so none of it is kept."
      : `Your attempt so far is commit ${short(attempt)}, which git keeps (git show ${short(attempt)}).`
  return (
    `tutti: the ${limit} for this hand-back is up, so tutti has stopped you and ends it: it ${back} ` +
    `and sets ${id} aside for review. ${kept} Don't work on it any more: no git commands in ` +
    `${worktree}, no ticket changes. Say DONE.`
  )
}

/** What give needs: the host, what a resume records (sessions.ts), and git to end a hand-back. */
export type GiveEnv = MergeEnv

/**
 * Where a hand-back due to a worker at the account's usage limit waits for the limit to lift: the
 * usage-limit hold (usageLimit.ts), which sends it at the reset as the worker's carry-on.
 */
export interface AtReset {
  /**
   * Keeps the hand-back due to the ticket's worker, at the limit, `prompt`, for the reset to send:
   * its send's uuid once sent, undefined when you steered the worker meanwhile (it is sent nothing,
   * steer.ts), or why its worker didn't take it. Null when the hold is off, the limit reset
   * already: the caller sends it.
   */
  keep(
    id: string,
    mode: HandBackMode,
    prompt: string,
  ): Effect.Effect<Effect.Effect<string | undefined, AgentGone> | null>
  /** Takes back the ticket's hand-back kept for the reset: false once the reset has sent it. */
  takeBack(id: string): Effect.Effect<boolean>
  /**
   * Runs `wait`, the ticket's hand-back waiting for its worker, at the limit on it, to leave the
   * limit: with nothing else running, the run waits for the reset, or ends USAGE_LIMIT, meanwhile.
   */
  waits<A, E, R>(id: string, wait: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/** Why a hand-back kept for the reset isn't sent: you steered its worker meanwhile. */
const steeredWhile = "you steered its worker while it waited for the usage limit"

/** What a ticket's worker is handed back, for a line: `conflicts to resolve`. */
export const handedWords = (mode: HandBackMode): string =>
  mode === "resolving" ? "conflicts to resolve" : "failed check to fix"

/**
 * Resumes the ticket's session for its hand-back, `prompt`, recording it (`why`, the RESUMED line
 * starting with `what`). Why it couldn't be; undefined once it is resumed.
 */
const resumeFor = (
  id: string,
  why: ResumeWhy,
  prompt: string,
  what: Line,
): Effect.Effect<string | undefined, never, GiveEnv> =>
  Effect.map(Effect.result(resume(id, why, prompt, what)), (resumed) =>
    Result.isFailure(resumed) ? resumed.failure.reason : undefined,
  )

/**
 * The ticket's Gone worker (`why`) resumed for its hand-back, `prompt`, as the ticket's one Gone
 * resume of the run (§ 4.8): one that can't be is warned about, WORKER_GONE. Why it wasn't resumed;
 * undefined once it is.
 */
const resumeGoneFor = (
  id: string,
  why: string,
  prompt: string,
  what: Line,
): Effect.Effect<string | undefined, never, GiveEnv> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    if (!(yield* ledger.claimGoneResume(id))) return goneAgain(why)
    const failed = yield* resumeFor(id, "gone", prompt, line`${what}, which is gone (${why})`)
    if (failed === undefined) return undefined
    const text = ticketLine(
      Tag.workerGone,
    )`${id}'s worker is gone (${why}), and its session could not be resumed for its hand-back (${failed})`
    yield* logs.writeWith(
      [text],
      events.emit({ kind: "warn", ticket: id, detail: "its worker gone", text }),
    )
    return line`its worker is gone (${why}) and its session could not be resumed: ${failed}`
  })

/**
 * Waits until the ticket's worker is in a state `wanted` takes; forever when it never is (its
 * worker ended).
 */
const whenState = (
  id: string,
  wanted: (state: WorkerState) => boolean,
): Effect.Effect<void, never, AgentHost> =>
  Effect.gen(function* () {
    const found = yield* (yield* AgentHost).state(id).pipe(
      Stream.filter(wanted),
      Stream.runHead,
      Effect.catchTag("AgentGone", () => Effect.succeed(Option.none())),
    )
    if (Option.isNone(found)) yield* Effect.never
  })

const isLimited = (state: WorkerState) => state._tag === "UsageLimited"

/** What a hand-back's give reads of the run: its atReset and whether the machine is loaded. */
type GiveOptions = Pick<MergeOptions, "atReset" | "loaded">

/** A hand-back past its time limit: `loaded`, the time the machine's load added to it. */
interface Late {
  readonly loaded: Duration.Duration
}

/**
 * The hand-back's clock: `limit` of the time its worker isn't at the account's usage limit, as
 * orchestra 0.8.0 counts it, and of that, the time the machine is loaded (`options.loaded`, sampled
 * every loadEvery) left out too, up to `limit` again, as orchestra 0.9.0 has it. Each time the
 * worker is seen at the limit, git is asked whether it has done what it was asked, its turn having
 * ended on the limit as it finished (a turn that has ended can't change git): "taken" when it has.
 * Late once the time is up. Its wait for the limit is one of `options.atReset`'s, when given.
 */
const clock = (
  handBack: HandBack,
  limit: Duration.Duration,
  options: GiveOptions,
): Effect.Effect<"taken" | Late, never, GiveEnv> =>
  Effect.gen(function* () {
    const logs = yield* Log
    const { id, branch } = handBack.ticket
    const { atReset } = options
    const loaded = options.loaded ?? Effect.succeed(false)
    const most = Duration.toMillis(limit)
    const every = Duration.toMillis(loadEvery)
    let left = most
    // The time the machine was loaded, up to `most`; and since when the time is counted, toward it
    // (`spare`, the machine loaded at that time's sample) or toward `left`.
    let extra = 0
    let since = 0
    let spare = false
    const count = (now: number) => {
      const spent = Math.max(0, now - since)
      const added = spare ? Math.min(spent, most - extra) : 0
      extra += added
      left = Math.max(0, left - (spent - added))
      since = now
    }
    // Until `left` runs out, the machine sampled every loadEvery.
    const runsOut = Effect.gen(function* () {
      for (;;) {
        count(yield* Clock.currentTimeMillis)
        if (left === 0) return
        spare = extra < most && (yield* loaded)
        yield* Effect.sleep(Duration.millis(Math.min(spare ? most - extra : left, every)))
      }
    })
    for (;;) {
      since = yield* Clock.currentTimeMillis
      spare = false
      const limited = yield* Effect.raceFirst(
        Effect.as(runsOut, false),
        Effect.as(whenState(id, isLimited), true),
      )
      if (!limited) return { loaded: Duration.seconds(Math.round(extra / 1000)) }
      count(yield* Clock.currentTimeMillis)
      if (yield* handBack.done) {
        yield* logs.write(
          detail`${id}'s worker is at the usage limit, but ${doneWords(handBack.mode)}: ${branch} is taken as it is, without waiting for the limit to lift`,
        )
        return "taken"
      }
      yield* logs.write(
        detail`${id}'s worker is at the usage limit on its hand-back: it carries on once the limit lifts, the wait not counting toward the ${formatDuration(limit)}`,
      )
      const lifted = whenState(id, (state) => !isLimited(state))
      yield* atReset === undefined ? lifted : atReset.waits(id, lifted)
    }
  })

/** Stops the turn of the ticket's worker, still at its hand-back past its time limit, and tells it `text`. */
const interruptWith = (id: string, text: string): Effect.Effect<void, never, GiveEnv> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const logs = yield* Log
    yield* Effect.ignore(host.interrupt(id))
    const sent = yield* Effect.result(host.send(id, text, "clientComposed"))
    if (Result.isFailure(sent)) {
      yield* logs.write(
        detail`${id}'s worker did not take the message that its hand-back is over (${sent.failure.why})`,
      )
    }
  })

/**
 * Ends the hand-back of its worker, still at it past its time limit, `limit`, as orchestra does
 * since tutti-nrg.5.9's worker lost a resolution it had committed, and worked an hour on a ticket set
 * aside: what git shows done already is taken as it is, the worker stopped and told so; otherwise
 * the worker is stopped and told the hand-back is over and where its attempt is kept, before the
 * caller puts its branch back. Why it failed, `why`; undefined when it is taken.
 */
const endLate = (
  handBack: HandBack,
  limit: Duration.Duration,
  why: string,
): Effect.Effect<string | undefined, never, GiveEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const git = yield* Git
    const logs = yield* Log
    const { id, branch, worktree } = handBack.ticket
    const after = formatDuration(limit)
    if (yield* handBack.done) {
      const at = yield* Effect.result(git.revParse(worktree, branch))
      yield* logs.write(
        detail`${id}'s worker was still at its hand-back after ${after}, but ${doneWords(handBack.mode)}: ${branch} is taken as it is`,
      )
      const check = config.settings.checks.fast.command ?? ""
      yield* interruptWith(
        id,
        handBackTaken(handBack, after, Result.isSuccess(at) ? at.success : "", check),
      )
      return undefined
    }
    const head = yield* Effect.result(git.revParse(worktree, "HEAD"))
    const attempt =
      Result.isFailure(head) || head.success === handBack.to || head.success === handBack.onto
        ? ""
        : head.success
    yield* interruptWith(id, handBackOver(handBack, after, attempt))
    yield* logs.write(detail`${id}'s worker was stopped and told its hand-back is over`)
    return why
  })

/** The hand-back sent to the ticket's worker: its send's uuid, or why it wasn't, for a line. */
type Sent = Result.Result<string, string>

/** Sends the ticket's worker its hand-back, `prompt`, now. */
const sendNow = (id: string, prompt: string): Effect.Effect<Sent, never, AgentHost> =>
  Effect.gen(function* () {
    const sent = yield* Effect.result((yield* AgentHost).send(id, prompt, "clientComposed"))
    return Result.isSuccess(sent)
      ? Result.succeed(sent.success)
      : Result.fail(line`its worker did not take the hand-back (${sent.failure.why})`)
  })

/**
 * Sends the hand-back to the ticket's worker, at the account's usage limit, once the limit lifts, as
 * orchestra 0.8.0 has it: `atReset` keeps it for the reset to send as the worker's carry-on, the wait
 * not counting toward `limit`, and the hand-back's turn starts its clock. A worker you steered
 * meanwhile is sent nothing (steer.ts), and the hand-back is over. Its send's uuid, or why it
 * wasn't sent; undefined when the worker left the limit without it, not steered (its session
 * ended), for the caller to give it as to any worker.
 */
const sendAtReset = (
  handBack: HandBack,
  limit: Duration.Duration,
  atReset: AtReset,
): Effect.Effect<Sent | undefined, never, GiveEnv> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const { id } = handBack.ticket
    const steered = Effect.map(ledger.current, (state) => state.tickets.get(id)?.steered === true)
    // Handed over to a steered worker, it is sent all the same (§ 4.3).
    const before = yield* steered
    const kept = yield* atReset.keep(id, handBack.mode, handBack.prompt)
    if (kept === null) return yield* sendNow(id, handBack.prompt)
    yield* logs.write(
      detail`${id}'s worker is at the usage limit: it is handed its ${handedWords(handBack.mode)} once the limit lifts, the wait not counting toward the ${formatDuration(limit)}`,
    )
    let sent = yield* Effect.raceFirst(
      Effect.result(kept),
      Effect.as(
        whenState(id, (state) => !isLimited(state)),
        undefined,
      ),
    )
    if (sent === undefined) {
      if (yield* atReset.takeBack(id)) {
        return !before && (yield* steered) ? Result.fail(steeredWhile) : undefined
      }
      sent = yield* Effect.result(kept)
    }
    if (Result.isFailure(sent)) {
      return Result.fail(line`its worker did not take the hand-back (${sent.failure.why})`)
    }
    if (sent.success === undefined) return Result.fail(steeredWhile)
    // Sent at the reset, its worker is UsageLimited until the hand-back's turn starts.
    yield* whenState(id, (state) => !isLimited(state))
    return Result.succeed(sent.success)
  })

/**
 * Gives the ticket's worker a hand-back, its prompt, resuming its session if tutti closed it or it
 * is Gone (the RESUMED line starting with its `what`), and waits until its send is no longer
 * outstanding and the worker has settled, within `limit` from the push, the time its worker waits at
 * the account's usage limit not counting, nor the time the machine is loaded meanwhile
 * (`options.loaded`), up to `limit` again (clock). A worker at the limit already is handed it once
 * the limit lifts, by `options.atReset` when given (sendAtReset). A worker at the limit with what it
 * was asked done in git has given its answer; one past the limit is stopped (endLate), the line
 * saying how much more the machine's load gave it. Why it wasn't done; undefined when what it left
 * is to be looked at.
 */
export const give = (
  handBack: HandBack,
  limit: Duration.Duration,
  options: GiveOptions,
): Effect.Effect<string | undefined, never, GiveEnv> =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* AgentHost
      const { ticket, prompt, what } = handBack
      const { id } = ticket
      const { atReset } = options
      const state = yield* Effect.result(host.current(id))
      let taken: Effect.Effect<void>
      if (Result.isSuccess(state) && state.success._tag === "Gone") {
        const failed = yield* resumeGoneFor(id, state.success.why, prompt, what)
        if (failed !== undefined) return failed
        // As below: the resume put its state back at Starting.
        taken = Effect.void
      } else if (Result.isSuccess(state) && state.success._tag !== "Closed") {
        // Subscribed to the session's messages before the send, so its turn's result can't be
        // missed, however soon it comes. A worker ended meanwhile fails the send.
        const heard = yield* host
          .subscribe(id)
          .pipe(Effect.orElseSucceed((): Stream.Stream<SessionMessage> => Stream.never))
        const sent =
          state.success._tag === "UsageLimited" && atReset !== undefined
            ? yield* sendAtReset(handBack, limit, atReset)
            : yield* sendNow(id, prompt)
        // It left the limit without the hand-back: given as to any worker, from its state now.
        if (sent === undefined) return yield* give(handBack, limit, options)
        if (Result.isFailure(sent)) return sent.failure
        const answered = heard.pipe(
          Stream.filter(({ message }) => answers(message, sent.success)),
          Stream.runHead,
        )
        const ended = host.state(id).pipe(
          Stream.filter((each) => each._tag === "Gone" || each._tag === "Closed"),
          Stream.runHead,
          Effect.ignore,
        )
        taken = Effect.raceFirst(Effect.asVoid(answered), ended)
      } else {
        const failed = yield* resumeFor(id, "hand_back", prompt, what)
        if (failed !== undefined) return line`its session could not be resumed: ${failed}`
        // The resume put its state back at Starting: it settles only once the hand-back's turn,
        // the first of a resumed session, is over.
        taken = Effect.void
      }
      const ended = yield* Effect.raceFirst(
        Effect.as(Effect.andThen(taken, untilSettled(id)), "settled" as const),
        clock(handBack, limit, options),
      )
      if (ended === "settled" || ended === "taken") return undefined
      const now = yield* Effect.result(host.current(id))
      const how = Result.isSuccess(now) ? still(now.success) : "its worker is gone"
      const more =
        Duration.toMillis(ended.loaded) > 0
          ? ` (and ${formatDuration(ended.loaded)} more for the machine's load)`
          : ""
      return yield* endLate(
        handBack,
        limit,
        line`${how} after ${formatDuration(limit)}${more}, with the hand-back not done`,
      )
    }),
  )

/**
 * Why what the worker left is rejected, looked at without taking its word for it: the rebase over,
 * the worktree clean (no untracked files either: the check would see them, the merge not) and on
 * its branch, and the branch on top of the base it was rebased onto with
 * the ticket's own commits and nothing more (as many as it had, or fewer where its worker skipped
 * those the base has already). A branch left changing nothing passes too. Undefined when it passes.
 */
export const verifyResolved = (
  stop: RebaseStop,
  options: MergeOptions,
): Effect.Effect<string | undefined, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { id, branch, worktree } = stop.ticket
    const { repo, base } = options
    const read = yield* Effect.result(
      Effect.gen(function* () {
        if (yield* git.rebaseInProgress(worktree))
          return line`its worker left the rebase unfinished`
        const status = yield* git.status(worktree)
        if (trackedChanges(status).length > 0) {
          return line`its worker left uncommitted changes in ${worktree}`
        }
        const loose = untrackedFiles(status)
        if (loose.length > 0) {
          return line`its worker left untracked files in ${worktree}: ${someFiles(loose)}`
        }
        const on = yield* onBranch(stop.ticket)
        if (on._tag === "Unknown") return yield* Effect.fail(on.error)
        if (on._tag === "OffBranch") {
          return line`its worker left ${worktree} with ${on.on}, not ${branch}`
        }
        if ((yield* git.mergeBase(repo, stop.onto, branch)) !== stop.onto) {
          return line`${branch} is not on top of ${base} as it was rebased onto`
        }
        if ((yield* git.changedFiles(repo, stop.onto, branch)).length === 0) return undefined
        const commits = yield* git.log(repo, stop.onto, branch)
        if (!commits.some((commit) => namesTicket(commit.message, id))) {
          return line`no commit on ${branch} names ${id} any more`
        }
        if (commits.length > stop.own) {
          return line`${branch} has ${commits.length} commits where the ticket had ${stop.own} (a commit made besides the rebase?)`
        }
        return undefined
      }),
    )
    return Result.isSuccess(read)
      ? read.success
      : line`git could not say what its worker left: ${gitWhy(read.failure)}`
  })

/**
 * Puts the branch back as the ticket closed it, at `stop.head`, after a rejected resolution: a
 * rebase in progress aborted, and the branch reset when it is elsewhere and the worktree is clean
 * and on it. What it did, for the lines and notes.
 */
export const undoResolution = (stop: RebaseStop): Effect.Effect<string, never, MergeEnv> =>
  Effect.gen(function* () {
    const { branch, worktree } = stop.ticket
    const to = stop.head
    const short = (hash: string) => hash.slice(0, 10)
    const was = line`it was at ${short(to)} before the rebase`
    const restored = yield* restoreBranch(stop.ticket, to)
    switch (restored._tag) {
      case "AbortFailed":
        return line`the rebase could not be aborted, so ${worktree} is left mid-rebase`
      case "AlreadyThere":
        return restored.aborted
          ? line`the rebase was aborted`
          : line`${branch} is as the ticket closed it`
      case "Dirty":
        return line`${branch} is left as its worker left it (${was})`
      case "OffBranch":
        return line`${branch} is left at ${short(restored.at)} (${was}), as ${worktree} has ${restored.on}`
      case "Unknown":
        return line`${branch} is left at ${short(restored.at)} (${was}), as git could not tell what ${worktree} has checked out: ${gitWhy(restored.error)}`
      case "ResetFailed":
        return line`${branch} could not be reset to ${short(to)}, where it was before the rebase; it is left at ${short(restored.at)}`
      case "Reset":
        return line`${branch} was reset to ${short(to)}, where it was before the rebase (its worker's attempt is ${short(restored.from)})`
    }
  })

/**
 * How a hand-back ended: the resolution verified and checked, verified and changing nothing (for
 * the caller to close as unchanged, closeUnchanged), the ticket blocked, or the resolution verified
 * but its check, or the setup before it, failing, for checkback.ts to hand back or block.
 */
export type Resolved =
  | { readonly _tag: "Verified" }
  | { readonly _tag: "Unchanged"; readonly unchanged: Unchanged }
  | { readonly _tag: "Blocked" }
  | {
      readonly _tag: "CheckFailed"
      readonly error: CheckError
      readonly output: string
      /** The commit checked, its branch's as the setup started; "" when git couldn't say. */
      readonly at: string
    }

/** Why a resolution whose check fails is rejected, for its lines and notes. */
export const failedResolved = (stop: RebaseStop, error: CheckError, output: string): string => {
  const where = error._tag === "CheckTimedOut" ? "" : line` (output is in ${output})`
  return line`${failedHow(error)} on the resolved ${stop.ticket.branch}${where}`
}

/**
 * Rejects the worker's resolution of `stop` for `why`: its branch put back as the ticket closed it,
 * its notes saying why, and the ticket Blocked (MERGE_CONFLICT), by `by` (see block).
 */
export const rejectResolution = (
  stop: RebaseStop,
  options: MergeOptions,
  why: string,
  by: "Block" | "Aside" = "Block",
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const { id, branch } = stop.ticket
    const { base } = options
    const undone = yield* undoResolution(stop)
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: `tutti: ${branch} conflicted with ${base} in ${stop.files.join(", ")}; its worker was asked to resolve the rebase, but ${why}, so ${id} was set aside for review; ${undone}.`,
      }),
    )
    yield* block(stop, base, `handed back to its worker, but ${why}; ${undone}`, by)
  })

/**
 * The hand-back of `stop`'s conflicts to the ticket's worker, Resolving: the hand-back given, what
 * the worker left verified, set up if need be (the memory's setUps, setup.ts) and checked, the
 * commit it passed on kept in the memory's passes; when the base moved on meanwhile, it is left
 * unchecked, for the merge to rebase it onto the base and check it once there, as orchestra 0.8.5
 * has it, the setup's commits and any fix's tries carried to that check (the memory's fixes).
 * Verified: the caller puts it back in the merge queue; Unchanged, the branch left changing
 * nothing, unchecked: the caller closes it so; its setup or check failing: the caller hands that
 * back, or blocks it (checkback.ts). Else it is Blocked here, its branch put back and its notes
 * saying why.
 */
export const resolve = (
  stop: RebaseStop,
  options: MergeOptions,
  memory: MergeMemory,
): Effect.Effect<Resolved, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const logs = yield* Log
    const { id } = stop.ticket
    const { base } = options
    const check = config.settings.checks.fast.command ?? ""
    const limit = config.settings.merge.resolve_timeout
    const what = line`${id}'s conflicts with ${base} are handed back to its worker`
    const setup = (yield* setupToResolve(stop, options, memory.setUps)).prompt
    let why = yield* give(
      {
        ticket: stop.ticket,
        mode: "resolving",
        prompt: resolvePrompt(stop, base, check, setup),
        what,
        onto: stop.onto,
        to: stop.head,
        done: Effect.map(verifyResolved(stop, options), (rejected) => rejected === undefined),
      },
      limit,
      options,
    )
    if (why === undefined) why = yield* verifyResolved(stop, options)
    if (why === undefined) {
      const { branch } = stop.ticket
      const nothing = yield* unchanged(stop.ticket, options, (own) =>
        own
          ? `the commits on ${branch}, taken together, change nothing`
          : `its worker found the changes of ${branch} on ${base} already and skipped them in the rebase`,
      )
      if (nothing !== undefined) return { _tag: "Unchanged", unchanged: nothing } satisfies Resolved
      // Checked once, where it merges: a check on stop.onto would be run again on the branch
      // rebased.
      // Where git can't tell whether the base moved on, the merge reads where the branch is again.
      const since = yield* baseSince(options, stop.onto)
      if (since._tag !== "Still") {
        yield* logs.write(
          since._tag === "Moved"
            ? detail`${id}'s worker finished the rebase, but ${base} moved on meanwhile: rebasing ${branch} onto it before checking it`
            : detail`${id}'s worker finished the rebase, but git could not tell whether ${base} moved on meanwhile: ${gitWhy(since.error)}; ${branch} goes back to its merge, which checks it`,
        )
        // Kept as the setup here would have them, for the setup before the merge's check.
        yield* memory.setUps.from(id, stop.fork)
        yield* memory.setUps.since(id, stop.head)
        const before = yield* memory.fixes.carried(id)
        yield* memory.fixes.carry(id, {
          fix: { what: "resolution", from: stop.head },
          tries: before?.tries ?? [],
        })
        return { _tag: "Verified" } satisfies Resolved
      }
      yield* logs.write(detail`${id}'s worker finished the rebase; checking it with '${check}'`)
      // The commit checked: one its worker makes while it runs is checked before it merges.
      const at = yield* branchHead(stop.ticket, options)
      const setup = yield* setUp(stop.ticket, options, memory.setUps, stop.fork, stop.onto, {
        what: "resolution",
        from: stop.head,
      })
      const checked = setup._tag === "Failed" ? setup : yield* runMergeCheck(stop.ticket)
      if (checked._tag !== "Failed") {
        yield* notePass(stop.ticket, memory.passes, at)
        return { _tag: "Verified" } satisfies Resolved
      }
      return {
        _tag: "CheckFailed",
        error: checked.error,
        output: checked.output,
        at,
      } satisfies Resolved
    }
    yield* rejectResolution(stop, options, why)
    return { _tag: "Blocked" } satisfies Resolved
  })
