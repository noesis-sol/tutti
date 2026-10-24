// The worker view's resource line (§ 7.5, worker-view design D2), under its head: what the worker
// is consuming. Its time on the ticket; its tokens, every model's; on an API key its dollars, or on
// a subscription login its ticket's estimated share of the account's five-hour window,
// `5h window ≈1% (estimate)`, in the estimate's italic sand with its word, which keeps the meaning
// under NO_COLOR; its context window as amounts against the window Claude Code compacts at,
// `context ▰▰▰▰▰▰▱▱▱▱  126k of 200k`, yellow from 70% and red from 90%; its compactions once
// there has been one; its processes' memory, as its card shows it; and near or at a usage limit,
// the account's figure as a warning, `⚠ 5h window 92% · resets 14:20`, so you know why the worker
// may stop. Each part, and a gauge and its figure, are two spaces apart, drawn as segments of
// their own, so cutting the line never joins them. A narrow pane drops the memory, then the
// warning's reset time, then the compactions, then whole parts from the end: a gauge never loses
// its figure, nor the estimate its word.
//
// A click on the line opens the breakdown, `Spent`: the tokens by model with the cache's share,
// the model calls, the dollars (at API prices on a subscription, an estimate), how the window's
// share is made, the context's split and the ticket's share of the run's tokens. It is the
// whole-ticket panel's last section (TicketHead.tsx), which the click opens scrolled to it.
import { useRef } from "react"
import type { ContextUsage } from "../agent/contextUsage.ts"
import type { Tokens } from "../run/events.ts"
import { dollarsText, tokenCount } from "../run/figures.ts"
import { resetLabel } from "../run/localTime.ts"
import { allTokens, type Resources } from "../run/resources.ts"
import type { Usage } from "../run/runView.ts"
import { elapsed } from "./Card.tsx"
import { clickable } from "./click.ts"
import { type FitPart, fitParts } from "./fit.ts"
import { workerMemory } from "./LoadLine.tsx"
import { Line, type Look, type Segments, seg, wrap } from "./line.tsx"
import { sanitizeLine } from "./sanitize.ts"
import { gauge } from "./TitleLine.tsx"
import type { Theme } from "./theme.ts"
import { useNow, useRunViewPart, useTheme } from "./useRunView.ts"

/** The gap between two parts, and between a gauge and its figure. */
const gap = "  "

/** From this full the context gauge is yellow, and from `nearCompaction` red. */
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

/** A share of the window to the whole point: `≈1%`, or `<1%` for one under half a point. */
export const shareText = (share: number): string => {
  const points = share * 100
  return points > 0 && points < 0.5 ? "<1%" : `≈${Math.round(points)}%`
}

/** A usage limit's name as the line says it: `5h window` for the five-hour limit. */
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

/** What the line shows beside the ticket's resources. */
export interface LineInputs {
  /** The worker's processes' memory, as its card has it; none before the run has read it. */
  readonly memory?: number
  /** The account's usage near or at a limit: its warning; null short of one. */
  readonly usage: Usage | null
  /** When its time is read: now, or when the view first saw the worker finished. */
  readonly now: number
}

/**
 * The ranks of the line's steps down in a narrow pane, the lowest first: the memory dropped, then
 * the warning's reset time, then the compactions, then whole parts from the end of the line.
 */
const dropMemory = 0
const shortWarning = 1
const dropCompactions = 2
const fromTheEnd = 3

/** A part shown whole or left out, at `rank`. */
const droppable = (segments: Segments, rank: number): FitPart => ({ forms: [segments, []], rank })

