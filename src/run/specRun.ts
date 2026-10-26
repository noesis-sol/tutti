// A spec run's start (§ 4.14), once the startup checks have passed and the run holds its lock: the
// spec committed, the tree an earlier run filed for it looked up, then, as its state says, the run
// carried on, nothing to run, or the breakdown (src/agent/breakdown.ts), headless or with the user
// in the Interview view (--refine), after which the tree is checked and the root epic marked as
// filed for this version of the spec, last of all. The run is then scoped to the root epic, as
// --ticket <root epic> scopes one.
//
// Each step that stops the run says why on stderr and in the log, a SPEC line, and gives the exit
// code: 2 for a breakdown that failed, ran out of time, filed no tree or a tree the run can't take,
// or two root epics; 8 for one at the account's usage limit that resets too late or at an unknown
// time (src/agent/breakdown.ts waits for one that doesn't); 4 when git or bd failed; 0 when the spec
// is built already, or a refinement was left with nothing filed; 130 when Ctrl+C stopped it. What
// was filed stays filed: the same command carries on from it.
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  type FileSystem,
  Option,
  Result,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import type { Attention } from "../agent/Attention.ts"
import {
  type Breakdown,
  type BreakdownEnd,
  BreakdownMode,
  type BreakdownStart,
  startBreakdown,
} from "../agent/breakdown.ts"
import { type BreakdownState, filedAny } from "../agent/breakdownTools.ts"
import { Filing } from "../agent/interviewTools.ts"
import type { Transcripts } from "../agent/Transcripts.ts"
import type { AppConfig } from "../cli/AppConfig.ts"
import { dollars } from "../organs/OrganCost.ts"
import { duration, type OrganLine, type Printer } from "../print/organLine.ts"
import { formatDuration } from "../project/configFile.ts"
import { type Beads, beadsWhy, type Issue, type TicketId } from "../services/Beads.ts"
import type { Git, GitError } from "../services/Git.ts"
import { writeRunFile } from "../services/Worktrees.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { exitCodes } from "./holds.ts"
import { type InterviewScreen, inInterviewView } from "./interview.ts"
import { type Arg, type Line, Log, line, Tag } from "./log.ts"
import {
  checkFiled,
  commitSpec,
  issueLine,
  markFiled,
  plural,
  type Spec,
  short,
  specDiff,
  specIssues,
  specState,
  specUpdateName,
  treeCount,
  twoRootsProblem,
  updateText,
} from "./spec.ts"
import { nothingSpent, Spending, type Spent } from "./spending.ts"

/** A SPEC line of the log: `SPEC: committed <path> (sha256 …)`. */
export const specLine = (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>): Line =>
  `${Tag.spec}: ${line(strings, ...args)}` as Line

/**
 * The SPEC line of what the breakdown's session `session` spent, as its results give it (§ 10):
 * `breakdown $4.1234 in 212 turns, 14m2s, session <id>`, or that it gave no result.
 */
export const spentLine = (spent: Spent, took: string, session: string): Line =>
  spent.results === 0
    ? specLine`claude session ${session} gave no result (${took})`
    : specLine`breakdown ${dollars(spent.costUsd)} in ${plural(spent.turns, "turn")}, ${took}, session ${session}`

/** What a spec run asks for. */
export interface SpecRequest {
  readonly spec: Spec
  readonly repo: string
  /** Break it down with the user (--refine). */
  readonly refine: boolean
  /** How long a headless breakdown may take (spec.timeout, --spec-timeout). */
  readonly timeLimit: Duration.Duration
  readonly effort: BreakdownStart["effort"]
  /** The files a spec run's setup wrote, committed with the spec; none where init had set it up. */
  readonly setup?: ReadonlyArray<string>
  /**
   * The scope a headless breakdown of a new spec goes on in once it has filed the environment
   * ticket, the run starting on that ticket (Early): the run's. None: the run waits for the end.
   */
  readonly earlyIn?: Scope.Scope
}

