// The pressure cap: the workers a run allows under memory pressure. The workers allowed are the least
// of concurrent, the machine's cap (HOLD: MACHINE, machine.ts) and this cap, which starts at
// concurrent. It falls a step after the kernel's memory pressure has been at warn or worse for
// pressureLowerAfter (two steps at critical), and again each further such time it lasts; it rises a
// step after pressureRaiseAfter with the pressure normal, and again each further such time, up to
// concurrent. Never below 1, so the run keeps going. The kernel's pressure level alone moves it.
// Swapping doesn't: with gigabytes in swap, touching old pages swaps them in at hundreds of
// thousands of pages a minute long after the pressure has passed (tutti-epza.14), so it would keep
// the cap at 1 all night; it stays a figure on the load line and in the load records. Nor does the
// load average: it counts threads waiting (238.6 on 10 cores while the processes used 6.3), and a
// run's own checks keep it high. Like a stop, a lowered cap never interrupts a worker: it only
// keeps the run from dispatching or resuming until fewer workers run than it allows
// (pressureGate.ts, HOLD: PRESSURE). The times and steps are load.ts's, beside its thresholds.
import { criticalStep, pressureLowerAfter, pressureRaiseAfter, type Reading } from "./load.ts"
import { type Line, line, Tag, tagged } from "./log.ts"

/** The word of the hold at the pressure cap, on the dashboard's title line while it holds. */
export const holdWord = "PRESSURE"

/**
 * What a reading says of the machine's memory, for the cap: the kernel's pressure at critical or
 * warn, calm (the pressure normal), or unknown, which moves the cap neither way. Swapping, however
 * heavy, is none of them.
 */
export type Strain = "critical" | "warn" | "calm" | "unknown"

/** `reading`'s strain: its kernel's memory pressure alone. */
export const strainOf = (reading: Reading): Strain => {
  const { pressure } = reading.kernel
  if (pressure === "critical" || pressure === "warn") return pressure
  return pressure === "normal" ? "calm" : "unknown"
}

/** Whether `strain` presses the machine's memory: what lowers the cap, and holds the optional checks. */
export const pressedBy = (strain: Strain): boolean => strain === "critical" || strain === "warn"

/** The cap, and since when what moves it has lasted. */
export interface Cap {
  /** The workers allowed, from 1 to concurrent. */
  readonly cap: number
  /** Since when the memory has been pressed, or the cap last fell; null while it isn't pressed. */
  readonly pressedSince: number | null
  /** Since when it has been calm under concurrent, or the cap last rose; null otherwise. */
  readonly calmSince: number | null
}

/** The cap at a run's start: concurrent. */
export const capAt = (concurrent: number): Cap => ({
  cap: concurrent,
  pressedSince: null,
  calmSince: null,
})

/** A step of the cap: from, to, and what moved it. */
export interface CapChange {
  readonly from: number
  readonly to: number
  /** `memory pressure warn for 60 s`, `memory pressure normal for 5 min`. */
  readonly why: string
}

/** `ms` as the cap's lines say it: `60 s`, `5 min`. */
export const lasted = (ms: number): string =>
  ms >= 120_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`

/** What `strain`, lasting `ms`, is said as. */
const strainWords = (strain: Strain, ms: number): string =>
  `memory pressure ${strain === "calm" ? "normal" : strain} for ${lasted(ms)}`

/**
 * The cap after a reading of `strain` at `now`, out of `concurrent`, and the step it took, if any.
 * Readings come every few seconds (load.ts's loadEvery): a stretch is timed from its first.
 */
export const stepCap = (
  cap: Cap,
  strain: Strain,
  now: number,
  concurrent: number,
): { readonly cap: Cap; readonly change: CapChange | null } => {
  if (pressedBy(strain)) {
    const since = cap.pressedSince ?? now
    if (now - since < pressureLowerAfter || cap.cap <= 1) {
      return { cap: { ...cap, pressedSince: since, calmSince: null }, change: null }
    }
    const to = Math.max(1, cap.cap - (strain === "critical" ? criticalStep : 1))
    return {
      cap: { cap: to, pressedSince: now, calmSince: null },
      change: { from: cap.cap, to, why: strainWords(strain, pressureLowerAfter) },
    }
  }
  if (strain === "unknown" || cap.cap >= concurrent) {
    return {
      cap: { cap: Math.min(cap.cap, concurrent), pressedSince: null, calmSince: null },
      change: null,
    }
  }
  const since = cap.calmSince ?? now
  if (now - since < pressureRaiseAfter) {
    return { cap: { ...cap, pressedSince: null, calmSince: since }, change: null }
  }
  const to = cap.cap + 1
  return {
    cap: { cap: to, pressedSince: null, calmSince: now },
    change: { from: cap.cap, to, why: strainWords("calm", pressureRaiseAfter) },
  }
}

/**
 * A change's log line: `HOLD: PRESSURE: workers allowed 4 → 3: memory pressure warn for 60 s` as it
 * falls, `workers allowed 3 → 4: memory pressure normal for 5 min` as it rises.
 */
export const capLine = (change: CapChange): Line =>
  change.to < change.from
    ? tagged(Tag.hold)`${holdWord}: workers allowed ${change.from} → ${change.to}: ${change.why}`
    : line`workers allowed ${change.from} → ${change.to}: ${change.why}`

/** Why the cap goes back to concurrent when the run stops reading the machine's load. */
export const unreadWhy = "the machine's load is no longer read"

/** A time spent, to the second under 2 minutes and to the minute past them: `45 s`, `12 min`. */
const spentWords = (ms: number): string =>
  ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`

/**
 * What the run report says of the cap: the time spent below concurrent and the lowest cap; null
 * when it never fell.
 */
export const capEvidence = (spent: {
  readonly below: number
  readonly lowest: number
  readonly concurrent: number
}): string | null =>
  spent.lowest >= spent.concurrent
    ? null
    : `The workers allowed fell below concurrent (${spent.concurrent}) under memory pressure for ${spentWords(spent.below)} in all; the lowest was ${spent.lowest}.`
