// The setup before the merge check (§ 5 item 7, § 5.1's Merging{setup}, § 8.4's checks.setup), as
// orchestra's setup.go has it. A finished ticket's worktree has the dependencies its worker
// installed (node_modules, a virtualenv) for the code as it closed the ticket. Its rebase onto the
// base can bring in a lockfile another ticket changed meanwhile, and the check would then run the
// rebased code against the old dependencies and fail on code the ticket never touched. So before
// the check on a rebased branch, the setup command (checks.setup.command, such as bun install) runs
// in the worktree when the base's commits since its dependencies were last set up change a file
// checks.setup.files names; when git can't say what they change, it runs anyway. Before the check
// on a worker's fix of a failed check, or on its resolution of a rebase, the worker's own commits
// count too, as orchestra's checkRebased has it ("the rebase, or the fix, may have changed the
// dependencies"): a fix that changes bun.lock is checked on the dependencies it names. It runs
// within the check's time limit, its whole output in the worktree's .tutti/run/setup.log, and a
// setup that fails fails the check: the ticket is set aside as for a failing check (merge.ts).
//
// What a worktree was last set up for is a commit of the base, and one of its branch: the base's
// where its branch left it, and the branch's before its worker's fix or resolution, until a setup in
// this run passes, then the ones that setup was for. A setup that fails leaves them as they were, so
// a recheck, or the next fix, sets up again. The branch's own commits count only after a fix or a
// resolution: those its worker made before it closed the ticket, it installed for itself.
//
// A ticket's new worktree has nothing installed in it, so before its worker starts there the setup
// runs in it too (setUpWorktree), within the merge check's time limit: workers start with their
// dependencies installed, and their first message says so, rather than each installing them itself.
// It runs again in a worktree an earlier attempt left when the last setup there failed or was cut
// short (its mark, .tutti/run/setup.started, is still there), or when its branch has changed a
// file checks.setup.files names since its dependencies were last set up in this run. tutti doesn't
// rebase a reused worktree before its worker starts, so its own commits are all that can change
// one. A setup that fails there isn't the ticket's fault: no worker starts (SETUP_FAILED), and the
// ticket goes back in the queue, open, Waiting{setup}, its worktree and the setup's output kept,
// until a ticket merges, which may bring what the setup needs, or a probe ends a hold for the
// environment (retrySetups). Setups failing ticket after ticket hold the run for the environment,
// as workers failing at once do (environment.ts), and the run's end names the tickets still waiting
// on one (SETUP_WAITS). A merge that changes checks.setup in .tutti/settings.json has the run use it
// from then on (takeSettings), and one that changes its requires list has the run check the new
// list before the next ticket starts (requires.ts).
import { unlinkSync } from "node:fs"
import { basename, join } from "node:path"
import { Effect, Option, Ref, Result } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { decodeConfig, formatDuration } from "../project/configFile.ts"
import { type Requirement, Settings, settingsFile } from "../project/settings.ts"
import { Beads } from "../services/Beads.ts"
import { type CheckError, Checks, setupLogName } from "../services/Checks.ts"
import { Git } from "../services/Git.ts"
import { Store } from "../services/Store.ts"
import {
  checkRunFolder,
  readRunFile,
  runFolder,
  type TicketWorktree,
  type Worktrees,
  writeRunFile,
} from "../services/Worktrees.ts"
import { outputTo, recorded } from "./check.ts"
import { EventStream } from "./eventstream.ts"
import { globMatch } from "./footprint.ts"
import { Ledger, type State as LedgerState } from "./ledger.ts"
import { detail, type Line, Log, line, Tag, ticketLine } from "./log.ts"
import { beadsWhy, type FinishedTicket, type MergeOptions } from "./merge.ts"
import { Cause, Detail, setupWait } from "./phase.ts"
import { sameRequires } from "./requires.ts"

/** The run's setup: its command (null: none), and the globs of the files it reads. */
export interface SetupConf {
  readonly command: string | null
  readonly files: ReadonlyArray<string>
}

