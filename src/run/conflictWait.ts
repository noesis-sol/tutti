// A ticket in line waits for one whose conflict it would reopen (§ 5 item 7, merge.conflict_wait;
// tutti-mc6o). A ticket handed its rebase's conflicts holds on to the files they were in until its
// merge is over: merged, closed or set aside. A ticket that has not conflicted itself and whose branch
// changes one of those files is passed over in the line while that one resolves, fixes or is in line,
// as merging first would have it conflict again and spend another hand-back: Fabrica's run of
// 2026-11-04 merged fab-mgi.8.2 and fab-mgi.7.7 around fab-mgi.7.9's resolves, each overlap warned
// LIKELY_CONFLICT, until 7.9 was set aside.
//
// Only that ticket waits: the tickets behind it that change none of those files go on, so a wait costs
// the queue little. A conflict's holder in line goes first with no time limit, as nothing holds it up;
// one still with its worker holds a ticket back for merge.conflict_wait at most, counted from when
// that ticket first waited, so that a hung resolve, or a worker at the account's usage limit, doesn't
// hold it for long. A ticket that has conflicted itself waits for none, so two can't wait for each
// other, and its turn comes once it is in line.
//
// The files `queue.shared_files` name hold nothing here either, as they hold no two tickets apart: one
// nearly every ticket edits would stop the line, and its conflicts are cheap. Nor does anything with
// the queue's footprint off (§ 8.4), or a branch git can't say the files of.
import { Duration, Effect, Fiber, FiberSet, Ref, Result, type Scope } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import type { TicketId } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { RunFibers } from "./fibers.ts"
import { nfc, settingsGlobMatch } from "./glob.ts"
import { detail, Log } from "./log.ts"
import type { FinishedTicket, MergeTarget } from "./merge.ts"
import type { QueueState } from "./mergequeue.ts"
import { fileList } from "./setup.ts"

/** Where the tickets are in the queue, as far as a wait goes by it. */
type Line = Pick<QueueState, "waiting" | "merging" | "resolving">

/** A ticket with a conflict that a ticket's branch would reopen. */
interface Overlap {
  readonly by: TicketId
  /** The files of its conflict that the branch changes. */
  readonly files: ReadonlyArray<string>
  /** It is in line or merging, its worker done, rather than with its worker. */
  readonly inLine: boolean
}

/** A ticket waiting for its turn because of an Overlap, from when it first did until its turn. */
interface Wait {
  /** The ticket it was last said to wait for. */
  readonly by: TicketId
  /** merge.conflict_wait has passed: a ticket still with its worker holds it no longer. */
  readonly over: boolean
  /** Whether the line that it waits no longer was said. */
  readonly saidOver: boolean
  readonly timer: Fiber.Fiber<void>
}

interface State {
  /** The tickets handed their conflicts whose merge isn't over, with the files they were in. */
  readonly conflicted: ReadonlyMap<TicketId, ReadonlyArray<string>>
  readonly waits: ReadonlyMap<TicketId, Wait>
}

export interface ConflictWaits {
  /** The ticket's conflict in `files` is handed back to its worker: it holds them from now on. */
  conflicted(id: TicketId, files: ReadonlyArray<string>): Effect.Effect<void>
  /** The ticket's merge is over, or it isn't to be handed its conflict: it holds nothing. */
  over(id: TicketId): Effect.Effect<void>
  /** The tickets of `line.waiting` that nothing holds back, for the train to check ahead. */
  free(line: Line): Effect.Effect<ReadonlyArray<TicketId>>
  /** The ticket whose turn it is: the first in line nothing holds back. It says who waits for what. */
  next(line: Line): Effect.Effect<FinishedTicket | undefined>
  /** The ticket's turn has come: its wait is over. */
  taken(id: TicketId): Effect.Effect<void>
}

/** The ticket holding a ticket back, of those it overlaps: one in line, or one with its worker in time. */
const holderOf = (overlaps: ReadonlyArray<Overlap>, waitOver: boolean): Overlap | undefined =>
  overlaps.find((each) => each.inLine) ?? (waitOver ? undefined : overlaps[0])

/**
 * The queue's waits. `tickets`: the tickets in line by ID. `changed`: called when a wait runs out, for
 * the queue to look again at whose turn it is.
 */
