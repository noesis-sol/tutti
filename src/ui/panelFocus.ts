// The dashboard's focus (§ 7.3): which of its panels the keys are on, and whether they have gone
// into it. At the top level the arrows move spatially between the panels; inside one they select in
// it. Tab goes its own way, through the cards and what needs you, going in as it does. Worked out
// here apart from the keys and the drawing, as what a panel's neighbours are depends only on which
// panels there are.

/**
 * A panel the focus can be on: the tickets table, the Needs you panel beside it, Current, or, where
 * the pane has no panel beside the table, the totals' Needs you cell, which has no inside.
 */
export type Panel = "tickets" | "needs" | "cell" | "current"

/** Where the dashboard's keys are. */
export interface Focus {
  readonly panel: Panel
  /** Gone into the panel, where the keys select in it, or at the top level, where they move on. */
  readonly inside: boolean
}

/** Where the focus starts: on the panel at the top left, not gone into it. */
export const startFocus: Focus = { panel: "tickets", inside: false }

export type Direction = "left" | "right" | "up" | "down"

/** Where each panel's arrows go, the first of each list that is there: as the panels are laid out. */
const routes: {
  readonly [P in Panel]: { readonly [D in Direction]?: ReadonlyArray<Panel> }
} = {
  tickets: { right: ["needs", "cell"], up: ["cell"], down: ["current"] },
  needs: { left: ["tickets"], down: ["current"] },
  // Over the table, in a pane with no panel beside it.
  cell: { left: ["tickets"], down: ["tickets", "current"] },
  current: { up: ["tickets", "needs", "cell"] },
}

/**
 * The panel an arrow goes to from `from`, among `panels`: `from` where there is none that way. Up
 * from Current goes back to `upper`, the panel above it last on, where it is still there.
 */
export const panelTowards = (
  panels: ReadonlyArray<Panel>,
  from: Panel,
  direction: Direction,
  upper: Panel = "tickets",
): Panel => {
  const way = routes[from][direction] ?? []
  const back = from === "current" && direction === "up" ? [upper] : []
  return [...back, ...way].find((panel) => panels.includes(panel)) ?? from
}

/**
 * A stop of Tab's order (§ 7.3), as they come: a card, Needs you or the totals' cell in its place,
 * then a row that wants you. A card's and a row's `ticket` names it, as the highlight does.
 */
export interface TabStop {
  readonly panel: Panel
  readonly ticket: string | null
}

/**
 * The stop `by` on from `from` in `stops`, round. From none of them, the top level or a row that
 * doesn't want you, Tab starts the box selection: the first or last card, or where there is none,
 * the first or last of what needs you. Undefined with no stops.
 */
export const tabStop = (
  stops: ReadonlyArray<TabStop>,
  from: TabStop | null,
  by: 1 | -1,
): TabStop | undefined => {
  const at = stops.findIndex((stop) => stop.panel === from?.panel && stop.ticket === from.ticket)
  if (at !== -1) return stops[(at + by + stops.length) % stops.length]
  const cards = stops.filter((stop) => stop.panel === "current")
  const among = cards.length > 0 ? cards : stops
  return by === 1 ? among[0] : among.at(-1)
}

/** Where a panel that has gone leaves the focus, the first of these that is there. */
const movedOff: { readonly [P in Panel]: ReadonlyArray<Panel> } = {
  tickets: ["cell", "needs", "current"],
  needs: ["tickets", "cell", "current"],
  cell: ["tickets", "needs", "current"],
  current: ["tickets", "needs", "cell"],
}

/**
 * `focus` among `panels`, of which `filled` have something to select: off a panel that has gone (a
 * resize, the last need answered), to the top level of the next there, and out of an emptied one.
 */
export const focusAmong = (
  focus: Focus,
  panels: ReadonlyArray<Panel>,
  filled: ReadonlyArray<Panel>,
): Focus => {
  if (!panels.includes(focus.panel)) {
    const panel = movedOff[focus.panel].find((each) => panels.includes(each)) ?? "current"
    return { panel, inside: false }
  }
  return focus.inside && !filled.includes(focus.panel) ? { ...focus, inside: false } : focus
}

/**
 * The index a move goes to among `count` things laid out `across` to a row, from `at`: left and
 * right one on, in reading order and round; up and down in the column, round, to the last thing
 * where a shorter last row has none under it. `at` -1 is none yet: the first, or the last.
 */
export const gridMove = (
  count: number,
  across: number,
  at: number,
  direction: Direction,
): number => {
  if (count === 0) return -1
  const forward = direction === "right" || direction === "down"
  if (at < 0 || at >= count) return forward ? 0 : count - 1
  if (direction === "left" || direction === "right") {
    return (at + (forward ? 1 : -1) + count) % count
  }
  const column = at % across
  if (direction === "down") {
    if (at + across < count) return at + across
    // Below is the last row's end, where it is shorter than this one's place in it.
    return Math.floor(at / across) < Math.floor((count - 1) / across) ? count - 1 : column
  }
  if (at - across >= 0) return at - across
  const last = Math.floor((count - 1) / across) * across + column
  return Math.min(last, count - 1)
}
