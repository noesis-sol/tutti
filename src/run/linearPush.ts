// Pushing to Linear in a run (the epic tutti-qatu's "Pushing", tutti-qatu.8), only where the
// settings' linear block turns the sync on: without it the run has `off`, and nothing here runs.
//
// A ticket's push is queued as its status changes in the run, read from the ledger's changes
// (followChanges): as its worker starts (it enters Working from the queue), as it merges and
// closes (Done), and as it is deferred or set aside for review. A ticket's end also queues a look
// for the tickets filed since the run began (a worker's follow-ups, what tutti files itself), each
// pushed once as it is found, which creates its Linear issue and links it.
//
// One fiber works the queue, one push at a time, after the ticket's own step is done: the step
// only queues it, so a merge never waits on Linear. Each push holds the sync, the pulls' `busy`
// (linearPull.ts), so that a pull and a push run one at a time: a pull racing the push of a ticket
// filed in the run would read it as not yet linked and import its issue again.
//
// Each push reads the ticket first: one linked to a Linear issue is pushed, and so is one filed in
// the run that isn't a question for the maintainer (label human), an epic or ephemeral; any other,
// the backlog's history, never is. A start is pushed once the worker has claimed its ticket, as bd
// has it open until then: it is read again every claimPoll, for up to claimWait, then pushed as it
// is. tutti pushes by ticket ID only, with the local version winning (Beads.linearPush).
//
// Each push is a `linear` record and a LINEAR line. A failed one is said so and kept: the end
// (finish), before the summary, looks for filed tickets once more, waits for the queue, tries each
// failed push once more, all within endWait, and lists what still failed, LINEAR_PUSH_FAILED. A
// push never sets a ticket aside or fails the run.
import {
  Cause,
  Clock,
  Duration,
  Effect,
  FiberSet,
  Queue,
  Ref,
  Result,
  type Scope,
  type Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { causeWhy, type Line, type Log, line, Tag, ticketLine } from "../core/log.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, beadsWhy, HumanLabel, type Issue, type TicketId } from "../services/Beads.ts"
import type { EventStream } from "../services/EventStream.ts"
import type { linearOutcomes } from "../services/events.ts"
import { linearWhy } from "../services/linearSync.ts"
import { RunFibers } from "./fibers.ts"
import type { State } from "./ledger.ts"
import { factsOf } from "./phase.ts"
import { sayer } from "./say.ts"

/** Why a ticket is pushed: its status changed in the run, or it was filed in it. */
export type PushWhy = "started" | "closed" | "deferred" | "set aside" | "filed"

/** The run's pushes to Linear. */
export interface LinearPushes {
  /** Queues `ticket`'s push, as `why` says; a ticket already queued is pushed once. */
  changed(ticket: TicketId, why: PushWhy): Effect.Effect<void>
  /** Queues a look for the tickets filed since the run began, each of which is pushed once. */
  readonly scan: Effect.Effect<void>
  /** Whether a push is under way or queued. */
  readonly busy: Effect.Effect<boolean>
  /**
   * The run's end: one more look for filed tickets, the queue waited for and each failed push
   * tried once more, within endWait, and LINEAR_PUSH_FAILED for each that still failed.
   */
  readonly finish: Effect.Effect<void>
}

/** No sync: nothing is pushed. */
export const off: LinearPushes = {
  changed: () => Effect.void,
  scan: Effect.void,
  busy: Effect.succeed(false),
  finish: Effect.void,
}

/**
 * How long a start's push waits for the worker's claim (read again every claimPoll, for up to
 * claimWait), and how long the run's end waits for the pushes (endWait).
 */
export const LinearPushTimes = {
  claimPoll: Duration.seconds(15),
  claimWait: Duration.minutes(5),
  endWait: Duration.minutes(1),
} as const

/** Whether `issue` is linked to a Linear issue: it has the issue's key. */
const linked = (issue: Issue): boolean => issue.linearKey !== undefined

/** The second the run began at `since` (epoch ms) began: bd keeps creation times to the second. */
const secondOf = (since: number): number => Math.floor(since / 1000) * 1000

/**
 * Whether `issue` was filed in a run that began at `since` (epoch ms) and is pushed as such: no
 * link to another tracker yet, created since the second the run began, and not a question for the
 * maintainer, an epic or ephemeral. A creation time that can't be read is no such ticket.
 */
export const filedIn = (issue: Issue, since: number): boolean => {
  const created = Date.parse(issue.createdAt)
  return (
    issue.externalRef === undefined &&
    !Number.isNaN(created) &&
    created >= secondOf(since) &&
    !issue.labels.includes(HumanLabel) &&
    issue.type !== "epic" &&
    issue.ephemeral !== true
  )
}

/** Whether `issue` is pushed in a run that began at `since`: linked, or filed in the run. */
export const pushable = (issue: Issue, since: number): boolean =>
  linked(issue) || filedIn(issue, since)

/**
 * The pushes the ledger's move from `before` to `after` asks for: a ticket that entered Working
 * from the queue (or from outside the run) started, one Done closed, one Deferred deferred, one in
 * Review set aside.
 */
export const pushesBetween = (
  before: State,
  after: State,
): ReadonlyArray<{ readonly ticket: TicketId; readonly why: PushWhy }> =>
  [...after.tickets.values()].flatMap(
    (entry): ReadonlyArray<{ ticket: TicketId; why: PushWhy }> => {
      const was = before.tickets.get(entry.ticket)?.phase
      if (was !== undefined && was._tag === entry.phase._tag) return []
      switch (entry.phase._tag) {
        case "Working":
          return was === undefined || factsOf(was).inQueue
            ? [{ ticket: entry.ticket, why: "started" }]
            : []
        case "Done":
          return [{ ticket: entry.ticket, why: "closed" }]
        case "Deferred":
          return [{ ticket: entry.ticket, why: "deferred" }]
        case "Review":
          return [{ ticket: entry.ticket, why: "set aside" }]
        default:
          return []
      }
    },
  )

/** What a push did, in the words of its line. */
const outcomeWords: Readonly<Record<(typeof linearOutcomes)[number], string>> = {
  created: "created",
  updated: "updated",
  skipped: "unchanged",
  failed: "failed",
}

/** `  LINEAR: t-1 closed, pushed to NOE-12 (updated)`. */
export const pushedLine = (
  id: TicketId,
  why: PushWhy,
  key: string | undefined,
  outcome: (typeof linearOutcomes)[number] | undefined,
): Line =>
  ticketLine(Tag.linear)`${id} ${why}, pushed${key === undefined ? "" : line` to ${key}`}${
    outcome === undefined ? "" : ` (${outcomeWords[outcome]})`
  }`

/** `  LINEAR: t-1 closed, not pushed: <why>; tried again at the run's end`. */
export const notPushedLine = (id: TicketId, why: PushWhy, reason: string): Line =>
  ticketLine(Tag.linear)`${id} ${why}, not pushed: ${reason}; tried again at the run's end`

/** `  LINEAR_PUSH_FAILED: t-1: <why>`, at the run's end. */
export const pushFailedLine = (id: TicketId, reason: string): Line =>
  ticketLine(Tag.linearPushFailed)`${id}: ${reason}`

/** `  LINEAR: could not list the tickets filed in the run: <why>`. */
export const scanFailedLine = (reason: string): Line =>
  ticketLine(Tag.linear)`could not list the tickets filed in the run: ${reason}`

/** What the queue holds: a ticket to push, or a look for the tickets filed in the run. */
type Item = { readonly _tag: "Push"; readonly ticket: TicketId } | { readonly _tag: "Scan" }

/** A push that failed: why it was pushed, and why it failed. */
interface Failed {
  readonly why: PushWhy
  readonly reason: string
}

/**
 * The run's pushes, for a run that began at `since` (epoch ms), its queue worked by a fiber of the
 * run's, each push holding `sync`, the pulls' `busy`, where the run pulls. `times` are
 * LinearPushTimes, for tests.
 */
export const make = (options: {
  readonly since: number
  readonly sync?: Semaphore.Semaphore
  readonly times?: Partial<{ readonly [K in keyof typeof LinearPushTimes]: Duration.Duration }>
}): Effect.Effect<LinearPushes, never, Beads | Log | EventStream | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const times = { ...LinearPushTimes, ...options.times }
    const beads = yield* Beads
    const { say } = yield* sayer
    const queue = yield* Queue.unbounded<Item>()
    // The tickets queued, each with why it is pushed: a later change replaces an earlier one's.
    const pending = new Map<TicketId, PushWhy>()
    let scanQueued = false
    // The tickets whose start waits for their worker's claim, each with when it was first queued.
    const claims = new Map<TicketId, number>()
    // The filed tickets found already, each pushed once as found.
    const found = new Set<TicketId>()
    const failures = new Map<TicketId, Failed>()
    // The items queued or being worked: the end waits for none.
    const outstanding = yield* SubscriptionRef.make(0)
    // The ticket the queue's fiber works on now, read or pushed, and why.
    let working: { readonly ticket: TicketId; readonly why: PushWhy } | undefined
    // Set by finish: a start waits for no claim, and nothing more is queued once it is over.
    let ending = false
    let over = false

    const offer = (item: Item) =>
      Effect.andThen(
        SubscriptionRef.update(outstanding, (n) => n + 1),
        Queue.offer(queue, item),
      )

    const changed = (ticket: TicketId, why: PushWhy): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (over) return Effect.void
        // A change since a start waiting for its claim pushes the ticket as it is now.
        if (why !== "started") claims.delete(ticket)
        const queued = pending.has(ticket)
        pending.set(ticket, why)
        return queued ? Effect.void : offer({ _tag: "Push", ticket })
      })

    const scan = Effect.suspend(() => {
      if (over || scanQueued) return Effect.void
      scanQueued = true
      return offer({ _tag: "Scan" })
    })

    const failed = (ticket: TicketId, why: PushWhy, reason: string, quiet: boolean) =>
      Effect.suspend(() => {
        failures.set(ticket, { why, reason })
        return quiet
          ? Effect.void
          : say({
              kind: "linear",
              sync: "push",
              ticket,
              outcome: "failed",
              why: reason,
              text: notPushedLine(ticket, why, reason),
            })
      })

    const fibers = yield* (yield* RunFibers).make<unknown, never>("linear")

    // Runs `effect` holding the sync, where the run pulls.
    const held = (effect: Effect.Effect<void>): Effect.Effect<void> =>
      options.sync === undefined ? effect : options.sync.withPermits(1)(effect)

    // Reads `ticket` and pushes it if it is to be pushed; `last`: the end's try, which says
    // nothing of a failure, as the end lists what still failed.
    const push = (ticket: TicketId, why: PushWhy, last: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const shown = yield* Effect.result(beads.show(ticket))
        if (Result.isFailure(shown)) {
          return yield* failed(ticket, why, beadsWhy(shown.failure), last)
        }
        const issue = shown.success
        if (!pushable(issue, options.since)) return
        // bd has a ticket open until its worker claims it: its start is pushed once it has.
        if (why === "started" && issue.status === "open" && !ending) {
          const now = yield* Clock.currentTimeMillis
          const first = claims.get(ticket) ?? now
          if (now - first < Duration.toMillis(times.claimWait)) {
            claims.set(ticket, first)
            yield* FiberSet.run(
              fibers,
              Effect.andThen(
                Effect.sleep(times.claimPoll),
                Effect.suspend(() =>
                  claims.has(ticket) && !ending ? changed(ticket, "started") : Effect.void,
                ),
              ),
            )
            return
          }
        }
        claims.delete(ticket)
        const sync = yield* Effect.result(beads.linearPush([ticket]))
        if (Result.isFailure(sync)) {
          return yield* failed(ticket, why, linearWhy(sync.failure), last)
        }
        const item = sync.success.items.find((each) => each.name === ticket)
        if (item?.outcome === "failed") {
          return yield* failed(ticket, why, item.why ?? "bd failed it", last)
        }
        failures.delete(ticket)
        // A push that created the issue linked the ticket to it: its key is read back.
        const key =
          issue.linearKey ??
          (item?.outcome === "created"
            ? yield* Effect.map(Effect.option(beads.show(ticket)), (read) =>
                read._tag === "Some" ? read.value.linearKey : undefined,
              )
            : undefined)
        yield* say({
          kind: "linear",
          sync: "push",
          ticket,
          ...(key === undefined ? {} : { issue: key }),
          ...(item?.outcome === undefined ? {} : { outcome: item.outcome }),
          text: pushedLine(ticket, why, key, item?.outcome),
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : failed(ticket, why, causeWhy(cause), last),
        ),
        held,
      )

    // Queues each ticket filed in the run not found before.
    const look = Effect.gen(function* () {
      const listed = yield* Effect.result(
        beads.list({ createdAfter: new Date(secondOf(options.since) - 1000).toISOString() }),
      )
      if (Result.isFailure(listed)) {
        const reason = beadsWhy(listed.failure)
        return yield* say({
          kind: "linear",
          sync: "push",
          outcome: "failed",
          why: reason,
          text: scanFailedLine(reason),
        })
      }
      for (const issue of listed.success) {
        if (found.has(issue.id) || !filedIn(issue, options.since)) continue
        found.add(issue.id)
        yield* changed(issue.id, "filed")
      }
    })

    const work = (item: Item): Effect.Effect<void> => {
      if (item._tag === "Scan") {
        scanQueued = false
        return look
      }
      const why = pending.get(item.ticket) ?? "filed"
      pending.delete(item.ticket)
      working = { ticket: item.ticket, why }
      return Effect.ensuring(
        push(item.ticket, why, false),
        Effect.sync(() => {
          working = undefined
        }),
      )
    }

    yield* FiberSet.run(
      fibers,
      Effect.forever(
        Effect.flatMap(Queue.take(queue), (item) =>
          Effect.ensuring(
            work(item),
            SubscriptionRef.update(outstanding, (n) => n - 1),
          ),
        ),
      ),
    )

    const busy = Effect.map(SubscriptionRef.get(outstanding), (n) => n > 0)

    // Waits until nothing is queued or being worked.
    const drained = SubscriptionRef.changes(outstanding).pipe(
      Stream.filter((n) => n === 0),
      Stream.take(1),
      Stream.runDrain,
    )

    const finish = Effect.gen(function* () {
      if (over) return
      ending = true
      // The starts still waiting for their claims are pushed as they are.
      for (const ticket of [...claims.keys()]) {
        claims.delete(ticket)
        yield* changed(ticket, "started")
      }
      yield* scan
      const done = yield* Effect.timeoutOption(
        Effect.gen(function* () {
          yield* drained
          for (const [ticket, { why }] of [...failures]) yield* push(ticket, why, true)
        }),
        times.endWait,
      )
      over = true
      // What the end's time left unpushed, the ticket under way and those queued, is pushed no
      // more: the queue's fiber stops, and its starts waiting for a claim with it.
      const left: ReadonlyArray<readonly [TicketId, PushWhy]> =
        done._tag === "None"
          ? [...(working === undefined ? [] : [[working.ticket, working.why] as const]), ...pending]
          : []
      yield* FiberSet.clear(fibers)
      const unpushed = `not pushed within the run end's ${formatDuration(times.endWait)}`
      for (const [ticket, why] of left) failures.set(ticket, { why, reason: unpushed })
      for (const [ticket, { reason }] of failures) {
        yield* say({
          kind: "linear",
          sync: "push",
          ticket,
          outcome: "failed",
          why: reason,
          last: true,
          text: pushFailedLine(ticket, reason),
        })
      }
    })

    return { changed, scan, busy, finish } satisfies LinearPushes
  })

/**
 * Queues the pushes the ledger's changes ask for (pushesBetween), and a look for filed tickets as
 * a ticket's part in the run ends (closed, deferred or set aside), when its worker has filed what
 * it found.
 */
export const followChanges = (
  changes: Stream.Stream<State>,
  pushes: Pick<LinearPushes, "changed" | "scan">,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const last = yield* Ref.make<State | undefined>(undefined)
    yield* Stream.runForEach(changes, (state) =>
      Effect.gen(function* () {
        const before = yield* Ref.getAndSet(last, state)
        if (before === undefined) return
        const asked = pushesBetween(before, state)
        for (const { ticket, why } of asked) yield* pushes.changed(ticket, why)
        if (asked.some(({ why }) => why !== "started")) yield* pushes.scan
      }),
    )
  })