/**
 * A ticket whose worktree's setup failed before its worker could start, Waiting{setup}: where the
 * whole output is, whether bd failed to reopen it (it isn't in bd ready then), and how many tickets
 * the run had merged as it failed: one more lets it be taken again.
 */
export interface FailedSetup {
  readonly output: string
  readonly notReopened: boolean
  readonly merged: number
}

/**
 * The file in a worktree's .tutti/run/ that says a setup began there before a worker and hasn't
 * worked since: written before the setup runs, holding `failed` once it fails, and removed once one
 * works. One a quit cut short leaves it empty, its dependencies half installed or missing (npm ci
 * removes node_modules first), and the next run that takes the worktree up runs the setup again.
 */
export const setupMarkName = "setup.started"

/** What the mark holds once the setup it marks failed. */
const failedMark = "failed"

/** The commits the tickets' dependencies were last set up for in a run, and the run's setup. */
export interface SetUps {
  /** The setup as the run has it now: checks.setup, unless a merge committed another (takeSettings). */
  readonly now: Effect.Effect<SetupConf>
  /** The run uses `setup` from now on. */
  take(setup: SetupConf): Effect.Effect<void>
  /**
   * The requires list as the run has it now: the settings', unless a merge committed another
   * (takeSettings).
   */
  readonly requires: Effect.Effect<ReadonlyArray<Requirement>>
  /** The run has `list` as its requires list from now on, due to be checked (requiresDue). */
  takeRequires(list: ReadonlyArray<Requirement>): Effect.Effect<void>
  /**
   * Whether the requires list is due to be checked, a merge having changed it since it was last
   * asked: true once for each change.
   */
  readonly requiresDue: Effect.Effect<boolean>
  /**
   * The branch commit the dependencies in the ticket's worktree were last set up for in this run,
   * before its worker or before its check; undefined when they weren't.
   */
  worktree(id: string): Effect.Effect<string | undefined>
  /** The dependencies in the ticket's worktree are set up for its branch at `head` (its worker's). */
  setWorktree(id: string, head: string): Effect.Effect<void>
  /** The setup failed in the ticket's worktree before its worker could start (see FailedSetup). */
  failed(id: string, failed: FailedSetup): Effect.Effect<void>
  /** The tickets whose worktree's setup failed before their worker started, the last time it ran. */
  readonly failures: Effect.Effect<ReadonlyMap<string, FailedSetup>>
  /**
   * The base commit the ticket's dependencies were last set up for: `fork`, where its branch left
   * the base, the first time it is asked, until `set` says otherwise.
   */
  from(id: string, fork: string): Effect.Effect<string>
  /**
   * The branch commit the ticket's dependencies were last set up for, as far as its worker's own
   * commits go: `at`, its branch before its worker's fix or resolution, the first time it is asked,
   * until `set` says otherwise; "" when git couldn't say.
   */
  since(id: string, at: string): Effect.Effect<string>
  /** The ticket's dependencies are now set up for the base at `onto` and its branch at `head`. */
  set(id: string, onto: string, head: string): Effect.Effect<void>
  /**
   * The ticket's dependencies were set up off the base, `why` saying how: on top of the branch
   * ahead of it in the merge queue, its branch since put back (mergetrain.ts). Its next setup runs
   * whatever the base changed, until `set` says otherwise, in a later run too (offBaseKey).
   */
  offBase(id: string, why: string): Effect.Effect<void>
  /** How the ticket's dependencies were set up off the base, if they were, as offBase says. */
  off(id: string): Effect.Effect<string | undefined>
}

/** What a ticket's dependencies were last set up for, of what was asked: the base's commit, its branch's. */
interface SetUpFor {
  readonly base?: string
  readonly head?: string
  /** Set up off the base: how. */
  readonly off?: string
}

/**
 * The Store metadata key holding how a ticket's dependencies were set up off the base, as offBase
 * says: a run that ends before its next setup leaves it for the next run's.
 */
export const offBaseKey = "set_up_off_base"

/**
 * A run's setups, its setup checks.setup: none yet, but those an earlier run left set up off the
 * base, as state.json says when there is a Store.
 */