/** Where the spec run talks. */
export interface SpecIO {
  /** stdout: what the run says, and the breakdown's spinner. */
  readonly printer: Printer
  /** Says a line on stderr. */
  readonly error: (text: string) => Effect.Effect<void>
  /** The Interview view the refinement is shown in; none without a terminal to show it on. */
  readonly refine: Option.Option<InterviewScreen>
}

/** How the spec run's start ended: the root epic to run, or stopped with an exit code. */
export type SpecOutcome = Data.TaggedEnum<{
  Run: { readonly root: TicketId }
  /**
   * The breakdown filed the root epic and the environment ticket first: the run starts on that
   * ticket while it files the rest, in the scope `earlyIn` gave (orchestra-qd9e.1). `filing` says
   * what it has filed meanwhile, null once it is over; `rest` is how it ended, Run with the same
   * root epic, or Stopped, which stops the run.
   */
  Early: {
    readonly root: TicketId
    readonly environment: TicketId
    readonly filing: SubscriptionRef.SubscriptionRef<string | null>
    readonly rest: Effect.Effect<SpecOutcome>
    /** Stops the breakdown, as the run's end does where it hasn't finished. */
    readonly stop: Effect.Effect<void>
  }
  Stopped: { readonly exitCode: number }
}>

export const SpecOutcome = Data.taggedEnum<SpecOutcome>()

/**
 * Follows an early start's breakdown, `rest`, as the run goes on its environment ticket: one that
 * ends Stopped, failing or stopped, stops the run with `stop`, given its exit code, which is then
 * the run's; one that filed the rest leaves the run to go on.
 */
export const followRest = (
  rest: Effect.Effect<SpecOutcome>,
  stop: (exitCode: number) => Effect.Effect<unknown>,
): Effect.Effect<void> =>
  Effect.flatMap(rest, (ended) =>
    ended._tag === "Stopped" ? Effect.asVoid(stop(ended.exitCode)) : Effect.void,
  )

/** The most issues a breakdown that didn't finish lists. */
export const listedAtMost = 20

/** The command that carries the spec run on. */
export const carryOnLine = (spec: Spec, refine: boolean): string =>
  `Run it again to carry on: tutti --spec ${sanitizeLine(spec.given)}${refine ? " --refine" : ""}`

/** What the spec's tree holds, for a breakdown that didn't finish: its count and its issues. */
export const filedLines = (
  spec: Pick<Spec, "path">,
  issues: ReadonlyArray<Issue>,
  root: TicketId | null,
): ReadonlyArray<string> => {
  if (issues.length === 0) return []
  const epics = issues.filter((issue) => issue.type === "epic").length
  const shown = issues.slice(0, listedAtMost)
  return [
    `It filed ${plural(epics, "epic")} and ${plural(issues.length - epics, "ticket")} for ${spec.path}${root === null ? "" : `, under ${sanitizeLine(root)}`}:`,
    ...shown.map((issue) => `  ${issueLine(issue)}`),
    ...(issues.length > shown.length
      ? [
          `  … and ${issues.length - shown.length} more: bd list --metadata-field spec=${spec.path} --all`,
        ]
      : []),
  ]
}

/**
 * Commits the spec, looks up its tree, and breaks it down where it needs to be: the root epic to
 * run, or stopped with the exit code, having said why.
 */
