// The worker view's figures on line 1 (§ 7.5, worker-view design D2, tutti-cxgo.4): what the
// worker consumes, on a subscription and on an API key; the estimate's colour and its word, under
// NO_COLOR too; the context gauge's amounts and colours; compactions once there has been one; the
// warning near a limit; the two-space gaps; and the breakdown a click on them opens. Line 1 as a
// whole, its order and its narrow panes, is worker-view-head.test.tsx's.

import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import type { Resources } from "../src/run/resources.ts"
import type { Usage } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { fitParts } from "../src/ui/fit.ts"
import { workerMemory } from "../src/ui/LoadLine.tsx"
import { type Segments, seg } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  contextLook,
  type FigureInputs,
  figureParts,
  gap,
  shareText,
  spentLines,
  spentTarget,
} from "../src/ui/worker/figures.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")
const noColor = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const began = new Date(2026, 9, 24, 13, 0, 0).getTime()
/** 6m53s on. */
const now = began + 413_000
const model = "claude-opus-5-5"
const memory = 0.8 * 1024 ** 3

/** A worker 6m53s on its ticket, 1.2M tokens in, its context 126k of 200k. */
const resources = (over: Partial<Resources> = {}): Resources => ({
  ticket: "t-1" as TicketId,
  took: began,
  spent: {
    costUsd: 1.84,
    turns: 41,
    results: 3,
    tokens: {
      [model]: { input: 2_000, output: 30_000, cache_write: 168_000, cache_read: 1_000_000 },
    },
  },
  runTokens: 10_000_000,
  subscription: true,
  window: { share: 0.012, rise: 0.06, cost: 1.84, runCost: 9.2 },
  context: {
    tokens: 126_000,
    window: 200_000,
    percentage: 63,
    split: [
      { name: "Messages", tokens: 100_000 },
      { name: "System tools", tokens: 26_000 },
    ],
  },
  compactions: 0,
  ...over,
})

const inputs = (over: Partial<FigureInputs> = {}): FigureInputs => ({
  took: began,
  memory,
  usage: null,
  now,
  ...over,
})

const textOf = (segments: Segments): string => segments.map((each) => each.text).join("")

const segmentsOf = (
  r: Resources | undefined,
  over: Partial<FigureInputs> = {},
  appearance = theme,
): Segments => fitParts(figureParts(r, inputs(over), appearance), 300, [seg(gap)])

const lineOf = (r: Resources, over: Partial<FigureInputs> = {}) => segmentsOf(r, over)

