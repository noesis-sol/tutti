// Nothing to run (§ 5 item 4, § 7.11), as orchestra's nothing.go has it. A run with nothing to do
// says so before it starts, rather than open the dashboard only to end at once: `check` reads what
// the run would start from (bd ready in its scope, and the workers the last run left) and, when
// neither gives it anything, says why: everything is done (`✓ All done`), or nothing is ready
// (`○ Nothing ready to run`, with each reason and its command), and the deferred tickets whose
// blockers have merged (DEFERRED_FREE). The run then prints that in a box on the main screen, or
// as plain lines, and exits 0 without a dashboard, triage, a report or a notification.
import { Console, Effect, Result } from "effect"
import { Beads, type BeadsError, HumanLabel, type Issue, type TicketId } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import type { Theme } from "../ui/theme.ts"
import type { Branches } from "./closedBranches.ts"
import * as free from "./deferredFree.ts"
import { EventStream } from "./eventstream.ts"
import { exitCodes } from "./holds.ts"
import { dated, detail, type Line, Log, line } from "./log.ts"
import { say } from "./say.ts"
import * as scope from "./scope.ts"
import { endRecord } from "./spending.ts"

/** What holds back a ready ticket the run would otherwise start (§ 2 Held back). */
export type HoldKind =
  /** A parent waiting for its subtickets to be closed and merged. */
  | "parent"
  /** A ticket waiting for a closed ticket blocking it to merge. */
  | "blocker"
  /** A follow-up waiting for the closed ticket it was discovered from to merge. */
  | "followUp"

/** Why a run has nothing to do: everything is done, or nothing is ready, and what holds the rest. */
export interface NothingToRun {
  /** The run's scope (--ticket), or null for all of bd ready. */
  readonly scope: TicketId | null
  /**
   * No ticket is left but those of the excluded types, never run, and none is closed but not
   * merged. In a scoped run: SCOPE_DONE.
   */
  readonly allDone: boolean
  /** When all is done, the tickets of the excluded types (epics) still open, for you to close. */
  readonly stillOpen: ReadonlyArray<string>

  // Nothing ready, in a run of all of bd ready: the tickets not closed, other than those of the
  // excluded types, by what holds them, and the tickets closed but not merged.
  /** Questions (labelled human) waiting for your answer. */
  readonly questions: number
  /** Open or blocked, waiting on other tickets. */
  readonly waiting: number
  /** Ready parents the run holds back for their subtickets, which bd blocked doesn't list. */
  readonly heldParents: number
  /** Ready tickets the run holds back for a closed blocker to merge. */
  readonly heldBlocked: number
  /** Ready follow-ups the run holds back for the ticket they were discovered from to merge. */
  readonly heldFollowUps: number
  readonly inProgress: number
  readonly deferred: number
  /** In any other status. */
  readonly other: number
  /** Closed but not merged. */
  readonly unmerged: number

  /** Nothing ready in a scoped run: each ticket of the scope not done, as SCOPE_OPEN names it. */
  readonly notDone: ReadonlyArray<scope.NotDone>
  /** Each deferred ticket of the run's scope whose blockers have all merged, for you to reopen. */
  readonly deferredFree: ReadonlyArray<free.DeferredFree>
  /** Why bd couldn't say which those are, for the log: it only drops the list. */
  readonly freeError: string | null
  /** The run's done line for this early exit, as the log and events.jsonl record it. */
  readonly done: string
}

/** Nothing ready and nothing held: what a NothingToRun has unless it says otherwise. */
const none: NothingToRun = {
  scope: null,
  allDone: false,
  stillOpen: [],
  questions: 0,
  waiting: 0,
  heldParents: 0,
  heldBlocked: 0,
  heldFollowUps: 0,
  inProgress: 0,
  deferred: 0,
  other: 0,
  unmerged: 0,
  notDone: [],
  deferredFree: [],
  freeError: null,
  done: "",
}

/** A NothingToRun with `fields`, the rest none. */
export const make = (fields: Partial<NothingToRun>): NothingToRun => ({ ...none, ...fields })

/** How many tickets not closed are left, in a run of all of bd ready: not those closed unmerged. */
export const open = (n: NothingToRun): number =>
  n.questions +
  n.waiting +
  n.heldParents +
  n.heldBlocked +
  n.heldFollowUps +
  n.inProgress +
  n.deferred +
  n.other

