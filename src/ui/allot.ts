// A screen's lines handed out in priority order (tutti-rvzn.27), so that its parts add up to the
// pane's height and none draws over the part below it: allot, for a layout whose steps depend on
// what the steps before left (Dashboard.tsx's dashboardLayout), and stack, for one that is a list.

/** The lines of a pane, handed out one part at a time. */
export interface Allotment {
  /** A part's lines: as many as it needs, `lines`, of those left. */
  readonly take: (lines: number) => number
  /** The lines not yet handed out. */
  readonly rest: () => number
}

/** The lines of a pane `height` tall, to hand out. */
export const allot = (height: number): Allotment => {
  let rest = Math.max(height, 0)
  return {
    take: (lines) => {
      const got = Math.min(Math.max(lines, 0), rest)
      rest -= got
      return got
    },
    rest: () => rest,
  }
}

/**
 * A pane `height` tall handed out to `wants` in their order, each its part's lines of those left,
 * a part named more than once the sum of them; then `rest` takes the lines left. The parts add up
 * to `height`.
 */
export const stack = <K extends string>(
  height: number,
  wants: ReadonlyArray<readonly [K, number]>,
  rest: NoInfer<K>,
): Record<K, number> => {
  const lines = allot(height)
  const laid = {} as Record<K, number>
  laid[rest] = 0
  for (const [key, want] of wants) laid[key] = (laid[key] ?? 0) + lines.take(want)
  laid[rest] += lines.rest()
  return laid
}
