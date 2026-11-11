// The scheduler's dependencies and state (schedule.ts's make builds it once): the services it
// works over, its options, and what it keeps between fills, the slots (slots.ts) and the memo
// (queue.ts). Each operation of the scheduler takes it, so what one reads or changes is in its
// signature.
import { Effect, type FiberSet, Queue, Ref, type Scope, Semaphore } from "effect"
import { Log } from "../../core/log.ts"
import { Beads, type TicketId } from "../../services/Beads.ts"
import { EventStream } from "../eventstream.ts"
import { RunFibers } from "../fibers.ts"
import { type Gate, openGate } from "../holds.ts"
import { Ledger } from "../ledger.ts"
import { type Sayer, sayer } from "../say.ts"
import type { Options } from "../schedule.ts"
import type { Filter } from "../scope.ts"
import { type Memo, noMemo } from "./queue.ts"
import type { Slots } from "./slots.ts"

/** How far the run is through its ticket limit after `n` tickets: `n/limit`, or `n` with none. */
export const progress = (n: number, limit: number | null): string =>
  limit === null ? String(n) : `${n}/${limit}`

/** Whether `n` tickets started reach the run's ticket limit; never with none. */
export const reached = (n: number, limit: number | null): boolean => limit !== null && n >= limit

/**
 * The scheduler's dependencies and state, built once for the run (`scheduling`) and given to each
 * of its operations.
 */
export interface Scheduling {
  readonly options: Options
  readonly beads: Beads["Service"]
  readonly ledger: Ledger["Service"]
  readonly logs: Log["Service"]
  readonly events: EventStream["Service"]
  /** Logs a line and writes its warn record. */
  readonly warn: Sayer["warn"]
  /** The tickets' fibers: a ticket holds its slot for as long as its fiber is in the set. */
  readonly tickets: FiberSet.FiberSet<void, never>
  /** The slots: the tickets running, those started, and the issues and solo ticket held. */
  readonly slots: Ref.Ref<Slots>
  /** What the scheduler keeps between fills, each change one step. */
  readonly memo: Ref.Ref<Memo>
  /** Offered as a ticket's fiber ends and frees its slot, so that the slot is filled at once. */
  readonly freed: Queue.Queue<void>
  /** One fill, carry or recheck at a time. */
  readonly oneFill: Semaphore.Semaphore
  /** Whether the run may take work: the options' gate, or the ledger's wind-down and the limit. */
  readonly gate: Effect.Effect<Gate>
  /** Run before each start and carry, before the gate is read; nothing without the option. */
  readonly beforeStart: Effect.Effect<void>
  /** Whether the run holds a free slot at --machine-workers; never without the option. */
  readonly machineFull: Effect.Effect<boolean>
  /** The tickets whose workers wait to be resumed, dispatched afresh meanwhile by no fill. */
  readonly carrying: Effect.Effect<ReadonlySet<TicketId>>
  /** What bd ready is read with. */
  readonly filter: Filter
}

/** The scheduler's state over the run's Beads, Ledger, Log, EventStream and RunFibers. */
export const scheduling = (
  options: Options,
): Effect.Effect<Scheduling, never, Beads | Ledger | Log | EventStream | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { warn } = yield* sayer
    const tickets = yield* (yield* RunFibers).make<void, never>("tickets")
    const slots = yield* Ref.make<Slots>({
      running: new Set(),
      started: 0,
      issues: new Map(),
      solo: null,
    })
    // A ticket's fiber that ends wakes the poll, so its slot is filled at once.
    const freed = yield* Queue.sliding<void>(1)
    const oneFill = yield* Semaphore.make(1)
    const gate =
      options.gate ??
      Effect.map(
        Effect.all([ledger.current, Ref.get(slots)]),
        ([state, s]): Gate => ({
          ...openGate,
          windingDown: state.windDown !== null,
          limitReached: reached(s.started, options.limit),
        }),
      )
    const memo = yield* Ref.make(noMemo)
    return {
      options,
      beads,
      ledger,
      logs,
      events,
      warn,
      tickets,
      slots,
      memo,
      freed,
      oneFill,
      gate,
      beforeStart: options.beforeStart ?? Effect.void,
      machineFull: options.machineFull ?? Effect.succeed(false),
      carrying: options.carrying ?? Effect.succeed(new Set<TicketId>()),
      filter: { excludeTypes: options.excludeTypes },
    }
  })