export const makeSetUps: Effect.Effect<SetUps, never, AppConfig> = Effect.gen(function* () {
  const { settings } = yield* AppConfig
  const { command, files } = settings.checks.setup
  const store = yield* Effect.serviceOption(Store)
  const setup = yield* Ref.make<SetupConf>({ command, files })
  const requires = yield* Ref.make(settings.requires)
  const requiresDue = yield* Ref.make(false)
  const heads = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
  const failures = yield* Ref.make<ReadonlyMap<string, FailedSetup>>(new Map())
  const left = new Map<string, SetUpFor>()
  if (Option.isSome(store)) {
    for (const [id, record] of Object.entries((yield* store.value.state).tickets)) {
      const off = Object.hasOwn(record.metadata, offBaseKey) ? record.metadata[offBaseKey] : null
      if (typeof off === "string" && off !== "") left.set(id, { off })
    }
  }
  const commits = yield* Ref.make<ReadonlyMap<string, SetUpFor>>(left)
  // Writes to state.json, when there is a Store; one that can't be written doesn't.
  const persist = (write: (store: Store["Service"]) => Effect.Effect<void, unknown>) =>
    Option.isSome(store) ? Effect.ignore(write(store.value)) : Effect.void
  const setWorktree = (id: string, head: string) =>
    Effect.andThen(
      Ref.update(heads, (now) => new Map(now).set(id, head)),
      Ref.update(failures, (now) => {
        const left = new Map(now)
        left.delete(id)
        return left
      }),
    )
  /** The ticket's `key`, `first` and kept so the first time it is asked. */
  const get = (id: string, key: keyof SetUpFor, first: string) =>
    Ref.modify(commits, (setUps): [string, ReadonlyMap<string, SetUpFor>] => {
      const was = setUps.get(id)
      const kept = was?.[key]
      if (kept !== undefined) return [kept, setUps]
      return [first, new Map(setUps).set(id, { ...was, [key]: first })]
    })
  return {
    now: Ref.get(setup),
    take: (conf) => Ref.set(setup, conf),
    requires: Ref.get(requires),
    takeRequires: (list) => Effect.andThen(Ref.set(requires, list), Ref.set(requiresDue, true)),
    requiresDue: Ref.getAndSet(requiresDue, false),
    worktree: (id) => Effect.map(Ref.get(heads), (now) => now.get(id)),
    setWorktree,
    failed: (id, failed) => Ref.update(failures, (now) => new Map(now).set(id, failed)),
    failures: Ref.get(failures),
    from: (id, fork) => get(id, "base", fork),
    since: (id, at) => get(id, "head", at),
    set: (id, onto, head) =>
      Effect.gen(function* () {
        const was = yield* Ref.modify(commits, (setUps) => [
          setUps.get(id)?.off,
          new Map(setUps).set(id, { base: onto, head }),
        ])
        if (was !== undefined) yield* persist((store) => store.unsetMetadata(id, offBaseKey))
        if (head !== "") yield* setWorktree(id, head)
      }),
    offBase: (id, why) =>
      Effect.andThen(
        Ref.update(commits, (setUps) => new Map(setUps).set(id, { ...setUps.get(id), off: why })),
        persist((store) => store.setMetadata(id, offBaseKey, why)),
      ),
    off: (id) => Effect.map(Ref.get(commits), (setUps) => setUps.get(id)?.off),
  } satisfies SetUps
})

/**
 * The files of `files` that one of `globs` matches: by its name, or by its path from the
 * repository's top when the glob has a slash (a leading one aside), as orchestra matches them.
 */
