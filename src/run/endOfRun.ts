// The run's end (§ 5 item 14), once nothing is left to start or merge, or the run quit: the tickets
// still in a phase a run can't end in are Stopped and their sessions suspended (§ 4.8), as are the
// sessions of those that stopped the run, a worker still waiting on you suspended so (`waiting on
// you`); each ticket closed and not merged is labelled `unmerged`; then the summary lines (the run's
// figures among them, figures.ts), the
// closing line (the stops', or READY_EMPTY, LIMIT_REACHED or DRAINED, with a scoped run's SCOPE_
// part), and the full check when the run ended by itself having merged a ticket (fullcheck.ts).
import { Clock, Deferred, Duration, Effect, Result } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { type Section, section } from "../organs/evidence.ts"
import { Ending, type Summary } from "../print/summary.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { Notifier } from "../services/Notifier.ts"
import { Store } from "../services/Store.ts"
import { marks } from "../ui/marks.ts"
import { windowLabel } from "../ui/TitleLine.tsx"
import { saveAsked, saveLeft } from "./carry.ts"
import { drainedLine } from "./drain.ts"
import { EventStream } from "./eventstream.ts"
import { type FiguresLine, figuresLines, figuresText } from "./figures.ts"
import { fullCheck, fullCheckDue, fullCheckEvidence, fullCheckReport } from "./fullcheck.ts"
import { firstStop, type StopReason, type Stops, stopFor, stopsLine } from "./holds.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, type Line, Log, line } from "./log.ts"
import { closedAfter } from "./merge.ts"
import { finished } from "./notices.ts"
import { Cause, stopsAtEnd, type TicketPhase } from "./phase.ts"
import type { Quitting } from "./quitting.ts"
import { emptyStatus, project, type Row, type Totals } from "./runView.ts"
import { sayer } from "./say.ts"
import type { Scheduler } from "./schedule.ts"
import * as scope from "./scope.ts"
import { type SetUps, setupWaiting, setupWaitsPart } from "./setup.ts"
import { labelAtEnd } from "./unmerged.ts"
import { neverHanded, type UsageLimitHold } from "./usageLimit.ts"
import type { WorkEnv } from "./work.ts"

/** The time a run took, to the second: `2m5s`, `45s`, `1h12m`. */
export const runTime = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  return seconds === 0 ? "0s" : formatDuration(Duration.seconds(seconds))
}

/**
 * The run's summary as plain lines (§ 7.1): its title, its totals, its figures when it took any
 * ticket up, and every ticket's row.
 */
export const summaryLines = (s: {
  readonly version: string
  readonly base: string
  readonly scope: string | null
  readonly took: number
  readonly totals: Totals
  readonly figures: ReadonlyArray<FiguresLine>
  readonly rows: ReadonlyArray<Row>
}): ReadonlyArray<Line> => {
  const scoped = s.scope === null ? "" : line` · ticket ${s.scope}`
  const { totals } = s
  return [
    line`tutti ${s.version} on ${s.base}${scoped} · ${runTime(s.took)}`,
    detail`Completed ${totals.completed} · Set aside ${totals.deferred + totals.review} · Needs you ${totals.needsYou}`,
    ...(s.rows.length === 0 ? [] : s.figures.map((each) => detail`${figuresText(each)}`)),
    ...s.rows.map((row) => detail`${marks[row.mark]} ${row.ticket} ${row.word}: ${row.note}`),
  ]
}

/** The done line of a run that ended by itself, before a scoped run's SCOPE_ part. */
export const doneLine = (n: number, how: "drained" | "limit" | "empty"): Line =>
  how === "drained"
    ? drainedLine(n)
    : how === "limit"
      ? line`LIMIT_REACHED at ${n} tickets`
      : line`READY_EMPTY after ${n} tickets`

/**
 * `root`, when the run closed it, an epic whose last subticket merged in this run: its close reason
 * names a ticket the run merged. None when it didn't, or bd can't show it.
 */
