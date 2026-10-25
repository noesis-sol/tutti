// Starting a ticket (§ 5 item 6, § 4.1 Messages, § 4.8 Session IDs): the start of the per-ticket
// fiber, once the ticket is dispatched and Working. Its worktree on tutti/<id>, reused when an
// earlier attempt left one or its branch; its .tutti/run/ checked; a new session ID drawn; the
// session started through AgentHost, whose live layer gives it the worker options (§ 4.1); its
// first message; and the session ID saved in state.json once the session's first system/init
// comes, so that a quit or a failure before then leaves no session to resume that Claude Code never
// made. The first message is sent client_composed, holding what is specific to this start: the
// ticket's ID, a pointer to the rules (in the system prompt), the spec it comes from, the time it
// has, the --ticket scope line, and what an earlier attempt left on the branch. There is no prompt
// file and no paste.
//
// Before the session, the project's setup runs in the worktree when it is new, or when the last
// setup there failed or didn't finish (setup.ts's setUpWorktree), and the first message says how its
// dependencies are installed. A setup that fails there starts no worker: SETUP_FAILED, the ticket
// back in the queue, Working → Waiting{setup}, until a ticket merges or a probe passes.
//
// A ticket whose ID can't name a worktree (BAD_TICKET_ID), whose worktree's run folder is a
// symbolic link (RUN_FILES_OUTSIDE), or whose worker didn't start (START_FAILED) is set aside:
// Working → Deferred. A session that didn't start or begin counts toward the environment hold
// (environment.ts), so that Claude Code failing to start sessions holds the run rather than defer
// the queue a ticket at a time. git failing to make the worktree, and a state.json that can't be written, are
// errors for the run to stop on.
import { join } from "node:path"
import { Data, Duration, Effect, Exit, Option, Stream } from "effect"
import { AgentHost, type AgentStartFailed } from "../agent/AgentHost.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import type { Beads, TicketId } from "../services/Beads.ts"
import type { Checks } from "../services/Checks.ts"
import {
  type Commit,
  type Git,
  type GitError,
  type StatusEntry,
  shortHash,
} from "../services/Git.ts"
import { Store, type StoreWriteFailed } from "../services/Store.ts"
import { timeoutAwake } from "../services/Wake.ts"
import {
  type Earlier,
  type ExcludeUnwritable,
  leftWork,
  type RunFilesError,
  runFolder,
  type TicketWorktree,
  Worktrees,
} from "../services/Worktrees.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { type Aside, type AsideTicket, putAside } from "./aside.ts"
import type { EventStream } from "./eventstream.ts"
import type { Ledger } from "./ledger.ts"
import type { Log } from "./log.ts"
import * as log from "./log.ts"
import { info } from "./say.ts"
import { leaveSetupFailed, makeSetUps, type SetUps, setUpWorktree, setupNote } from "./setup.ts"

/** The ticket to start, as bd ready gives it. */
export interface StartTicket extends AsideTicket {
  /** Its custom metadata: `spec` names the spec it comes from. */
  readonly metadata: Readonly<Record<string, unknown>>
  /** Its status in bd ready: one not open is reopened when its setup fails. Open unless given. */
  readonly status?: string
}

/** A ticket's worker, started and sent its first message. */
export interface StartedWorker {
  readonly ticket: TicketId
  readonly worktree: TicketWorktree
  /** The session's ID, saved in state.json once the session began. */
  readonly session: string
  /** The first message's uuid. */
  readonly message: string
}

/** How a start went: the worker started, or the ticket set aside without one. */
export type Start = Data.TaggedEnum<{
  Started: { readonly worker: StartedWorker }
  /**
   * Deferred, or kept out of this run when bd couldn't defer it; `why` in a few words. `session`:
   * its session didn't start or begin (START_FAILED from the Agent SDK), which counts toward the
   * environment hold as a worker failing at once does.
   */
  SetAside: { readonly why: string; readonly deferred: boolean; readonly session: boolean }
  /** The setup failed in its worktree, so no worker started: back in the queue, Waiting{setup}. */
  SetupFailed: { readonly output: string }
  /**
   * Its worker was stopped over a setup problem found as its session started, before its first
   * turn (§ 4.1, `problem`): the run stops, as for one its first system/init shows (SETUP_PROBLEM).
   */
  SetupProblem: { readonly worktree: TicketWorktree; readonly problem: string }
}>