/** The done line of a run with nothing to run, before a scoped run's SCOPE_ part. */
export const readyEmpty = (allDone: boolean): string =>
  `READY_EMPTY after 0 tickets: ${allDone ? "everything is done" : "nothing ready"}`

/** Why a ticket the run finds closed but not merged at its start is so. */
export const earlierRun = "left unmerged by an earlier run"

/** What the run knows as it starts, before its loop, beside Beads. */
export interface Options {
  /** The ticket the run is scoped to (--ticket), or null for the whole of bd ready. */
  readonly scope: TicketId | null
  /** The queue's `exclude_types`. */
  readonly filter: scope.Filter
  /** The main checkout. */
  readonly repo: string
  /** The branch tickets merge into. */
  readonly base: string
  /** The tickets whose workers the last run left, for this one to carry on with (§ 4.8). */
  readonly carried: ReadonlySet<TicketId>
  /** The tickets closed but not merged, as the run finds them (merged by hand counts as merged). */
  readonly unmerged: ReadonlySet<TicketId>
  /**
   * Why git finds a closed ticket's work only on its branch (closedBranches.ts's startBranches),
   * for a blocker closed where no run saw it close; without it, such a blocker counts as merged.
   */
  readonly branches?: Branches
  /** What holds back a ready ticket as the run starts, or undefined when it would start. */
  readonly held: (issue: Issue) => Effect.Effect<HoldKind | undefined, BeadsError, Git>
}

/** Holds nothing back. */
export const noHolds = (): Effect.Effect<HoldKind | undefined> => Effect.succeed(undefined)

/**
 * What holds back a ready ticket as the run starts, as its scheduler would hold it back (§ 5 item
 * 5), given the tickets closed but not merged (`unmerged`) and why git finds a closed ticket's work
 * only on its branch (`branches`): a parent whose subtickets aren't all closed and merged, a ticket
 * blocked by one not merged, a follow-up filed from one. Nothing runs yet, so a blocker or a source
 * holds it back only while closed and not merged: left so by an earlier run, or closed where no run
 * saw it close with its work only on its branch.
 */
export const heldAtStart =
  (beads: Beads["Service"], unmerged: ReadonlySet<TicketId>, branches?: Branches) =>
  (issue: Issue): Effect.Effect<HoldKind | undefined, BeadsError, Git> =>
    Effect.gen(function* () {
      const children = yield* beads.list({ parent: issue.id, all: true })
      if (children.some((child) => child.status !== "closed" || unmerged.has(child.id))) {
        return "parent"
      }
      const links = (yield* beads.show(issue.id)).dependencies
      const by = (type: string) =>
        Effect.gen(function* () {
          for (const link of links) {
            if (link.type !== type) continue
            if (unmerged.has(link.id)) return true
            // bd ready lists a ticket once its blockers are closed: one bd show didn't describe is.
            if (branches === undefined || (link.issue?.status ?? "closed") !== "closed") continue
            if ((yield* branches(link.id)) !== undefined) return true
          }
          return false
        })
      if (yield* by("blocks")) return "blocker"
      if (yield* by("discovered-from")) return "followUp"
      return undefined
    })

/**
 * Why a run of all of bd ready has nothing to run, given the tickets not closed (`unclosed`), how
 * many are closed but not merged, and the ready tickets, all held back, with what holds each.
 */
export const allNothing = (
  filter: scope.Filter,
  unclosed: ReadonlyArray<Issue>,
  unmerged: number,
  held: ReadonlyMap<string, HoldKind>,
): NothingToRun => {
  const excluded = scope.excludedTypes(filter)
  const counts = { ...none, unmerged }
  const stillOpen: Array<string> = []
  for (const ticket of unclosed) {
    const hold = held.get(ticket.id)
    if (excluded.includes(ticket.type)) stillOpen.push(ticket.id)
    else if (hold === "parent") counts.heldParents++
    else if (hold === "followUp") counts.heldFollowUps++
    else if (hold !== undefined) counts.heldBlocked++
    else if (ticket.labels.includes(HumanLabel)) counts.questions++
    else if (ticket.status === "open" || ticket.status === "blocked") counts.waiting++
    else if (ticket.status === "in_progress") counts.inProgress++
    else if (ticket.status === "deferred") counts.deferred++
    else counts.other++
  }
  const allDone = open(counts) === 0 && unmerged === 0
  return { ...counts, allDone, stillOpen: allDone ? stillOpen : [], done: readyEmpty(allDone) }
}

