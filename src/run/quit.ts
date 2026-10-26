// Quitting (§ 4.8's Quitting, § 7.4's signals, D15, D18): what `q` in the quit box, a second
// Ctrl+C in the dashboard, and SIGINT, SIGTERM or SIGHUP in any mode ask for. The run (run.ts)
// takes the requests and goes through § 4.8's steps, in order:
//
// 1. scheduling stops, and the dashboard shows `Quitting…`, naming what it waits for;
// 2. every worker is interrupted at once (their open requests withdrawn, their queued messages
//    cancelled), and tutti waits for their results, quitWait at most for all of them together;
// 3. a merge under way finishes its protected step; a rebase in progress is aborted, and a check or
//    setup is killed, its ticket left waiting to merge (mergequeue.ts);
// 4. organ calls under way are aborted; triage and the report are skipped;
// 5. every session is closed;
// 6. state.json saves each worker not merged or dropped, with its session ID and why it was
//    suspended (`quit`);
// 7. the run ends INTERRUPTED, exit code 130.
//
// A second request says what is under way, a merge's protected step above all, and how to abandon
// it; a third ends tutti at once: the workers not merged or dropped are saved, the INTERRUPTED line
// names what was abandoned, and the process exits 130 (the reapers end the workers' and commands'
// process groups). A panic in one of the run's fibers ends the run the same way, PANIC (exit 4).
//
// The signals reach the run through runMain, which replaces BunRuntime.runMain's: while a run
// listens (listen), SIGINT, SIGTERM and SIGHUP go to it; otherwise they interrupt the command, as
// BunRuntime's do. SIGUSR1 winds the run down (drain.ts), SIGUSR2 as well: M0 found SIGUSR1 works
// in Bun (docs/spikes/06-bun-ffi.md, § 3), so SIGUSR2 is kept as an alias. SIGTSTP is ignored with a
// log line (D18).
import { Duration, Effect, Queue, Ref, Runtime, type Scope, Stream } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { settled } from "../agent/WorkerState.ts"
import type { TicketId } from "../services/Beads.ts"
import { detail, type Line, Log, line } from "./log.ts"

/** The signals that quit. */
export type QuitSignal = "SIGINT" | "SIGTERM" | "SIGHUP"

export const quitSignals: ReadonlyArray<QuitSignal> = ["SIGINT", "SIGTERM", "SIGHUP"]

/** The signals that wind the run down: SIGUSR1, and SIGUSR2 as its alias. */
export const drainSignals = ["SIGUSR1", "SIGUSR2"] as const

/** A request to quit now, and how it came, as the lines say it. */
export interface QuitRequest {
  /** `with Ctrl+C`, `by SIGTERM`, `from the dashboard`. */
  readonly how: string
  /** How to ask again: `press Ctrl+C again`, `send SIGTERM again`. */
  readonly again: string
}

/** The request a signal makes. A SIGINT is Ctrl+C in plain mode, as orchestra says it. */
export const quitBy = (signal: QuitSignal): QuitRequest =>
  signal === "SIGINT"
    ? { how: "with Ctrl+C", again: "press Ctrl+C again" }
    : { how: `by ${signal}`, again: `send ${signal} again` }

/**
 * The request a spec's breakdown makes when it fails, or is stopped, as the run goes on its
 * environment ticket (§ 4.14): the run stops as Ctrl+C stops it.
 */
export const breakdownFailed: QuitRequest = {
  how: "because the spec's breakdown failed",
  again: "press Ctrl+C",
}

/** The request of `q` in the quit box, or a second Ctrl+C in the dashboard (D15). */
export const fromDashboard: QuitRequest = {
  how: "from the dashboard",
  again: "press Ctrl+C again",
}

/** How long quitting waits for the interrupted workers' results, for all of them together. */
export const quitWait: Duration.Duration = Duration.seconds(10)

/** What the nth quit request does: the first quits, the second warns, a third exits at once. */
export type Heard = "quit" | "warn" | "exit"

export const heard = (n: number): Heard => (n <= 1 ? "quit" : n === 2 ? "warn" : "exit")

/** Something quitting waits for: a ticket's worker, or its merge. */
export interface Awaited {
  readonly ticket: TicketId
  readonly what: "worker" | "merge"
}