export const Start = Data.taggedEnum<Start>()

/** What a start can fail with: git making the worktree, info/exclude, or state.json. */
export type StartError = GitError | ExcludeUnwritable | StoreWriteFailed

/** The metadata key naming the spec a ticket comes from, as orchestra's spec runs set it. */
export const specKey = "spec"

/** The most commits, and the most files, the first message lists of an earlier attempt. */
export const listedAtMost = 30

/** What a ticket's first message is made from. */
export interface FirstMessage {
  readonly id: TicketId
  /** `tutti/<id>`. */
  readonly branch: string
  /** Where finished tickets land. */
  readonly base: string
  /** The time the ticket has (--ticket-limit); null: no limit. */
  readonly ticketLimit: Duration.Duration | null
  /** The ticket the run is scoped to (--ticket); null for the whole backlog. */
  readonly scope: TicketId | null
  /** The spec the ticket comes from (see specOf); null when none. */
  readonly spec: string | null
  /** What an earlier attempt left on the branch. */
  readonly earlier: Earlier
  /** The setup command the worktree's dependencies are installed with; null or absent: none. */
  readonly setup?: string | null
}

/**
 * The spec a ticket's metadata names, or null: the metadata is anyone's to change, so a path that
 * isn't a string, is empty, or holds a control or invisible character names none.
 */
export const specOf = (metadata: Readonly<Record<string, unknown>>): string | null => {
  const value = Object.hasOwn(metadata, specKey) ? metadata[specKey] : undefined
  if (typeof value !== "string") return null
  const path = value.trim()
  return path === "" || sanitizeLine(path) !== path || /[\p{C}]/u.test(path) ? null : path
}

/** At most `listedAtMost` lines, the rest counted. */
const capped = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.length <= listedAtMost
    ? lines
    : [...lines.slice(0, listedAtMost), `… and ${lines.length - listedAtMost} more`]

/** A commit as `git log --oneline` shows it, its subject on one line. */
const commitLine = (commit: Commit): string =>
  `${shortHash(commit.hash)} ${sanitizeLine(commit.subject)}`

/** A file as `git status --short` shows it, its paths on one line. */
const statusLine = (entry: StatusEntry): string =>
  entry.from === undefined
    ? `${entry.code} ${sanitizeLine(entry.path)}`
    : `${entry.code} ${sanitizeLine(entry.from)} -> ${sanitizeLine(entry.path)}`

/** Lines indented as a Markdown code block, so the model reads them as output, not as words. */
const block = (lines: ReadonlyArray<string>): string =>
  capped(lines)
    .map((line) => `    ${line}`)
    .join("\n")

/**
 * What an earlier attempt left on the branch, for the first message: how much, what to do with it,
 * and the commits (`git log <base>..HEAD`) and changes (`git status`) themselves. Empty when it
 * left nothing.
 */
export const earlierNote = (branch: string, base: string, earlier: Earlier): string => {
  if (!leftWork(earlier)) return ""
  const n = earlier.commits.length
  const left = [
    ...(n === 0 ? [] : [`${n} ${n === 1 ? "commit" : "commits"} that ${base} doesn't have`]),
    ...(earlier.status.length === 0 ? [] : ["uncommitted changes"]),
  ]
  const parts = [
    `An earlier attempt at this ticket left work on ${branch}: ${left.join(" and ")}. ` +
      "Read it before anything else, then build on it, or revert it deliberately; " +
      "don't start over, and don't commit or discard it unread.",
    ...(n === 0 ? [] : [`git log ${base}..HEAD:\n\n${block(earlier.commits.map(commitLine))}`]),
    ...(earlier.status.length === 0
      ? []
      : [`git status:\n\n${block(earlier.status.map(statusLine))}`]),
  ]
  return parts.join("\n\n")
}

