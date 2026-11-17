// A run's pulls from Linear (§ 5 item 20; tutti-qatu.7), only where the settings hold a linear block.
// bd's pull of a whole team overwrites every linked ticket, a held one too (spike 09), so each pull
// lists the team's issues from Linear's API (src/services/LinearIssues.ts) and pulls by key only
// those it may change (`choose`): an issue no ticket links, which becomes a ticket, and the issue of
// a linked ticket deferred here that left Backlog, which hands it over (Todo opens it). A ticket the
// run's ledger has is never pulled: one a worker has, one waiting to merge, one set aside in this
// run. One pull runs at the start, before the first fill, listing every issue not done; then one
// every pull_every in a fiber of the run's, listing those changed since the last listing, skipped
// while a pull holds `busy` or a push is queued or under way (the pushes' own busy, given to
// `every`), and waking a look when it added or released a ticket, until the run's end stops them
// (`stop`, end.ts's wind-down). Each push to Linear takes `busy`
// too (linearPush.ts), so none runs beside a pull: a pull that listed an issue a push had created
// but not yet linked would add a second ticket for it. Each
// is a `linear` record and its line; one that fails says LINEAR_PULL_FAILED and changes nothing,
// and the run goes on with the backlog it has.
import { Clock, Duration, Effect, Result, Semaphore } from "effect"
import { type Line, tagged } from "../core/log.ts"
import type { LinearSettings } from "../project/settings.ts"
import { type Beads, beadsWhy, type Issue } from "../services/Beads.ts"
import type { LinearIssuesSource, ListedIssue } from "../services/LinearIssues.ts"
import { type LinearKey, type LinearSync, linearWhy } from "../services/linearSync.ts"
import type { Sayer } from "./say.ts"

/**
 * How far before the last listing began a pull lists from: a clock here behind Linear's would miss
 * what changed meanwhile. Listing an issue twice is harmless: the second time it is linked.
 */
export const listOverlap: Duration.Duration = Duration.minutes(2)

/** The issues a pull takes, by what it does with them, each in the order Linear listed it. */
export interface Chosen {
  /** No ticket links it: it becomes a ticket. */
  readonly added: ReadonlyArray<LinearKey>
  /** Its tickets are deferred here and it is in Todo now: handed over, they open. */
  readonly released: ReadonlyArray<LinearKey>
  /** Its tickets are deferred here and it left Backlog for another state: started, done. */
  readonly updated: ReadonlyArray<LinearKey>
}

/** States whose new issue is no work to take: Linear's done ones. */
const done: ReadonlySet<string> = new Set(["completed", "canceled"])

/**
 * What a pull takes of `listed`, Linear's issues, given `linked`, the tickets that link a Linear
 * issue, and `held`, the tickets the run's ledger has: an issue no ticket links unless it is done,
 * and one whose tickets are all deferred, none of them held, that left Backlog. Any other linked
 * issue is never pulled, as a pull would overwrite its ticket with Linear's version.
 */
export const choose = (
  listed: ReadonlyArray<ListedIssue>,
  linked: ReadonlyArray<Issue>,
  held: ReadonlySet<string>,
): Chosen => {
  const tickets = new Map<string, Array<Issue>>()
  for (const issue of linked) {
    if (issue.linearKey !== undefined) {
      tickets.set(issue.linearKey, [...(tickets.get(issue.linearKey) ?? []), issue])
    }
  }
  const seen = new Set<string>()
  const added: Array<LinearKey> = []
  const released: Array<LinearKey> = []
  const updated: Array<LinearKey> = []
  for (const { key, state } of listed) {
    if (seen.has(key)) continue
    seen.add(key)
    const its = tickets.get(key) ?? []
    if (its.length === 0) {
      if (!done.has(state)) added.push(key)
    } else if (
      state !== "backlog" &&
      its.every((ticket) => ticket.status === "deferred" && !held.has(ticket.id))
    ) {
      if (state === "unstarted") released.push(key)
      else updated.push(key)
    }
  }
  return { added, released, updated }
}

/** What a pull did: what it took, less what bd skipped or failed, and those, with bd's why. */
export interface Pulled extends Chosen {
  readonly failed: ReadonlyArray<{ readonly key: string; readonly why: string }>
}

/** What `sync`, bd's pull of `chosen`, did with each, as bd's output says. */
export const pulledOf = (chosen: Chosen, sync: LinearSync): Pulled => {
  const failed = sync.items.flatMap((item) =>
    item.outcome === "failed" || item.outcome === "skipped"
      ? [{ key: item.name, why: item.why ?? item.outcome }]
      : [],
  )
  const out = new Set(failed.map((each) => each.key))
  const kept = (keys: ReadonlyArray<LinearKey>) => keys.filter((key) => !out.has(key))
  return {
    added: kept(chosen.added),
    released: kept(chosen.released),
    updated: kept(chosen.updated),
    failed,
  }
}

const list = (keys: ReadonlyArray<string>): string => keys.join(", ")