describe("the figures", () => {
  test("on a subscription: time, the 5-hour share as an estimate, context, memory; no tokens", () => {
    expect(textOf(lineOf(resources()))).toBe(
      `6m53s  ≈1% (estimate)  context ▰▰▰▰▰▰▱▱▱▱  126k of 200k  ${workerMemory(memory)}`,
    )
  })

  test("on an API key: its dollars, in the text's colour, and no window", () => {
    const segments = lineOf(resources({ subscription: false, window: null }))
    expect(textOf(segments)).toBe(
      `6m53s  $1.84  context ▰▰▰▰▰▰▱▱▱▱  126k of 200k  ${workerMemory(memory)}`,
    )
    expect(segments.find((each) => each.text === "$1.84")?.look).toBeNull()
  })

  test("on a subscription before the window is heard, no share", () => {
    expect(textOf(lineOf(resources({ window: null })))).toBe(
      `6m53s  context ▰▰▰▰▰▰▱▱▱▱  126k of 200k  ${workerMemory(memory)}`,
    )
  })

  test("before the run has resources, the time from the card and the memory", () => {
    expect(textOf(segmentsOf(undefined))).toBe(`6m53s  ${workerMemory(memory)}`)
  })

  test("the time, estimate, context, compactions and memory open Spent; the gaps and warning don't", () => {
    const resetsAt = new Date(2026, 9, 24, 14, 20, 0).getTime()
    const usage: Usage = { utilization: 0.92, resetsAt, limit: "five-hour" }
    const segments = lineOf(resources({ compactions: 2 }), { usage })
    const opening = segments.filter((each) => each.target === spentTarget).map((each) => each.text)
    expect(opening.join("")).toBe(
      `6m53s≈1% (estimate)context ▰▰▰▰▰▰▱▱▱▱  126k of 200k↻ 2 compactions${workerMemory(memory)}`,
    )
    expect(segments.at(-1)?.target).toBeUndefined()
  })

  test("the estimate in its italic colour, followed by its word, which NO_COLOR keeps", () => {
    const estimate = lineOf(resources()).find((each) => each.text.includes("(estimate)"))
    expect(estimate?.text).toBe("≈1% (estimate)")
    expect(estimate?.look).toBe(theme.styles.estimate)
    expect((theme.styles.estimate.attributes & TextAttributes.ITALIC) !== 0).toBe(true)
    const plain = segmentsOf(resources(), {}, noColor)
    expect(textOf(plain)).toContain("≈1% (estimate)")
    expect(shareText(0.004)).toBe("<1%")
    expect(shareText(0)).toBe("≈0%")
    expect(shareText(0.126)).toBe("≈13%")
  })

  test("the context gauge's amounts, plain at 50%, yellow from 70%, red near compaction", () => {
    const at = (tokens: number) => {
      const segments = lineOf(
        resources({ context: { tokens, window: 200_000, percentage: 0, split: [] } }),
      )
      const figure = segments.findIndex((each) => each.text === "context ")
      return {
        gauge: segments[figure + 1],
        figure: segments[figure + 3],
        text: textOf(segments.slice(figure, figure + 6)),
      }
    }
    const half = at(100_000)
    expect(half.text).toBe("context ▰▰▰▰▰▱▱▱▱▱  100k of 200k")
    expect(half.figure?.look).toBeNull()
    expect(half.gauge?.look).toBe(theme.styles.dim)
    const three = at(150_000)
    expect(three.text).toBe("context ▰▰▰▰▰▰▰▰▱▱  150k of 200k")
    expect(three.gauge?.look).toBe(theme.look("notice"))
    expect(three.figure?.look).toBe(theme.look("notice"))
    const near = at(190_000)
    expect(near.text).toBe("context ▰▰▰▰▰▰▰▰▰▰  190k of 200k")
    expect(near.gauge?.look).toBe(theme.look("needsYou"))
    expect(contextLook(0.95, theme)).toBe(theme.look("needsYou"))
    expect(contextLook(0.5, theme)).toBeNull()
  })

  test("compactions show only once there has been one", () => {
    expect(textOf(lineOf(resources()))).not.toContain("compaction")
    expect(textOf(lineOf(resources({ compactions: 1 })))).toContain(
      "126k of 200k  ↻ 1 compaction  ",
    )
    expect(textOf(lineOf(resources({ compactions: 2 })))).toContain("↻ 2 compactions")
  })

  test("near a limit, the account's figure as a warning with its reset", () => {
    const resetsAt = new Date(2026, 9, 24, 14, 20, 0).getTime()
    const usage: Usage = { utilization: 0.92, resetsAt, limit: "five-hour" }
    const segments = lineOf(resources(), { usage })
    expect(textOf(segments)).toEndWith(`${workerMemory(memory)}  ⚠ 5h window 92% · resets 14:20`)
    expect(segments.at(-1)?.look).toBe(theme.styles.deferred)
    const reached = lineOf(resources(), { usage: { ...usage, utilization: 1 } })
    expect(reached.at(-1)?.look).toBe(theme.styles.testing)
  })

  test("every gauge and figure and every part two spaces apart, segments of their own", () => {
    const segments = lineOf(resources({ compactions: 2 }))
    const gauge = segments.findIndex((each) => each.text.startsWith("▰"))
    expect(segments[gauge + 1]?.text).toBe("  ")
    expect(segments[gauge + 2]?.text).toBe("126k")
    // No segment but the gaps starts or ends with a space beside another part.
    const gaps = segments.filter((each) => each.text === "  ")
    expect(gaps.length).toBe(5)
  })
})

describe("the breakdown", () => {
  const linesText = (r: Resources) =>
    spentLines(r, theme, 200)
      .map((line) => textOf(line).trimEnd())
      .join("\n")

  test("on a subscription: tokens by model, calls, dollars and the window as estimates, context", () => {
    const text = linesText(resources({ compactions: 2 }))
    expect(text).toContain("Spent")
    expect(text).toContain("tokens      1.2M · 85% of the input from the cache")
    expect(text).toContain(`${model}  1.2M · 2k in, 168k cache writes, 1M cache reads, 30k out`)
    expect(text).toContain("model calls 41 model calls")
    expect(text).toContain("dollars     $1.84 at API prices (estimate)")
    expect(text).toContain("5h window   ≈1% (estimate): the window rose 6% over the run")
    expect(text).toContain("this ticket's $1.84 of the run's $9.20")
    expect(text).toContain("context     63% of 200k, 126k tokens: Messages 100k · System tools 26k")
    expect(text).toContain("compactions ↻ 2")
    expect(text).toContain("of the run  12% of its 10M tokens")
    const estimates = spentLines(resources(), theme, 76)
      .flat()
      .filter((each) => each.text.includes("(estimate)"))
    expect(estimates.every((each) => each.look === theme.styles.estimate)).toBe(true)
  })

  test("on an API key: the dollars spent, plain, and no window", () => {
    const text = linesText(resources({ subscription: false, window: null }))
    expect(text).toContain("dollars     $1.84")
    expect(text).not.toContain("estimate")
    expect(text).not.toContain("5h window")
  })

  test("before the session has said, the context is not measured yet", () => {
    expect(linesText(resources({ context: null }))).toContain("context     not measured yet")
  })
})