/**
 * What a start tells the worker of this run, as paragraphs: the time the ticket has, and the
 * --ticket scope line. A resumed worker is told them too (carry.ts).
 */
export const runFacts = (
  m: Pick<FirstMessage, "id" | "ticketLimit" | "scope">,
): ReadonlyArray<string> => {
  const { id, scope } = m
  return [
    ...(m.ticketLimit === null
      ? []
      : [
          `You have about ${formatDuration(m.ticketLimit)} for this ticket: a worker still going ` +
            "after that stops the run, so pace yourself to it.",
        ]),
    ...(scope === null || scope === id
      ? []
      : [
          `This run works on ${scope} and its subtickets only. File a follow-up that belongs to ` +
            `this work as a child of ${scope} (bd create --parent ${scope} …) so this run picks ` +
            "it up; anything else waits for a later run.",
        ]),
  ]
}

/** A ticket's first message (§ 4.1): what is specific to this start, in paragraphs. */
export const firstMessage = (m: FirstMessage): string => {
  const { id } = m
  const paragraphs = [
    `Your ticket is ${id}. Your standing rules for it are in your system prompt: ` +
      "follow them exactly, from claiming the ticket to closing it.",
    ...(m.spec === null
      ? []
      : [
          `${id} is part of the spec at ${m.spec}: read the sections of it that ${id} cites ` +
            "before you start, and treat the spec as settled.",
        ]),
    ...runFacts(m),
    setupNote(m.setup ?? null),
    earlierNote(m.branch, m.base, m.earlier),
  ]
  return `${paragraphs.filter((p) => p !== "").join("\n\n")}\n`
}

/** `word` as one word for a POSIX shell: as it is when it needs no quoting, else single-quoted. */
const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`

/** Setting aside a ticket whose ID can't name its worktree and branch. */
export const badTicketId = (id: TicketId, why: string): Aside => ({
  note:
    `tutti: ${why}, so no worker was started on ${id}: a ticket's ID names its worktree folder ` +
    `and its branch tutti/<id>. Give it a plain ID (bd rename ${id} <new-id>), then bring it ` +
    "back with: bd undefer <new-id>",
  reason: why,
  detail: why,
  deferred: log.ticketLine(
    log.Tag.badTicketId,
  )`${why}: ${id} -> deferred without starting a worker; rename it (bd rename ${id} <new-id>), then bd undefer <new-id>`,
  failed: `${why}: ${id}, and bd could not defer it`,
  instead: `rename it with: bd rename ${id} <new-id>`,
})

/** Setting aside a ticket whose worktree has a symbolic link at `path` on the way to its run files. */
export const runFilesOutside = ({
  id,
  worktree,
  path,
}: {
  readonly id: TicketId
  readonly worktree: string
  /** The link, relative to the worktree. */
  readonly path: string
}): Aside => {
  const why = `its worktree's ${path} is a symlink`
  const link = join(worktree, path)
  return {
    note:
      `tutti: ${why} (${link}), so no worker was started on it: tutti writes a worker's run ` +
      `files only in its worktree's own ${runFolder} folder, which git ignores. Look at what it ` +
      `points to, remove the link (rm ${shellWord(link)}), then bring it back with: bd undefer ${id}`,
    reason: why,
    detail: why,
    deferred: log.ticketLine(
      log.Tag.runFilesOutside,
    )`${why} -> ${id} deferred without starting a worker; remove the link ${link}, then bd undefer ${id}`,
    failed: `${why}, and bd could not defer ${id}`,
    instead: `remove the link in ${worktree}`,
  }
}

