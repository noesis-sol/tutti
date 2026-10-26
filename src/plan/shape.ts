// The shape of an epic's open tickets, as orchestra v0.9.5's: how the blocks links among them let
// them run, by their count, their longest chain of tickets each waiting on the one before, and their
// hubs, the tickets that hubHolds or more of them wait on directly. Its tickets over its chain is the
// most that run at a time on average, the tickets taken as equal (widthOf). A spec's breakdown warns
// of a narrow tree from it (narrowWarning, § 4.14 'Checked'): the run goes on all the same.
import type { Issue, TicketId } from "../services/Beads.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { compareIds, type Link } from "./plan.ts"

/** How many open tickets must wait directly on a ticket for the shape to name it a hub. */
export const hubHolds = 3

/** The longest chain of tickets, each waiting on the one before, a breakdown's tree may have unwarned. */
export const longChain = 3

/** A ticket of the epic that `holds` of its other open tickets wait on directly. */
export interface Hub {
  readonly id: TicketId
  readonly holds: number
}

export interface Shape {
  readonly epic: TicketId
  /** Its open tickets, epics left out. */
  readonly tickets: number
  /** The longest chain, its first blocker first; empty for no tickets. */
  readonly chain: ReadonlyArray<TicketId>
  /** Its hubs, the most held first. */
  readonly hubs: ReadonlyArray<Hub>
}

/**
 * The longest path through `ids` along `after` (blocker → the tickets waiting on it), the first in
 * ids' order of those as long. A link back to a ticket already on the path isn't followed, so a
 * blocks cycle ends it rather than loop.
 */
const longestChain = (
  ids: ReadonlyArray<TicketId>,
  after: ReadonlyMap<TicketId, ReadonlyArray<TicketId>>,
): ReadonlyArray<TicketId> => {
  // The tickets on the longest path from a ticket, itself included, and the next one on it.
  const depth = new Map<TicketId, number>()
  const next = new Map<TicketId, TicketId>()
  const onPath = new Set<TicketId>()
  const walk = (id: TicketId): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    onPath.add(id)
    let best = 0
    for (const waiting of after.get(id) ?? []) {
      if (onPath.has(waiting)) continue
      const d = walk(waiting)
      if (d > best) {
        best = d
        next.set(id, waiting)
      }
    }
    onPath.delete(id)
    depth.set(id, best + 1)
    return best + 1
  }
  let start: TicketId | undefined
  let most = 0
  for (const id of ids) {
    const d = walk(id)
    if (d > most) {
      start = id
      most = d
    }
  }
  const chain: Array<TicketId> = []
  for (let id = start; id !== undefined; id = next.get(id)) chain.push(id)
  return chain
}

/**
 * The shape of `epic`, whose issues are `issues`: the epics and closed tickets among them are left
 * out, as are links from or to a ticket that isn't one of the rest.
 */
export const shapeOf = (
  epic: TicketId,
  issues: ReadonlyArray<Issue>,
  links: ReadonlyArray<Link>,
): Shape => {
  const ids = [
    ...new Set(
      issues
        .filter((issue) => issue.type !== "epic" && issue.status !== "closed")
        .map((issue) => issue.id),
    ),
  ].sort(compareIds)
  const open = new Set(ids)
  const after = new Map<TicketId, Array<TicketId>>()
  for (const { blocker, blocked } of links) {
    if (!open.has(blocker) || !open.has(blocked) || blocker === blocked) continue
    const waiting = after.get(blocker) ?? []
    if (!waiting.includes(blocked)) after.set(blocker, [...waiting, blocked])
  }
  for (const waiting of after.values()) waiting.sort(compareIds)
  const hubs = ids
    .map((id) => ({ id, holds: after.get(id)?.length ?? 0 }))
    .filter((hub) => hub.holds >= hubHolds)
    .sort((a, b) => b.holds - a.holds)
  return { epic, tickets: ids.length, chain: longestChain(ids, after), hubs }
}

/** The most tickets the shape's links let run at a time on average: its tickets over its chain. */
export const widthOf = (shape: Shape): number =>
  shape.chain.length === 0 ? 0 : shape.tickets / shape.chain.length

/** A width to one decimal, without a trailing ".0": "3.5", "7". */
export const formatWidth = (width: number): string => String(Math.round(width * 10) / 10)

/**
 * The shape in a line: `tutti-aq0o: 7 tickets, longest chain 2 (aq0o.1 > aq0o.3), at most 3.5 at a
 * time; tutti-aq0o.1 holds 6`. The chain's tickets go without the project's prefix of the epic's ID.
 */
export const shapeLine = (shape: Shape): string => {
  const dash = shape.epic.indexOf("-")
  const prefix = dash < 0 ? "" : shape.epic.slice(0, dash + 1)
  const chain = shape.chain
    .map((id) =>
      sanitizeLine(prefix !== "" && id.startsWith(prefix) ? id.slice(prefix.length) : id),
    )
    .join(" > ")
  const tickets = shape.tickets === 1 ? "1 ticket" : `${shape.tickets} tickets`
  const line = `${sanitizeLine(shape.epic)}: ${tickets}, longest chain ${shape.chain.length} (${chain}), at most ${formatWidth(widthOf(shape))} at a time`
  return shape.hubs.length === 0
    ? line
    : `${line}; ${shape.hubs.map((hub) => `${sanitizeLine(hub.id)} holds ${hub.holds}`).join(", ")}`
}

/**
 * The warning of a tree whose blocks links keep a run narrow, or null: its longest chain is over
 * longChain tickets, or its links let fewer tickets run at a time on average than `concurrent`, the
 * run's concurrency, or than its tickets where they are fewer. It names the chain and the hubs.
 */
export const narrowWarning = (shape: Shape, concurrent: number): string | null => {
  const why: Array<string> = []
  if (shape.chain.length > longChain) why.push(`its longest chain over ${longChain}`)
  if (widthOf(shape) < Math.min(concurrent, shape.tickets)) {
    why.push(`fewer than the run's ${concurrent} tickets at a time`)
  }
  return why.length === 0
    ? null
    : `a narrow ticket tree, ${why.join(" and ")}: ${shapeLine(shape)}. A ticket needs a blocks link only to one whose code it builds on, so that the rest run side by side`
}
