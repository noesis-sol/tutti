// The run's merge side (run.ts, § 5 item 8): each finished ticket's branch checked early
// (earlyCheck.ts), the critic, the auditor and the playbook's reflections when the run has organs
// (critic.ts, auditor.ts, playbookRun.ts), the merge queue (mergequeue.ts), the stop a merge
// that stopped the merges holds the run with, taken up once, and the closed blockers whose work
// git finds only on their branch (closedBranches.ts).
import { Effect, Option, Ref, type Scope } from "effect"
import { Organs } from "../../organs/Organs.ts"
import { type Auditor, off as auditorOff, make as makeAuditor } from "../auditor.ts"
import { type ClosedBranches, closedBranches } from "../closedBranches.ts"
import { type Critic, off as criticOff, make as makeCritic } from "../critic.ts"
import { type EarlyChecks, make as makeEarlyChecks } from "../earlyCheck.ts"
import { stopFor, stopOfLine } from "../holds.ts"
import type { Ledger } from "../ledger.ts"
import { type MergeQueue, make as makeQueue, type QueueState } from "../mergequeue.ts"
import { make as makePlaybook, type RunPlaybook } from "../playbookRun.ts"
import { showOn } from "../runView.ts"
import type { Holds } from "./holds.ts"
import type { Services } from "./services.ts"
import { firstLine, type RunEnv } from "./shared.ts"

/** The run's merge side: what checks, reviews and merges the finished tickets. */
export interface MergeSide {
  readonly early: EarlyChecks
  /** Whether the critic may review: no merge under way, a slot free, the memory not pressed. */
  readonly criticIdle: Ref.Ref<Effect.Effect<boolean>>
  readonly critic: Critic
  readonly auditor: Auditor
  readonly playbook: RunPlaybook
  readonly queue: MergeQueue
  /** The merge that stopped the merges, taken up once, by its watcher or by the end. */
  readonly mergeStop: (state: QueueState) => Effect.Effect<void>
  readonly branches: ClosedBranches
}

/** The run's merge side, made over `services` and `holds`, in the run's scope. */
export const make = (
  services: Pick<Services, "config" | "base" | "status" | "wakeUp" | "holds">,
  runHolds: Pick<
    Holds,
    | "panicked"
    | "setUps"
    | "usage"
    | "organs"
    | "noMore"
    | "recheckSlot"
    | "machineFull"
    | "machineLoaded"
    | "pressure"
    | "overnight"
  >,
): Effect.Effect<MergeSide, never, RunEnv | Ledger | Scope.Scope> =>
  Effect.gen(function* () {
    const { config, base, status, wakeUp } = services
    const { stopped } = services.holds
    const {
      panicked,
      setUps,
      usage,
      organs,
      noMore,
      recheckSlot,
      machineFull,
      machineLoaded,
      pressure,
      overnight,
    } = runHolds
    // Each finished ticket's branch checked early, while its worker's verifier runs, in the check
    // slot every other check takes (earlyCheck.ts).
    const early = yield* makeEarlyChecks({
      repo: config.repo,
      base,
      setup: Effect.map(setUps.now, (setup) => setup.command),
      held: pressure.pressed,
      loaded: machineLoaded,
    })
    // The critic (critic.ts), when the run has organs: told of each merge, it reviews the merges due
    // one at a time, each in a slot the look's fill left free, with no merge under way and the
    // memory not pressed (`criticIdle`, set once the scheduler is made). Each review's end wakes
    // the run, which doesn't end while one runs.
    const criticIdle = yield* Ref.make<Effect.Effect<boolean>>(Effect.succeed(false))
    const critic = Option.isNone(organs)
      ? criticOff
      : yield* makeCritic({
          repo: config.repo,
          idle: Effect.flatten(Ref.get(criticIdle)),
          done: wakeUp("verdict"),
        }).pipe(Effect.provideService(Organs, organs.value))
    // The auditor (auditor.ts), when the run has organs and organs.auditor is on: told of each
    // ticket whose part in the run ends (followEnds, below), it audits its worker's transcript in
    // the background. Each audit's end wakes the run, which doesn't end while one waits.
    const auditor = Option.isNone(organs)
      ? auditorOff
      : yield* makeAuditor({ repo: config.repo, done: wakeUp("verdict") }).pipe(
          Effect.provideService(Organs, organs.value),
        )
    // The playbook (playbookRun.ts): what each ticket dispatched is given of it, counted as it ends
    // (followEnds, below), and, when the run has organs, a reflection every so many ends in the
    // background. Each reflection's end wakes the run, which doesn't end while one waits.
    const playbook = yield* makePlaybook({
      repo: config.repo,
      organs,
      done: wakeUp("verdict"),
    })
    const queue = yield* makeQueue(
      {
        repo: config.repo,
        base,
        early,
        merged: critic.merged,
        noMore,
        atReset: usage.atReset,
        recheckSlot,
        setUps,
        // No ticket is checked ahead of its turn while the run holds at the machine's cap, nor while
        // the memory is pressed.
        machineFull: Effect.map(
          Effect.all([machineFull, pressure.pressed]),
          ([full, hard]) => full || hard,
        ),
        loaded: machineLoaded,
        ...overnight,
      },
      (where, defect) =>
        panicked(where, stopFor("PANIC", `${where}: ${firstLine(defect)}`), defect),
    )
    // The merge that stopped the merges, taken up once, by its watcher or by the end.
    const mergeStopSeen = yield* Ref.make(false)
    const mergeStop = (state: QueueState) =>
      Effect.gen(function* () {
        const stop = state.stop
        if (stop === null || (yield* Ref.getAndSet(mergeStopSeen, true))) return
        yield* showOn(status, "mergesStopped")(true)
        yield* stopped(
          stopOfLine(stop, {
            ticket: stop.ticket,
            recorded: stop.why === "MERGE_FAILED",
            held: true,
          }),
        )
      })

    // A closed blocker the run knows nothing of hasn't merged while git finds its work only on its
    // branch (closedBranches.ts): the holds, WAITS_FOR_MERGE and DEFERRED_FREE all count it so.
    const branches = yield* closedBranches({ repo: config.repo, base })
    return { early, criticIdle, critic, auditor, playbook, queue, mergeStop, branches }
  })