export const specRun = (
  request: SpecRequest,
  io: SpecIO,
): Effect.Effect<
  SpecOutcome,
  never,
  AgentHost | AppConfig | Attention | Beads | Git | Log | Transcripts | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const log = yield* Log
    const { spec, repo } = request
    const stopped = (exitCode: number) => SpecOutcome.Stopped({ exitCode })
    const fail = (exitCode: number, lines: ReadonlyArray<string>, logged: Line) =>
      Effect.gen(function* () {
        for (const text of lines) yield* io.error(text)
        yield* log.write(logged)
        return stopped(exitCode)
      })
    const gitWhy = (error: GitError) =>
      sanitizeLine(
        error._tag === "GitFailed"
          ? error.stderr.trim().split("\n")[0] || `exit code ${error.exitCode}`
          : `git took longer than ${formatDuration(error.timeLimit)}`,
      )

    // The spec committed, so that workers can read it.
    const setup = request.setup ?? []
    // The commit and what it says go together, uninterruptible: a stop as it commits says what was
    // committed, the setup included.
    const said = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const committed = yield* Effect.result(commitSpec(spec, repo, setup))
        if (Result.isFailure(committed)) {
          const failure = committed.failure
          const why =
            "_tag" in failure && (failure._tag === "GitFailed" || failure._tag === "GitTimedOut")
              ? gitWhy(failure)
              : sanitizeLine(String(failure.message))
          return yield* fail(
            exitCodes.tool,
            [`tutti couldn't commit the spec ${spec.path}: ${why}`],
            specLine`couldn't commit ${spec.path}: ${why}`,
          )
        }
        const { commit } = committed.success
        if (committed.success.committed && setup.length > 0) {
          const files = plural(new Set([...setup, spec.path]).size, "file")
          yield* io.printer.print(
            `committed the setup with the spec ${spec.path} as ${short(commit)} (${files})`,
          )
          yield* log.write(
            specLine`committed the setup with ${spec.path} as ${short(commit)} (${files}; sha256 ${short(spec.sha256)})`,
          )
        } else if (committed.success.committed) {
          yield* io.printer.print(`committed the spec ${spec.path} (sha256 ${short(spec.sha256)})`)
          yield* log.write(specLine`committed ${spec.path} (sha256 ${short(spec.sha256)})`)
        } else {
          yield* io.printer.print(
            `the spec ${spec.path} is committed already (sha256 ${short(spec.sha256)})`,
          )
          yield* log.write(
            specLine`${spec.path} is committed already (sha256 ${short(spec.sha256)}, commit ${short(commit)})`,
          )
        }
        return { _tag: "Committed", commit: committed.success.commit } as const
      }),
    )
    if (said._tag !== "Committed") return said
    const { commit } = said

    // The tree an earlier run filed for it.
    const listed = yield* Effect.result(specIssues(spec.path))
    if (Result.isFailure(listed)) {
      const why = beadsWhy(listed.failure)
      return yield* fail(
        exitCodes.tool,
        [`tutti can't look for the spec's root epic, which an earlier run filed: ${why}`],
        specLine`can't look for the root epic of ${spec.path}: ${why}`,
      )
    }
    const state = specState(listed.success, spec.sha256)
    let mode: BreakdownMode
    switch (state._tag) {
      case "TwoRoots": {
        const problem = twoRootsProblem(spec.path, state.roots)
        return yield* fail(exitCodes.setup, [problem], specLine`${problem}`)
      }
      case "Built":
        yield* io.printer.say(`✓ ${spec.path} is built (${sanitizeLine(state.root.id)})`)
        yield* log.write(specLine`${spec.path} is unchanged, and ${state.root.id} is closed`)
        return stopped(exitCodes.ok)
      case "Unchanged":
        yield* io.printer.print(
          `the spec ${spec.path} is unchanged; carrying on with ${sanitizeLine(state.root.id)}`,
        )
        yield* log.write(specLine`${spec.path} is unchanged; carrying on with ${state.root.id}`)
        return SpecOutcome.Run({ root: state.root.id })
      case "New":
        mode = BreakdownMode.New()
        break
      case "Unfinished":
        yield* io.printer.print(
          `the breakdown that filed ${sanitizeLine(state.root.id)} didn't finish: carrying it on`,
        )
        yield* log.write(
          specLine`the breakdown that filed ${state.root.id} didn't finish: carrying it on`,
        )
        mode = BreakdownMode.Carry({
          root: state.root,
          filed: listed.success.filter((issue) => issue.id !== state.root.id),
        })
        break
      case "Changed": {
        yield* io.printer.print(
          `the spec ${spec.path} changed since ${sanitizeLine(state.root.id)} was filed: updating its tickets`,
        )
        yield* log.write(
          specLine`${spec.path} changed since ${state.root.id} was filed: updating its tickets`,
        )
        const diff = yield* specDiff(repo, spec.path, state.filedFor, commit)
        if (Result.isFailure(diff))
          yield* log.write(specLine`no diff of the change: ${diff.failure}`)
        const written = yield* Effect.result(
          writeRunFile(
            repo,
            specUpdateName,
            updateText({
              path: spec.path,
              root: state.root,
              filedFor: state.filedFor,
              commit,
              diff,
              tree: listed.success,
            }),
          ),
        )
        if (Result.isFailure(written)) {
          const why = sanitizeLine(written.failure.message)
          return yield* fail(
            exitCodes.tool,
            [`tutti couldn't write the spec's change for the breakdown: ${why}`],
            specLine`couldn't write ${specUpdateName}: ${why}`,
          )
        }
        mode = BreakdownMode.Update({ root: state.root, filedFor: state.filedFor })
        break
      }
    }
    return yield* breakDown(request, io, { commit, mode })
  })

