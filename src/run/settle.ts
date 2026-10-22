// Settling (§ 5 item 6, § 4.2 Settled, § 4.3 the continue nudge): the per-ticket fiber waits until
// its worker has settled (Idle, Closed or Gone; never NeedsYou, Retrying or UsageLimited), then reads
// the ticket in Beads and its worktree in git, as orchestra's settle step does. What they say is a
// Reading, which work.ts turns into the ticket's next phase.
//
// A worker that settles with its ticket still in progress, no question asked and no deferral, is
// told to continue, at most twice: client_composed nudges, each waited for until it is no longer
// outstanding and the worker has settled again. Then, after a 10-minute idle grace, the run holds
// with PAUSED. A worker whose turn failed (an interrupt, an API error) is read as an idle one. A
// worker you have steered (the ledger's flag) gets no nudges, and its grace counts from your last
// message; released during its grace, it gets the nudges it has left. One that has been closed can't
// be nudged: it pauses at once. One whose session went is resumed once in this run and told to carry
// on (sessions.ts); gone again, or steered, it pauses, and one whose session can't be resumed is
// dropped (WORKER_GONE).
//
// A worker that stops at the account's usage limit with its ticket deferred, as orchestra 0.8.1 has
// it, has the ticket put back in progress: it waits in the usage-limit hold (usageLimit.ts) and its
// worker carries on after the reset, rather than the ticket being set aside as deferred.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Clock, Data, Duration, Effect, Option, Queue, Result, Schedule, Stream } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { settled as isSettled, WorkerState } from "../agent/WorkerState.ts"
import { Beads, type BeadsError, HumanLabel, type Issue, type Status } from "../services/Beads.ts"
import { type Commit, Git, type GitError, type StatusEntry } from "../services/Git.ts"
import { runFolder } from "../services/Worktrees.ts"
import { asking, type ClosedBranches, offBase } from "./closedBranches.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, Log } from "./log.ts"
import { type MergeEnv, onBranch } from "./merge.ts"
import { readAgainAfter, readTries } from "./schedule.ts"
import { resumeGone } from "./sessions.ts"
import type { StartedWorker } from "./start.ts"

/** How many times a worker that left its ticket in progress is told to continue. */
export const nudges = 2

/** How long an idle worker, its ticket still in progress and its nudges used, may stay so. */
export const idleGrace: Duration.Duration = Duration.minutes(10)

/** The label of a ticket closed but not merged, which still holds the tickets it blocks (§ 4.8). */
export const unmergedLabel = "unmerged"

/** The continue nudge, sent client_composed. */
export const nudgeText = (id: string): string =>
  `tutti: your ticket ${id} is still in progress. Continue; if something blocks you, ask or ` +
  "defer as your instructions say."

const isIdChar = (c: string): boolean => /^[A-Za-z0-9_]$/.test(c)

/**
 * Whether a commit message names ticket `id` as a whole ID, as orchestra's namesID reads it: not
 * inside a longer one, such as `id3`, `xid`, `id-x` or the child `id.1`.
 */
export const namesTicket = (message: string, id: string): boolean => {
  if (id === "") return false
  for (let i = message.indexOf(id); i >= 0; i = message.indexOf(id, i + 1)) {
    const before = message[i - 1]
    const end = i + id.length
    const after = message[end]
    const next = message[end + 1]
    const startsHere =
      before === undefined || (!isIdChar(before) && before !== "-" && before !== ".")
    const endsHere =
      after === undefined ||
      (!isIdChar(after) &&
        !((after === "-" || after === ".") && next !== undefined && isIdChar(next)))
    if (startsHere && endsHere) return true
  }
  return false
}