/** Why a scoped run has nothing to run, as the scope's end says it; null when bd can't say. */
const scopeNothing = (
  beads: Beads["Service"],
  root: TicketId,
  filter: scope.Filter,
  unmerged: ReadonlySet<TicketId>,
): Effect.Effect<NothingToRun | null> =>
  Effect.map(
    scope.end(
      beads,
      root,
      {
        unmerged: (issue) => (unmerged.has(issue.id) ? earlierRun : undefined),
        aside: () => false,
        closedByRun: () => false,
      },
      filter,
    ),
    (end) => {
      if (end._tag === "Unreadable") return null
      const allDone = end._tag === "Done"
      return make({
        scope: root,
        allDone,
        stillOpen: end._tag === "Done" && end.closed === "you" ? [root] : [],
        notDone: end._tag === "Open" ? end.notDone : [],
        done: `${readyEmpty(allDone)}; ${scope.line(end)}`,
      })
    },
  )

/**
 * Why the run `options` describes has nothing to run, or null when it has something: bd ready, in
 * the run's scope, lists a ticket it would start, or the last run left a worker on a ticket in the
 * scope for this one to carry on with. A ready ticket held back at the start is not one it would
 * start. With nothing to run, it lists the deferred tickets whose blockers have merged. It only
 * reads, so it can run before the loop. Its error is bd's, when it can't tell: the run then goes
 * ahead, and the loop reports it.
 */
export const check = (
  options: Options,
): Effect.Effect<NothingToRun | null, BeadsError, Beads | Git> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const root = options.scope
    const ready = yield* scope.ready(beads, root, options.filter)
    const subs = root === null ? [] : yield* scope.descendants(beads, root)
    const inScope = new Set([...(root === null ? [] : [root]), ...subs.map((issue) => issue.id)])
    const within = (id: TicketId) => root === null || inScope.has(id)
    if ([...options.carried].some(within)) return null
    let unclosed: ReadonlyArray<Issue> | null =
      ready.length > 0 || root === null ? yield* beads.list() : null
    const held = new Map<string, HoldKind>()
    for (const issue of ready) {
      if (options.carried.has(issue.id)) continue
      const hold = yield* options.held(issue)
      if (hold === undefined) return null
      held.set(issue.id, hold)
    }
    const n =
      root === null
        ? allNothing(options.filter, unclosed ?? [], options.unmerged.size, held)
        : yield* scopeNothing(beads, root, options.filter, options.unmerged)
    if (n === null) return null
    if (unclosed === null) {
      const read = yield* Effect.result(beads.list())
      if (Result.isFailure(read)) {
        return { ...n, freeError: free.unreadable(free.reasonOf(read.failure)) }
      }
      unclosed = read.success
    }
    const freeing: free.Freeing = {
      repo: options.repo,
      base: options.base,
      filter: options.filter,
      inScope: within,
      pending: free.startPending(options.carried, options.unmerged, options.branches),
    }
    const listed = yield* Effect.result(free.list(freeing, unclosed))
    return Result.isSuccess(listed)
      ? { ...n, deferredFree: listed.success }
      : { ...n, freeError: free.unreadable(free.reasonOf(listed.failure)) }
  })

/** Text in a style: ANSI sequences around it, or the text as it is. */
export type Paint = (text: string) => string

/** How the box draws each of its parts (§ 7.11 "Nothing to run"). */
export interface Styles {
  /** All done's frame: `done`. */
  readonly doneFrame: Paint
  /** Nothing ready's frame: `frame`. */
  readonly frame: Paint
  /** All done's `✓`: `done` bold. */
  readonly check: Paint
  /** Nothing ready's `○`: faint. */
  readonly circle: Paint
  /** The heading: bold. */
  readonly heading: Paint
  /** Ticket IDs: `live` bold. */
  readonly id: Paint
  /** Commands: `emphasis` bold. */
  readonly command: Paint
}

const asIs: Paint = (text) => text

/** No styles: the plain lines, and the box where no theme is given. */
export const noStyles: Styles = {
  doneFrame: asIs,
  frame: asIs,
  check: asIs,
  circle: asIs,
  heading: asIs,
  id: asIs,
  command: asIs,
}

