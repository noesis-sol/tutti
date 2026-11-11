// A row's box (Box.Row, § 7.2, tutti-149z.3, tutti-149z.9), which Enter opens on a row with no worker
// view to go to, one done or set aside, or on any row with no need in a pane with no panel: over the
// dashboard, the pane's whole height and up to the answer form's width, the whole ticket and how it
// went, where the panel can only say what happened last. Under the top border (TicketHead's, `Ticket`
// and its type and priority), in a scrollbox: what the panel says of the row (rowParagraphs); the
// whole ticket, drawn with <markdown> as the worker view's is (wholeTicket), read again with bd show
// as the box opens so that notes added during the run show, what RunView has until bd answers, and
// kept if bd can't; and its stats (statsLines), its scorecard or what the run knows so far, each
// figure against the run's median for its size where it has one.
//
// ↑↓, PgUp/PgDn and the wheel scroll it, `↓ N more lines` in its bottom border while there is more;
// Enter opens its worker view while it has one, Esc closes it, as does its row's leaving.
import type { OptimizedBuffer, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useRef } from "react"
import { clock } from "../core/localTime.ts"
import { UiCommand } from "../run/commands.ts"
import { dollarsText, tokenCount } from "../run/figures.ts"
import type { TicketOutcome } from "../run/phase.ts"
import type { Row } from "../run/runView.ts"
import { sizeWords } from "../run/scorecard.ts"
import { type Peer, type PeerMedian, peerMedian } from "../run/ticketStats.ts"
import type { TicketId } from "../services/Beads.ts"
import { arrowKeys, marks } from "../text/marks.ts"
import { formWidth } from "./AnswerForm.tsx"
import { elapsed } from "./Card.tsx"
import { type Command, isOn, useCommands } from "./keyCommands.ts"
import { useInput } from "./keys.ts"
import {
  boxSides,
  boxWidth,
  FrameRow,
  frameEdge,
  frameInner,
  Line,
  Lines,
  padded,
  plainFg,
  type Segments,
  seg,
  separatorOf,
  wrap,
} from "./line.tsx"
import { Backdrop, choiceRows } from "./Modal.tsx"
import { rowParagraphs } from "./SidePanel.tsx"
import { badgesOf, ticketEdge, wholeTicket } from "./TicketHead.tsx"
import type { Theme } from "./theme.ts"
import { useCommand, useNow, useRunViewPart, useTheme } from "./useRunView.ts"
import { useSyntaxStyles } from "./worker/Looks.tsx"

/** The columns of a stat's name, the gap after it included. */
const nameWidth = 13

/** The narrowest a box gets, its frame included. */
const leastWidth = 8

const outcomeWords: { readonly [O in TicketOutcome]: string } = {
  merged: "merged",
  no_change: "no change to merge",
  set_aside: "set aside",
  needs_you: "needs you",
  stopped: "stopped",
  queued: "back in the queue",
}

const counted = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const ofSeconds = (seconds: number): string => elapsed(seconds * 1000)

/** What came of the row: when it merged (its commit), was closed or set aside, and why. */
const endedLine = (row: Row): readonly [string, string] | null => {
  const { detail, since } = row
  switch (detail._tag) {
    case "Merged":
      return ["Merged", `${clock(since)} as ${detail.commit} into ${detail.base}`]
    case "NoChange":
      return ["Closed", `${clock(since)}, no change to merge`]
    case "Deferred":
    case "Review":
      return ["Set aside", `${clock(since)}: ${detail.why}`]
    case "Stopped":
      return ["Stopped", `${clock(since)}: ${detail.why}`]
    default:
      return null
  }
}

/** `figure`, and the median beside it where there is one. */
const against = (figure: string, median: string | null): string =>
  median === null ? figure : `${figure} (median ${median})`

/**
 * The verifier's rounds as a line: `2 rounds: 1 passed, 1 failed; last FAIL, last fix unverified`.
 */
const verifierWords = ({ verifier }: Row["stats"]): string => {
  if (verifier.rounds === 0) return "no rounds"
  const last = [
    ...(verifier.last === undefined ? [] : [`last ${verifier.last.toUpperCase()}`]),
    ...(verifier.last_fix_verified === false ? ["last fix unverified"] : []),
  ]
  return `${counted(verifier.rounds, "round")}: ${verifier.passed} passed, ${verifier.failed} failed${
    last.length === 0 ? "" : `; ${last.join(", ")}`
  }`
}