/** The changes in a worktree, untracked files included, outside its .tutti/run/, by path. */
export const changeEntries = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<StatusEntry> =>
  status
    .filter(
      (entry) =>
        entry.code !== "!!" && entry.path !== runFolder && !entry.path.startsWith(`${runFolder}/`),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

/** The files with changes in a worktree, untracked ones included, outside its .tutti/run/. */
export const changes = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  changeEntries(status).map((entry) => entry.path)

/** The most files a line about a worktree's uncommitted changes names. */
export const shownChanges = 5

/**
 * The first `shownChanges` of `entries`, each as its git status code and path (`M a.txt`,
 * `?? out/b`), and how many more there are, if any: a line names them as `<shown>` then
 * ` and <more> more`.
 */
export const listChanges = (
  entries: ReadonlyArray<StatusEntry>,
): { readonly shown: ReadonlyArray<string>; readonly more: number } => ({
  shown: entries.slice(0, shownChanges).map((entry) => `${entry.code.trim()} ${entry.path}`),
  more: Math.max(0, entries.length - shownChanges),
})

/**
 * The open question `issue` waits on, if any: a ticket labelled human that blocks it and isn't
 * closed. A related or parent-child link to a question doesn't hold it.
 */
export const openQuestion = (issue: Issue): Issue | undefined =>
  issue.dependencies.find(
    (dependency) =>
      dependency.type === "blocks" &&
      dependency.issue !== undefined &&
      dependency.issue.status !== "closed" &&
      dependency.issue.labels.includes(HumanLabel),
  )?.issue

/**
 * The tickets blocking `issue` that haven't merged, as the run knows it: those not closed, those
 * the run has taken up and not finished (merging, set aside, blocked, …), and those labelled
 * unmerged; and, by `branches` (closedBranches.ts's offBase), those closed where the run didn't see
 * them close whose work git finds only on their branch, as the holds count them. A question for you
 * is a blocker of another kind, and isn't one of them.
 */
export const unmergedBlockers = (
  issue: Issue,
  state: State,
  branches: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<string> =>
  issue.dependencies
    .filter((dependency) => {
      if (dependency.type !== "blocks") return false
      const blocker = dependency.issue
      if (blocker?.labels.includes(HumanLabel) === true) return false
      const phase = state.tickets.get(dependency.id)?.phase
      return (
        blocker === undefined ||
        blocker.status !== "closed" ||
        blocker.labels.includes(unmergedLabel) ||
        (phase !== undefined && phase._tag !== "Done") ||
        branches.has(dependency.id)
      )
    })
    .map((dependency) => dependency.id)

/** What the ticket and its worktree say once its worker has settled. */
export type Reading = Data.TaggedEnum<{
  /** Closed, with `commit` naming it, its worktree clean and on its branch: ready to merge. */
  Finished: { readonly commit: Commit }
  /**
   * Closed with no change of its own to merge; `why` says which way: no commits of its own (`own`
   * false), or commits that together change nothing.
   */
  NoChange: { readonly why: string; readonly own: boolean }
  /** Closed with changes, but no commit on its branch names it. */
  NoCommit: Record<never, never>
  /** Closed with `commit` naming it, but with uncommitted changes, untracked files included. */
  Uncommitted: { readonly commit: Commit; readonly files: ReadonlyArray<StatusEntry> }
  /** Closed, but its worktree has `on` checked out instead of its branch. */
  OffBranch: { readonly on: string }
  /** It waits on `question`, which its worker filed. */
  Asked: { readonly question: Issue }
  /** Its worker stopped with nothing done, having linked `blockers`, which haven't merged. */
  WaitsForMerge: { readonly blockers: ReadonlyArray<string>; readonly status: Status }
  /** Its worker deferred it; `nothingDone` as nothingDone says. */
  Deferred: { readonly nothingDone: boolean }
  /** Still in progress, with no question and no deferral. */
  InProgress: { readonly nothingDone: boolean }
  /** Left in another status (open, blocked, …), with nothing to merge or wait for. */
  Unfinished: { readonly status: Status; readonly nothingDone: boolean }
}>

export const Reading = Data.taggedEnum<Reading>()

/** How the worker settled: what its ticket says, or the pause after the nudges and the grace. */
export type Settled = Data.TaggedEnum<{
  /** It settled in `state`, and its ticket and worktree read as `reading`. */
  Read: { readonly reading: Reading; readonly state: WorkerState }
  /**
   * Its ticket is still in progress: its worker stayed idle through the grace (`gone` null), or
   * has gone or been closed, as `gone` says, and can't be told to continue.
   */
  Paused: { readonly gone: string | null }
  /**
   * Its ticket is still in progress, its worker gone, and its session couldn't be resumed (`why`):
   * it is dropped (WORKER_GONE).
   */
  Dropped: { readonly why: string }
}>

export const Settled = Data.taggedEnum<Settled>()

/** What settling reads and writes through. */
export type SettleEnv = AgentHost | MergeEnv

/** The worker's state once it has settled; a worker the host no longer knows is Gone. */
export const untilSettled = (ticket: string): Effect.Effect<WorkerState, never, AgentHost> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const found = yield* host.state(ticket).pipe(
      Stream.filter(isSettled),
      Stream.runHead,
      Effect.catchTag("AgentGone", (error) =>
        Effect.succeed(Option.some(WorkerState.Gone({ why: error.why }))),
      ),
    )
    return Option.getOrElse(found, () => WorkerState.Closed())
  })