export const setupFilesIn = (
  files: ReadonlyArray<string>,
  globs: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  files.filter((file) =>
    globs.some((glob) =>
      glob.includes("/")
        ? globMatch((glob.startsWith("/") ? glob.slice(1) : glob).split("/"), file.split("/"))
        : globMatch([glob], [basename(file)]),
    ),
  )

/** The most files a line names of those the rebase changed. */
export const maxFilesNamed = 5

/** The files for a line: at most maxFilesNamed of them, then how many more. */
export const fileList = (files: ReadonlyArray<string>): string =>
  files.length <= maxFilesNamed
    ? line`${files}`
    : line`${files.slice(0, maxFilesNamed)} and ${files.length - maxFilesNamed} more`

/** How the setup before a ticket's check went. */
export type SetUp =
  /** No setup command is set, or no file it is for changed: nothing ran. */
  | { readonly _tag: "Unneeded" }
  | { readonly _tag: "Passed" }
  /** It failed, timed out or couldn't run; `output` is where its whole output is. */
  | { readonly _tag: "Failed"; readonly error: CheckError; readonly output: string }

/**
 * A worker's own commits on the ticket's branch since it closed the ticket, whose changes to a setup
 * file count before their check too: its fix of a failed check, or its resolution of the rebase,
 * made on its branch at `from`.
 */
export interface Fix {
  readonly what: "fix" | "resolution"
  readonly from: string
}

/**
 * Runs the setup command in the ticket's worktree, its branch just rebased onto the base at `onto`
 * from `fork`, when the base's commits since its dependencies were last set up change a file
 * the run's setup files names (setUps.now), or, after its worker's `fix`, the branch's commits since
 * then do, or git can't say whether they do; Merging{setup} while it runs, unless it is for a `fix`
 * (checked again in Fixing or Resolving), or `ahead` of its turn to merge (mergetrain.ts), its
 * branch rebased onto the branch ahead of it at `onto` and its phase left as it is.
 */
export const setUp = (
  ticket: FinishedTicket,
  options: MergeOptions,
  setUps: SetUps,
  fork: string,
  onto: string,
  fix?: Fix,
  ahead = false,
): Effect.Effect<SetUp, never, Checks | Git | Worktrees | Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const { command, files } = yield* setUps.now
    if (command === null) return { _tag: "Unneeded" } satisfies SetUp
    const git = yield* Git
    const from = yield* setUps.from(ticket.id, fork)
    const changed = yield* Effect.result(git.changedFiles(options.repo, from, onto))
    const at = yield* Effect.result(git.revParse(options.repo, ticket.branch))
    const head = Result.isSuccess(at) ? at.success : ""
    const why: Array<string> = []
    const rebased = Result.isSuccess(changed) ? setupFilesIn(changed.success, files) : []
    if (Result.isFailure(changed)) why.push("git could not say what the rebase changed")
    else if (rebased.length > 0) why.push(line`${fileList(rebased)} changed in the rebase`)
    const off = yield* setUps.off(ticket.id)
    if (off !== undefined) why.push(off)
    if (fix !== undefined) {
      const since = yield* setUps.since(ticket.id, fix.from)
      const own =
        since === "" || head === ""
          ? undefined
          : yield* Effect.result(git.filesBetween(options.repo, since, head))
      if (own === undefined || Result.isFailure(own)) {
        why.push(line`git could not say what its worker's ${fix.what} changed`)
      } else {
        const hit = setupFilesIn(own.success, files).filter((file) => !rebased.includes(file))
        if (hit.length > 0) why.push(line`${fileList(hit)} changed in its worker's ${fix.what}`)
      }
    }
    if (why.length === 0) return { _tag: "Unneeded" } satisfies SetUp
    const what = why.join(" and ")
    if (fix === undefined && !ahead) {
      yield* (yield* Ledger).refine(ticket.id, Detail.Step({ step: "setup" }))
    }
    yield* (yield* Log).write(detail`${ticket.id}: ${what}; running '${command}' before the check`)
    const checks = yield* Checks
    const { ran, output } = yield* Effect.scoped(
      Effect.gen(function* () {
        const to = yield* outputTo(ticket, setupLogName, "the setup's")
        const ran = yield* recorded(
          "setup",
          ticket.id,
          checks.setup({ cwd: ticket.worktree, ...to, before: "fast", command }),
        )
        return { ran, output: to.outputFile }
      }),
    )
    if (Result.isFailure(ran)) {
      return { _tag: "Failed", error: ran.failure, output } satisfies SetUp
    }
    if (ran.success._tag === "NoCheckCommand") return { _tag: "Unneeded" } satisfies SetUp
    yield* setUps.set(ticket.id, onto, head)
    return { _tag: "Passed" } satisfies SetUp
  })

