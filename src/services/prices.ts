// What model calls cost at API prices, for the worker view's figures while a turn goes on (§ 7.5),
// before its result gives the SDK's own total_cost_usd. Anthropic prices a model's tokens as
// multiples of its input price: cache reads 0.1×, cache writes 1.25×, output 5×. So a call's
// weighted tokens times its model's dollars per input token are its dollars, near enough: the
// result's figure replaces them when it comes.
//
// The table is Anthropic's first-party input prices by model family (cached 2026-10-06); a model it
// doesn't name has no price here, and a model the run has seen a result of is priced from that.
import type { Tokens } from "./events.ts"

/** `tokens` weighted as Anthropic prices them, in input tokens. */
export const weighted = (tokens: Tokens): number =>
  tokens.input + 1.25 * tokens.cache_write + 0.1 * tokens.cache_read + 5 * tokens.output

// Dollars per million input tokens, by the first pattern a model ID matches.
const inputPrices: ReadonlyArray<readonly [RegExp, number]> = [
  [/(fable|mythos)-5/, 10],
  [/opus-5-5/, 4],
  [/opus-5/, 5],
  [/opus-4-[5-9]/, 5],
  [/opus-4/, 15],
  [/sonnet-5/, 2],
  [/sonnet-4|3-7-sonnet/, 3],
  [/haiku-5-5/, 0.1],
  [/haiku-4-5/, 1],
  [/3-5-haiku/, 0.8],
]

/** The dollars per input token of `model`, an API model ID; undefined for one the table doesn't name. */
export const inputPrice = (model: string): number | undefined => {
  const found = inputPrices.find(([pattern]) => pattern.test(model))
  return found === undefined ? undefined : found[1] / 1_000_000
}