/** The breakdown, and what follows its end. */
const breakDown = (
  request: SpecRequest,
  io: SpecIO,
  at: { readonly commit: string; readonly mode: BreakdownMode },
) =>
  Effect.gen(function* () {
    const log = yield* Log
    const spending = yield* Effect.serviceOption(Spending)
    const { spec } = request
    const update = at.mode._tag === "Update"
    const known = at.mode._tag === "New" ? null : at.mode.root.id
    const stopped = (exitCode: number) => SpecOutcome.Stopped({ exitCode })
    if (request.refine && Option.isNone(io.refine)) {
      yield* io.error(
        "tutti couldn't break the spec down: refining the spec needs you at tutti's screen, in a terminal and without --plain: tutti --spec <file> breaks it down unattended",
      )
      yield* log.write(specLine`not refined: no terminal`)
      return stopped(exitCodes.setup)
    }
    const began = yield* Clock.currentTimeMillis
    yield* log.write(
      request.refine
        ? specLine`refining ${spec.path} with claude and you`
        : specLine`breaking ${spec.path} down with claude (effort ${request.effort ?? "Claude Code's"}, time limit ${formatDuration(request.timeLimit)})`,
    )
    // What the breakdown had filed when it was stopped, said on the way out.
    let filedNow: BreakdownState | null = null
    // The breakdown once its session started, whose spending is logged as it ends.
    let opened: Breakdown | null = null
    /**
     * What its session spent in `took`, logged: its worker's sums, as it is the run's one session
     * of that worker (--spec and --feature don't go together). Nothing before it started.
     */
    const logSpent = (took: string) =>
      Effect.gen(function* () {
        if (opened === null) return
        const spent = Option.isSome(spending)
          ? yield* spending.value.ofTicket(opened.worker)
          : nothingSpent
        yield* log.write(spentLine(spent, took, opened.sessionId))
      })
    // The early start: once the root epic and the environment ticket are filed, the run starts on
    // that ticket, the breakdown going on in `request.earlyIn`; `filing` is its banner meanwhile.
    const earlyIn =
      request.earlyIn !== undefined && !request.refine && at.mode._tag === "New"
        ? request.earlyIn
        : null
    const environment = yield* Deferred.make<{
      readonly root: TicketId
      readonly ticket: TicketId
    }>()
    const filing = yield* SubscriptionRef.make<string | null>(null)
    let early = false
    const stoppedLines = () => {
      const root = filedNow?.root ?? known
      return [
        update
          ? `tutti: stopped while ${sanitizeLine(root ?? "the root epic")}'s tree was updated for the spec's change.`
          : root === null
            ? "tutti: stopped while the spec was broken down."
            : `tutti: stopped while the spec was broken down, with ${sanitizeLine(root)} filed.`,
        carryOnLine(spec, request.refine),
      ]
    }

    const whole = Effect.gen(function* () {
      const ended = yield* Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Effect.result(
            startBreakdown({
              spec,
              commit: at.commit,
              mode: at.mode,
              refine: request.refine,
              timeLimit: request.timeLimit,
              effort: request.effort,
            }),
          )
          if (Result.isFailure(started)) {
            return { _tag: "NotStarted", why: started.failure.reason } as const
          }
          const breakdown = started.success
          opened = breakdown
          // What it has filed, as it files: the epics in the log, the spinner's count.
          const said = new Set<string>()
          const watch = (spinner: OrganLine | null) =>
            SubscriptionRef.changes(breakdown.state).pipe(
              Stream.runForEach((now) =>
                Effect.gen(function* () {
                  filedNow = now
                  if (now.root !== null && !said.has(now.root)) {
                    said.add(now.root)
                    if (known === null) yield* log.write(specLine`filed the root epic ${now.root}`)
                  }
                  const counted = `${plural(now.epics, "epic")}, ${plural(now.tickets, "ticket")}`
                  if (earlyIn !== null && !early && now.root !== null && now.environment !== null) {
                    early = true
                    if (spinner !== null) yield* spinner.drop
                    yield* log.write(
                      specLine`the run starts on ${now.environment}, the environment ticket, while the breakdown files the rest of ${now.root}`,
                    )
                    yield* io.printer.say(
                      `Starting on ${sanitizeLine(now.environment)}, the environment ticket, while the breakdown files the rest`,
                    )
                    // The banner first, so that the run never looks with the breakdown not filing.
                    yield* SubscriptionRef.set(filing, `breaking the spec down: ${counted} filed`)
                    yield* Deferred.succeed(environment, {
                      root: now.root,
                      ticket: now.environment,
                    })
                  }
                  if (early) {
                    yield* SubscriptionRef.set(filing, `breaking the spec down: ${counted} filed`)
                  } else if (spinner !== null) {
                    yield* spinner.detail(
                      `${plural(now.epics, "epic")} · ${plural(now.tickets, "ticket")}`,
                    )
                  }
                }),
              ),
              Effect.forkScoped,
            )
          if (request.refine && Option.isSome(io.refine)) {
            yield* watch(null)
            const filed = yield* SubscriptionRef.make(false)
            yield* SubscriptionRef.changes(breakdown.state).pipe(
              Stream.runForEach((now) => SubscriptionRef.set(filed, filedAny(now))),
              Effect.forkScoped,
            )
            const shown = yield* inInterviewView(
              {
                description: `Break the spec ${spec.path} down into Beads tickets`,
                filing: yield* SubscriptionRef.make<Filing>(Filing.None()),
                filed,
                leaveQuestion: "End the breakdown?",
                send: breakdown.send,
                leave: breakdown.leave,
                ended: breakdown.ended,
              },
              io.refine.value,
            )
            return { _tag: "Ended", end: shown.ended, quit: shown.left === "quit" } as const
          }
          const spinner = yield* io.printer.organ(
            update
              ? "Updating the spec's tickets with Claude… (Ctrl+C stops)"
              : "Breaking the spec down with Claude… (Ctrl+C stops)",
          )
          yield* watch(spinner)
          // Every minute, how far it has got, in the log (which plain output prints).
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep(Duration.minutes(1))
                const now = yield* Clock.currentTimeMillis
                const state = filedNow
                yield* log.write(
                  specLine`breaking the spec down: ${plural(state?.epics ?? 0, "epic")} and ${plural(state?.tickets ?? 0, "ticket")} filed so far (${duration(now - began)})`,
                )
              }),
            ),
          )
          const end = yield* breakdown.ended.pipe(
            Effect.onInterrupt(() =>
              Effect.andThen(early ? Effect.void : spinner.drop, breakdown.leave),
            ),
          )
          if (early) {
            // The spinner went as the run started: its outcome is said below.
          } else if (end._tag === "Filed") {
            yield* spinner.done(
              update
                ? `Spec's tickets updated: ${treeCount(end.state.epics, end.state.tickets)} filed`
                : `Spec broken down: ${treeCount(end.state.epics, end.state.tickets)}`,
            )
          } else {
            yield* spinner.warn(update ? "Spec's tickets not updated" : "Spec not broken down")
          }
          return { _tag: "Ended", end, quit: false } as const
        }),
      ).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            for (const text of stoppedLines()) yield* io.error(text)
            yield* logSpent(duration((yield* Clock.currentTimeMillis) - began))
            yield* log.write(specLine`stopped while ${spec.path} was broken down`)
          }),
        ),
      )
      const took = duration((yield* Clock.currentTimeMillis) - began)
      if (ended._tag === "NotStarted") {
        const why = sanitizeLine(ended.why)
        yield* io.error(`tutti couldn't break the spec down: its session couldn't start: ${why}`)
        yield* log.write(specLine`claude session gave no result (it couldn't start: ${why})`)
        return stopped(exitCodes.tool)
      }
      yield* logSpent(took)
      return yield* afterBreakdown(request, io, {
        ...at,
        end: ended.end,
        quit: ended.quit,
        took,
        stoppedLines: stoppedLines(),
      })
    })
    if (earlyIn === null) return yield* whole
    // The breakdown in the run's scope, the run starting once it has filed the environment ticket.
    const fiber = yield* Effect.forkIn(
      whole.pipe(Effect.ensuring(SubscriptionRef.set(filing, null))),
      earlyIn,
    )
    const first = yield* Effect.raceFirst(
      Effect.map(Fiber.join(fiber), (outcome) => ({ _tag: "Done", outcome }) as const),
      Effect.map(Deferred.await(environment), (filed) => ({ _tag: "Early", filed }) as const),
    ).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
    if (first._tag === "Done") return first.outcome
    return SpecOutcome.Early({
      root: first.filed.root,
      environment: first.filed.ticket,
      filing,
      rest: Fiber.join(fiber),
      stop: Fiber.interrupt(fiber),
    })
  })

