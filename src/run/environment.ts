// The environment hold and the probe (§ 2, § 4.9, § 5 item 11, § 5.1), as orchestra's
// environment.go. An environment-wide failure (a safety classifier refusing every command, a login
// that fails every turn) fails each worker the same way at once, whichever ticket it has. Setting
// each ticket aside in turn would burn through the queue, so the run holds instead: no new
// tickets, the running ones finish, and the tickets that failed this way are reopened (Deferred →
// Waiting), as they did nothing. Either signal holds it, with environment_hold.count tickets in a
// row:
//
// - their workers settled within environment_hold.window of dispatch with the ticket still open
//   (never claimed), no commits and a clean worktree;
// - triage blamed the environment with high confidence (blamed(), which the triage organ calls).
//
// A worker seen UsageLimited in its attempt counts for nothing (§ 4.12), as do a ticket back in
// the queue to wait for a merge and one set aside as it started; any other settling ends the row.
// Each ticket counts once in a row: one ticket failing again, as its setup does after each merge
// (retrySetups), doesn't fill the row alone.
// A ticket failing at once while the run holds is reopened too. A setup that failed in a ticket's
// worktree before its worker could start (setup.ts) adds to the row as a worker failing at once
// does, so that setups failing ticket after ticket hold the run rather than leave the queue to
// them; its ticket is back in the queue already, Waiting{setup}, and isn't reopened. So does a
// worker whose session didn't start or begin (START_FAILED from the Agent SDK: a Claude Code that
// can't be launched, a session that never sends its system/init), set aside as it started: else a
// machine where no session starts would defer the queue a ticket at a time. Its ticket is reopened
// as one whose worker failed at once is.
//
// Once nothing runs or waits to merge, and environment_hold.probe after, one session without a
// ticket is started in the main checkout, with no MCP servers and no worker prompt, and asked to
// run one command, which writes .tutti/run/probe. If it does within probeLimit, and the run's setup
// command, when it has one, passes in a new worktree of the base's head, as a ticket's new worktree
// has it (its whole output in the main checkout's .tutti/run/probe-setup.log), PROBE_OK: the hold
// ends, the reopened tickets, and those whose setup failed, go back to Queued and the run takes
// tickets again. If not, the run ends ENVIRONMENT (exit 7). Each hold is probed, the wait before
// each probe twice the one before, up to an hour (probeWait), so that a blip at 1am and another at
// 4am don't end the run, nor an environment that keeps failing spend sessions on it every few
// minutes. Triage's verdicts on tickets queued for it before the probe ended the hold count for
// nothing (the generation): they can come long after the probe has shown that the machine works.
// The probe shows as a card labelled `probe` (probing).
import { join } from "node:path"
import {
  Clock,
  Data,
  Duration,
  Effect,
  Option,
  Ref,
  Result,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { SessionKind } from "../agent/sessionKind.ts"
import { settled as isSettled, type WorkerState } from "../agent/WorkerState.ts"
import { AppConfig } from "../core/AppConfig.ts"
import { detail, Log, Tag, tagged, ticketLine } from "../core/log.ts"
import { O } from "../native/libc.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, beadsWhy, type TicketId } from "../services/Beads.ts"
import { Checks } from "../services/Checks.ts"
import type { EventStream } from "../services/EventStream.ts"
import { Git } from "../services/Git.ts"
import { sleepAwake } from "../services/Wake.ts"
import { readRunFile, runFolder, Worktrees, writeRunFile } from "../services/Worktrees.ts"
import { howFailed } from "./check.ts"
import { leftWarning, removeLeftWorktrees, worktreeWhy } from "./fullcheck.ts"
import { type StopReason, type Stops, stopFor } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { Move } from "./phase.ts"
import { sayer } from "./say.ts"
import type { Settled } from "./settle.ts"

/**
 * How a ticket's worker settled, as the hold counts it: failed at once (`atOnce`), no worker
 * started as the setup failed in its worktree (`setup`), or its session didn't start (`start`),
 * adding to the row; any other way (`other`), ending it; or counting for nothing (`uncounted`).
 */
export type Settling = "atOnce" | "setup" | "start" | "other" | "uncounted"

/** A ticket in the row failing at once, and how it failed. */
export interface FastFail {
  readonly ticket: TicketId
  readonly how: Exclude<Settling, "other" | "uncounted">
}

/** Triage's verdict on a deferred ticket, as the hold counts it (§ 6.2). */
export interface Verdict {
  readonly ticket: TicketId
  /** Its cause: `environment` blames the environment. */
  readonly cause: string
  /** `high` counts. */
  readonly confidence: string
  readonly summary: string
  /** The hold's generation as the ticket was queued for triage (EnvironmentHold.generation). */
  readonly generation: number
}

/** The probe's card (§ 4.9): when its session started. */
export interface ProbeView {
  readonly since: number
}

/** What the run does once nothing runs, as probe() says. */
export type Probed = Data.TaggedEnum<{
  /** The run ends with its stops as they are: no hold for the environment, or no probe for it. */
  Ends: Record<never, never>
  /** The probe ran its command: the hold's stop is lifted, and the run takes tickets again. */
  Resumed: Record<never, never>
  /** The probe failed: the run ends with `stop` in place of the hold's. */
  Failed: { readonly stop: StopReason }
}>

export const Probed = Data.taggedEnum<Probed>()

/** The probe's card's label. */
export const probeLabel = "probe"

/** The name AgentHost knows the probe's session by, as a ticket's worker is known by its ID. */
export const probeWorker = "tutti-probe" as TicketId

/** The run file, in the main checkout's .tutti/run/, the probe's command writes. */
export const probeFile = "probe"

/** How long the probe's session has to run its command, from its start, awake (§ 4.9, Wake.ts). */
export const probeLimit: Duration.Duration = Duration.minutes(5)

/** The longest wait before a probe that the doubling reaches, unless environment_hold.probe is longer. */
export const probeWaitMost: Duration.Duration = Duration.hours(1)

/**
 * How long the run waits, once nothing runs, before the probe of a hold after `probes` probes in
 * the run: environment_hold.probe (`after`) the first time, twice the wait before each time after,
 * up to probeWaitMost or `after`, whichever is longer.
 */
export const probeWait = (after: Duration.Duration, probes: number): Duration.Duration => {
  const most = Duration.max(after, probeWaitMost)
  const doubled = Duration.times(after, 2 ** Math.min(probes, 30))
  return Duration.min(doubled, most)
}

/** The prefix of the folder of the worktree the probe runs the setup in, under the worktrees' folder. */
export const probeFolderPrefix = "probe-setup-"

/**
 * Removes the probe's worktrees a run killed while the probe's setup ran left, as a run starts and
 * before each probe's setup (removeLeftWorktrees).
 */
export const removeLeftProbes: Effect.Effect<void, never, Worktrees | Log | EventStream> =
  removeLeftWorktrees(probeFolderPrefix, "the probe's")

/** The run file, in the main checkout's .tutti/run/, the probe's setup writes its output to. */
export const probeSetupLogName = "probe-setup.log"

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/** What the probe's session is asked, its command writing `file`. */
export const probePrompt = (file: string): string =>
  "tutti is checking that commands run on this machine; there is no ticket. Run exactly this one " +
  `shell command, then stop without doing anything else: echo ok > ${shellQuote(file)}`

/** Why the row of tickets failing at once holds the run. */
export const atOnceWhy = (tickets: ReadonlyArray<TicketId>, window: Duration.Duration): string =>
  `the last ${tickets.length} tickets (${tickets.join(", ")}) each settled within ${formatDuration(window)} of starting without being claimed or changed`

/**
 * Why the row of tickets failing at once holds the run: their workers settled at once, the setup
 * (`command`) failed in their worktrees, their sessions didn't start, or some of each.
 */
export const fastFailsWhy = (
  row: ReadonlyArray<FastFail>,
  window: Duration.Duration,
  command: string | null,
): string => {
  const tickets = row.map((each) => each.ticket)
  const last = `the last ${tickets.length} tickets (${tickets.join(", ")})`
  const setup = command === null ? "" : ` '${command}'`
  const hows = new Set(row.map((each) => each.how))
  if (hows.size === 1 && hows.has("atOnce")) return atOnceWhy(tickets, window)
  if (hows.size === 1 && hows.has("setup")) {
    return `the setup${setup} failed in the worktrees of the last ${tickets.length} tickets (${tickets.join(", ")})`
  }
  if (hows.size === 1) return `the sessions of ${last} didn't start`
  const ways = [
    ...(hows.has("setup") ? [`the setup${setup} failed in their worktree`] : []),
    ...(hows.has("start") ? ["their session didn't start"] : []),
    ...(hows.has("atOnce")
      ? [
          `their worker settled within ${formatDuration(window)} of starting without being claimed or changed`,
        ]
      : []),
  ]
  return `${last} each failed at once: ${ways.join(", or ")}`
}

/** Why the row of tickets triage blamed on the environment holds the run. */
export const blamedWhy = (tickets: ReadonlyArray<TicketId>, summary: string): string =>
  `triage blamed the environment for the last ${tickets.length} tickets (${tickets.join(", ")}) with high confidence (${summary.trim().replace(/\.$/, "")})`

/** The hold's stop: `ENVIRONMENT: <why>; check the machine, then restart`. */
export const holdStop = (why: string): StopReason =>
  stopFor("ENVIRONMENT", `${why}; check the machine, then restart`)

/** The stop of a hold whose probe, `after` the hold, failed as `failed` says. */
export const probeFailedStop = (why: string, after: Duration.Duration, failed: string) =>
  stopFor(
    "ENVIRONMENT",
    `${why}; a session probing the machine ${formatDuration(after)} later failed too: ${failed}; check the machine, then restart`,
  )

/** The stop of a hold whose probe's session, `after` the hold, ran its command but whose setup failed. */
export const probeSetupFailedStop = (why: string, after: Duration.Duration, failed: string) =>
  stopFor(
    "ENVIRONMENT",
    `${why}; a session probing the machine ${formatDuration(after)} later ran its command, but ${failed}; check the machine, then restart`,
  )

/** The time a worker settled in `state`: Idle's and Failed's own, else `now`. */
const settledAt = (state: WorkerState, now: number): number =>
  state._tag === "Idle" || state._tag === "Failed" ? state.at : now

/**
 * How the worker dispatched at `started` (epoch milliseconds) settled, as the hold counts it:
 * `limited` says it was UsageLimited in its attempt. It failed at once when it settled within the
 * window with its ticket still open, no commits beyond the base and a clean worktree.
 */
export const settlingOf = (input: {
  readonly settled: Settled
  readonly started: number
  readonly limited: boolean
}): Effect.Effect<Settling, never, AppConfig> =>
  Effect.gen(function* () {
    const { settled } = input
    if (input.limited) return "uncounted"
    // A setup problem stops the run itself (SETUP_PROBLEM): it isn't the environment failing.
    if (settled._tag === "Setup") return "uncounted"
    if (settled._tag !== "Read") return "other"
    const { reading, state } = settled
    if (reading._tag === "WaitsForMerge" || reading._tag === "MergedSinceCut") return "uncounted"
    if (reading._tag !== "Unfinished" || reading.status !== "open") return "other"
    const window = (yield* AppConfig).settings.environment_hold.window
    const at = settledAt(state, yield* Clock.currentTimeMillis)
    if (at - input.started >= Duration.toMillis(window)) return "other"
    // Read as it settled: a worktree with nothing done is removed once triage has its evidence.
    return reading.nothingDone ? "atOnce" : "other"
  })

/** The environment hold, the run's own (run.ts makes it); the triage organ calls blamed(). */
export interface EnvironmentHold {
  /** Counts a ticket's worker settling `how` toward the hold. */
  settled(ticket: TicketId, how: Settling): Effect.Effect<void>
  /** The hold's generation, for a ticket queued for triage now: blamed() takes it back. */
  readonly generation: Effect.Effect<number>
  /** Counts triage's verdict toward the hold. */
  blamed(verdict: Verdict): Effect.Effect<void>
  /**
   * Once nothing runs or waits to merge, with `stops` the run's: when the hold's stop is the only
   * one, waits probeWait and probes the machine, with `meanwhile` running as it does: the run's
   * loop is here, so no look runs.
   */
  probe(stops: Stops, meanwhile?: Effect.Effect<never>): Effect.Effect<Probed>
  /** The probe's card while its session runs, null otherwise: now, then each change. */
  readonly probing: Stream.Stream<ProbeView | null>
}

interface HoldState {
  /** The row of tickets whose workers failed at once, or whose setup failed. */
  readonly atOnce: ReadonlyArray<FastFail>
  /** The row of tickets triage blamed on the environment. */
  readonly blamed: ReadonlyArray<TicketId>
  /** The hold's stop, while the run holds for the environment. */
  readonly stop: StopReason | null
  readonly why: string
  /** How many probes the run has begun. */
  readonly probes: number
  readonly generation: number
}

const fresh: HoldState = {
  atOnce: [],
  blamed: [],
  stop: null,
  why: "",
  probes: 0,
  generation: 0,
}

/**
 * The run's environment hold. `onHold` holds the run with the hold's stop, as any stop does; the
 * run asks probe() what to do once nothing runs.
 */
export const make = (options: {
  readonly onHold: (stop: StopReason) => Effect.Effect<void>
  /** Where finished tickets land: the probe runs the setup on its head. */
  readonly base: string
  /** The run's setup command now, for the hold's why and the probe; checks.setup's by default. */
  readonly setup?: Effect.Effect<string | null>
}): Effect.Effect<
  EnvironmentHold,
  never,
  AppConfig | AgentHost | Beads | Checks | Git | Worktrees | Ledger | Log | EventStream
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const host = yield* AgentHost
    const beads = yield* Beads
    const checks = yield* Checks
    const git = yield* Git
    const worktrees = yield* Worktrees
    const ledger = yield* Ledger
    const logs = yield* Log
    const context = yield* Effect.context<Worktrees | Log | EventStream>()
    const { say, warn } = yield* sayer
    const { count, probe: after } = config.settings.environment_hold
    const state = yield* Ref.make(fresh)
    const probing = yield* SubscriptionRef.make<ProbeView | null>(null)
    // Counting and holding run one at a time, so a row is never counted twice.
    const one = yield* Semaphore.make(1)
    const setupNow = options.setup ?? Effect.succeed(config.settings.checks.setup.command)

    // Puts a ticket whose worker failed at once back in the queue to wait for the probe.
    const reopen = (id: TicketId) =>
      Effect.gen(function* () {
        const reopened = yield* Effect.result(beads.update(id, { status: "open" }))
        if (Result.isFailure(reopened)) {
          const text = ticketLine(
            Tag.reopenFailed,
          )`${id} failed at once like the tickets before it, and bd could not reopen it: ${beadsWhy(reopened.failure)}; reopen it with: bd update ${id} --status open`
          yield* warn(text, id)
          return
        }
        yield* Effect.ignore(
          beads.update(id, {
            appendNotes:
              "tutti: reopened; its worker failed at once, like the tickets before it, so the run held for the environment rather than for this ticket.",
          }),
        )
        const text = detail`${id} reopened: its worker failed at once, like the tickets before it`
        yield* ledger.transition(id, Move.Reopened(), {
          said: [
            { kind: "reopened", ticket: id, detail: "the run held for the environment", text },
          ],
        })
      })

    // Holds the run, once, and reopens the tickets of the row failing at once.
    const hold = (why: string) =>
      Effect.gen(function* () {
        const now = yield* Ref.get(state)
        if (now.stop !== null) return
        const stop = holdStop(why)
        yield* Ref.set(state, { ...now, stop, why })
        yield* options.onHold(stop)
        // A ticket whose setup failed is back in the queue already.
        const failed = now.atOnce.filter((each) => each.how !== "setup").map((each) => each.ticket)
        yield* Effect.forEach(failed, reopen, { discard: true })
      })

    const settled = (ticket: TicketId, how: Settling) =>
      Effect.gen(function* () {
        if (count === 0 || how === "uncounted") return
        if (how === "other") {
          yield* Ref.update(state, (now) => ({ ...now, atOnce: [] }))
          return
        }
        // A ticket in the row already isn't counted again.
        const now = yield* Ref.updateAndGet(state, (s) =>
          s.atOnce.some((each) => each.ticket === ticket)
            ? s
            : { ...s, atOnce: [...s.atOnce, { ticket, how }] },
        )
        if (now.stop !== null) {
          if (how !== "setup") yield* reopen(ticket)
        } else if (now.atOnce.length >= count) {
          const command = yield* setupNow
          yield* hold(fastFailsWhy(now.atOnce, config.settings.environment_hold.window, command))
        }
      }).pipe(one.withPermit)

    const blamed = (verdict: Verdict) =>
      Effect.gen(function* () {
        const before = yield* Ref.get(state)
        if (count === 0 || verdict.generation !== before.generation) return
        if (verdict.cause !== "environment" || verdict.confidence !== "high") {
          yield* Ref.set(state, { ...before, blamed: [] })
          return
        }
        if (before.blamed.includes(verdict.ticket)) return
        const now = { ...before, blamed: [...before.blamed, verdict.ticket] }
        yield* Ref.set(state, now)
        if (now.blamed.length >= count) yield* hold(blamedWhy(now.blamed, verdict.summary))
      }).pipe(one.withPermit)

    // Whether `.tutti/run/probe` in the main checkout says the probe's command ran.
    const ran = readRunFile(config.repo, probeFile).pipe(
      Effect.map((text) => text.trim() === "ok"),
      Effect.orElseSucceed(() => false),
    )

    // Why the probe's session didn't show its command ran, from its state.
    const unran = (worker: WorkerState): string | undefined => {
      switch (worker._tag) {
        case "Idle":
        case "Closed":
          return "it stopped without running its command"
        case "Failed":
          return `its turn failed without running its command: ${worker.error}`
        case "Gone":
          return `it went away without running its command: ${worker.why}`
        case "UsageLimited":
          return "it reached the account's usage limit without running its command"
        case "LoginRefused":
          return `Claude's login was refused without its command run: ${worker.error}`
        case "ApiUnavailable":
          return `Claude's API was unavailable without its command run: ${worker.error}`
      }
      return undefined
    }

    // Runs the probe's session: why it failed, or null once its command ran.
    const runProbe = Effect.gen(function* () {
      const file = join(config.repo, runFolder, probeFile)
      const cleared = yield* Effect.result(writeRunFile(config.repo, probeFile, ""))
      if (Result.isFailure(cleared))
        return `${file} could not be cleared: ${cleared.failure.message}`
      yield* SubscriptionRef.set(probing, { since: yield* Clock.currentTimeMillis })
      const started = yield* Effect.result(
        Effect.andThen(
          host.start(probeWorker, {
            sessionId: crypto.randomUUID(),
            cwd: config.repo,
            kind: SessionKind.Probe(),
          }),
          host.send(probeWorker, { text: probePrompt(file), from: "clientComposed" }),
        ),
      )
      if (Result.isFailure(started)) return `it could not be started: ${started.failure.message}`
      yield* logs.write(detail`probe session started in ${config.repo}`)
      // Its command ran, or it settled or reached the usage limit without: why, or null.
      const verdict = (worker: WorkerState) =>
        Effect.map(ran, (ok) =>
          ok
            ? null
            : isSettled(worker) ||
                worker._tag === "UsageLimited" ||
                worker._tag === "LoginRefused" ||
                worker._tag === "ApiUnavailable"
              ? unran(worker)
              : undefined,
        )
      const outcome = host.state(probeWorker).pipe(
        Stream.mapEffect(verdict),
        Stream.filter((why) => why !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrElse(() => "it went away without running its command")),
        Effect.catchTag("AgentGone", (error) =>
          Effect.succeed(`it went away without running its command: ${error.why}`),
        ),
      )
      return yield* Effect.raceFirst(
        outcome,
        Effect.as(sleepAwake(probeLimit), `it ran no command within ${formatDuration(probeLimit)}`),
      )
    }).pipe(
      Effect.ensuring(Effect.andThen(host.end(probeWorker), SubscriptionRef.set(probing, null))),
    )

    // Runs the run's setup in a new worktree of the base's head, as a ticket's new worktree has it,
    // the worktree removed after: why it failed, or null once it passed or there is none.
    const probeSetup = Effect.gen(function* () {
      const command = yield* setupNow
      if (command === null) return null
      const { base } = options
      const file = join(config.repo, runFolder, probeSetupLogName)
      const what = `the setup '${command}'`
      // The probe's worktrees a run killed while its setup ran left behind.
      yield* removeLeftProbes
      const head = yield* Effect.result(git.revParse(config.repo, base))
      if (Result.isFailure(head)) {
        return `${what} couldn't run on ${base}: ${worktreeWhy(head.failure)}`
      }
      const made = yield* Effect.result(worktrees.addDetached(probeFolderPrefix, head.success))
      if (Result.isFailure(made)) {
        const error = made.failure
        const why = error._tag === "ExcludeUnwritable" ? error.message : worktreeWhy(error)
        return `${what} couldn't run on ${base}: no worktree for it (${why})`
      }
      const path = made.success
      yield* logs.write(detail`probe: running '${command}' in a new worktree of ${base} (${path})`)
      const ran = Effect.scoped(
        Effect.gen(function* () {
          const fd = yield* worktrees.openRunFile(
            config.repo,
            probeSetupLogName,
            O.WRONLY | O.CREAT | O.TRUNC,
          )
          const to = { cwd: path, outputFile: file, outputFd: fd }
          return yield* Effect.result(checks.setup({ ...to, before: "fast", command }))
        }),
      )
      const outcome = yield* Effect.result(ran).pipe(
        Effect.ensuring(
          Effect.catch(worktrees.removeDetached(path), (error) =>
            leftWarning(path, error, "the probe's"),
          ),
        ),
      )
      if (Result.isFailure(outcome)) {
        return `${what} couldn't run: its output can't be kept in ${file} (${outcome.failure.message})`
      }
      const set = outcome.success
      if (Result.isFailure(set)) {
        return `${what} ${howFailed(set.failure)} in a new worktree of ${base} (the whole output is in ${file})`
      }
      return null
    }).pipe(Effect.provide(context))

    // Puts each ticket the hold reopened, or whose setup failed, back in the queue, Waiting → Queued.
    const requeue = Effect.gen(function* () {
      for (const entry of (yield* ledger.current).tickets.values()) {
        const { phase } = entry
        if (
          phase._tag !== "Waiting" ||
          (phase.for._tag !== "Probe" && phase.for._tag !== "Setup")
        ) {
          continue
        }
        const queued =
          [...(yield* ledger.current).tickets.values()].filter(
            (each) => each.phase._tag === "Queued",
          ).length + 1
        yield* ledger.transition(entry.ticket, Move.Requeued(), {
          beside: [{ kind: "queue", queued }],
          lines: [detail`${entry.ticket}: the probe passed; back in the queue`],
        })
      }
    })

    // Waits `wait`, or until the run winds down: whether it waited.
    const waitToProbe = (wait: Duration.Duration) =>
      Effect.raceFirst(
        Effect.as(Effect.sleep(wait), true),
        ledger.changes.pipe(
          Stream.filter((ledgerState) => ledgerState.windDown !== null),
          Stream.runHead,
          Effect.as(false),
        ),
      )

    // The hold's wait, then its probe, with the stop `now` holding the run.
    const waitAndProbe = (now: HoldState) =>
      Effect.gen(function* () {
        const wait = probeWait(after, now.probes)
        yield* Ref.set(state, { ...now, probes: now.probes + 1 })
        const command = yield* setupNow
        const text =
          command === null
            ? tagged(
                Tag.probe,
              )`the run holds for the environment; in ${formatDuration(wait)} a session without a ticket runs a command in the main checkout, and if it does the run takes tickets again`
            : tagged(
                Tag.probe,
              )`the run holds for the environment; in ${formatDuration(wait)} a session without a ticket runs a command in the main checkout, and '${command}' runs in a new worktree of ${options.base}; if both work, the run takes tickets again`
        yield* say({ kind: "hold", text })
        if (!(yield* waitToProbe(wait))) return Probed.Ends()
        const failed = yield* runProbe
        if (failed !== null) return Probed.Failed({ stop: probeFailedStop(now.why, wait, failed) })
        const unset = yield* probeSetup
        if (unset !== null) {
          return Probed.Failed({ stop: probeSetupFailedStop(now.why, wait, unset) })
        }
        // Triage's verdicts still to come on the tickets queued so far are forgotten with the row.
        yield* Ref.update(state, (s) => ({
          ...s,
          atOnce: [],
          blamed: [],
          stop: null,
          why: "",
          generation: s.generation + 1,
        }))
        const ok = tagged(
          Tag.probeOk,
        )`a session without a ticket ran a command ${formatDuration(wait)} after the hold; taking tickets again`
        yield* say({ kind: "probed", text: ok })
        yield* requeue
        return Probed.Resumed()
      })

    const probe = (stops: Stops, meanwhile: Effect.Effect<never> = Effect.never) =>
      Effect.gen(function* () {
        const now = yield* Ref.get(state)
        const winding = (yield* ledger.current).windDown !== null
        if (
          now.stop === null ||
          stops[0] !== now.stop ||
          stops.length > 1 ||
          Duration.isZero(after) ||
          winding
        ) {
          return Probed.Ends()
        }
        return yield* Effect.raceFirst(waitAndProbe(now), meanwhile)
      })

    return {
      settled,
      generation: Effect.map(Ref.get(state), (s) => s.generation),
      blamed,
      probe,
      probing: SubscriptionRef.changes(probing),
    } satisfies EnvironmentHold
  })