/** The line a pull from `team` that did `pulled` says: `LINEAR: pulled from NOE: added NOE-5`. */
export const pulledLine = (team: string, atStart: boolean, pulled: Pulled): Line => {
  const parts = [
    ...(pulled.added.length > 0 ? [`added ${list(pulled.added)}`] : []),
    ...(pulled.released.length > 0 ? [`released ${list(pulled.released)}`] : []),
    ...(pulled.updated.length > 0 ? [`updated ${list(pulled.updated)}`] : []),
    ...(pulled.failed.length > 0
      ? [`could not pull ${pulled.failed.map(({ key, why }) => `${key} (${why})`).join(", ")}`]
      : []),
  ]
  const what = parts.length === 0 ? "nothing new" : parts.join("; ")
  return tagged("LINEAR")`pulled from ${team}${atStart ? " at the start" : ""}: ${what}`
}

/** The line a pull that failed says, with `why`. */
export const pullFailedLine = (why: string): Line =>
  tagged("LINEAR_PULL_FAILED")`${why}; the run goes on with the backlog it has`

/** A run's pulls from Linear. */
export interface LinearPulls {
  /** The pull at the start, before the first fill: it waits for a pull or push under way. */
  readonly atStart: Effect.Effect<void>
  /**
   * The pulls every pull_every, for the run's fiber; none with pull_every 0. Each is skipped while
   * `pushing`, the pushes' busy, says a push is queued or under way.
   */
  every(pushing: Effect.Effect<boolean>): Effect.Effect<void>
  /**
   * Stops the pulls every pull_every, at the run's end: none begins from now, and it waits for one
   * under way to end, so that no pull is said after the run's end.
   */
  readonly stop: Effect.Effect<void>
  /** Held by a pull, and by a push, so that one runs at a time: a pull finding it held is skipped. */
  readonly busy: Semaphore.Semaphore
}

/** The pulls of a run whose settings hold `linear`, listing Linear's issues from `source`. */
export const make = (options: {
  readonly linear: LinearSettings
  readonly source: LinearIssuesSource
  readonly beads: Beads["Service"]
  /** The tickets the run's ledger has, which no pull changes. */
  readonly held: Effect.Effect<ReadonlySet<string>>
  readonly sayer: Sayer
  /** Wakes the run to look again, at a ticket a pull added or released. */
  readonly wakeUp: Effect.Effect<void>
}): Effect.Effect<LinearPulls> =>
  Effect.gen(function* () {
    const { linear, source, beads, held, sayer, wakeUp } = options
    const busy = yield* Semaphore.make(1)
    // Held by each pull every pull_every, which `stop` waits for; once stopped, none begins.
    const pulling = yield* Semaphore.make(1)
    let stopped = false
    // When the last pull that went through began listing, which the next lists the changes since.
    let listedAt: number | null = null

    const pull = (atStart: boolean): Effect.Effect<Pulled, string> =>
      Effect.gen(function* () {
        const began = yield* Clock.currentTimeMillis
        const since =
          atStart || listedAt === null ? null : listedAt - Duration.toMillis(listOverlap)
        const listed = yield* Effect.mapError(source.list(linear.team, since), (error) => error.why)
        const linked = yield* Effect.mapError(
          beads.list({ all: true, externalContains: "linear.app" }),
          (error) => `could not list the linked tickets: ${beadsWhy(error)}`,
        )
        const chosen = choose(listed, linked, yield* held)
        const keys = [...chosen.added, ...chosen.released, ...chosen.updated]
        const [first, ...rest] = keys
        const pulled =
          first === undefined
            ? { ...chosen, failed: [] }
            : pulledOf(
                chosen,
                yield* Effect.mapError(beads.linearPull([first, ...rest]), linearWhy),
              )
        // Only a pull that went through moves the next one's listing on: one that failed changed
        // nothing, so the next lists what it listed again.
        listedAt = began
        return pulled
      })

    const pullAndSay = (atStart: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pulled = yield* Effect.result(pull(atStart))
        if (Result.isFailure(pulled)) {
          yield* sayer.say({
            kind: "linear",
            sync: "pull",
            ...(atStart ? { start: true as const } : {}),
            why: pulled.failure,
            text: pullFailedLine(pulled.failure),
          })
          return
        }
        const { added, released, updated, failed } = pulled.success
        yield* sayer.say({
          kind: "linear",
          sync: "pull",
          ...(atStart ? { start: true as const } : {}),
          ...(added.length > 0 ? { added } : {}),
          ...(released.length > 0 ? { released } : {}),
          ...(updated.length > 0 ? { updated } : {}),
          ...(failed.length > 0 ? { failed: failed.map(({ key }) => key) } : {}),
          text: pulledLine(linear.team, atStart, pulled.success),
        })
        if (!atStart && added.length + released.length > 0) yield* wakeUp
      })

    return {
      atStart: busy.withPermits(1)(pullAndSay(true)),
      every: (pushing) =>
        Duration.isZero(linear.pull_every)
          ? Effect.void
          : Effect.forever(
              Effect.andThen(
                Effect.sleep(linear.pull_every),
                pulling.withPermits(1)(
                  Effect.suspend(() =>
                    stopped
                      ? Effect.void
                      : // Read under `busy`: a push queued after it waits for the pull to finish.
                        busy.withPermitsIfAvailable(1)(
                          Effect.flatMap(pushing, (going) =>
                            going ? Effect.void : pullAndSay(false),
                          ),
                        ),
                  ),
                ),
              ),
            ),
      stop: pulling.withPermits(1)(
        Effect.sync(() => {
          stopped = true
        }),
      ),
      busy,
    }
  })
