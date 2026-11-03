// The login check (§ 4.13), the run's own (run.ts makes it). Claude Code's workers share one OAuth
// login: as its access token expires overnight their refreshes can race, or the keychain may not
// be readable right after a wake, so one worker's turn can be refused (LoginRefused, login.ts) that
// a moment later would pass. So a turn refused for the login doesn't quit the run at once:
//
// - The first such worker holds the run: no new tickets start (the gate's loginHeld), the dashboard
//   shows the LOGIN_CHECK banner, and the log says `LOGIN_CHECK: t-1's turn was refused for Claude's
//   login (…); no new tickets while tutti checks the login again, in 30s`. The running workers go
//   on; one whose turn is refused meanwhile waits with it.
// - The check asks the login with the usage probe's turn (UsageProbe: a few tokens to haiku, billed
//   as workers are) checkAfter's waits after the hold: 30s, then 1m, then 2m. A probe answered, even
//   refused for the usage limit, passes: the hold lifts (`LOGIN_CHECK: lifted: …`), each waiting
//   worker you haven't steered is sent again what its refused turn was to tell it (loginBackText),
//   its ticket's saved texts forgotten, and the run takes tickets again.
// - Every probe failing, the run quits LOGIN as it did at once before (login.ts), each waiting
//   worker's texts saved for the next run to tell it again. A turn refused within againWithin of a
//   check that passed quits it at once: the login fails the workers though the probe gets through.
//
// What the refused turn was to tell its worker is saved on its ticket as it is refused (saveTold),
// so a quit for another reason meanwhile keeps it too. The environment probe's session, the
// interview's and the breakdown's are no ticket of the run's: a turn of theirs refused quits the run
// at once, as before.
import { Clock, Duration, Effect, FiberSet, Ref, type Scope, Semaphore } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { UsageProbe } from "../agent/UsageProbe.ts"
import { formatDuration } from "../project/configFile.ts"
import type { TicketId } from "../services/Beads.ts"
import { Store } from "../services/Store.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, Log, Tag, tagged } from "./log.ts"
import { type Refused, refusedLine, retellKey, saveTold } from "./login.ts"

/** The check's word, on its banner and its lines. */
export const holdWord = Tag.loginCheck

/** How long the check waits before each probe of the login, in order: then it gives up. */
export const checkAfter: ReadonlyArray<Duration.Duration> = [
  Duration.seconds(30),
  Duration.minutes(1),
  Duration.minutes(2),
]

/** How long after a check passed a turn refused again quits the run without another check. */
export const againWithin: Duration.Duration = Duration.minutes(10)

/** The line said as `refused` holds the run, the first probe due in `wait`. */
export const heldLine = (refused: Refused, wait: Duration.Duration): Line =>
  tagged(
    holdWord,
  )`${refused.ticket}'s turn was refused for Claude's login (${refused.error}); no new tickets while tutti checks the login again, in ${formatDuration(wait)}`

/** The line said as a probe of the login failed, for `reason`, the next due in `wait`. */
export const failedLine = (reason: string, wait: Duration.Duration): Line =>
  tagged(
    holdWord,
  )`a check of Claude's login failed too (${reason}); tutti checks it again in ${formatDuration(wait)}`

/** The line said as the check passed, `after` the hold began. */
export const liftedLine = (after: Duration.Duration): Line =>
  tagged(holdWord)`lifted: Claude's login passed a check ${formatDuration(after)} after the hold`

/** The line said as the run quits, `refused` first, after `checks` probes failed over `over`. */
export const gaveUpLine = (refused: Refused, checks: number, over: Duration.Duration): Line =>
  tagged(
    holdWord,
  )`${refused.ticket}'s turn was refused for Claude's login (${refused.error}), and ${checks} checks of it over ${formatDuration(over)} failed too: the run stops, its workers stopped and their sessions kept for the next run`

/** The line said as `refused` comes within againWithin of a check that passed, quitting the run. */
export const againLine = (refused: Refused): Line =>
  tagged(
    holdWord,
  )`${refused.ticket}'s turn was refused for Claude's login again (${refused.error}), within ${formatDuration(againWithin)} of a check of it passing: the run stops, its workers stopped and their sessions kept for the next run`

/** How the message a worker is sent once the login passes a check starts. */
export const loginBackHead =
  "tutti: your last turn was refused for Claude's login, and a check of the login passes now."

/**
 * What a worker whose turn was refused is sent once the login passes a check: the texts that turn
 * was to tell it, `told`, after loginBackHead; with none, to carry on where it left off.
 */
export const loginBackText = (told: ReadonlyArray<string>): string =>
  told.length === 0
    ? `${loginBackHead} Carry on where you left off.`
    : [`${loginBackHead} This is what tutti sent you then, sent again:`, ...told].join("\n\n")

/** The run's login check, which quits the run in R. */
export interface LoginCheck<R> {
  /** Whether it holds the run: no new tickets start. */
  readonly held: Effect.Effect<boolean>
  /** A worker's turn refused for the login (watchLogins). */
  readonly refused: (refused: Refused) => Effect.Effect<void, never, R>
}

/**
 * The run's login check. `show` puts its banner on (true) or off; `wakeUp` wakes the run, which
 * starts tickets again once it lifts; `quit` quits the run LOGIN, `line` said as it does, its stop
 * over `first`, the ticket whose refusal began it.
 */
export const make = <R>(options: {
  readonly show: (held: boolean) => Effect.Effect<void>
  readonly wakeUp: Effect.Effect<void>
  readonly quit: (first: Refused, line: Line) => Effect.Effect<void, never, R>
}): Effect.Effect<
  LoginCheck<R>,
  never,
  AgentHost | UsageProbe | Ledger | Log | EventStream | Store | Scope.Scope
> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const probe = yield* UsageProbe
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const store = yield* Store
    // When the hold began, and the refusal that began it; null while it doesn't hold the run.
    const since = yield* Ref.make<{ readonly at: number; readonly first: Refused } | null>(null)
    // When a check last passed, null before one has.
    const passed = yield* Ref.make<number | null>(null)
    const waiting = yield* Ref.make<ReadonlyMap<TicketId, Refused>>(new Map())
    // What each worker was sent again as a check passed, and the texts that was: a turn refused
    // again on it saves those, so that the next run doesn't wrap them twice.
    const resent = yield* Ref.make<ReadonlyMap<TicketId, readonly [string, ReadonlyArray<string>]>>(
      new Map(),
    )
    const probes = yield* FiberSet.make<void>()
    // Holding, lifting and taking refusals run one at a time, so no worker is told twice.
    const one = yield* Semaphore.make(1)

    const hold = (text: Line, lifted?: true) =>
      logs.writeWith(
        [text],
        events.emit({
          kind: "hold",
          text: tagged(Tag.hold)`${text}`,
          ...(lifted === undefined ? {} : { lifted }),
        }),
      )

    // The check passed: each waiting worker sent again what its refused turn was to tell it.
    const lift = Effect.gen(function* () {
      const began = yield* Ref.getAndSet(since, null)
      if (began === null) return
      const now = yield* Clock.currentTimeMillis
      yield* Ref.set(passed, now)
      yield* options.show(false)
      yield* hold(liftedLine(Duration.millis(now - began.at)), true)
      const due = yield* Ref.getAndSet(waiting, new Map())
      const entries = (yield* ledger.current).tickets
      for (const [ticket, refused] of due) {
        const entry = entries.get(ticket)
        if (entry?.steered === true) {
          yield* logs.write(
            detail`${ticket}: Claude's login passes again; you steer its worker, so tutti tells it nothing`,
          )
          continue
        }
        const phase = entry?.phase._tag
        // Its ticket went on without it meanwhile: set aside, or its hand-back ended.
        if (phase !== "Working" && phase !== "Resolving" && phase !== "Fixing") {
          yield* logs.write(
            detail`${ticket}: Claude's login passes again; its ticket is ${phase ?? "gone"} now, so tutti tells its worker nothing`,
          )
          continue
        }
        const text = loginBackText(refused.told)
        const sent = yield* Effect.result(host.send(ticket, { text, from: "clientComposed" }))
        if (sent._tag === "Success") {
          yield* Ref.update(resent, (all) => new Map(all).set(ticket, [text, refused.told]))
          yield* Effect.ignore(store.unsetMetadata(ticket, retellKey))
          yield* logs.write(
            detail`${ticket}: Claude's login passes again; its worker is sent its refused turn's messages again`,
          )
        }
      }
      yield* options.wakeUp
    }).pipe(one.withPermit)

    // Every check failed: the run quits.
    const giveUp = (reason: string) =>
      Effect.gen(function* () {
        const began = yield* Ref.get(since)
        if (began === null) return
        const now = yield* Clock.currentTimeMillis
        yield* logs.write(detail`the last check of Claude's login failed too (${reason})`)
        yield* options.quit(
          began.first,
          gaveUpLine(began.first, checkAfter.length, Duration.millis(now - began.at)),
        )
      }).pipe(one.withPermit)

    // Asks the login after each of checkAfter's waits, until a probe is answered.
    const checking = Effect.gen(function* () {
      for (const [tried, wait] of checkAfter.entries()) {
        yield* Effect.sleep(wait)
        const answer = yield* probe.probe(null)
        if (answer._tag !== "Unanswered") return yield* lift
        const next = checkAfter[tried + 1]
        if (next === undefined) return yield* giveUp(answer.reason)
        yield* logs.write(failedLine(answer.reason, next))
      }
    })

    // The texts its refused turn was to tell `ticket`'s worker: those it was sent again as a check
    // passed in place of that message.
    const unwrapped = (refused: Refused) =>
      Effect.map(Ref.get(resent), (all): Refused => {
        const [text, told] = all.get(refused.ticket) ?? []
        const [only] = refused.told
        return text !== undefined &&
          told !== undefined &&
          refused.told.length === 1 &&
          only === text
          ? { ...refused, told }
          : refused
      })

    const refused = (turn: Refused) =>
      Effect.gen(function* () {
        const ours = (yield* ledger.current).tickets.has(turn.ticket)
        // No ticket of the run's: the run quits, as before.
        if (!ours) return yield* options.quit(turn, refusedLine(turn))
        const refused = yield* unwrapped(turn)
        yield* Effect.provideService(saveTold(refused.ticket, refused.told), Store, store)
        yield* Ref.update(waiting, (all) => new Map(all).set(refused.ticket, refused))
        if ((yield* Ref.get(since)) !== null) {
          yield* logs.write(
            detail`${refused.ticket}: its turn was refused for Claude's login too; its worker waits for the check`,
          )
          return
        }
        const now = yield* Clock.currentTimeMillis
        const last = yield* Ref.get(passed)
        if (last !== null && now - last < Duration.toMillis(againWithin)) {
          return yield* options.quit(refused, againLine(refused))
        }
        yield* Ref.set(since, { at: now, first: refused })
        yield* options.show(true)
        yield* hold(heldLine(refused, checkAfter[0] ?? Duration.zero))
        yield* FiberSet.run(probes, checking)
      }).pipe(one.withPermit)

    return {
      held: Effect.map(Ref.get(since), (began) => began !== null),
      refused,
    } satisfies LoginCheck<R>
  })
