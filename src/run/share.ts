// The checks' share of the machine (tutti-epza.18): the cores and the memory a worker's checks may
// use, kept live. A test runner left alone starts a process per core, each of a gigabyte or more:
// at concurrency 2 on a 16 GB, 10-core Mac one worker's whole-suite check took 7.7 GB, swap filled
// and the memory pressure went to warn. So beside its share of the cores, each worker gets a share
// of the memory checks may use (budgetOf): the memory available and what the checks hold already,
// the machine's other runs' with them, less a reserve (load.ts' memoryReserve), divided among the
// workers allowed now and the machine's other runs' workers, a part each, and the merge check,
// mergeWeight parts (src/agent/env.ts' memoryShare), as it runs one at a time and every ticket
// waits on it (tutti-k4if.3). The other runs' checks are counted in as their workers are counted
// among, or each run's share would be cut twice for them (tutti-0l05).
//
// The share follows the run: each load reading (load.ts, every loadEvery) works it out again from
// the workers the pressure cap allows (pressureCap.ts), the other runs' workers and the readings,
// and where it moved (changeOf) the run writes it to .tutti/run/share.json, a JSON line, which each
// worker's environment names (TUTTI_SHARE_FILE), and the merge check's to merge-share.json beside
// it, which the merge check's environment names, and says the change (`share: cores 5 → 3, memory 6.0 → 3.5 GB;
// merge check cores 10 → 6, memory 12.0 → 7.0 GB: workers allowed 2 → 1`, a share record). A check
// script reads the file as it starts, so a check started under pressure starts smaller;
// TUTTI_CORES and TUTTI_MEMORY_MB keep the share as it stood as the check or the worker's session
// started, for scripts that don't read the file.
import { totalmem } from "node:os"
import { join } from "node:path"
import { Clock, Context, Effect, type FileSystem, Layer, Ref } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { coreShare, mebibyte, memoryShare, mergeWeight, sharers } from "../agent/env.ts"
import { makeFoldersUnder, writeFileUnder } from "../native/libc.ts"
import { runFolder } from "../services/Worktrees.ts"
import type { EventStream } from "./eventstream.ts"
import {
  type LoadSource,
  memoryReserve,
  memoryStep,
  newSampler,
  type Reading,
  sample,
} from "./load.ts"
import { type Line, type Log, line, tagged } from "./log.ts"
import { sayer } from "./say.ts"

/** A check's figures of the machine: its cores, and its memory in MiB. */
export interface Figures {
  readonly cores: number
  readonly memory: number
}

/** A worker's share of the machine, for its checks, and the merge check's. */
export interface Share extends Figures {
  /** Its share of the cores (coreShare). */
  readonly cores: number
  /** Its share of the memory checks may use, in MiB (memoryShare). */
  readonly memory: number
  /**
   * The merge check's, and the early and train checks' in its slot: mergeWeight times a worker's
   * memory, and its cores, no more than the machine's (shareOf).
   */
  readonly merge: Figures
}

/** The memory checks may use, and what it is made of. */
export interface Budget {
  /** In bytes; at least 0. */
  readonly bytes: number
  /**
   * What it is made of, as the START block says it: `5.2 GB available and 2.4 GB in checks, less
   * the 2.0 GB reserve`, or with other runs, `5.2 GB available, 2.4 GB in checks and 1.1 GB in
   * other runs' checks, less the 2.0 GB reserve`.
   */
  readonly words: string
}

/** `bytes` in GB to a tenth, without the unit: `4.8`. */
export const gigabytes = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)

/**
 * The memory checks may use, from `reading` (null before there is one), on a machine of `total`
 * bytes: the memory available (load.ts' Memory: on macOS the free, inactive, speculative and
 * purgeable pages, on Linux MemAvailable) and the checks' own resident memory, the machine's other
 * runs' checks' too where the reading has them, no more than the machine's, less memoryReserve. Without the readings, half the machine's memory less the reserve,
 * as a run's share of the cores is half of them without one.
 */