/** What follows the breakdown's end: the tree checked and marked filed, or the run stopped. */
const afterBreakdown = (
  request: SpecRequest,
  io: SpecIO,
  at: {
    readonly commit: string
    readonly mode: BreakdownMode
    readonly end: BreakdownEnd
    readonly quit: boolean
    readonly took: string
    readonly stoppedLines: ReadonlyArray<string>
  },
) =>
  Effect.gen(function* () {
    const log = yield* Log
    const { spec } = request
    const update = at.mode._tag === "Update"
    const known = at.mode._tag === "New" ? null : at.mode.root.id
    const stopped = (exitCode: number) => SpecOutcome.Stopped({ exitCode })
    const end = at.end
    const root = end.state.root ?? known
    /** What the spec's tree holds now, listed. */
    const listing = Effect.map(
      Effect.orElseSucceed(specIssues(spec.path), (): ReadonlyArray<Issue> => []),
      (issues) => filedLines(spec, issues, root),
    )
    const say = (lines: ReadonlyArray<string>) =>
      Effect.forEach(lines, (text) => io.error(text), { discard: true })

    switch (end._tag) {
      case "Left": {
        if (at.quit) {
          yield* say(at.stoppedLines)
          yield* log.write(specLine`stopped while ${spec.path} was refined`)
          return stopped(exitCodes.interrupted)
        }
        if (!filedAny(end.state)) {
          yield* io.printer.print("The refinement filed nothing; nothing to run.")
          yield* log.write(specLine`the refinement ended with nothing filed for ${spec.path}`)
          return stopped(exitCodes.ok)
        }
        yield* say([
          "tutti: the refinement ended without filing the tree, so there is nothing to run.",
          ...(yield* listing),
          carryOnLine(spec, true),
        ])
        yield* log.write(specLine`the refinement ended without filing the tree`)
        return stopped(exitCodes.setup)
      }
      case "NoTree": {
        const why = sanitizeLine(end.why)
        yield* say([
          "tutti: the spec's breakdown filed no tree, so there is nothing to run.",
          `It says: ${why}`,
          ...(yield* listing),
        ])
        yield* log.write(specLine`the breakdown filed no tree (${at.took}): ${why}`)
        return stopped(exitCodes.setup)
      }
      case "Failed": {
        const why = sanitizeLine(end.why)
        yield* say([
          update
            ? `tutti couldn't update the spec's tickets: ${why}`
            : `tutti couldn't break the spec down: ${why}`,
          ...(yield* listing),
          carryOnLine(spec, request.refine),
        ])
        yield* log.write(specLine`the breakdown failed: ${why} (${at.took})`)
        return stopped(end.usageLimit === true ? exitCodes.usageLimit : exitCodes.setup)
      }
      case "Filed":
        break
    }
    yield* log.write(
      specLine`filed ${plural(end.filed.ids.size, "issue")} from the breakdown's answer under ${end.root} (${at.took})`,
    )
    const checked = yield* Effect.result(checkFiled(end.root, spec.path))
    if (Result.isFailure(checked)) {
      const why = beadsWhy(checked.failure)
      yield* io.error(`tutti couldn't read the tree the spec's breakdown filed: ${why}`)
      yield* io.error(carryOnLine(spec, request.refine))
      yield* log.write(specLine`couldn't read the tree under ${end.root}: ${why}`)
      return stopped(exitCodes.tool)
    }
    const filed = checked.success
    if (filed.refused !== null) {
      yield* say([
        `tutti won't run what the spec's breakdown filed: ${filed.refused}`,
        ...(yield* listing),
      ])
      yield* log.write(specLine`won't run what the breakdown filed: ${filed.refused}`)
      return stopped(exitCodes.setup)
    }
    for (const warning of filed.warnings) {
      yield* io.error(`warning: ${warning}`)
      yield* log.write(specLine`warning: ${warning}`)
    }
    // Last of all: the tree is filed for this version of the spec.
    const marked = yield* Effect.result(markFiled(end.root, spec, at.commit))
    if (Result.isFailure(marked)) {
      const why = beadsWhy(marked.failure)
      yield* io.error(`tutti couldn't mark ${sanitizeLine(end.root)} as filed for the spec: ${why}`)
      yield* io.error(carryOnLine(spec, request.refine))
      yield* log.write(specLine`couldn't mark ${end.root} as filed: ${why}`)
      return stopped(exitCodes.tool)
    }
    const count = treeCount(filed.epics, filed.tickets)
    const id = sanitizeLine(end.root)
    yield* io.printer.print(
      update
        ? `updated ${id} for the spec's change (${count})`
        : `broke the spec down into ${id} (${count})`,
    )
    yield* log.write(
      update
        ? specLine`updated ${end.root} for the change (${count})`
        : specLine`broken down into ${end.root} (${count})`,
    )
    if (!request.refine && end.tree.assumptions.length > 0) {
      yield* io.printer.print(
        [
          "Assumed where the spec leaves a choice open:",
          ...end.tree.assumptions.map((a) => `  - ${sanitizeLine(a)}`),
        ].join("\n"),
      )
      for (const assumption of end.tree.assumptions)
        yield* log.write(specLine`assumed: ${assumption}`)
    }
    return SpecOutcome.Run({ root: end.root })
  })