const peersWords = (size: number | null, median: PeerMedian | null): string => {
  const words = sizeWords(size ?? undefined)
  return median === null
    ? `${words}; no other ticket of the size scored yet`
    : `${words}; median of ${counted(median.tickets, "other")} of the size in the run`
}

/**
 * The stats of `row`, `width` wide: its figures one a line, their names in a column and what wraps
 * kept under what it says. `now` counts a ticket still going on: its time in the phase it is in.
 */
export const statsLines = (
  row: Row,
  peers: ReadonlyArray<Peer>,
  theme: Theme,
  width: number,
  now: number,
): ReadonlyArray<Segments> => {
  const { stats } = row
  const median = peerMedian(peers, row.ticket, stats.size)
  const going = (phase: "working" | "resolving" | "fixing") =>
    stats[phase] + (stats.counting === phase ? Math.max(now - row.since, 0) / 1000 : 0)
  const estimate = stats.estimated ? marks.estimate : ""
  const dollars = (usd: number) => `${estimate}${dollarsText(usd)}`
  const ended = endedLine(row)
  const figures: ReadonlyArray<readonly [string, string]> = [
    [
      "Outcome",
      stats.outcome === null
        ? "under way"
        : `${outcomeWords[stats.outcome]}${stats.why === null ? "" : `: ${stats.why}`}`,
    ],
    ["Dispatched", stats.took === null ? "not yet" : clock(stats.took)],
    ...(ended === null ? [] : [ended]),
    ...(stats.seconds === null ? [] : [["In the run", ofSeconds(stats.seconds)] as const]),
    ["Verifier", verifierWords(stats)],
    [
      "Hand-backs",
      `${stats.handBacks.resolve} to resolve (${ofSeconds(going("resolving"))}), ${stats.handBacks.fix} to fix (${ofSeconds(going("fixing"))})`,
    ],
    ["Merge checks", `${stats.checks.failed} failed, ${stats.checks.timed_out} timed out`],
    ["FLAKY tests", String(stats.flaky)],
    ["Denied calls", String(stats.denied)],
    ["Questions", String(stats.asked)],
    ["Size", peersWords(stats.size, median)],
    [
      "Working",
      against(ofSeconds(going("working")), median === null ? null : ofSeconds(median.working)),
    ],
    ["Turns", against(String(stats.turns), median === null ? null : String(median.turns))],
    [
      "Tokens",
      against(tokenCount(stats.tokens), median === null ? null : tokenCount(median.tokens)),
    ],
    [
      "Cost",
      against(
        stats.costUsd === null ? "none yet" : dollars(stats.costUsd),
        median?.costUsd == null ? null : dollars(median.costUsd),
      ),
    ],
    ["Follow-ups", stats.followUps.length === 0 ? "none" : stats.followUps.join(", ")],
    ["Reverts", stats.reverts.length === 0 ? "none" : stats.reverts.join(", ")],
    ...(stats.audit === null
      ? []
      : [
          [
            "Audit",
            `flagged: ${stats.audit.flagged.join(", ") || "none"}; unclear: ${
              stats.audit.unclear.join(", ") || "none"
            }`,
          ] as const,
        ]),
  ]
  return [
    [seg("Stats", theme.look("heading3", "bold"))],
    ...figures.flatMap(([name, says]) =>
      wrap([...padded([seg(name, theme.styles.dim)], nameWidth), seg(says)], width, {
        indent: nameWidth,
        long: "line",
      }),
    ),
  ]
}

