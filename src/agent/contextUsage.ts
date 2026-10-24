// A worker's context window (§ 7.5's resource line): how full it is, as the session's
// query.getContextUsage() answers after each finished turn. The window is the one Claude Code
// compacts at (the SDK's `maxTokens`, its resolved autocompact window: 200K on a 1M-token model),
// so a full gauge means "compacts now". The answer is the CLI's, of whatever version: each field is
// read defensively, and an answer without its figures is none.
import { Predicate } from "effect"

/** A kind of what fills the window, as the SDK names it: `System tools`, `Messages`, … */
export interface ContextPart {
  readonly name: string
  readonly tokens: number
}

/** How full a worker's context window is. */
export interface ContextUsage {
  /** The tokens in it now. */
  readonly tokens: number
  /** The window it compacts at, in tokens. */
  readonly window: number
  /** How full it is, 0 to 100, as the SDK gives it. */
  readonly percentage: number
  /** What fills it, by kind, largest first: those the SDK counts as used. */
  readonly split: ReadonlyArray<ContextPart>
}

const count = (value: unknown): number | undefined =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * The context usage `answer` gives, a getContextUsage() answer; undefined when it has no tokens or
 * no window to read. A part with no name or count is left out, as are those not used: the free
 * space, the compaction's reserve, tools deferred out of the window.
 */
export const readContextUsage = (answer: unknown): ContextUsage | undefined => {
  if (!Predicate.isObject(answer)) return undefined
  const tokens = count(answer.totalTokens)
  const window = count(answer.maxTokens)
  if (tokens === undefined || window === undefined || window === 0) return undefined
  const percentage = count(answer.percentage) ?? (tokens / window) * 100
  const categories = Array.isArray(answer.categories) ? answer.categories : []
  const split = categories
    .flatMap((each: unknown): ReadonlyArray<ContextPart> => {
      if (!Predicate.isObject(each)) return []
      const name = Predicate.isString(each.name) ? each.name : undefined
      const tokens = count(each.tokens)
      if (name === undefined || name === "" || tokens === undefined || tokens === 0) return []
      // A CLI that doesn't classify its rows: the free space and the compaction's reserve aren't used.
      const used = each.kind === undefined ? !/free|buffer/i.test(name) : each.kind === "used"
      return used ? [{ name, tokens: Math.round(tokens) }] : []
    })
    .sort((a, b) => b.tokens - a.tokens)
  return { tokens: Math.round(tokens), window: Math.round(window), percentage, split }
}