/** What quitting waits for, as the dashboard and the lines say it: `t-1's worker, t-2's merge`. */
export const waitingFor = (awaited: ReadonlyArray<Awaited>): string =>
  awaited.map((each) => `${each.ticket}'s ${each.what}`).join(", ")

/** What the dashboard says while quitting: `Quitting… waiting for t-1's worker`. */
export const quittingText = (awaited: ReadonlyArray<Awaited>): string =>
  awaited.length === 0 ? "Quitting…" : `Quitting… waiting for ${waitingFor(awaited)}`

/** The line quitting starts with: `QUIT with Ctrl+C: no new tickets; interrupting …`. */
export const quitLine = (request: QuitRequest, workers: ReadonlyArray<string>): Line => {
  const sorted = [...workers].sort()
  return sorted.length === 0
    ? line`QUIT ${request.how}: no new tickets; no worker is running`
    : line`QUIT ${request.how}: no new tickets; interrupting the workers of ${sorted} and saving their sessions for the next run`
}

/** A second request with a merge under way: `<id>'s merge is under way; press Ctrl+C again …`. */
export const underWayLine = (ticket: TicketId, request: QuitRequest): Line =>
  detail`${ticket}'s merge is under way; ${request.again} to abandon it`

/** A second request with no merge under way: what quitting still waits for. */
export const stillQuittingLine = (awaited: ReadonlyArray<Awaited>, request: QuitRequest): Line =>
  awaited.length === 0
    ? detail`quitting; ${request.again} to quit at once`
    : detail`quitting: waiting for ${waitingFor(awaited)}; ${request.again} to quit at once`

/** The workers that didn't answer their interrupt within quitWait. */
export const unansweredLine = (tickets: ReadonlyArray<TicketId>): Line =>
  detail`the workers of ${[...tickets].sort()} did not end their turns within ${Duration.format(quitWait)}; closing their sessions`

/**
 * The INTERRUPTED stop's text, after `WHY: `: `quit with Ctrl+C`, the sessions saved, and the
 * hand-backs left as they are (§ 5.1's Resolving and Fixing → Stopped).
 */
export const interruptedText = (
  how: string,
  saved: ReadonlyArray<string>,
  handedBack: ReadonlyArray<string>,
): string => {
  const sessions = [...saved].sort()
  const kept =
    sessions.length === 0
      ? ""
      : sessions.length === 1
        ? `; ${sessions[0]}'s session is saved for the next run`
        : `; the sessions of ${sessions.join(", ")} are saved for the next run`
  const left = [...handedBack].sort()
  const handed =
    left.length === 0
      ? ""
      : `; ${left.join(", ")} ${left.length === 1 ? "was" : "were"} handed back, the rebase or fix left as it is`
  return `quit ${how}${kept}${handed}`
}

/** The INTERRUPTED stop's text of a third request, which exits at once. */
export const atOnceText = (
  how: string,
  saved: ReadonlyArray<string>,
  abandoned: string | null,
): string => {
  const sessions = [...saved].sort()
  const kept = sessions.length === 0 ? "" : `; saved the sessions of ${sessions.join(", ")}`
  const merge =
    abandoned === null
      ? ""
      : `; abandoned ${abandoned}'s merge: git may still finish it, so check git status before starting another run`
  return `quit at once ${how}${kept}${merge}`
}

/** A panic's lines: where it came from and what it said, then its stack, each line indented. */
export const panicLines = (where: string, defect: unknown): ReadonlyArray<Line> => {
  const said = defect instanceof Error ? defect.message : String(defect)
  const stack = defect instanceof Error && defect.stack !== undefined ? defect.stack : ""
  const frames = stack
    .split("\n")
    .slice(1)
    .map((frame) => frame.trim())
    .filter((frame) => frame !== "")
  return [
    line`PANIC in ${where}: ${said.split("\n")[0] ?? ""}`,
    ...frames.map((frame) => detail`${frame}`),
  ]
}

/** SIGTSTP's line: tutti can't be suspended (D18). */
export const suspendIgnoredLine: Line = detail`SIGTSTP ignored: tutti can't be suspended; SIGUSR1 stops it after the current tickets, Ctrl+C quits`