const closedByRun = (
  beads: Beads["Service"],
  root: string,
  state: State,
): Effect.Effect<ReadonlySet<string>> =>
  beads.show(root).pipe(
    Effect.map((issue): ReadonlySet<string> => {
      const after = issue.status === "closed" ? closedAfter(issue.closeReason) : undefined
      return after !== undefined && state.tickets.get(after)?.phase._tag === "Done"
        ? new Set([root])
        : new Set()
    }),
    Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
  )

/** What the end's suspending left. */
export interface Suspended {
  /** The tickets whose sessions were saved, for the next run to resume. */
  readonly saved: ReadonlyArray<string>
  /** The tickets left handed back to their workers, their hand-backs sent. */
  readonly handedBack: ReadonlyArray<string>
  /** What the closing line says of the hand-backs kept for the usage limit's reset, never sent. */
  readonly neverSent: ReadonlyArray<string>
}

/** What the full check after the closing line said (fullCheck). */
export interface Checked {
  /** The lines it wrote after the closing line. */
  readonly said: ReadonlyArray<Line>
  /** Its evidence for the report. */
  readonly sections: ReadonlyArray<Section>
  /** What the report says after the reviewer's text: a failed full check, the end of its output. */
  readonly after: string
  /** The exit code of a quit, or a panic, that stopped it, or came as the run ended. */
  readonly code?: number
}

export interface EndOfRun {
  /**
   * The tickets a run can't end in Stopped, and every stopped ticket's session suspended, why each
   * was saying: past its ticket limit (`over`), waiting on you (`asking`), how the run `quit`, or
   * its first stop. Quitting's steps 5 and 6 are any end's: the sessions are closed, every open one
   * (`open`) when quitting, then state.json says why each was suspended; the tickets closed and not
   * merged are labelled `unmerged`. The hand-backs kept for the usage limit's reset and never sent,
   * the run ending first: the rebase whose conflicts the worker never saw is aborted, so that the
   * next run merges its ticket again rather than set it aside mid-rebase, and the closing line says
   * so (`neverSent`).
   */
  suspend(how: {
    readonly quit: Quitting | null
    readonly over: ReadonlySet<string>
    readonly asking: ReadonlySet<string>
    readonly stops: Stops
    readonly open: Effect.Effect<ReadonlyArray<string>>
  }): Effect.Effect<Suspended>
  /**
   * The run's figures as its records have them so far: the summary's, and the styled summary's
   * again after the full check, which they then count.
   */
  readonly figures: Effect.Effect<ReadonlyArray<FiguresLine>>
  /** Writes the summary of the run as `state` has it: its lines, and the styled summary's makings. */
  summary(
    state: State,
  ): Effect.Effect<{ readonly lines: ReadonlyArray<Line>; readonly summary: Summary }>
  /**
   * Writes the closing line, the stops' (`stops`), or how the run ended by itself, with its scope's
   * part, and records it: a run that ended by itself, having taken `took`, notifies that it
   * finished.
   */
  closing(
    state: State,
    stops: Stops,
    took: number,
  ): Effect.Effect<{ readonly line: Line; readonly ending: Ending }>
  /**
   * The full check, after a run that ended by itself, not `stopped`, having merged a ticket (its
   * tickets' `phases`); a request to quit, or a panic, while it runs stops it (FULL_CHECK_SKIPPED),
   * and the run ends INTERRUPTED (130), or PANIC (4), after all, as one that came as a run not
   * quit (`quit` null) ended does.
   */
  fullCheck(
    phases: ReadonlyArray<TicketPhase>,
    stopped: boolean,
    quit: Quitting | null,
  ): Effect.Effect<Checked>
}

/**
 * The end of the run `version` onto `base`, begun at `begun`, its quitting done by `quitting`: what
 * `usage`, `setUps` and `scheduler` leave of it. Its workers bill a `subscription` login, or not.
 */
