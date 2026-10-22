// The run's side of the screen (§ 3.5, § 7.1): which screen it shows, the sources its RunView is
// projected from, and how it hands both to a dashboard. A run shows the dashboard when Tty says the
// terminal can draw one and main gave it one (run.ts); otherwise its output is plain (§ 7.6).
//
// The workers' states come from AgentHost, one stream per worker: a fiber follows the workers the
// host knows and starts following each one's state once the host knows it (from its first start,
// which comes after the ledger moves its ticket to Working), and forgets it once its stream ends
// (the worker ended). Their latest actions come from Transcripts, read for each ticket whose phase
// holds a worker every `actionPoll`: a tool call starts and ends without changing the worker's
// state, and a denied call stops being the latest action after its 10 s.
import { Data, Duration, Effect, type Scope, Stream, SubscriptionRef } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { Attention } from "../agent/Attention.ts"
import { type LatestAction, Transcripts } from "../agent/Transcripts.ts"
import type { WorkerState } from "../agent/WorkerState.ts"
import { type Commands, makeCommands } from "./commands.ts"
import type { TicketFiling } from "./fileTicket.ts"
import { keepsWorker, Ledger } from "./ledger.ts"
import { make as makeView, type RunView, type Sources, type Status, same } from "./runView.ts"

/** The screen the run shows. */
export type Screen = Data.TaggedEnum<{
  Dashboard: Record<never, never>
  /** The worker view of the ticket's worker (§ 7.5). */
  Worker: { readonly ticket: string }
  /** The interview of a new feature (§ 4.10). */
  Interview: Record<never, never>
}>

export const Screen = Data.taggedEnum<Screen>()

/** What the run hands a dashboard: what it reads, and the queue it writes commands to. */
export interface ScreenInputs {
  readonly view: SubscriptionRef.SubscriptionRef<RunView>
  readonly screen: SubscriptionRef.SubscriptionRef<Screen>
  readonly commands: Commands
  /** The workers' transcripts, which a worker view reads its own from (§ 3.5, § 7.5). */
  readonly transcripts: Transcripts["Service"]
  /** The tickets whose steered worker has a conflict hand-back waiting, for its view (§ 4.3). */
  readonly handBacks: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>
  /** How the tickets filed from finished workers' views went, by the view's uuid (§ 7.5). */
  readonly filings: SubscriptionRef.SubscriptionRef<ReadonlyArray<TicketFiling>>
}

/** A dashboard: shows `inputs` until the scope closes. */
export type Dashboard = (inputs: ScreenInputs) => Effect.Effect<void, never, Scope.Scope>

/** Each open worker's state, by its ticket: now, then on each change. */
export const workerStates: Effect.Effect<
  Stream.Stream<ReadonlyMap<string, WorkerState>>,
  never,
  AgentHost | Scope.Scope
> = Effect.gen(function* () {
  const host = yield* AgentHost
  const states = yield* SubscriptionRef.make<ReadonlyMap<string, WorkerState>>(new Map())
  const followed = new Set<string>()
  const ensure = (ticket: string): Effect.Effect<void, never, Scope.Scope> =>
    Effect.suspend(() => {
      if (followed.has(ticket)) return Effect.void
      followed.add(ticket)
      return Effect.asVoid(Effect.forkScoped(follow(ticket)))
    })
  // Once its stream ends, a worker the host still knows was started again: it is followed anew.
  const follow = (ticket: string): Effect.Effect<void, never, Scope.Scope> =>
    host.state(ticket).pipe(
      Stream.runForEach((state) =>
        SubscriptionRef.update(states, (all) => new Map(all).set(ticket, state)),
      ),
      Effect.ignore,
      Effect.andThen(Effect.sync(() => followed.delete(ticket))),
      Effect.andThen(host.current(ticket)),
      Effect.matchEffect({
        onSuccess: () => ensure(ticket),
        onFailure: () =>
          SubscriptionRef.update(states, (all) => {
            const left = new Map(all)
            left.delete(ticket)
            return left
          }),
      }),
    )
  yield* host.workers.pipe(
    Stream.runForEach((tickets) => Effect.forEach(tickets, ensure, { discard: true })),
    Effect.forkScoped,
  )
  return SubscriptionRef.changes(states)
})

/** How often the workers' latest actions are read. */
export const actionPoll = Duration.millis(500)

/** Each open worker's latest action, by its ticket: now, then on each change. */
export const latestActions: Effect.Effect<
  Stream.Stream<ReadonlyMap<string, LatestAction>>,
  never,
  Ledger | Transcripts | Scope.Scope
> = Effect.gen(function* () {
  const ledger = yield* Ledger
  const transcripts = yield* Transcripts
  const read = Effect.gen(function* () {
    const state = yield* ledger.current
    const found = new Map<string, LatestAction>()
    for (const entry of state.tickets.values()) {
      if (!keepsWorker(entry)) continue
      const action = yield* transcripts.action(entry.ticket)
      if (action !== undefined) found.set(entry.ticket, action)
    }
    return found
  })
  const actions = yield* SubscriptionRef.make<ReadonlyMap<string, LatestAction>>(yield* read)
  yield* Effect.gen(function* () {
    yield* Effect.sleep(actionPoll)
    const found = yield* read
    const before = yield* SubscriptionRef.get(actions)
    if (!same(Object.fromEntries(before), Object.fromEntries(found))) {
      yield* SubscriptionRef.set(actions, found)
    }
  }).pipe(Effect.forever, Effect.forkScoped)
  return SubscriptionRef.changes(actions)
})

/**
 * RunView's sources in a run: the ledger, the workers' states and latest actions, the open
 * requests, `status`.
 */
export const sources = (
  status: Stream.Stream<Status>,
): Effect.Effect<Sources, never, Ledger | AgentHost | Attention | Transcripts | Scope.Scope> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const attention = yield* Attention
    return {
      ledger: ledger.changes,
      workers: yield* workerStates,
      requests: attention.open,
      status,
      actions: yield* latestActions,
    }
  })

/**
 * Shows `dashboard` for the rest of the scope: RunView projected from the run's sources, `status`
 * now and on each change among them, the screen at the dashboard, an empty command queue, the
 * transcripts, no hand-backs waiting yet (the run follows its merge queue's into them), and no
 * filings.
 */
export const show = (
  dashboard: Dashboard,
  status: Stream.Stream<Status>,
): Effect.Effect<ScreenInputs, never, Ledger | AgentHost | Attention | Transcripts | Scope.Scope> =>
  Effect.gen(function* () {
    const inputs: ScreenInputs = {
      view: yield* makeView(yield* sources(status)),
      screen: yield* SubscriptionRef.make<Screen>(Screen.Dashboard()),
      commands: yield* makeCommands,
      transcripts: yield* Transcripts,
      handBacks: yield* SubscriptionRef.make<ReadonlyArray<string>>([]),
      filings: yield* SubscriptionRef.make<ReadonlyArray<TicketFiling>>([]),
    }
    yield* dashboard(inputs)
    return inputs
  })
