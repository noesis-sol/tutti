// A check's share of the machine (§ 3.2, tutti-epza.18): the cores and the memory a worker's checks
// may use, and the merge check's; the memory budget it is cut from (budgetOf), the files the run
// keeps a share in, which a check's environment names (TUTTI_SHARE_FILE), and the Shares the run
// keeps for each worker's session as it starts. The run works the share out again at each load
// reading and keeps it (src/run/share.ts); a session or a check reads it here.
import { totalmem } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Ref } from "effect"
import { coreShare, memoryReserve, memoryShare, mergeWeight } from "../core/env.ts"
import type { Reading } from "../run/load.ts"
import { runFolder } from "./Worktrees.ts"

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
