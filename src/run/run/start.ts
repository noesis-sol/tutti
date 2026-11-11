// The start's steps (run.ts, § 5 items 1 and 2), before the first dispatch: the project's
// requirements checked (requires.ts), the tickets earlier runs left `unmerged` (unmerged.ts), the
// lock files, rebased branches and worktrees a killed run left (branch.ts, mergetrain.ts,
// fullcheck.ts, environment.ts, trash.ts), the workers the last run left taken up (carry.ts), each
// suspended one resumed in a slot, counting toward no limit, and the DEFERRED_FREE lines of the
// START block (deferredFree.ts). A quit cuts the step under way short and skips the rest.
import { Effect, Ref, Result } from "effect"
import { beadsWhy, type TicketId } from "../../services/Beads.ts"
import { clearStaleLocks } from "../branch.ts"
import { type Carried, type CarryOptions, carryOver } from "../carry.ts"
import { sayAtStart as sayDeferredFree } from "../deferredFree.ts"
import { removeLeftProbes } from "../environment.ts"
import { removeLeftFullChecks } from "../fullcheck.ts"
import { stopFor } from "../holds.ts"
import type { Ledger } from "../ledger.ts"
import { putBackLeft } from "../mergetrain.ts"
import { runRequires } from "../requires.ts"
import { Trash } from "../trash.ts"
import { loadUnmerged } from "../unmerged.ts"
import type { RunParts } from "./parts.ts"
import type { RunEnv } from "./shared.ts"
import type { Watchers } from "./watchers.ts"

/** What the start's steps leave for the looks. */
export interface Started {
  /** The workers to be resumed that found no slot since the look began, for its end (runEnd.ts). */
  readonly unslotted: Ref.Ref<ReadonlySet<string>>
  /** How a worker is carried over or an answered ticket taken back (carry.ts, asked.ts). */
  readonly carryOptions: CarryOptions
  /** The tickets of `carried` whose workers wait for a slot. */
  readonly waitingOf: (carried: ReadonlyMap<TicketId, Carried>) => ReadonlySet<TicketId>
}

/** The start's steps, each cut short by a quit. */
export const make = (
  parts: RunParts,
  watchers: Pick<Watchers, "untilQuit">,
): Effect.Effect<Started, never, RunEnv | Ledger> =>
  Effect.gen(function* () {
    const { config, base, context, holds } = parts.services
    const { stopped } = holds
    const { setUps, triage, overnight } = parts.holds
    const { queue, branches } = parts.merge
    const { onResumedLimit, outcomeOf, carrying, scheduler } = parts.starting
    const { untilQuit } = watchers
    // The project's requirements, checked before the first dispatch and before any worker is
    // carried over (requires.ts): what is still missing stops the run, REQUIREMENTS_MISSING, exit 2,
    // and nothing starts or resumes; the workers the last run left stay for the next. A quit cuts an
    // install short, and the run quits with nothing resumed.
    const missing = yield* untilQuit(
      runRequires(config.settings.requires, {
        repo: config.repo,
        installLimit: config.settings.checks.fast.timeout,
      }),
      "",
    )
    if (missing !== "") yield* stopped(stopFor("REQUIREMENTS_MISSING", missing))

    // The tickets earlier runs left unmerged, checked before the first dispatch: one merged by hand
    // since loses its label, so the tickets it blocks can start.
    const loaded = yield* untilQuit(
      Effect.result(loadUnmerged({ repo: config.repo, base })),
      undefined,
    )
    if (loaded !== undefined && Result.isFailure(loaded)) {
      yield* stopped(
        stopFor(
          "BEADS_FAILED",
          `could not read the tickets left unmerged: ${beadsWhy(loaded.failure)}`,
        ),
      )
    }

    // The lock files a git stopped mid-write left in the main repository (a run killed mid
    // fast-forward, a power loss), removed before anything writes there (branch.ts).
    yield* untilQuit(clearStaleLocks(config.repo), undefined)

    // The branches a killed run's trains left rebased onto the branch ahead, put back before their
    // tickets are carried over to merge (mergetrain.ts). One cut short by a quit keeps its mark in
    // state.json, for the next run to put back.
    yield* untilQuit(putBackLeft(config.repo, setUps), undefined)

    // The full check's worktrees a run killed while its full check ran left, removed (fullcheck.ts).
    yield* untilQuit(removeLeftFullChecks, undefined)

    // The probe's worktrees a run killed while the probe's setup ran left, removed (environment.ts).
    yield* untilQuit(removeLeftProbes, undefined)

    // The merged worktrees' folders an earlier run left in the trash folder, deleted in the
    // background (trash.ts), before a carried-over ticket's merge sets aside any more.
    yield* untilQuit((yield* Trash).clearLeft, undefined)

    // The workers the last run left (carry.ts), taken up before the first dispatch: each resumed
    // takes a slot, counting toward no limit, its ticket limit counted afresh; one with no slot
    // for it waits for a later look. A quit takes up no more of them: those not yet taken stay in
    // state.json as they were, for the next run.
    // The workers to be resumed that found no slot since the look began, for its end (runEnd.ts).
    const unslotted = yield* Ref.make<ReadonlySet<string>>(new Set())
    const carryOptions: CarryOptions = {
      base,
      queue,
      triage,
      closedBranches: branches,
      onTicketLimit: onResumedLimit,
      ...overnight,
      carry: (ticket, start, issue) =>
        Effect.tap(
          scheduler.carry(
            ticket,
            Effect.map(start, (worked) =>
              worked === undefined ? undefined : outcomeOf(ticket, worked),
            ),
            issue,
          ),
          (took) =>
            took ? Effect.void : Ref.update(unslotted, (all) => new Set([...all, ticket])),
        ),
    }
    const waitingOf = (carried: ReadonlyMap<TicketId, Carried>) =>
      new Set([...carried].flatMap(([id, what]) => (what === "waiting" ? [id] : [])))
    const carried: ReadonlyMap<TicketId, Carried> =
      missing !== ""
        ? new Map()
        : yield* untilQuit(carryOver(carryOptions).pipe(Effect.provideContext(context)), new Map())
    yield* Ref.set(carrying, waitingOf(carried))

    // The deferred tickets in the run's scope whose blockers have all merged, each a DEFERRED_FREE
    // line of the START block (deferredFree.ts); not when bd can't list those left unmerged.
    if (loaded !== undefined && Result.isSuccess(loaded)) {
      yield* untilQuit(
        sayDeferredFree({
          repo: config.repo,
          base,
          filter: { excludeTypes: config.settings.queue.exclude_types },
          root: config.ticket,
          carried,
          unmerged: new Set(loaded.success.map((left) => left.issue.id)),
          closedBranches: branches,
        }),
        undefined,
      )
    }

    return { unslotted, carryOptions, waitingOf }
  })