/** Setting aside a ticket whose worker didn't start in `worktree`, for `reason`. */
export const startFailed = ({
  id,
  worktree,
  reason,
}: {
  readonly id: TicketId
  readonly worktree: string
  readonly reason: string
}): Aside => ({
  note:
    `tutti: ${id}'s worker didn't start (${reason}); deferred so it can be retried ` +
    `(worktree ${worktree}). Bring it back with: bd undefer ${id}`,
  reason: `its worker didn't start: ${reason}`,
  detail: "its worker didn't start",
  deferred: log.ticketLine(
    log.Tag.startFailed,
  )`${id}'s worker didn't start: ${reason} -> deferred; worktree ${worktree} left as it is`,
  failed: `${id}'s worker didn't start (${reason}), and bd could not defer it`,
  instead: `worktree ${worktree} left as it is`,
})

/**
 * Why a session didn't start, with the CLI's startup_failure_reason when it gave one and the
 * reason doesn't already say it, as the live host's does (startFailure).
 */
const notStarted = (error: AgentStartFailed): string =>
  error.startupFailureReason === undefined || error.reason.includes(error.startupFailureReason)
    ? error.reason
    : `${error.reason} (${error.startupFailureReason})`

/** The session didn't begin, for `reason`: the start failed. */
class NotBegun extends Data.TaggedError("NotBegun")<{ readonly reason: string }> {}

/** The session's start found a setup problem, `problem`, before its first turn. */
class SetupStopped extends Data.TaggedError("SetupStopped")<{
  readonly worktree: TicketWorktree
  readonly problem: string
}> {}

/**
 * How long a new session has to begin its first turn, its system/init, once it is sent its first
 * message: the CLI sends one as it takes the message, before it calls the model. Counted awake
 * (Wake.ts), as tutti's other limits are.
 */
export const initLimit: Duration.Duration = Duration.minutes(1)

/** The start set the ticket aside, as `aside` says; `session` when its session didn't begin. */
class SetAsideBy extends Data.TaggedError("SetAsideBy")<{
  readonly aside: Aside
  readonly session?: boolean
}> {}

/** A run folder that can't be checked for another reason than a link: the start failed. */
const runFolderFailed = (id: TicketId, worktree: string, error: RunFilesError): SetAsideBy =>
  new SetAsideBy({
    aside:
      error._tag === "RunFilesOutside"
        ? runFilesOutside({ id, worktree, path: error.path })
        : startFailed({
            id,
            worktree,
            reason: `its ${runFolder} can't be opened: ${error.message}`,
          }),
  })

/**
 * Starts the dispatched ticket's worker on `base`: its worktree, set up for it (the run's
 * `setUps`), its session and its first message, the session's ID saved once it begins. A ticket
 * that can't be started is set aside (Working → Deferred); one whose setup fails is back in the
 * queue.
 */