/** Logs suspendIgnoredLine for each SIGTSTP `suspends` hears of, until the caller's scope closes. */
export const logSuspends = (
  suspends: Queue.Dequeue<void>,
): Effect.Effect<void, never, Log | Scope.Scope> =>
  Effect.flatMap(Log, (logs) =>
    Effect.asVoid(
      Effect.forkScoped(
        Effect.forever(Effect.andThen(Queue.take(suspends), logs.write(suspendIgnoredLine))),
      ),
    ),
  )

/** Whether a worker in `state` has no turn to wait for: its result is in, or it can't come. */
const answered = (state: WorkerState): boolean => settled(state) || state._tag === "UsageLimited"

/**
 * Interrupts the workers of `tickets` at once and waits for their results, `wait` at most for all
 * of them together, the interrupts included: the tickets whose workers hadn't answered by then.
 */
export const interruptWorkers = (
  tickets: ReadonlyArray<TicketId>,
  wait: Duration.Input = quitWait,
): Effect.Effect<ReadonlyArray<TicketId>, never, AgentHost> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const waiting = yield* Ref.make<ReadonlySet<TicketId>>(new Set(tickets))
    // Each interrupt and its result within `wait`: a CLI that never answers the interrupt's control
    // request holds quitting no longer than one that never ends its turn.
    const one = (ticket: TicketId) =>
      Effect.ignore(host.interrupt(ticket)).pipe(
        Effect.andThen(host.state(ticket).pipe(Stream.filter(answered), Stream.runHead)),
        Effect.ignore,
        Effect.andThen(
          Ref.update(waiting, (left) => new Set([...left].filter((t) => t !== ticket))),
        ),
      )
    yield* Effect.forEach(tickets, one, { concurrency: "unbounded", discard: true }).pipe(
      Effect.timeoutOption(wait),
    )
    return [...(yield* Ref.get(waiting))]
  })

// Where SIGINT, SIGTERM and SIGHUP go while a run listens: one listener at a time, the process's.
let listener: ((signal: QuitSignal) => void) | null = null

/** Sends SIGINT, SIGTERM and SIGHUP to `on` until the caller's scope closes. */
export const listen = (on: (signal: QuitSignal) => void): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const before = listener
      listener = on
      return before
    }),
    (before) =>
      Effect.sync(() => {
        listener = before
      }),
  )

/** Sends `signal` to the run listening, if one is; otherwise calls `otherwise`. */
export const route = (signal: QuitSignal, otherwise: () => void): void => {
  if (listener !== null) listener(signal)
  else otherwise()
}

/**
 * Catches SIGUSR1 and SIGUSR2, calling `drain` with the one that came, and SIGTSTP, calling `suspend` instead of letting
 * it stop tutti (D18), until the caller's scope closes. Without a handler SIGUSR1 kills tutti, so
 * this comes before tutti's PID is written anywhere a user might read it.
 */
export const catchSignals = (on: {
  readonly drain: (signal: (typeof drainSignals)[number]) => void
  readonly suspend: () => void
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const drains = drainSignals.map((signal) => [signal, () => on.drain(signal)] as const)
      const suspend = () => on.suspend()
      for (const [signal, drain] of drains) process.on(signal, drain)
      process.on("SIGTSTP", suspend)
      return { drains, suspend }
    }),
    ({ drains, suspend }) =>
      Effect.sync(() => {
        for (const [signal, drain] of drains) process.off(signal, drain)
        process.off("SIGTSTP", suspend)
      }),
  )

/**
 * Runs tutti's main Effect, as BunRuntime.runMain does, but with SIGINT, SIGTERM and SIGHUP going
 * to the run while one listens; otherwise they interrupt the Effect, which then exits 130.
 */
export const runMain: <E, A>(effect: Effect.Effect<A, E>) => void = Runtime.makeRunMain(
  ({ fiber, teardown }) => {
    let signalled = false
    const onSignal = (signal: QuitSignal) =>
      route(signal, () => {
        signalled = true
        fiber.interruptUnsafe(fiber.id)
      })
    const handlers = quitSignals.map((signal) => [signal, () => onSignal(signal)] as const)
    for (const [signal, handler] of handlers) process.on(signal, handler)
    fiber.addObserver((exit) => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
      teardown(exit, (code) => {
        if (signalled || code !== 0) process.exit(code)
      })
    })
  },
)
