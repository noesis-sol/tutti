// The worker view's figures (§ 7.5, worker-view design D2, redesigned in tutti-cxgo.4 and .6): what
// the worker is consuming, on line 1 of its head after its status (worker/Head.tsx). Its time on
// the ticket, in the text's colour; on an API key its dollars, or on a subscription login its
// ticket's estimated share of the account's five-hour window, `≈1% (estimate)`, in the estimate's
// italic sand with its word, which keeps the meaning under NO_COLOR; its context window as amounts
// against the window Claude Code compacts at, `context 126k of 200k`, the figure yellow from 70%
// and red from 90%; its compactions once there has been one; its processes' memory; and near or at
// a usage limit, the account's figure as a warning, `⚠ 5h window 92% · resets 14:20`, so you know
// why the worker may stop. Each part is two spaces from the next, drawn as segments of its own, so
// cutting the line never joins them. Tokens, model calls and the dollars at API prices are not
// shown in the worker view (tutti-cxgo.6): the run's summary has its own Spent line.
import type { ContextUsage } from "../../agent/contextUsage.ts"
import { dollarsText, tokenCount } from "../../run/figures.ts"
import { resetLabel } from "../../run/localTime.ts"
import type { Resources } from "../../run/resources.ts"
import type { Usage } from "../../run/runView.ts"
import { elapsed } from "../Card.tsx"
import type { FitPart } from "../fit.ts"
import { workerMemory } from "../LoadLine.tsx"
import { type Look, type Segments, seg } from "../line.tsx"
import { sanitizeLine } from "../sanitize.ts"
import type { Theme } from "../theme.ts"

/** The gap between two parts. */
export const gap = "  "

/** From this full the context's figure is yellow, and from `nearCompaction` red. */
export const contextNotice = 0.7
export const nearCompaction = 0.9

/** How full `context` is, 0 to 1. */
const fullness = (context: ContextUsage): number => Math.min(context.tokens / context.window, 1)

/** The look of a context `full`, 0 to 1: the text's own, then `notice`, then `needsYou`. */
export const contextLook = (full: number, theme: Theme): Look | null =>
  full >= nearCompaction
    ? theme.look("needsYou")
    : full >= contextNotice
      ? theme.look("notice")
      : null

/** A share of the window to the whole point: `≈1%`, or `< 1%` for one under half a point. */
export const shareText = (share: number): string => {
  const points = share * 100
  return points > 0 && points < 0.5 ? "< 1%" : `≈${Math.round(points)}%`
}

/** A usage limit's name as the warning says it: `5h window` for the five-hour limit. */
export const limitLabel = (limit: string | undefined): string => {
  switch (limit) {
    case undefined:
      return "usage"
    case "five-hour":
      return "5h window"
    case "seven-day":
      return "week"
  }
  return sanitizeLine(limit.replaceAll("-", " "))
}

/** What the figures show beside the ticket's resources. */
export interface FigureInputs {
  /** When the worker's time counts from: when the run took the ticket up. */
  readonly took: number
  /** The worker's processes' memory, as its card has it; none before the run has read it. */
  readonly memory?: number
  /** The account's usage near or at a limit: its warning; null short of one. */
  readonly usage: Usage | null
  /** When its time is read: now, or when the view first saw the worker finished. */
  readonly now: number
}

/**
 * The ranks of line 1's steps down in a narrow pane, the lowest first: the memory dropped, then the
 * warning's reset time, then the compactions, then whole parts from the end of the line.
 */
export const dropMemory = 0
const shortWarning = 1
const dropCompactions = 2
export const fromTheEnd = 3

/** A part shown whole or left out, at `rank`. */
const droppable = (segments: Segments, rank: number): FitPart => ({ forms: [segments, []], rank })

/**
 * The figures' parts, in order, each in its forms for a narrow pane (fitParts): `r`, the ticket's
 * resources, none before the run has any. The time is never left out.
 */
export const figureParts = (
  r: Resources | undefined,
  inputs: FigureInputs,
  theme: Theme,
): ReadonlyArray<FitPart> => {
  const { styles } = theme
  const parts: Array<FitPart> = [
    { forms: [[seg(elapsed(inputs.now - inputs.took))]], rank: fromTheEnd },
  ]
  if (r?.subscription === false) {
    parts.push(droppable([seg(dollarsText(r.spent.costUsd))], fromTheEnd))
  } else if (r?.window != null) {
    parts.push(
      droppable([seg(`${shareText(r.window.share)} (estimate)`, styles.estimate)], fromTheEnd),
    )
  }
  if (r?.context != null) {
    parts.push(
      droppable(
        [
          seg("context "),
          seg(tokenCount(r.context.tokens), contextLook(fullness(r.context), theme)),
          seg(" of ", styles.dim),
          seg(tokenCount(r.context.window)),
        ],
        fromTheEnd,
      ),
    )
  }
  if (r !== undefined && r.compactions > 0) {
    const word = r.compactions === 1 ? "compaction" : "compactions"
    parts.push(droppable([seg(`↻ ${r.compactions}`), seg(` ${word}`, styles.dim)], dropCompactions))
  }
  if (inputs.memory !== undefined) {
    parts.push(droppable([seg(workerMemory(inputs.memory), styles.dim)], dropMemory))
  }
  const usage = inputs.usage
  if (usage !== null) {
    const look = usage.utilization >= 1 ? styles.testing : styles.deferred
    const figure = `⚠ ${limitLabel(usage.limit)} ${Math.round(usage.utilization * 100)}%`
    const resets =
      usage.resetsAt === null ? "" : ` · resets ${resetLabel(usage.resetsAt, inputs.now)}`
    parts.push({
      forms: [[seg(`${figure}${resets}`, look)], [seg(figure, look)], []],
      rank: [shortWarning, fromTheEnd],
    })
  }
  return parts
}