export const budgetOf = (reading: Reading | null, total: number = totalmem()): Budget => {
  const reserve = `the ${gigabytes(memoryReserve)} GB reserve`
  const of = (bytes: number, words: string): Budget => ({ bytes: Math.max(bytes, 0), words })
  const memory = reading?.memory
  const machine = reading?.kernel.memory
  if (memory !== undefined && machine !== undefined && machine.available >= 0) {
    const { available } = machine
    const others = memory.others
    const checks = `${gigabytes(memory.checks)} GB in checks`
    return of(
      Math.min(available + memory.checks + (others ?? 0), machine.total) - memoryReserve,
      others === undefined
        ? `${gigabytes(available)} GB available and ${checks}, less ${reserve}`
        : `${gigabytes(available)} GB available, ${checks} and ${gigabytes(others)} GB in other runs' checks, less ${reserve}`,
    )
  }
  return of(
    total / 2 - memoryReserve,
    `half of ${gigabytes(total)} GB, as the machine's memory isn't read, less ${reserve}`,
  )
}

/** What a share is divided by. */
export interface Division {
  /** The memory checks may use, in bytes (budgetOf). */
  readonly budget: number
  /** The workers the run allows now (the pressure cap). */
  readonly allowed: number
  /** The workers of the machine's other runs, as the run last read them. */
  readonly others: number
}

/** The machine's cores and the cap on the workers across the machine (0 for none). */
export interface Machine {
  readonly cores: number
  readonly limit: number
}

/**
 * The share `division` gives a worker on `machine`, and the merge check: mergeWeight times a
 * worker's memory, as memoryShare keeps it mergeWeight parts of the budget, and its cores, no more
 * than the machine's. The cores are divided among the workers alone, as they were before the merge
 * check was weighted: counting its parts in would halve a worker's on a 10-core machine at 4
 * workers allowed, where the merge check's memory, not its cores, held it to one process.
 */
export const shareOf = (machine: Machine, division: Division): Share => {
  const cores = coreShare(machine.cores, division.allowed, division.others, machine.limit)
  const memory = memoryShare(division.budget, division.allowed, division.others, machine.limit)
  return {
    cores,
    memory,
    merge: {
      cores: Math.max(Math.min(cores * mergeWeight, machine.cores), cores),
      memory: memory * mergeWeight,
    },
  }
}

/** A share as the share file holds it: one JSON line, its memory in MiB, and when it was set. */
export const shareLine = (share: Figures, at: number): string =>
  `${JSON.stringify({ cores: share.cores, memory_mb: share.memory, at: new Date(at).toISOString() })}\n`

/** The share file, in the main checkout. */
export const shareFile = `${runFolder}/share.json`

/** The share file's path in `repo`, as TUTTI_SHARE_FILE names it. */
export const shareFileOf = (repo: string): string => join(repo, shareFile)

/** The merge check's share file (Share's `merge`), in the main checkout. */
export const mergeShareFile = `${runFolder}/merge-share.json`

/** The merge check's share file's path in `repo`, as its TUTTI_SHARE_FILE names it. */
export const mergeShareFileOf = (repo: string): string => join(repo, mergeShareFile)

/** A change of the share: from, to, and what moved it. */
export interface ShareChange {
  readonly from: Share
  readonly to: Share
  /** `workers allowed 2 → 1`, `memory budget 9.6 → 6.1 GB`, those that moved, joined by commas. */
  readonly why: string
}

/** A share kept, and what it was divided by. */
export interface Kept {
  readonly share: Share
  readonly division: Division
}

/**
 * The change from `was` to the share `division` gives on `machine`; null where it doesn't change.
 * The merge check's share moves only with a worker's (shareOf), so a worker's figures decide it.
 * The workers allowed or the other runs' workers changing moves it to the new share; the readings
 * alone, only where the cores change or the memory moves by memoryStep or more, so that a budget
 * that wavers with every reading doesn't rewrite the file and say so every few seconds.
 */
export const changeOf = (
  was: Kept,
  machine: Machine,
  division: Division,
): { readonly kept: Kept; readonly change: ShareChange } | null => {
  const to = shareOf(machine, division)
  const workersMoved =
    was.division.allowed !== division.allowed || was.division.others !== division.others
  const memoryMoved = Math.abs(to.memory - was.share.memory) * mebibyte >= memoryStep
  const moved = to.cores !== was.share.cores || to.memory !== was.share.memory
  if (!moved || (!workersMoved && !memoryMoved && to.cores === was.share.cores)) return null
  const why = [
    ...(was.division.allowed === division.allowed
      ? []
      : [`workers allowed ${was.division.allowed} → ${division.allowed}`]),
    ...(was.division.others === division.others
      ? []
      : [`other runs' workers ${was.division.others} → ${division.others}`]),
    ...(gigabytes(was.division.budget) === gigabytes(division.budget)
      ? []
      : [`memory budget ${gigabytes(was.division.budget)} → ${gigabytes(division.budget)} GB`]),
  ]
  return {
    kept: { share: to, division },
    change: { from: was.share, to, why: why.length === 0 ? "the readings" : why.join(", ") },
  }
}