/**
 * Whether `message` says the send `uuid` is no longer outstanding (§ 4.2): its command_lifecycle
 * `completed`, or a result listing it. A result that lists no sends at all, from a CLI that doesn't
 * report them, ended the turn it ran in, as the worker was idle when it was sent.
 */
export const answers = (message: SDKMessage, uuid: string): boolean => {
  const raw = message as { readonly type: string } & Record<string, unknown>
  if (raw.type === "command_lifecycle") {
    return raw.command_uuid === uuid && raw.state === "completed"
  }
  if (raw.type !== "result") return false
  const listed = raw.user_message_uuids
  return !Array.isArray(listed) || listed.includes(uuid)
}

/** Waits until the worker has gone or been closed. */
const ended = (ticket: string) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* host.state(ticket).pipe(
      Stream.filter((state) => state._tag === "Gone" || state._tag === "Closed"),
      Stream.runHead,
      Effect.ignore,
    )
  })

/**
 * Tells the worker to continue, the `n`th time, and waits until the nudge is no longer outstanding
 * (or the worker has gone); false when it couldn't be sent. Settling again is the caller's.
 */
const nudge = (ticket: string, n: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* AgentHost
      const logs = yield* Log
      // The session's messages are taken from before the send, so its turn's result can't be missed.
      const heard = yield* Queue.unbounded<SDKMessage>()
      yield* host.messages(ticket).pipe(
        Stream.runForEach(({ message }) => Queue.offer(heard, message)),
        Effect.ignore,
        Effect.forkScoped({ startImmediately: true }),
      )
      const sent = yield* Effect.result(host.send(ticket, nudgeText(ticket), "clientComposed"))
      if (Result.isFailure(sent)) return false
      yield* logs.write(
        detail`${ticket}'s worker ended its turn with the ticket still in progress; told it to continue (${n} of ${nudges})`,
      )
      const answered = Stream.fromQueue(heard).pipe(
        Stream.filter((message) => answers(message, sent.success)),
        Stream.runHead,
      )
      yield* Effect.raceFirst(Effect.asVoid(answered), ended(ticket))
      return true
    }),
  )

/** The note on a ticket put back in progress as its worker stopped at the usage limit. */
export const limitDeferralNote =
  "tutti: deferred as its worker stopped at the account's usage limit; back in progress, its " +
  "worker carries on after the reset"

/** The ticket as bd show gives it, read again a few seconds later while bd fails. */
const show = (id: string) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    return yield* beads
      .show(id)
      .pipe(Effect.retry({ times: readTries - 1, schedule: Schedule.spaced(readAgainAfter) }))
  })

