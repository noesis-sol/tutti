// What the scheduler keeps between fills (Memo), and the queue as it is shown to the dashboard
// and recorded in events.jsonl: its counts, the solo ticket, and why each waiting ticket is held
// back or skipped, as the log last said it.
import { Effect, Ref } from "effect"
import type { TicketId } from "../../services/Beads.ts"
import { type Said, saying, unsaid } from "../holds.ts"
import type { State } from "../ledger.ts"
import type { HoldBack, TicketPhase } from "../phase.ts"
import type { QueueShown } from "../schedule.ts"
import type { Slots } from "./slots.ts"
import type { Scheduling } from "./state.ts"

/** The reasons `said` holds, without the empty ones of tickets no longer held. */
const reasons = (said: Said): Readonly<Record<string, string>> =>
  Object.fromEntries([...said].filter(([, why]) => why !== ""))

/** The solo ticket running, or the one next, as queue and dispatch records give it. */
export interface SoloState {
  readonly ticket: TicketId
  readonly next?: true
}

/** The queue's counts among `ids`, as `state` has them with `change` made: a queue record's. */
export const counts = (
  state: State,
  ids: ReadonlyArray<TicketId>,
  solo: SoloState | null,
  change?: readonly [string, TicketPhase],
) => {
  let queued = 0
  const by: Partial<Record<HoldBack | "setup", number>> = {}
  for (const id of ids) {
    const phase = change?.[0] === id ? change[1] : state.tickets.get(id)?.phase
    if (phase?._tag === "Queued") queued++
    if (phase?._tag === "HeldBack") by[phase.why] = (by[phase.why] ?? 0) + 1
    // Back in the queue as its setup failed, it is held back until a ticket merges or a probe.
    if (phase?._tag === "Waiting" && phase.for._tag === "Setup") by.setup = (by.setup ?? 0) + 1
  }
  const held = Object.values(by).reduce((sum, n) => sum + n, 0)
  return {
    queued,
    ...(held > 0 ? { held, held_by: by } : {}),
    ...(solo === null ? {} : { solo }),
  }
}

/** The queue's counts for a record, `machine_full` with them while the run holds at the cap. */
export const recorded = (sched: Scheduling, ...args: Parameters<typeof counts>) =>
  Effect.map(sched.machineFull, (full) => ({
    ...counts(...args),
    ...(full ? { machine_full: true as const } : {}),
  }))

/**
 * What the scheduler keeps between fills, as its fills, the slots it frees and the queue it shows
 * share it: changed in one step each.
 */
export interface Memo {
  /** The parents of the tickets the run took up, for those closed and not merged yet. */
  readonly parentOf: ReadonlyMap<TicketId, TicketId | null>
  /** What holds each waiting ticket back, as last said. */
  readonly waitSaid: Said
  /** What each ticket was last skipped for, an overlap. */
  readonly skipSaid: Said
  /** The solo ticket next, which holds back the others while a slot is free. */
  readonly soloNext: TicketId | null
  /**
   * The solo ticket first in line at the last pick, even one made with every slot taken: no
   * recheck takes a slot ahead of it.
   */
  readonly soloFirst: TicketId | null
  /** The solo line last said. */
  readonly soloSaid: string
  /** The LIKELY_CONFLICT lines said, each once. */
  readonly warned: ReadonlySet<string>
  /**
   * What the branch of each ticket dispatched or carried changed on top of the base as it
   * started: one with some is footprinted from them while it runs, as it was when it started.
   */
  readonly startBranch: ReadonlyMap<TicketId, ReadonlyArray<string>>
  /** The tickets the queue draws from, as the last fill read them. */
  readonly unclosed: number | null
  /** The queue last shown. */
  readonly shownLast: string
  /** The candidates the last fill read, which a queue record counts. */
  readonly lastIds: ReadonlyArray<TicketId>
  /**
   * The tickets set aside (Deferred) that a fill found gone from bd ready, their fibers ended: one
   * bd ready lists again was undeferred outside the run, and is queued again while the run doesn't
   * hold. One bd couldn't defer, which bd ready still lists, is kept out of the run. So is one an
   * environment hold reopens itself (Deferred → Waiting), which it does once the run holds.
   */
  readonly leftReady: ReadonlySet<TicketId>
}