export const make = (
  { repo, base }: MergeTarget,
  tickets: Effect.Effect<ReadonlyMap<TicketId, FinishedTicket>>,
  changed: Effect.Effect<void>,
): Effect.Effect<ConflictWaits, never, AppConfig | Git | Log | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const git = yield* Git
    const log = yield* Log
    const fibers = yield* RunFibers
    const { settings } = yield* AppConfig
    const limit = settings.merge.conflict_wait
    const on = settings.queue.footprint && Duration.toMillis(limit) > 0
    const shared = (file: string) =>
      settings.queue.shared_files.some((glob) => settingsGlobMatch(nfc(glob), nfc(file)))
    const ref = yield* Ref.make<State>({ conflicted: new Map(), waits: new Map() })
    const timers = yield* fibers.make<void>("conflict waits")

    const overlapsOf = (id: TicketId, line: Line) =>
      Effect.gen(function* () {
        const { conflicted } = yield* Ref.get(ref)
        const ticket = (yield* tickets).get(id)
        if (conflicted.size === 0 || conflicted.has(id) || ticket === undefined) return []
        const read = yield* Effect.result(git.changedFiles(repo, base, ticket.branch))
        if (Result.isFailure(read)) return []
        return [...conflicted].flatMap(([by, files]): ReadonlyArray<Overlap> => {
          const inLine = line.merging === by || line.waiting.includes(by)
          if (!inLine && !line.resolving.includes(by)) return []
          const both = files.filter((file) => read.success.includes(file))
          return both.length === 0 ? [] : [{ by, files: both, inLine }]
        })
      })

    const setWait = (id: TicketId, wait: Wait) =>
      Ref.update(ref, (now) => ({ ...now, waits: new Map(now.waits).set(id, wait) }))

    // Runs out by the time limit. Forked before it is kept, the sleep ending only after that.
    const startWait = (id: TicketId, by: TicketId) =>
      Effect.gen(function* () {
        const runOut = Effect.andThen(
          Ref.update(ref, (now) => {
            const wait = now.waits.get(id)
            return wait === undefined
              ? now
              : { ...now, waits: new Map(now.waits).set(id, { ...wait, over: true }) }
          }),
          changed,
        )
        const timer = yield* FiberSet.run(timers, Effect.andThen(Effect.sleep(limit), runOut))
        yield* setWait(id, { by, over: false, saidOver: false, timer })
      })

    const say = (id: TicketId, held: Overlap) =>
      log.write(
        detail`${id} waits to merge: ${held.by}'s rebase conflicted in ${fileList(held.files)}, which ${id} changes too, so ${held.by} goes first`,
      )

    return {
      conflicted: (id, files) => {
        const held = files.filter((file) => !shared(file))
        if (!on || held.length === 0) return Effect.void
        return Ref.update(ref, (now) => ({
          ...now,
          conflicted: new Map(now.conflicted).set(id, [
            ...new Set([...(now.conflicted.get(id) ?? []), ...held]),
          ]),
        }))
      },
      over: (id) =>
        Ref.update(ref, (now) => {
          if (!now.conflicted.has(id)) return now
          const conflicted = new Map(now.conflicted)
          conflicted.delete(id)
          return { ...now, conflicted }
        }),
      free: (line) =>
        Effect.filter(line.waiting, (id) =>
          Effect.gen(function* () {
            const overlaps = yield* overlapsOf(id, line)
            const wait = (yield* Ref.get(ref)).waits.get(id)
            return holderOf(overlaps, wait?.over ?? false) === undefined
          }),
        ),
      next: (line) =>
        Effect.gen(function* () {
          for (const id of line.waiting) {
            const ticket = (yield* tickets).get(id)
            if (ticket === undefined) continue
            const overlaps = yield* overlapsOf(id, line)
            const wait = (yield* Ref.get(ref)).waits.get(id)
            const held = holderOf(overlaps, wait?.over ?? false)
            if (held === undefined) {
              const by = overlaps[0]?.by
              if (by !== undefined && wait !== undefined && !wait.saidOver) {
                yield* setWait(id, { ...wait, saidOver: true })
                yield* log.write(
                  detail`${id} waits no longer: ${by} hasn't resolved its conflict after ${formatDuration(limit)}, and may conflict again once ${id} merges`,
                )
              }
              return ticket
            }
            if (wait === undefined) {
              yield* startWait(id, held.by)
              yield* say(id, held)
            } else if (wait.by !== held.by) {
              yield* setWait(id, { ...wait, by: held.by })
              yield* say(id, held)
            }
          }
          return undefined
        }),
      taken: (id) =>
        Effect.gen(function* () {
          const wait = yield* Ref.modify(ref, (now) => {
            const waits = new Map(now.waits)
            waits.delete(id)
            return [now.waits.get(id), { ...now, waits }] as const
          })
          if (wait !== undefined) yield* Fiber.interrupt(wait.timer)
        }),
    } satisfies ConflictWaits
  })