/** The styles of `theme`: its roles' colours, with tutti's bold and faint. */
export const themeStyles = (theme: Theme): Styles => {
  const coloured =
    (open: string): Paint =>
    (text) =>
      open === "" ? text : `${open}${text}\x1b[0m`
  return {
    doneFrame: coloured(theme.ansi("done")),
    frame: coloured(theme.ansi("frame")),
    check: theme.styles.closed.paint,
    circle: theme.styles.dim.paint,
    heading: coloured("\x1b[1m"),
    id: theme.styles.picked.paint,
    command: theme.styles.key.paint,
  }
}

/** `1 <one>` or `n <many>`. */
const plural = (n: number, one: string, many: string): string =>
  n === 1 ? `1 ${one}` : `${n} ${many}`

/**
 * The lines for the deferred tickets whose blockers have merged: each with the command that
 * reopens it, and the one that removes the empty worktree it was left, or the one that shows the
 * uncommitted changes that keep it.
 */
const freeLines = (n: NothingToRun, id: Paint, command: Paint): ReadonlyArray<string> =>
  n.deferredFree.flatMap((d) => {
    const blockers = d.blockers.map(id).join(", ")
    const lines = [
      `Deferred: ${id(d.id)}: its blockers have merged (${blockers}); to run it: ${command(free.reopen(d))}`,
    ]
    const removable = free.cleanup(d)
    const kept = free.changes(d)
    if (removable !== undefined) {
      lines.push(`  its worktree has no commits of its own, safe to remove: ${command(removable)}`)
    } else if (kept !== undefined) {
      lines.push(`  its worktree holds uncommitted changes, not safe to remove: ${command(kept)}`)
    }
    return lines
  })