export const start = (
  ticket: StartTicket,
  base: string,
  setUps?: SetUps,
): Effect.Effect<
  Start,
  StartError,
  AppConfig | Worktrees | Store | AgentHost | Beads | Ledger | Log | EventStream | Checks | Git
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const worktrees = yield* Worktrees
    const store = yield* Store
    const host = yield* AgentHost
    const id = ticket.id

    // prepare checks the ID, once, before it makes a folder or a branch of it.
    const worktree = yield* worktrees
      .prepare(id)
      .pipe(
        Effect.catchTag("BadTicketId", (error) =>
          Effect.fail(new SetAsideBy({ aside: badTicketId(id, error.why) })),
        ),
      )
    const { path, branch } = worktree
    const made = worktree.reused
      ? log.detail`reusing worktree ${path} (${branch})`
      : log.detail`worktree ${path} on ${branch}`
    yield* info(made, id)
    yield* worktrees
      .checkRunFolder(path)
      .pipe(Effect.mapError((error) => runFolderFailed(id, path, error)))

    // The worker starts with the project's dependencies installed (setup.ts).
    const setups = setUps ?? (yield* makeSetUps)
    const setup = yield* setUpWorktree(worktree, setups, config.repo)
    if (setup._tag === "Failed") {
      yield* leaveSetupFailed(ticket, path, setup, setups)
      return Start.SetupFailed({ output: setup.output })
    }

    const message = firstMessage({
      id,
      branch,
      base,
      ticketLimit: config.settings.workers.ticket_limit,
      scope: config.ticket,
      spec: specOf(ticket.metadata),
      earlier: worktree.earlier,
      setup: (yield* setups.now).command,
    })
    // An earlier attempt's session isn't this start's: until this one begins, none is to resume,
    // nor is the ticket suspended (a record carry-over kept).
    if ((yield* store.ticket(id)) !== undefined) {
      yield* store.updateTicket(id, ({ session: _, suspended: __, phase: ___, ...rest }) => rest)
    }
    const session = crypto.randomUUID()
    // Saved once Claude Code has made the session, as its first system/init says (§ 4.8): a start
    // that fails or is interrupted before then (a quit) ends it, leaving nothing to resume, and the
    // next start draws a new session, in the same worktree.
    const save = store.saveSession(id, { session, worktree: path, branch })
    const begunNow = host.begun(id).pipe(
      Stream.runHead,
      Effect.map(Option.getOrElse(() => false)),
      Effect.orElseSucceed(() => false),
    )
    const starting = Effect.gen(function* () {
      yield* host.start(id, { sessionId: session, cwd: path })
      // Stopped over a setup problem as it started, the session is sent nothing (§ 4.1).
      const now = yield* Effect.option(host.current(id))
      if (Option.isSome(now) && now.value._tag === "Gone" && now.value.setup === true) {
        return yield* new SetupStopped({ worktree, problem: now.value.why })
      }
      const sent = yield* host.send(id, { text: message, from: "clientComposed" })
      const ended = host.state(id).pipe(
        Stream.filter((state) => state._tag === "Gone" || state._tag === "Closed"),
        Stream.runHead,
      )
      yield* Effect.raceFirst(
        Effect.asVoid(host.begun(id).pipe(Stream.filter(Boolean), Stream.runHead)),
        Effect.asVoid(ended),
      ).pipe(
        timeoutAwake({
          duration: initLimit,
          orElse: () =>
            Effect.fail(
              new NotBegun({
                reason: `its session didn't begin its first turn within ${formatDuration(initLimit)}`,
              }),
            ),
        }),
      )
      // A session that began, then ended, has begun all the same: followed, and resumed.
      if (!(yield* begunNow)) {
        const state = yield* Effect.option(host.current(id))
        return yield* new NotBegun({
          reason:
            Option.isSome(state) && state.value._tag === "Gone"
              ? `its session ended at once: ${state.value.why}`
              : "its session ended at once",
        })
      }
      yield* save
      return sent
    })
    const sent = yield* starting.pipe(
      // Interrupted once Claude Code has made the session, the start leaves it for the run's end to
      // suspend, saved; otherwise one cleanup for failure and interruption: the session is ended.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.flatMap(begunNow, (made) =>
              made && Exit.hasInterrupts(exit) ? Effect.ignore(save) : host.end(id),
            ),
      ),
      Effect.catchTags({
        AgentStartFailed: (error) => Effect.fail(new NotBegun({ reason: notStarted(error) })),
        AgentGone: (error) =>
          Effect.fail(new NotBegun({ reason: `its session ended at once: ${error.why}` })),
      }),
      Effect.catchTag("NotBegun", ({ reason }) =>
        Effect.fail(
          new SetAsideBy({ aside: startFailed({ id, worktree: path, reason }), session: true }),
        ),
      ),
    )
    return Start.Started({ worker: { ticket: id, worktree, session, message: sent } })
  }).pipe(
    Effect.catchTag("SetupStopped", ({ worktree, problem }) =>
      Effect.succeed(Start.SetupProblem({ worktree, problem })),
    ),
    Effect.catchTag("SetAsideBy", ({ aside, session }) =>
      Effect.map(putAside(ticket, aside), (deferred) =>
        Start.SetAside({ why: aside.detail, deferred, session: session === true }),
      ),
    ),
  )