export const make = (options: {
  readonly version: string
  readonly base: string
  readonly begun: number
  readonly subscription: boolean
  readonly usage: Pick<UsageLimitHold, "unsent">
  readonly setUps: SetUps
  readonly scheduler: Pick<Scheduler, "started" | "limitReached">
  readonly quitting: Deferred.Deferred<Quitting>
}): Effect.Effect<EndOfRun, never, WorkEnv | Notifier> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<WorkEnv | Notifier>()
    const config = yield* AppConfig
    const beads = yield* Beads
    const git = yield* Git
    const store = yield* Store
    const host = yield* AgentHost
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { say } = yield* sayer
    const notifier = yield* Notifier
    const { base, begun, setUps, scheduler, quitting } = options

    const suspend: EndOfRun["suspend"] = ({ quit, over, asking, stops, open }) =>
      Effect.gen(function* () {
        const ended = quit === null ? null : "panic" in quit ? quit.panic.why : "quit"
        const whyOf = (entry: { readonly ticket: string; readonly phase: TicketPhase }) =>
          entry.phase._tag === "Working" && over.has(entry.ticket)
            ? "TICKET_LIMIT"
            : entry.phase._tag === "Working" && asking.has(entry.ticket)
              ? "waiting on you"
              : (ended ?? stops[0]?.why ?? "run ended")
        const neverSent: Array<string> = []
        const unsent = [...(yield* options.usage.unsent)].sort(([a], [b]) => a.localeCompare(b))
        for (const [ticket, mode] of unsent) {
          const worktree = (yield* store.ticket(ticket))?.worktree
          if (mode === "fixing" || worktree === undefined) {
            neverSent.push(neverHanded(ticket, mode))
            continue
          }
          const rebasing = git.rebaseInProgress(worktree)
          yield* Effect.ignore(
            Effect.flatMap(rebasing, (on) => (on ? git.abortRebase(worktree) : Effect.void)),
          )
          const stuck = yield* Effect.result(rebasing)
          neverSent.push(
            neverHanded(
              ticket,
              mode,
              Result.isSuccess(stuck) && !stuck.success ? undefined : worktree,
            ),
          )
        }
        const suspended: Array<{ readonly ticket: string; readonly because: string }> = []
        const saved: Array<string> = []
        const handedBack: Array<string> = []
        for (const entry of (yield* ledger.current).tickets.values()) {
          const { ticket, phase } = entry
          const move = stopsAtEnd(phase)
          if (!move && phase._tag !== "Stopped") continue
          const because = phase._tag === "Stopped" ? phase.why : whyOf(entry)
          const session = (yield* store.ticket(ticket))?.session
          const records =
            session === undefined
              ? []
              : [{ kind: "suspended" as const, ticket, session, why: because }]
          if (move) {
            yield* ledger.transition(ticket, Cause.RunEnded({ why: because }), { beside: records })
          } else yield* Effect.forEach(records, (record) => events.emit(record), { discard: true })
          suspended.push({ ticket, because })
          if (session !== undefined) saved.push(ticket)
          const handed = phase._tag === "Resolving" || phase._tag === "Fixing"
          if (handed && !unsent.some(([each]) => each === ticket)) handedBack.push(ticket)
        }
        // The tickets left in the queue, waiting for a merge, a probe or a slot, end their part too.
        yield* ledger.endQueued
        // All at once: a session's Claude Code may take up to closeLimit to exit.
        const toClose = new Set(suspended.map((each) => each.ticket))
        if (quit !== null) for (const ticket of yield* open) toClose.add(ticket)
        yield* Effect.forEach(toClose, host.close, { concurrency: "unbounded", discard: true })
        // One whose worker never began has no session to resume: bd ready gives it to the next run.
        for (const each of suspended) {
          if (!saved.includes(each.ticket)) continue
          yield* Effect.ignore(store.suspend(each.ticket, each.because, "Stopped"))
        }
        yield* saveAsked
        yield* saveLeft
        yield* labelAtEnd({ repo: config.repo, base })
        return { saved, handedBack, neverSent }
      }).pipe(Effect.provideContext(context))

    const figures: EndOfRun["figures"] = Effect.map(events.figures, (sum) =>
      figuresLines(sum, { subscription: options.subscription, label: windowLabel }),
    )

    const summary: EndOfRun["summary"] = (state) =>
      Effect.gen(function* () {
        const view = project({
          ledger: state,
          workers: new Map(),
          requests: [],
          status: { ...emptyStatus, branch: base, concurrency: config.settings.concurrent },
        })
        const summarised: Summary = {
          version: options.version,
          branch: base,
          scope: config.ticket,
          took: (yield* Clock.currentTimeMillis) - begun,
          totals: view.totals,
          figures: yield* figures,
          rows: view.rows,
        }
        const lines = summaryLines({ ...summarised, base })
        yield* logs.write(...lines)
        return { lines, summary: summarised }
      })

    const closing: EndOfRun["closing"] = (state, stops, took) =>
      Effect.gen(function* () {
        // A scoped run's part of the closing line: `; SCOPE_DONE: …` or `; SCOPE_OPEN: …`.
        const scopePart = Effect.gen(function* () {
          const root = config.ticket
          if (root === null) return ""
          const view = scope.ledgerView(
            state,
            yield* closedByRun(beads, root, state),
            new Map(setupWaiting(state, yield* setUps.failures)),
          )
          const end = yield* scope.end(beads, root, view, {
            excludeTypes: config.settings.queue.exclude_types,
          })
          return `; ${scope.line(end)}`
        })
        const first = firstStop(stops)
        if (first !== null) {
          const text = stopsLine(stops)
          const record =
            !first.recorded || stops.length > 1
              ? events.emit({
                  kind: "stop",
                  detail: first.why,
                  ...(first.ticket === undefined ? {} : { ticket: first.ticket }),
                  ...(first.blocked === undefined ? {} : { blocked: first.blocked }),
                  text,
                })
              : Effect.void
          const ending = Ending.Stopped({ text: `${text}${yield* scopePart}` })
          yield* logs.writeWith([text], record)
          return { line: text, ending }
        }
        const n = yield* scheduler.started
        const how =
          state.windDown !== null ? "drained" : (yield* scheduler.limitReached) ? "limit" : "empty"
        const waits = setupWaitsPart(setupWaiting(state, yield* setUps.failures))
        const text = line`${doneLine(n, how)}${waits}${yield* scopePart}`
        yield* say({ kind: "done", text })
        yield* notifier.notify(finished([...state.tickets.values()].map((entry) => entry.phase)))
        return { line: text, ending: Ending.Done({ text, tickets: n, limit: config.limit, took }) }
      })

    // The stop of a quit, or a panic, after the loop: `when` it came, written and recorded.
    const lateStop = (late: Quitting, when: string) =>
      Effect.gen(function* () {
        const stop: StopReason =
          "panic" in late ? late.panic : stopFor("INTERRUPTED", `quit ${late.request.how} ${when}`)
        yield* say({ kind: "stop", detail: stop.why, text: stop.text })
        return { said: [stop.text], sections: [], after: "", code: stop.code } satisfies Checked
      })

    const checkFull: EndOfRun["fullCheck"] = (phases, stopped, quit) =>
      Effect.gen(function* () {
        const command = config.settings.checks.full.command
        if (fullCheckDue(command, stopped, phases)) {
          const checked = yield* Effect.raceFirst(
            Effect.map(
              Effect.flatMap(setUps.now, (setup) =>
                fullCheck({ base, started: begun, setup: setup.command }),
              ),
              (done) => ({ done }),
            ),
            Effect.map(Deferred.await(quitting), (quit) => ({ quit })),
          )
          if ("quit" in checked) return yield* lateStop(checked.quit, "during the full check")
          return {
            said: [checked.done.text],
            sections: [section("The full check", fullCheckEvidence(checked.done))],
            after: fullCheckReport(checked.done, command ?? ""),
          } satisfies Checked
        }
        if (quit === null && (yield* Deferred.isDone(quitting))) {
          // Asked to quit as the run ended: it ended all the same, INTERRUPTED.
          return yield* lateStop(yield* Deferred.await(quitting), "as the run ended")
        }
        return { said: [], sections: [], after: "" } satisfies Checked
      }).pipe(Effect.provideContext(context))

    return { suspend, figures, summary, closing, fullCheck: checkFull } satisfies EndOfRun
  })