/** The figures of `from` and `to` that moved: `cores 5 → 3`, `memory 6.0 → 3.5 GB`. */
const movedFigures = (from: Figures, to: Figures): ReadonlyArray<string> => [
  ...(from.cores === to.cores ? [] : [`cores ${from.cores} → ${to.cores}`]),
  ...(from.memory === to.memory
    ? []
    : [`memory ${gigabytes(from.memory * mebibyte)} → ${gigabytes(to.memory * mebibyte)} GB`]),
]

/**
 * A change's log line, each figure that moved, a worker's, then the merge check's: `share: cores
 * 5 → 3, memory 6.0 → 3.5 GB; merge check cores 10 → 6, memory 12.0 → 7.0 GB: workers allowed
 * 2 → 1`, `share: memory 3.5 → 2.0 GB; merge check memory 7.0 → 4.0 GB: memory budget 14.0 → 8.0
 * GB`.
 */
export const shareChangeLine = (change: ShareChange): Line => {
  const { from, to } = change
  const worker = movedFigures(from, to)
  const merge = movedFigures(from.merge, to.merge)
  const moved = [
    ...(worker.length === 0 ? [] : [worker.join(", ")]),
    ...(merge.length === 0 ? [] : [`merge check ${merge.join(", ")}`]),
  ]
  return line`share: ${moved.join("; ")}: ${change.why}`
}

/** `cores` as a share says them: `1 core`, `5 cores`. */
const coresWord = (cores: number): string => `${cores} ${cores === 1 ? "core" : "cores"}`

/**
 * The START block's note on the share: the memory budget, what it is made of, how it is divided
 * and the merge check's weight in it, `share: memory budget 6.3 GB (5.9 GB available …), divided
 * into 4 parts (2 workers allowed, a part each, and the merge check, 2 parts): 1.6 GB and 5 cores a
 * worker's checks, 3.1 GB and 10 cores the merge check's; kept live in .tutti/run/share.json and
 * .tutti/run/merge-share.json`.
 */
export const shareNote = (budget: Budget, machine: Machine, division: Division): string => {
  const share = shareOf(machine, { ...division, budget: budget.bytes })
  const among = [
    `${division.allowed} ${division.allowed === 1 ? "worker" : "workers"} allowed`,
    ...(division.others > 0 ? [`${division.others} of other runs`] : []),
  ]
  const parts = sharers(division.allowed, division.others, machine.limit) + mergeWeight
  const each = (figures: Figures) =>
    `${gigabytes(figures.memory * mebibyte)} GB and ${coresWord(figures.cores)}`
  return (
    `share: memory budget ${gigabytes(budget.bytes)} GB (${budget.words}), divided into ${parts} ` +
    `parts (${among.join(", ")}, a part each, and the merge check, ${mergeWeight} parts): ` +
    `${each(share)} a worker's checks, ${each(share.merge)} the merge check's; kept live in ` +
    `${shareFile} and ${mergeShareFile}`
  )
}

/**
 * The share the run keeps, for each worker's session as it starts (AgentHostLive): the run sets it
 * at each reading (makeShareKeeper), and a worker's environment names the file it is written to.
 */
export interface SharesValue {
  /** The share now; null where the run keeps none (no load read), and a session works it out. */
  readonly now: Effect.Effect<Share | null>
  set(share: Share): Effect.Effect<void>
}

/** The share the run keeps; none unless a layer provides it (shares). */
export const Shares = Context.Reference<SharesValue>("tutti/run/share/Shares", {
  defaultValue: () => ({ now: Effect.succeed(null), set: () => Effect.void }),
})

/** Shares kept in memory, for the run to set and its AgentHost to read. */
export const shares: Layer.Layer<never> = Layer.effect(
  Shares,
  Effect.map(Ref.make<Share | null>(null), (kept) => ({
    now: Ref.get(kept),
    set: (share: Share) => Ref.set(kept, share),
  })),
)