/** A row's box, its row found by its ticket: none once the row has left the table. */
export const RowBox = ({ ticket }: { readonly ticket: TicketId }) => {
  const theme = useTheme()
  const command = useCommand()
  const { box } = useInput()
  const { width, height } = useTerminalDimensions()
  const rows = useRunViewPart((view) => view.rows)
  const peers = useRunViewPart((view) => view.peers)
  const now = useNow()
  const looks = useSyntaxStyles(theme)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const row = rows.find((each) => each.ticket === ticket)
  const gone = row === undefined
  useEffect(() => {
    if (gone) box.set(null)
  }, [gone, box])
  // Notes added during the run show: what RunView has until bd answers, and if bd can't.
  useEffect(() => command(UiCommand.ReadTicket({ ticket })), [command, ticket])
  const issue = row?.issue
  const content = useMemo(() => (issue === undefined ? null : wholeTicket(issue)), [issue])
  const page = (step: 1 | -1) => {
    const shown = scroll.current
    shown?.scrollBy(step * Math.max(shown.viewport.height - 1, 1))
  }
  const commands: ReadonlyArray<Command> = [
    {
      keys: ["return", "enter"],
      when: () => row?.hasWorker === true,
      run: () => {
        box.set(null)
        command(UiCommand.OpenWorker({ ticket }))
      },
      hint: { keys: "Enter", does: "open its worker view" },
    },
    { keys: ["down"], run: () => scroll.current?.scrollBy(1) },
    { keys: ["up"], run: () => scroll.current?.scrollBy(-1) },
    {
      keys: ["pagedown"],
      run: () => page(1),
      hint: { keys: `${arrowKeys.upDown} PgUp/PgDn`, does: "scroll" },
    },
    { keys: ["pageup"], run: () => page(-1) },
    { keys: ["escape"], run: () => box.set(null), hint: { keys: "Esc", does: "close" } },
  ]
  useCommands("box", commands, "Row")
  if (row === undefined) return null

  const frame = theme.look("frame")
  const outer = boxWidth(width, { max: formWidth, least: leastWidth })
  const inner = frameInner(outer)
  const head = rowParagraphs(row, theme).flatMap((each) => wrap([each], inner, { long: "line" }))
  const stats = statsLines(row, peers, theme, inner, now)
  const drawn = commands.flatMap((each) =>
    each.hint !== undefined && isOn(each) ? [{ hint: each.hint, run: each.run }] : [],
  )
  const keys = choiceRows(
    drawn.map(({ hint }) => [
      seg(hint.keys, theme.styles.key),
      seg(` ${hint.does}`, theme.styles.dim),
    ]),
    separatorOf(theme),
    inner,
  )
  // The pane's whole height, however short the ticket: <markdown> lays out more lines than it has
  // as written (a table's rules), and the box doesn't jump as bd answers.
  const lines = Math.max(height - keys.length - 2, 1)
  const boxHeight = lines + keys.length + 2
  // Counted as it is drawn, from the scrollbox as it is then, so that scrolling changes no state.
  const bottom = function (this: Renderable, buffer: OptimizedBuffer) {
    const shown = scroll.current
    const more =
      shown === null ? 0 : Math.max(shown.scrollHeight - shown.scrollTop - shown.viewport.height, 0)
    const label =
      more <= 0
        ? []
        : [seg(`${marks.moreBelow} ${counted(more, "more line", "more lines")}`, theme.styles.dim)]
    let x = this.x
    for (const each of frameEdge("bottom", outer, frame, "rounded", label)) {
      const look = each.look
      buffer.drawText(each.text, x, this.y, look?.fg ?? plainFg, look?.bg, look?.attributes ?? 0)
      x += Bun.stringWidth(each.text)
    }
  }
  return (
    <>
      <Backdrop />
      <box
        position="absolute"
        zIndex={10}
        left={Math.max(Math.floor((width - outer) / 2), 0)}
        top={Math.max(Math.floor((height - boxHeight) / 2), 0)}
        width={outer}
        height={boxHeight}
        // Opaque, in the terminal's own background: the view's text doesn't show through its spaces.
        backgroundColor={RGBA.defaultBackground()}
        flexDirection="column"
      >
        <Line segments={ticketEdge(theme, outer, badgesOf(issue, theme))} />
        <FrameRow width={outer} frame={frame} lines={lines}>
          <scrollbox
            ref={scroll}
            flexGrow={1}
            focusable={false}
            scrollbarOptions={{ visible: false }}
          >
            <Lines lines={[...head, []]} />
            {content === null ? (
              <Line segments={[seg("Reading the ticket…", theme.styles.dim)]} />
            ) : (
              <markdown
                content={content}
                syntaxStyle={looks.markdown}
                renderNode={looks.blocks}
                {...looks.highlighter}
                conceal
              />
            )}
            <Lines lines={[[], ...stats]} />
          </scrollbox>
        </FrameRow>
        <Lines lines={boxSides(keys, outer, frame)} press={(choice) => drawn[choice]?.run()} />
        <box width={outer} height={1} flexShrink={0} renderAfter={bottom} />
      </box>
    </>
  )
}