/**
 * What the closed ticket's worktree says: off its branch; no change of its own (no commits beyond
 * the base and a clean worktree, or commits that together change nothing); no commit naming it;
 * uncommitted changes; or finished, ready to merge.
 */
const readClosed = (worker: StartedWorker, title: string, base: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const { id, branch, path } = worker.worktree
    const on = yield* onBranch({ id, title, branch, worktree: path })
    if (on._tag === "OffBranch") return Reading.OffBranch({ on: on.on })
    if (on._tag === "Unknown") return yield* Effect.fail(on.error)
    const commits = yield* git.log(path, base)
    const files = changeEntries(yield* git.status(path))
    const named = commits.find((commit) => namesTicket(commit.message, id))
    if (files.length === 0 && commits.length === 0) {
      return Reading.NoChange({
        why: `${branch} has no commits beyond ${base} and its worktree is clean`,
        own: false,
      })
    }
    if (files.length === 0 && (yield* git.changedFiles(path, base)).length === 0) {
      return Reading.NoChange({
        why: `the commits on ${branch}, taken together, change nothing`,
        own: true,
      })
    }
    if (named === undefined) return Reading.NoCommit()
    if (files.length > 0) return Reading.Uncommitted({ commit: named, files })
    return Reading.Finished({ commit: named })
  })

/**
 * Reads the ticket in Beads, and its worktree, as its worker left them: Beads, not the worker's
 * own words, says what happened. `closed`, the run's, says which closed blockers the run knows
 * nothing of haven't merged.
 */
export const read = (
  worker: StartedWorker,
  base: string,
  closed?: ClosedBranches,
): Effect.Effect<Reading, BeadsError | GitError, SettleEnv> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const { id, path } = worker.worktree
    const issue = yield* show(id)
    const question = openQuestion(issue)
    if (question !== undefined && issue.status !== "closed") return Reading.Asked({ question })
    const { status } = issue
    if (status === "open" || status === "in_progress") {
      const state = yield* ledger.current
      const ask = closed === undefined ? undefined : asking(closed)
      const branches = yield* offBase(ask, state, issue.dependencies, ["blocks"])
      const blockers = unmergedBlockers(issue, state, branches)
      if (blockers.length > 0 && (yield* nothingDone(path, base))) {
        return Reading.WaitsForMerge({ blockers, status })
      }
    }
    if (status === "closed") return yield* readClosed(worker, issue.title, base)
    // Set aside, a worktree git can't read counts as one with work in it: it is kept for review.
    const empty = yield* Effect.orElseSucceed(nothingDone(path, base), () => false)
    switch (status) {
      case "deferred":
        return Reading.Deferred({ nothingDone: empty })
      case "in_progress":
        return Reading.InProgress({ nothingDone: empty })
    }
    return Reading.Unfinished({ status, nothingDone: empty })
  })

/**
 * Whether the worker at `path` left nothing of its own: its branch has no commits beyond `base`
 * and its worktree no changes, as orchestra's nothingDone has it.
 */
export const nothingDone = (path: string, base: string): Effect.Effect<boolean, GitError, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    return (
      (yield* git.log(path, base)).length === 0 && changes(yield* git.status(path)).length === 0
    )
  })

/** Whether a settled worker in `state` is idle: its turn ended, cleanly or failed. */
const idle = (state: WorkerState): state is Extract<WorkerState, { _tag: "Idle" | "Failed" }> =>
  state._tag === "Idle" || state._tag === "Failed"

/**
 * Waits through the idle grace of a worker idle since `at`, its ticket still in progress: true when
 * it got going again before the grace ran out, or you released it, steered. The grace counts from
 * your last message to it, when that came later.
 */