/** How the setup before a ticket's worker went. */
export type WorktreeSetUp =
  /** No setup command is set, or the worktree's dependencies are set up already: nothing ran. */
  | { readonly _tag: "Unneeded" }
  | { readonly _tag: "Passed" }
  /** `command` failed, timed out or couldn't run; `output` is where its whole output is. */
  | {
      readonly _tag: "Failed"
      readonly command: string
      readonly error: CheckError
      readonly output: string
    }

/** What the mark of a setup in the worktree holds; undefined when there is none. */
const markIn = (worktree: string): Effect.Effect<string | undefined> =>
  readRunFile(worktree, setupMarkName).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => undefined),
  )

/**
 * Removes the mark of the setup under way in the worktree, now that one has worked there; a failure
 * is logged: the setup then runs again when the worktree is next taken up.
 */
const dropMark = (id: string, worktree: string): Effect.Effect<void, never, Log> =>
  Effect.gen(function* () {
    const dropped = yield* Effect.result(
      Effect.andThen(
        checkRunFolder(worktree),
        Effect.try(() => unlinkSync(join(worktree, runFolder, setupMarkName))),
      ),
    )
    if (Result.isSuccess(dropped)) return
    const why = dropped.failure instanceof Error ? dropped.failure.message : `${dropped.failure}`
    yield* (yield* Log).write(
      detail`${id}: the mark of the setup under way in ${worktree} can't be removed: ${why}`,
    )
  })

/** Writes the mark of a setup in the worktree, holding `text`; a failure is logged, not fatal. */
const writeMark = (id: string, worktree: string, text: string): Effect.Effect<void, never, Log> =>
  Effect.gen(function* () {
    const written = yield* Effect.result(writeRunFile(worktree, setupMarkName, text))
    if (Result.isSuccess(written)) return
    yield* (yield* Log).write(
      detail`${id}: the setup under way in ${worktree} can't be marked: ${written.failure.message}`,
    )
  })

/**
 * Runs the run's setup command in the ticket's worktree before its worker starts there, within the
 * merge check's time limit: always in a new one, where nothing is installed; in one an earlier
 * attempt left when the last setup there failed or was cut short (its mark); or when its branch has
 * changed a file the setup reads since its dependencies were last set up in this run, or git can't
 * say whether it has. It records the branch commit it set up for, and the mark says a setup is under
 * way until it works.
 */
export const setUpWorktree = (
  worktree: TicketWorktree,
  setUps: SetUps,
  repo: string,
): Effect.Effect<WorktreeSetUp, never, Checks | Git | Worktrees | Log | EventStream> =>
  Effect.gen(function* () {
    const { command, files } = yield* setUps.now
    if (command === null) return { _tag: "Unneeded" } satisfies WorktreeSetUp
    const git = yield* Git
    const { id, path, branch } = worktree
    const at = yield* Effect.result(git.revParse(repo, branch))
    const now = Result.isSuccess(at) ? at.success : ""
    const mark = worktree.fresh ? undefined : yield* markIn(path)
    let what: string
    if (worktree.fresh) what = line`running '${command}' in its new worktree`
    else if (mark === failedMark) {
      what = line`the last setup in its worktree failed; running '${command}' there again`
    } else if (mark !== undefined) {
      what = line`the last setup in its worktree didn't finish; running '${command}' there again`
    } else {
      const last = yield* setUps.worktree(id)
      if (last === undefined) return { _tag: "Unneeded" } satisfies WorktreeSetUp
      const changed =
        now === "" ? undefined : yield* Effect.result(git.filesBetween(repo, last, now))
      let why: string
      if (changed === undefined || Result.isFailure(changed)) {
        why = "git could not say what changed since its dependencies were last set up"
      } else {
        const hit = setupFilesIn(changed.success, files)
        if (hit.length === 0) return { _tag: "Unneeded" } satisfies WorktreeSetUp
        why = line`${fileList(hit)} changed since its dependencies were last set up`
      }
      what = line`${why}; running '${command}' in its worktree`
    }
    yield* (yield* Log).write(detail`${id}: ${what} before its worker starts`)
    yield* writeMark(id, path, "")
    const checks = yield* Checks
    const { ran, output } = yield* Effect.scoped(
      Effect.gen(function* () {
        const to = yield* outputTo({ id, worktree: path }, setupLogName, "the setup's")
        const ran = yield* recorded(
          "setup",
          id,
          checks.setup({ cwd: path, ...to, before: "fast", command }),
        )
        return { ran, output: to.outputFile }
      }),
    )
    if (Result.isFailure(ran)) {
      yield* writeMark(id, path, failedMark)
      return { _tag: "Failed", command, error: ran.failure, output } satisfies WorktreeSetUp
    }
    if (now !== "") yield* setUps.setWorktree(id, now)
    yield* dropMark(id, path)
    return { _tag: "Passed" } satisfies WorktreeSetUp
  })