/** The message: its heading, and the lines below it, in `styles`. Beads' text is sanitised. */
export const lines = (
  n: NothingToRun,
  styles: Styles,
): { readonly head: string; readonly rest: ReadonlyArray<string> } => {
  const id = (text: string) => styles.id(sanitizeLine(text))
  const command = (text: string) => styles.command(sanitizeLine(text))
  if (n.allDone) {
    const rest =
      n.stillOpen.length === 0
        ? []
        : [
            `Still open: ${n.stillOpen.map(id).join(", ")} (${command(`bd close ${n.stillOpen.join(" ")}`)})`,
          ]
    return { head: `${styles.check("✓")} ${styles.heading("All done")}`, rest }
  }
  const heading =
    n.scope === null
      ? "Nothing ready to run"
      : `Nothing under ${sanitizeLine(n.scope)} is ready to run`
  const head = `${styles.circle("○")} ${styles.heading(heading)}`
  if (n.scope !== null) {
    const notDone = n.notDone.map((each) => `${id(each.id)} (${sanitizeLine(each.why)})`)
    return { head, rest: [...notDone, ...freeLines(n, id, command)] }
  }
  const rest: Array<string> = []
  if (n.questions > 0) {
    rest.push(
      `${plural(n.questions, "question waits", "questions wait")} for your answer: ${command("bd human list")}`,
    )
  }
  if (n.waiting > 0) {
    rest.push(
      `${plural(n.waiting, "ticket waits", "tickets wait")} on other tickets: ${command("bd blocked")}`,
    )
  }
  if (n.heldParents > 0) {
    rest.push(
      `${plural(n.heldParents, "ticket waits for its subtickets", "tickets wait for their subtickets")} to merge`,
    )
  }
  if (n.heldBlocked > 0) {
    rest.push(
      `${plural(n.heldBlocked, "ticket waits for its blocker", "tickets wait for their blockers")} to merge`,
    )
  }
  if (n.heldFollowUps > 0) {
    rest.push(
      `${plural(
        n.heldFollowUps,
        "follow-up waits for the ticket it was filed from",
        "follow-ups wait for the tickets they were filed from",
      )} to merge`,
    )
  }
  const held = [
    [n.inProgress, "in progress"],
    [n.deferred, "deferred"],
    [n.other, "other"],
  ] as const
  const counted = held.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`)
  if (counted.length > 0) rest.push(counted.join(" · "))
  if (n.unmerged > 0) {
    rest.push(`${n.unmerged} closed but not merged: ${command("bd list --label unmerged")}`)
  }
  return { head, rest: [...rest, ...freeLines(n, id, command)] }
}

/** The narrowest the box is drawn. */
export const minWidth = 20

/** The columns a box takes besides its content: its rounded border and a space either side. */
const chrome = 4

/** `text` after `indent`, wrapped to `width`: the lines it wraps onto indented two spaces more. */
const hang = (text: string, indent: string, width: number): ReadonlyArray<string> => {
  if (indent.length + Bun.stringWidth(text) <= width) return [indent + text]
  return Bun.wrapAnsi(text, Math.max(width - indent.length - 2, 1), { hard: true })
    .split("\n")
    .map((wrapped, i) => `${indent}${i > 0 ? "  " : ""}${wrapped}`)
}

/**
 * The message in a rounded box, framed `done` when all is done and `frame` otherwise, at most
 * `width` columns wide (minWidth at the least) and no wider than its lines: a line too long for it
 * wraps, indented under its own.
 */
export const box = (n: NothingToRun, width: number, styles: Styles): string => {
  const { head, rest } = lines(n, styles)
  const widest = Math.max(Bun.stringWidth(head), ...rest.map((l) => 2 + Bun.stringWidth(l)))
  const inner = Math.min(widest, Math.max(width, minWidth) - chrome)
  const content = [...hang(head, "", inner), ...rest.flatMap((l) => hang(l, "  ", inner))]
  const frame = n.allDone ? styles.doneFrame : styles.frame
  return [
    frame(`╭${"─".repeat(inner + 2)}╮`),
    ...content.map(
      (l) =>
        `${frame("│")} ${l}${" ".repeat(Math.max(inner - Bun.stringWidth(l), 0))} ${frame("│")}`,
    ),
    frame(`╰${"─".repeat(inner + 2)}╯`),
  ].join("\n")
}

/** The message as plain lines, as the log writes them: the heading, and the rest indented. */
export const plainLines = (n: NothingToRun): ReadonlyArray<Line> => {
  const { head, rest } = lines(n, noStyles)
  return [line`${head}`, ...rest.map((l) => detail`${l}`)]
}

/** How the message is shown: in a box `width` columns wide in `styles`, or as plain lines. */
export type Output =
  | { readonly _tag: "Box"; readonly width: number; readonly styles: Styles }
  | { readonly _tag: "Plain" }

/** Prints the message on stdout: the box, or the plain lines, each after the time. */
export const show = (n: NothingToRun, output: Output): Effect.Effect<void> =>
  Effect.gen(function* () {
    const text =
      output._tag === "Box" ? [box(n, output.width, output.styles)] : yield* dated(plainLines(n))
    yield* Console.consoleWith((console) =>
      Effect.sync(() => {
        for (const each of text) console.log(each)
      }),
    )
  })

/**
 * Ends the run before its loop with the message `n`: the done line to the log and the event
 * stream, as the loop's end would, why the deferred tickets free to run couldn't be listed, if
 * so, and the message on stdout.
 */
export const report = (
  n: NothingToRun,
  output: Output,
): Effect.Effect<void, never, Log | EventStream> =>
  Effect.gen(function* () {
    const logs = yield* Log
    const text = line`${n.done}`
    yield* say({ kind: "done", text })
    if (n.freeError !== null) yield* logs.write(line`${n.freeError}`)
    yield* show(n, output)
  })

/**
 * Whether the run `options` describes has nothing to run, which it then reports (see `report`):
 * the run ends there, with exit code 0 and no dashboard. What the check can't read, the loop reads
 * again and reports, so a bd failure is something to run.
 */
export const nothingToRun = (
  options: Options,
  output: Output,
): Effect.Effect<boolean, never, Beads | Git | Log | EventStream> =>
  Effect.gen(function* () {
    const n = yield* Effect.result(check(options))
    if (Result.isFailure(n) || n.success === null) return false
    yield* report(n.success, output)
    return true
  })

/**
 * Ends the run before its loop with the message `n`, as main does: reported (see `report`), then
 * the end record with exit code 0, which it gives back.
 */
export const endWith = (
  n: NothingToRun,
  output: Output,
): Effect.Effect<number, never, Log | EventStream> =>
  Effect.gen(function* () {
    yield* report(n, output)
    yield* (yield* EventStream).emit(yield* endRecord(exitCodes.ok))
    return exitCodes.ok
  })

/**
 * Ends the run before its loop when it has nothing to run (see `endWith`), giving back its exit
 * code; null when the run has something to run, or bd can't say, and goes on to its loop.
 */
export const endIfNothing = (
  options: Options,
  output: Output,
): Effect.Effect<number | null, never, Beads | Git | Log | EventStream> =>
  Effect.gen(function* () {
    const n = yield* Effect.result(check(options))
    if (Result.isFailure(n) || n.success === null) return null
    return yield* endWith(n.success, output)
  })