/** The line's parts, in order, each in its forms for a narrow pane (fitParts). */
const partsOf = (r: Resources, inputs: LineInputs, theme: Theme): ReadonlyArray<FitPart> => {
  const { styles } = theme
  const parts: Array<FitPart> = [
    // The time is never left out: it is cut last.
    { forms: [[seg(elapsed(inputs.now - r.took))]], rank: fromTheEnd },
    droppable([seg(tokenCount(allTokens(r.spent.tokens))), seg(" tokens", styles.dim)], fromTheEnd),
  ]
  if (!r.subscription) {
    parts.push(droppable([seg(dollarsText(r.spent.costUsd))], fromTheEnd))
  } else if (r.window !== null) {
    parts.push(
      droppable(
        [
          seg("5h window ", styles.dim),
          seg(`${shareText(r.window.share)} (estimate)`, styles.estimate),
        ],
        fromTheEnd,
      ),
    )
  }
  if (r.context !== null) {
    const full = fullness(r.context)
    const look = contextLook(full, theme)
    parts.push(
      droppable(
        [
          seg("context ", styles.dim),
          seg(gauge(full), look ?? styles.dim),
          seg(gap),
          seg(tokenCount(r.context.tokens), look),
          seg(" of ", styles.dim),
          seg(tokenCount(r.context.window)),
        ],
        fromTheEnd,
      ),
    )
  }
  if (r.compactions > 0) {
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

/**
 * The resource line's segments, `width` wide, its parts two spaces apart. Where it doesn't fit, it
 * drops the memory, then shows the warning without its reset time, then drops the compactions, then
 * whole parts from its end, down to the time, which is cut last.
 */
export const resourceSegments = (
  r: Resources,
  inputs: LineInputs,
  theme: Theme,
  width: number,
): Segments => fitParts(partsOf(r, inputs, theme), width, [seg(gap)])

/** The cache's share of the input of `t`: its reads of everything read in. */
const cacheShare = (t: Tokens): number | null => {
  const given = t.input + t.cache_write + t.cache_read
  return given > 0 ? t.cache_read / given : null
}

/** `n` of 100, to the whole. */
const percent = (share: number): string => `${Math.round(share * 100)}%`

/** Every model's tokens added up. */
const summed = (r: Resources): Tokens =>
  Object.values(r.spent.tokens).reduce(
    (sum, t) => ({
      input: sum.input + t.input,
      output: sum.output + t.output,
      cache_write: sum.cache_write + t.cache_write,
      cache_read: sum.cache_read + t.cache_read,
    }),
    { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  )

/** The widest label of the breakdown, which its figures are lined up after. */
const labelWidth = 12

/**
 * The breakdown's lines (`Spent`), `width` wide within the whole-ticket panel's frame: each row its
 * label, faint, and its figures, wrapped under them.
 */
export const spentLines = (r: Resources, theme: Theme, width: number): ReadonlyArray<Segments> => {
  const { styles } = theme
  const row = (label: string, figures: Segments): ReadonlyArray<Segments> =>
    wrap([seg(label.padEnd(labelWidth), styles.dim), ...figures], width, {
      indent: labelWidth,
    })
  const total = summed(r)
  const all = allTokens(r.spent.tokens)
  const cache = cacheShare(total)
  const models = Object.entries(r.spent.tokens)
    .map(([model, t]) => ({ model, t, all: t.input + t.output + t.cache_write + t.cache_read }))
    .sort((a, b) => b.all - a.all)
  const lines: Array<Segments> = [[seg("Spent", styles.tickets)], []]
  lines.push(
    ...row("tokens", [
      seg(tokenCount(all)),
      ...(cache === null
        ? []
        : [seg(` · ${percent(cache)} of the input from the cache`, styles.dim)]),
    ]),
  )
  for (const { model, t, all: of } of models) {
    lines.push(
      ...row("", [
        seg(sanitizeLine(model)),
        seg(gap),
        seg(tokenCount(of)),
        seg(
          ` · ${tokenCount(t.input)} in, ${tokenCount(t.cache_write)} cache writes, ${tokenCount(t.cache_read)} cache reads, ${tokenCount(t.output)} out`,
          styles.dim,
        ),
      ]),
    )
  }
  const calls = r.spent.turns
  lines.push(...row("model calls", [seg(`${calls} model call${calls === 1 ? "" : "s"}`)]))
  if (r.subscription) {
    lines.push(
      ...row("dollars", [
        seg(`${dollarsText(r.spent.costUsd)} at API prices (estimate)`, styles.estimate),
        seg(": a subscription login pays none of it", styles.dim),
      ]),
    )
    lines.push(
      ...row(
        "5h window",
        r.window === null
          ? [seg("not reported yet", styles.dim)]
          : [
              seg(`${shareText(r.window.share)} (estimate)`, styles.estimate),
              seg(
                `: the window rose ${percent(r.window.rise)} over the run, shared by dollars at API prices, this ticket's ${dollarsText(r.window.cost)} of the run's ${dollarsText(r.window.runCost)}; it counts what you use beside the run too`,
                styles.dim,
              ),
            ],
      ),
    )
  } else lines.push(...row("dollars", [seg(dollarsText(r.spent.costUsd))]))
  const context = r.context
  lines.push(
    ...row(
      "context",
      context === null
        ? [seg("not measured yet", styles.dim)]
        : [
            seg(`${Math.round(context.percentage)}%`, contextLook(fullness(context), theme)),
            seg(` of ${tokenCount(context.window)}, ${tokenCount(context.tokens)} tokens`),
            ...(context.split.length === 0
              ? []
              : [
                  seg(
                    `: ${context.split.map((part) => `${sanitizeLine(part.name)} ${tokenCount(part.tokens)}`).join(" · ")}`,
                    styles.dim,
                  ),
                ]),
          ],
    ),
  )
  if (r.compactions > 0) {
    lines.push(...row("compactions", [seg(`↻ ${r.compactions}`)]))
  }
  lines.push(
    ...row("of the run", [
      seg(r.runTokens > 0 ? percent(Math.min(all / r.runTokens, 1)) : "0%"),
      seg(` of its ${tokenCount(r.runTokens)} tokens`, styles.dim),
    ]),
  )
  return lines
}

/** The line's indent, under the head's link. */
const indent = "  "

/**
 * The resource line of a worker, `resources`, `width` wide, its time stopped once `finished`; a
 * click opens the breakdown, in the whole-ticket panel. The clock ticks here, in a leaf, so the view over it isn't drawn anew
 * every second.
 */
export const ResourceLine = ({
  resources,
  memory,
  finished,
  width,
  open,
}: {
  readonly resources: Resources
  readonly memory: number | undefined
  readonly finished: boolean
  readonly width: number
  readonly open: () => void
}) => {
  const theme = useTheme()
  const now = useNow()
  const usage = useRunViewPart((view) =>
    view.banners.flatMap((banner) => (banner._tag === "Usage" ? [banner] : [])).at(0),
  )
  // Once the worker has finished, its time stops where the view first saw it so.
  const ended = useRef<number | undefined>(undefined)
  if (!finished) ended.current = undefined
  else ended.current ??= now
  const segments = resourceSegments(
    resources,
    {
      ...(memory === undefined ? {} : { memory }),
      usage: usage ?? null,
      now: ended.current ?? now,
    },
    theme,
    Math.max(width - indent.length, 1),
  )
  return (
    <box height={1} flexShrink={0} {...clickable(open)}>
      <Line segments={[seg(indent), ...segments]} />
    </box>
  )
}