/** How a setup failed, for a line: `fails`, did not finish, or could not be run. */
export const setupHow = (error: CheckError): string => {
  switch (error._tag) {
    case "CheckFailed":
      return "fails"
    case "CheckTimedOut":
      return `did not finish within ${formatDuration(error.timeLimit)}`
    case "CheckNotRun":
      return line`could not be run (${error.reason})`
  }
}

/** How many tickets the run has merged. */
export const mergedCount = (state: LedgerState): number =>
  [...state.tickets.values()].filter(
    (entry) => entry.phase._tag === "Done" && entry.phase.outcome._tag === "Merged",
  ).length

/** The ticket whose worktree's setup failed before its worker started: as bd ready gave it. */
export interface SetupTicket {
  readonly id: string
  readonly title: string
  /** Its status in bd ready; open unless given. */
  readonly status?: string
}

/**
 * Puts the ticket back in the queue, as `failed` says its worktree's setup failed before its
 * worker could start: its environment failed, not the ticket, so it isn't set aside. It is reopened
 * when bd ready gave it in another status, its worktree kept with the setup's whole output, and it
 * is Waiting{setup}, out of the run until a ticket merges or a probe ends a hold for the
 * environment (retrySetups): taken again at once, it would fail again.
 */
export const leaveSetupFailed = (
  ticket: SetupTicket,
  worktree: string,
  failed: Extract<WorktreeSetUp, { readonly _tag: "Failed" }>,
  setUps: SetUps,
): Effect.Effect<void, never, Beads | Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { id } = ticket
    const { command, output } = failed
    const how = setupHow(failed.error)
    let notReopened = false
    if (ticket.status !== undefined && ticket.status !== "open") {
      const reopened = yield* Effect.result(beads.update(id, { status: "open" }))
      if (Result.isFailure(reopened)) {
        notReopened = true
        const text = ticketLine(
          Tag.reopenFailed,
        )`${id} stays ${ticket.status}, so it won't be back in the queue after its setup failed: ${beadsWhy(reopened.failure)}; reopen it with: bd update ${id} --status open`
        yield* logs.writeWith([text], events.emit({ kind: "warn", ticket: id, text }))
      }
    }
    yield* setUps.failed(id, { output, notReopened, merged: mergedCount(yield* ledger.current) })
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: `tutti: the setup '${command}' ${how} in worktree ${worktree}, so no worker was started; back in the queue (the whole output is in ${output}).`,
      }),
    )
    const text = ticketLine(
      Tag.setupFailed,
    )`'${command}' ${how} in ${worktree} for ${id}; the whole output is in ${output}`
    yield* ledger.transition(id, Cause.SetupFailed(), {
      beside: [{ kind: "warn", ticket: id, detail: "setup failed", text }],
      lines: [text],
    })
  })