/** What the run's share keeper does with each reading. */
export interface ShareKeeper {
  /** Works the share out again from `reading`, writing and saying it where it moved. */
  read(reading: Reading): Effect.Effect<void>
  /** Works it out again with the last reading's budget, as the workers allowed changed without one. */
  readonly refresh: Effect.Effect<void>
}

/**
 * Keeps the run's share in Shares and in `repo`'s share files, a worker's and the merge check's:
 * one now, from no reading (budgetOf's half of the memory), and again at each reading, the workers
 * allowed and the other runs' workers as `allowed` and `others` give them then, on `machine`. The
 * first reading's share is taken without a word, as the START block says it; each change after it
 * is a log line and a share record. A file that can't be written is said once, and the share still
 * kept for the sessions.
 */
export const makeShareKeeper = (options: {
  readonly repo: string
  readonly machine: Machine
  readonly allowed: Effect.Effect<number>
  readonly others: Effect.Effect<number>
  /** The machine's memory, in bytes; totalmem(). */
  readonly total?: number
}): Effect.Effect<ShareKeeper, never, Log | EventStream> =>
  Effect.gen(function* () {
    const { repo, machine } = options
    const { say, warn } = yield* sayer
    const shares = yield* Shares
    const total = options.total ?? totalmem()
    const warned = yield* Ref.make(false)

    const write = (share: Share) =>
      Effect.gen(function* () {
        const at = Date.now()
        const made = makeFoldersUnder(repo, runFolder)
        const writeOne = (file: string, figures: Figures) =>
          writeFileUnder(repo, file, shareLine(figures, at)).pipe(
            Effect.as(undefined),
            Effect.catch((refusal) => Effect.succeed(refusal.message)),
          )
        const failed =
          made ??
          (yield* writeOne(shareFile, share)) ??
          (yield* writeOne(mergeShareFile, share.merge))
        if (failed === undefined || (yield* Ref.getAndSet(warned, true))) return
        yield* warn(
          tagged(
            "SHARE_UNWRITTEN",
          )`${shareFile} can't be written, so the workers' checks keep the share their sessions started with: ${failed}`,
        )
      })

    const division = (budget: number) =>
      Effect.map(
        Effect.all([options.allowed, options.others]),
        ([allowed, others]): Division => ({ budget, allowed, others }),
      )

    const first = yield* division(budgetOf(null, total).bytes)
    const kept = yield* Ref.make<Kept>({ share: shareOf(machine, first), division: first })
    const readOnce = yield* Ref.make(false)
    yield* shares.set((yield* Ref.get(kept)).share)
    yield* write((yield* Ref.get(kept)).share)

    const step = (budget: number) =>
      Effect.gen(function* () {
        const now = yield* division(budget)
        const was = yield* Ref.get(kept)
        if (!(yield* Ref.getAndSet(readOnce, true))) {
          const share = shareOf(machine, now)
          yield* Ref.set(kept, { share, division: now })
          yield* shares.set(share)
          if (share.cores !== was.share.cores || share.memory !== was.share.memory) {
            yield* write(share)
          }
          return
        }
        const next = changeOf(was, machine, now)
        if (next === null) return
        yield* Ref.set(kept, next.kept)
        yield* shares.set(next.kept.share)
        yield* write(next.kept.share)
        yield* say({
          kind: "share",
          cores: { from: next.change.from.cores, to: next.change.to.cores },
          memory: { from: next.change.from.memory, to: next.change.to.memory },
          why: next.change.why,
          text: shareChangeLine(next.change),
        })
      })

    return {
      read: (reading) => step(budgetOf(reading, total).bytes),
      refresh: Effect.flatMap(Ref.get(kept), (was) => step(was.division.budget)),
    } satisfies ShareKeeper
  })

/**
 * The START block's note on the share (shareNote), from one reading of `source` now, the run's
 * workers not started yet, for `concurrent` workers allowed on `machine`.
 */
export const startShareNote = (
  source: LoadSource,
  machine: Machine,
  concurrent: number,
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const processes = yield* source.processes
    const kernel = yield* source.kernel
    const now = yield* Clock.currentTimeMillis
    const { reading } = sample({
      sampler: newSampler,
      now,
      processes,
      kernel,
      roots: new Map(),
      self: process.pid,
    })
    return shareNote(budgetOf(reading), machine, { budget: 0, allowed: concurrent, others: 0 })
  })
