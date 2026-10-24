// The dashboard's load line (orchestra 0.8.5, § 7.2), under the title line, a blank line between,
// says whether the workers are overloading the machine:
//
//   ▶ 4 of 4 workers · memory 6.2 GB (workers 4.8, merge check 1.4) · pressure normal · CPU 9.8/10 cores
//
// the workers at work out of their slots, the memory their processes take and what tutti runs
// besides (its merge check above all), the kernel's memory pressure (and on Linux the memory
// available), swapping while it is under way, and the 1-minute load average against the cores
// (src/run/load.ts). The pressure, the swapping and the CPU are each in the colour of their own
// level, `done`, `notice` or `needsYou` bold; the memory, which has no threshold, is uncoloured. Before the
// run has read the machine's load the line has the workers alone.
import { type Level, swappingPerMinute } from "../run/load.ts"
import type { LoadView, Totals } from "../run/runView.ts"
import { type FitPart, fitParts } from "./fit.ts"
import { cut, Line, type Look, type Segments, seg } from "./line.tsx"
import { marks } from "./marks.ts"
import type { Theme } from "./theme.ts"

/** A level's look: green `done`, amber `notice` (`windingDown` is for winding down only), red `stop`. */
const levelLook = (level: Level, theme: Theme): Look =>
  level === "red"
    ? theme.styles.stop
    : level === "amber"
      ? theme.styles.deferred
      : theme.styles.done

/** The unit memory is counted in, as GB. */
const gibibyte = 1024 ** 3

/** `bytes` in GB to a tenth, without the unit: `4.8`. */
const number = (bytes: number): string => (bytes / gibibyte).toFixed(1)

/** `bytes` in GB to a tenth: `6.2 GB`. */
export const gigabytes = (bytes: number): string => `${number(bytes)} GB`

/** A worker's memory on its line in Current: `1.2 GB`, `? GB` when its processes can't be found. */
export const workerMemory = (memory: number): string => (memory < 0 ? "? GB" : gigabytes(memory))

/** The workers at work out of their slots: `▶ 4 of 4 workers`, faint with none. */
const workersPart = (totals: Totals, theme: Theme): Segments => {
  const { styles } = theme
  const of = ` of ${totals.slots} ${totals.slots === 1 ? "worker" : "workers"}`
  return totals.workers === 0
    ? [seg(`${marks.working} 0${of}`, styles.dim)]
    : [seg(`${marks.working} ${totals.workers}`, styles.picked), seg(of, styles.dim)]
}

/**
 * The memory the workers' processes and tutti's own commands take: `memory 6.2 GB`, with
 * `breakdown` `(workers 4.8, merge check 1.4)` after it, and how many workers' are unknown, if any.
 */
const memoryPart = (load: LoadView, breakdown: boolean): string => {
  const total = `memory ${gigabytes(load.workers + load.check)}`
  if (!breakdown) return total
  const parts: Array<string> = []
  if (load.check > 0 || load.unknown > 0) parts.push(`workers ${number(load.workers)}`)
  if (load.check > 0) parts.push(`merge check ${number(load.check)}`)
  if (load.unknown > 0) parts.push(`${load.unknown} unknown`)
  return parts.length === 0 ? total : `${total} (${parts.join(", ")})`
}

/** `pressure normal`, `pressure warn (1.2 GB available)` where the kernel says; "" when unknown. */
const pressurePart = (load: LoadView): string => {
  if (load.pressure === "unknown") return ""
  const available = load.available >= 0 ? ` (${gigabytes(load.available)} available)` : ""
  return `pressure ${load.pressure}${available}`
}

/** `swapping 840 pages/min` while swapping is under way; "" while it isn't. */
const swappingPart = (load: LoadView): string =>
  load.swapping < swappingPerMinute ? "" : `swapping ${Math.round(load.swapping)} pages/min`

/** `CPU 9.8/10 cores`; "" when unknown. */
const cpuPart = (load: LoadView): string =>
  load.load1 < 0 || load.cores <= 0 ? "" : `CPU ${load.load1.toFixed(1)}/${load.cores} cores`

/**
 * The load line `width` wide. A pane too narrow for it all drops the memory's breakdown, then the
 * memory, keeping the workers, the pressure and the CPU, and then cuts it.
 */
export const loadSegments = (
  totals: Totals,
  load: LoadView | null,
  theme: Theme,
  width: number,
): Segments => {
  const workers = workersPart(totals, theme)
  if (load === null) return cut([seg(" "), ...workers], width)
  const { levels } = load
  /** A part of the line that is always there, but for one that says nothing. */
  const kept = (text: string, look: Look | null): FitPart => ({
    forms: [text === "" ? [] : [seg(text, look)]],
    rank: 0,
  })
  return fitParts(
    [
      { forms: [[seg(" "), ...workers]], rank: 0 },
      {
        forms: [[seg(memoryPart(load, true))], [seg(memoryPart(load, false))], []],
        rank: 0,
      },
      kept(pressurePart(load), levelLook(levels.pressure, theme)),
      kept(swappingPart(load), levelLook(levels.swapping, theme)),
      kept(cpuPart(load), levelLook(levels.cpu, theme)),
    ],
    width,
    [seg(" · ", theme.styles.dim)],
  )
}

/** The load line, as loadSegments gives it. */
export const LoadLine = ({ segments }: { readonly segments: Segments }) => (
  <Line segments={segments} />
)