/**
 * Puts back in the queue, Waiting → Queued, each ticket whose worktree's setup failed when a ticket
 * has merged since, which may have brought what the setup needs; the tickets it put back. A probe
 * that ends a hold for the environment puts them back too (environment.ts).
 */
export const retrySetups = (
  setUps: SetUps,
): Effect.Effect<ReadonlyArray<string>, never, Ledger | Log> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const failures = yield* setUps.failures
    const back: Array<string> = []
    for (const entry of (yield* ledger.current).tickets.values()) {
      const { phase } = entry
      if (phase._tag !== "Waiting" || phase.for !== setupWait) continue
      const state = yield* ledger.current
      if (mergedCount(state) <= (failures.get(entry.ticket)?.merged ?? -1)) continue
      const queued = [...state.tickets.values()].filter((each) => each.phase._tag === "Queued")
      const moved = yield* ledger.transition(entry.ticket, Cause.Requeued(), {
        beside: [{ kind: "queue", queued: queued.length + 1 }],
        lines: [detail`${entry.ticket}: a ticket merged since its setup failed; back in the queue`],
      })
      if (Result.isFailure(moved)) continue
      back.push(entry.ticket)
    }
    return back
  })

/**
 * The tickets still waiting on the setup that failed in their worktrees, Waiting{setup}, with where
 * each one's output is: those bd failed to reopen, which aren't in bd ready, left out.
 */
export const setupWaiting = (
  state: LedgerState,
  failures: ReadonlyMap<string, FailedSetup>,
): ReadonlyArray<readonly [id: string, output: string]> =>
  [...state.tickets.values()].flatMap((entry) => {
    const failed = failures.get(entry.ticket)
    return entry.phase._tag === "Waiting" &&
      entry.phase.for === setupWait &&
      failed !== undefined &&
      !failed.notReopened
      ? [[entry.ticket, failed.output] as const]
      : []
  })

/**
 * What the run's end line adds for the tickets waiting on a setup that failed (setupWaiting):
 * `; SETUP_WAITS: …`, naming them and where each one's output is; "" for none.
 */
export const setupWaitsPart = (waiting: ReadonlyArray<readonly [string, string]>): string => {
  if (waiting.length === 0) return ""
  const ids = waiting.map(([id]) => id)
  const outputs = waiting.map(([, output]) => output)
  if (waiting.length === 1) {
    return line`; ${Tag.setupWaits}: ${ids} waits on the setup that failed in its worktree (the whole output is in ${outputs}); fix the setup, then run again`
  }
  return line`; ${Tag.setupWaits}: ${ids} wait on the setups that failed in their worktrees (the whole output is in ${outputs}); fix the setup, then run again`
}

/**
 * What the worker handed `stop`'s rebase back to resolve is told of the setup, and what its
 * RESOLVING line adds: to run it once the rebase has finished, before the tests, when the base's
 * commits the rebase brings in change a file the setup reads, or git can't say whether they do; ""
 * for both when they change none, or there is no setup. Its tests would otherwise run on
 * dependencies set up for the code before the rebase ("Cannot find module"). tutti runs the setup
 * itself before it checks the resolution (setUp).
 */
export const setupToResolve = (
  stop: { readonly ticket: FinishedTicket; readonly fork: string; readonly onto: string },
  options: MergeOptions,
  setUps: SetUps,
): Effect.Effect<{ readonly prompt: string; readonly told: Line }, never, Git> =>
  Effect.gen(function* () {
    const none = { prompt: "", told: "" as Line }
    const { command, files } = yield* setUps.now
    if (command === null) return none
    const from = yield* setUps.from(stop.ticket.id, stop.fork)
    const changed = yield* Effect.result((yield* Git).changedFiles(options.repo, from, stop.onto))
    let why: string
    if (Result.isFailure(changed)) {
      why =
        "git could not say whether the rebase brings in a change to the files the project's setup reads"
    } else {
      const hit = setupFilesIn(changed.success, files)
      if (hit.length === 0) return none
      why = line`the rebase brings in a change to ${fileList(hit)}, which the project's setup reads`
    }
    return {
      prompt:
        `As ${why}, once the rebase has finished run the setup, '${command}', in the foreground ` +
        "before the check, so that it runs on dependencies set up for the rebased code. ",
      told: line`; told to run '${command}' once the rebase has finished, as ${why}`,
    }
  })