const grace = (ticket: string, at: number) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const ledger = yield* Ledger
    const going = host.state(ticket).pipe(
      Stream.filter((state) => !idle(state)),
      Stream.runHead,
      Effect.map(Option.isSome),
      Effect.catchTag("AgentGone", () => Effect.succeed(true)),
    )
    const released = ledger.changes.pipe(
      Stream.filter((state) => state.tickets.get(ticket)?.steered !== true),
      Stream.runHead,
      Effect.as(true),
    )
    for (;;) {
      const entry = (yield* ledger.current).tickets.get(ticket)
      const from = Math.max(at, entry?.lastMessage ?? at)
      const left = from + Duration.toMillis(idleGrace) - (yield* Clock.currentTimeMillis)
      if (left <= 0) return false
      const woke = yield* Effect.raceAll([
        going,
        ...(entry?.steered === true ? [released] : []),
        Effect.as(Effect.sleep(left), false),
      ])
      if (woke) return true
    }
  })

/**
 * Watches the ticket's worker: each time it stops at the usage limit (UsageLimited) with its ticket
 * deferred, the ticket is put back in progress, so that it waits for the reset in the hold and its
 * worker, told to carry on then, finds it as it left it.
 */
const undeferAtLimit = (id: string) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const beads = yield* Beads
    const logs = yield* Log
    const back = Effect.gen(function* () {
      if ((yield* show(id)).status !== "deferred") return
      yield* beads.update(id, { status: "in_progress", appendNotes: limitDeferralNote })
      yield* logs.write(
        detail`${id}: its worker deferred it as it stopped at the usage limit; back in progress, it waits for the reset`,
      )
    })
    yield* host.state(id).pipe(
      Stream.map((state) => state._tag === "UsageLimited"),
      Stream.changes,
      Stream.filter((limited) => limited),
      Stream.runForEach(() => Effect.ignore(back)),
      Effect.ignore,
    )
  })

/** How the worker settled, for the log. */
const how = (state: WorkerState): string => {
  switch (state._tag) {
    case "Gone":
      return `its worker is gone (${state.why})`
    case "Closed":
      return "its session is closed"
  }
  return "its worker is idle"
}

/**
 * Waits until the ticket's worker has settled and reads what it left. A ticket left in progress has
 * its worker told to continue, up to `nudges` times, unless you have steered it; then, after the idle
 * grace, it is Paused.
 */
export const settle = (
  worker: StartedWorker,
  base: string,
  closed?: ClosedBranches,
): Effect.Effect<Settled, BeadsError | GitError, SettleEnv> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const logs = yield* Log
      const id = worker.ticket
      yield* Effect.forkScoped(undeferAtLimit(id), { startImmediately: true })
      let told = 0
      for (;;) {
        const state = yield* untilSettled(id)
        const reading = yield* read(worker, base, closed)
        if (reading._tag !== "InProgress") {
          yield* logs.write(detail`${id} settled: ${how(state)}`)
          return Settled.Read({ reading, state })
        }
        const steered = (yield* ledger.current).tickets.get(id)?.steered ?? false
        if (state._tag === "Gone" && steered) {
          // A steered worker is told nothing, so it isn't resumed to carry on (§ 4.3).
          return Settled.Paused({
            gone: `${how(state)}; you have steered it, so tutti did not resume it to carry on, and the next run resumes it`,
          })
        }
        if (state._tag === "Gone") {
          // Resumed once in this run, told to carry on; gone again, it pauses (§ 4.8).
          const back = yield* resumeGone(id, state.why)
          if (back._tag === "Resumed") continue
          if (back._tag === "Failed") return Settled.Dropped({ why: back.reason })
          return Settled.Paused({
            gone: `${how(state)}; its session was resumed once in this run already, and the next run resumes it again`,
          })
        }
        if (!idle(state)) return Settled.Paused({ gone: how(state) })
        if (!steered && told < nudges) {
          told++
          if (yield* nudge(id, told)) continue
        }
        if (yield* grace(id, state.at)) continue
        // The grace ran out: what the ticket says now decides.
        const last = yield* read(worker, base, closed)
        if (last._tag !== "InProgress") {
          yield* logs.write(detail`${id} settled: ${how(state)}`)
          return Settled.Read({ reading: last, state })
        }
        return Settled.Paused({ gone: null })
      }
    }),
  )