export const noMemo: Memo = {
  parentOf: new Map(),
  waitSaid: new Map(),
  skipSaid: new Map(),
  soloNext: null,
  soloFirst: null,
  soloSaid: "",
  warned: new Set(),
  startBranch: new Map(),
  unclosed: null,
  shownLast: "",
  lastIds: [],
  leftReady: new Set(),
}

/** Changes the memo in one step. */
export const remember = (sched: Scheduling, change: (m: Memo) => Memo): Effect.Effect<void> =>
  Ref.update(sched.memo, change)

/** Records the ticket's reason, waiting or skipped, and says whether it is one to say. */
export const said = (
  sched: Scheduling,
  which: "waitSaid" | "skipSaid",
  id: TicketId,
  why: string,
): Effect.Effect<boolean> =>
  Ref.modify(sched.memo, (m): readonly [boolean, Memo] => {
    const next = saying(m[which], id, why)
    return [next.say, { ...m, [which]: next.said }]
  })

/** Drops the ticket's reason, waiting or skipped: it is no longer held. */
export const forget = (
  sched: Scheduling,
  which: "waitSaid" | "skipSaid",
  id: TicketId,
): Effect.Effect<void> => remember(sched, (m) => ({ ...m, [which]: unsaid(m[which], id) }))

/** Notes `key` warned, and says whether it was fresh: a LIKELY_CONFLICT line is said once. */
export const warnOnce = (sched: Scheduling, key: string): Effect.Effect<boolean> =>
  Ref.modify(sched.memo, (m): readonly [boolean, Memo] =>
    m.warned.has(key) ? [false, m] : [true, { ...m, warned: new Set(m.warned).add(key) }],
  )

/** The solo ticket running, or else the one next. */
export const soloState = (s: Slots, soloNext: TicketId | null): SoloState | null =>
  s.solo !== null ? { ticket: s.solo } : soloNext !== null ? { ticket: soloNext, next: true } : null

/** The solo ticket running, or else the one next, as the slots and the memo have them now. */
export const soloNow = (sched: Scheduling): Effect.Effect<SoloState | null> =>
  Effect.map(Effect.all([Ref.get(sched.slots), Ref.get(sched.memo)]), ([s, m]) =>
    soloState(s, m.soloNext),
  )

/**
 * Writes a queue record of the tickets the last fill read, as they are now: for the machine's
 * hold (`machine_full`), which begins and ends without a ticket changing phase.
 */
export const recordQueue = (sched: Scheduling): Effect.Effect<void> =>
  Effect.gen(function* () {
    const solo = yield* soloNow(sched)
    yield* sched.events.emit({
      kind: "queue",
      ...(yield* recorded(
        sched,
        yield* sched.ledger.current,
        (yield* Ref.get(sched.memo)).lastIds,
        solo,
      )),
    })
  })

/** Shows the queue (Options.show) when it changed since it was last shown. */
export const showQueue = (sched: Scheduling): Effect.Effect<void> =>
  Effect.suspend(() => {
    const show = sched.options.show
    if (show === undefined) return Effect.void
    return Effect.flatMap(Ref.get(sched.slots), (s) =>
      Effect.flatMap(
        Ref.modify(sched.memo, (m): readonly [QueueShown | undefined, Memo] => {
          const solo = soloState(s, m.soloNext)
          const queue: QueueShown = {
            solo: solo === null ? null : { ticket: solo.ticket, running: solo.next !== true },
            unclosed: m.unclosed,
            waits: reasons(m.waitSaid),
            skips: reasons(m.skipSaid),
          }
          const key = JSON.stringify(queue)
          return key === m.shownLast ? [undefined, m] : [queue, { ...m, shownLast: key }]
        }),
        (queue) => (queue === undefined ? Effect.void : show(queue)),
      ),
    )
  })