/** What a worker is told of its worktree's dependencies: how they are installed; "" without a setup. */
export const setupNote = (command: string | null): string =>
  command === null
    ? ""
    : `This worktree's dependencies are installed with '${command}'. Run it again only after ` +
      "changing a file it reads, such as a manifest or a lockfile."

/** The setup command for a line: quoted, or `none`. */
const setupSaid = (command: string | null): string => (command === null ? "none" : `'${command}'`)

/**
 * Has the run take checks.setup from .tutti/settings.json as ticket `id`'s merge committed it to the
 * base, when the merge, from `before` to `now`, changed that file: a setup set during the run counts
 * from then on, as the environment ticket a spec's breakdown files first sets it for the tickets
 * after it. Its requires list too, which the run checks before the next ticket starts (requires.ts),
 * and names to the workers started or resumed from then on (AgentHost's takeRequires). One git
 * can't read, or that doesn't parse, is warned of (SETTINGS_UNREAD), and the setup and the
 * requires list stay as they were.
 */
export const takeSettings = (
  id: string,
  options: MergeOptions,
  setUps: SetUps,
  before: string,
): Effect.Effect<void, never, AgentHost | Git | Log | EventStream> =>
  Effect.gen(function* () {
    const git = yield* Git
    const logs = yield* Log
    const { repo, base } = options
    const at = yield* Effect.result(git.revParse(repo, base))
    if (before === "" || Result.isFailure(at)) return
    const now = at.success
    const changed = yield* Effect.result(git.filesBetween(repo, before, now))
    if (Result.isFailure(changed) || !changed.success.includes(settingsFile)) return
    const was = yield* setUps.now
    const read = yield* Effect.result(git.fileAt(repo, now, settingsFile))
    let problem: string | undefined
    let taken: Settings | undefined
    if (Result.isFailure(read)) problem = read.failure.message
    else {
      const parsed = (() => {
        try {
          return { json: JSON.parse(read.success) as unknown }
        } catch (error) {
          return { error: `it isn't valid JSON: ${error instanceof Error ? error.message : error}` }
        }
      })()
      if ("error" in parsed) problem = parsed.error
      else {
        const decoded = yield* Effect.result(decodeConfig(Settings, settingsFile, parsed.json))
        if (Result.isSuccess(decoded)) taken = decoded.success
        else {
          problem = decoded.failure.problems
            .map((each) => (each.path === "" ? each.message : `${each.path}: ${each.message}`))
            .join("; ")
        }
      }
    }
    if (taken === undefined) {
      const text = ticketLine(
        Tag.settingsUnread,
      )`${id}'s merge changed ${settingsFile} on ${base}, but it could not be read${problem === undefined ? "" : `: ${problem}`}; the setup stays ${setupSaid(was.command)}, and the requirements as they were`
      yield* logs.writeWith([text], (yield* EventStream).emit({ kind: "warn", ticket: id, text }))
      return
    }
    if (!sameRequires(taken.requires, yield* setUps.requires)) {
      yield* setUps.takeRequires(taken.requires)
      yield* (yield* AgentHost).takeRequires(taken.requires.map((r) => r.name))
      yield* logs.write(
        ticketLine(
          Tag.requires,
        )`${id}'s merge changed the requirements in ${settingsFile} on ${base}: they are checked before the next ticket starts`,
      )
    }
    const setup = taken.checks.setup
    const same =
      setup.command === was.command &&
      setup.files.length === was.files.length &&
      setup.files.every((file, i) => file === was.files[i])
    if (same) return
    yield* setUps.take({ command: setup.command, files: setup.files })
    yield* logs.write(
      ticketLine(
        Tag.setup,
      )`${id}'s merge changed ${settingsFile} on ${base}: the setup is ${setupSaid(setup.command)} from now on`,
    )
  })
