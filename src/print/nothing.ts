// Nothing to run, as the main screen shows it (§ 5 item 4, § 7.11 "Nothing to run"): the message
// src/run/nothing.ts's check made, in a rounded box in the theme's styles, or as plain lines, each
// after the time; and the run's end with it, before its loop, the done line said to the log and
// the event stream as the loop's end would say it, then the end record.
import { Console, Effect, Result } from "effect"
import { dated, detail, type Line, Log, line } from "../core/log.ts"
import * as free from "../run/deferredFree.ts"
import { exitCodes } from "../run/holds.ts"
import { check, type NothingToRun, type Options } from "../run/nothing.ts"
import { say } from "../run/say.ts"
import type { Beads } from "../services/Beads.ts"
import { EventStream } from "../services/EventStream.ts"
import type { Git } from "../services/Git.ts"
import { endRecord } from "../services/Spending.ts"
import type { Worktrees } from "../services/Worktrees.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import { boxed, type Look, paint, seg } from "../ui/line.tsx"
import { boxPad } from "../ui/spacing.ts"
import type { Theme } from "../ui/theme.ts"

/** Text in a style: ANSI sequences around it, or the text as it is. */
export type Paint = (text: string) => string

/** How the box draws each of its parts (§ 7.11 "Nothing to run"). */
export interface Styles {
  /** All done's frame: `done`. */
  readonly doneFrame: Look
  /** Nothing ready's frame: `frame`. */
  readonly frame: Look
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

/** The frame without a style: drawn as it is. */
const unstyled: Look = {
  fg: undefined,
  bg: undefined,
  attributes: 0,
  open: "",
  paint: asIs,
  bold: () => unstyled,
}

/** No styles: the plain lines, and the box where no theme is given. */
export const noStyles: Styles = {
  doneFrame: unstyled,
  frame: unstyled,
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
    doneFrame: theme.look("done"),
    frame: theme.look("frame"),
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

/** The columns boxed's frame takes besides its content: its side and boxPad, either side. */
const chrome = 2 * (1 + boxPad.length)

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
  // Each line is painted already: a segment in no look, which boxed measures without its ANSI.
  return boxed(
    content.map((l) => [seg(l)]),
    inner + chrome,
    frame,
  )
    .map(paint)
    .join("\n")
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
): Effect.Effect<boolean, never, Beads | Git | Worktrees | Log | EventStream> =>
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
): Effect.Effect<number | null, never, Beads | Git | Worktrees | Log | EventStream> =>
  Effect.gen(function* () {
    const n = yield* Effect.result(check(options))
    if (Result.isFailure(n) || n.success === null) return null
    return yield* endWith(n.success, output)
  })
