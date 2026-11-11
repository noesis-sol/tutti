// The panel beside the tickets table (§ 7.2, tutti-h2o9): in a pane at least 130 columns wide, the
// table gives up its right side, which its last column rarely fills, to a panel of the same height,
// under the totals strip's In queue cell, the gap between them under the strip's bar before In queue
// (tutti-ebra, tutti-nsw2), its label on the `Tickets` label's line and its rounded frame beside the
// table's. While nothing needs you it shows Up next: the tickets
// waiting in the queue, those only a free slot holds back first (an Asked ticket whose question is
// answered, then `ready`), then each held back or
// waiting with why, as the log says it (`› after t-1: both touch scripts/check.sh`, tutti-zv69), the
// tickets it waits for in the live role, wrapped under its text; `+N more` for those that don't fit,
// under `Nothing needs you`. With a row of the table selected (tutti-149z.3), by you or by itself
// (selectedTicket), it shows that row's detail instead (tutti-07nj): an Asked ticket's question, its
// title, which ticket waits on it, as much of its description as fits and its options, the
// recommended one first, to answer in place; a Blocked ticket, why, and what clears it; any other
// row's rowParagraphs. The dashboard's keys and clicks act on it (Dashboard.tsx); a click target
// names an option by its index, or one of panelTargets.
// A narrower pane has no panel, and the table its whole width, as before.

import { clock } from "../core/localTime.ts"
import { afterParts } from "../run/after.ts"
import { someFiles } from "../run/mergeShared.ts"
import {
  isConflict,
  type Need,
  type QueueRow,
  type Row,
  type RunGoes,
  type Totals,
} from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import { arrowKeys, ellipsis, marks, separator } from "../text/marks.ts"
import {
  type Border,
  boxed,
  cut,
  fit,
  frameInner,
  padded,
  type Segment,
  type Segments,
  sectionLabel,
  seg,
  wrap,
} from "./line.tsx"
import { fieldGap, unpointed } from "./spacing.ts"
import { queueDivider } from "./Totals.tsx"
import type { Style, Theme } from "./theme.ts"
import { lookOf } from "./tone.ts"

/** The narrowest pane with a panel. */
export const panelPane = 130

/** The panel's narrowest. */
const leastWidth = 44

/** The columns between the table and the panel. */
export const panelGap = 1

/**
 * The panel's width in a pane `width` wide: from the column right of the totals strip's bar before
 * In queue to the pane's right edge, so that the gap between the table and the panel is under that
 * bar, the table's right border left of it and the panel's left border right of it (tutti-nsw2), at
 * least 44 columns; 0 where the pane is too narrow for one. Where the 44 columns win, the gap is
 * left of the bar, though from 130 columns the bar leaves the panel 51 or more.
 */
export const panelWidth = (width: number): number =>
  width < panelPane ? 0 : Math.max(width - queueDivider(width) - panelGap, leastWidth)

/** The table's width beside a panel `panel` wide, in a pane `width` wide: all of it with none. */
export const tableWidth = (width: number, panel: number): number =>
  panel === 0 ? width : width - panel - panelGap

/** What the panel, and the Needs you list, say with nothing that needs you. */
export const nothingNeedsYou = "Nothing needs you"

/** The word of a ticket only a free slot holds back. */
const readyWord = "ready"

/**
 * The look of the tickets a held ticket waits for: the live role, bold where the scheme leaves it
 * the terminal's default colour, as every role is under NO_COLOR, so that they stand out still.
 */
export const waitedForLook = (theme: Theme): Style =>
  theme.look(
    "live",
    theme.noColor || theme.scheme.colours.live[theme.appearance]._tag === "Default"
      ? "bold"
      : "regular",
  )

/**
 * Up next's lines, `width` wide, `lines` tall with its label: the label, `Up next · 4 held back`,
 * then in its frame `Nothing needs you`, unless a card's request does (its Totals count it), and the
 * queue, blank rows filling it.
 */
export const upNextLines = (
  queue: ReadonlyArray<QueueRow>,
  totals: Totals,
  theme: Theme,
  width: number,
  lines: number,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  const held = totals.heldBack
  const label: Segments = [
    // Up next is no panel the focus goes to, so its label is never lit.
    ...sectionLabel("Up next", theme, { lit: false }),
    ...(held > 0 ? [seg(`${separator}${held} held back`, styles.heldBack)] : []),
  ]
  const inner = frameInner(width)
  const room = Math.max(lines - 3, 1)
  // An ID longer than a third of the panel is cut, as the table cuts one.
  const idWidth = Math.min(
    Math.max(readyWord.length, ...queue.map((each) => Bun.stringWidth(each.label))),
    Math.max(Math.floor(inner / 3), 1),
  )
  // A reason starts `› ` past the ID and its gap, and wraps under its text.
  const lead = `${marks.waitsFor} `
  const whyWidth = Math.max(inner - idWidth - 2 - lead.length, 1)
  const waitedFor = waitedForLook(theme)
  const entries = queue.map((each): ReadonlyArray<Segments> => {
    const id = padded(
      [seg(fit(each.label, idWidth), each.held === null ? null : styles.heldBack)],
      idWidth,
    )
    if (each.held === null) {
      const word = each.answered === undefined ? readyWord : `answered${separator}${each.answered}`
      return [[...id, seg(fieldGap), seg(word, styles.quiet)]]
    }
    const reason = afterParts(each.held).map((part) =>
      seg(part.text, part.id ? waitedFor : styles.quiet),
    )
    const why = wrap(reason, whyWidth)
    return why.map((part, i) => [
      ...(i === 0
        ? [...id, seg(fieldGap), seg(lead, styles.quiet)]
        : [seg(" ".repeat(idWidth + fieldGap.length + lead.length))]),
      ...(part as Segments),
    ])
  })
  const body: Array<Segments> = totals.needsYou === 0 ? [[seg(nothingNeedsYou, styles.quiet)]] : []
  if (queue.length === 0) body.push([seg("nothing queued", styles.quiet)])
  for (const [i, entry] of entries.entries()) {
    const left = queue.length - i
    // The last row says how many don't fit, where the rest don't.
    const fits = body.length + entry.length <= room - (left > 1 ? 1 : 0)
    if (!fits) {
      body.push([seg(`+${left} more`, styles.quiet)])
      break
    }
    body.push(...entry)
  }
  while (body.length < room) body.push([])
  return [padded(cut(label, width), width), ...boxed(body, width, theme.look("frame"))]
}

/** `left`'s lines, each `leftWidth` wide, with `right`'s beside them past the gap, line for line. */
export const beside = (
  left: ReadonlyArray<Segments>,
  right: ReadonlyArray<Segments>,
  leftWidth: number,
): ReadonlyArray<Segments> =>
  left.map((line, i) => [
    ...padded(cut(line, leftWidth), leftWidth),
    seg(" ".repeat(panelGap)),
    ...(right[i] ?? []),
  ])

/** The panel's click targets besides its options, which are their indexes. */
export const panelTargets = {
  /** Other…: the questions box, to type your own. */
  other: 100,
  /** The question's title or its cut description, or a Blocked ticket's cut foot: to read it all. */
  read: 101,
} as const

/** The tickets of `all` the run's needs answered here, gone from `needs`: their rows stand no more. */
const answeredHereOf = (needs: ReadonlyArray<Need>, all: ReadonlyArray<Need>) =>
  new Set(all.filter((need) => !needs.includes(need)).map((need) => need.ticket))

/** Those of `rows` that want you, a question answered here gone from them at once. */
export const wantingRows = (
  rows: ReadonlyArray<Row>,
  needs: ReadonlyArray<Need>,
  all: ReadonlyArray<Need>,
): ReadonlyArray<Row> => {
  const answeredHere = answeredHereOf(needs, all)
  return rows.filter((row) => row.attention !== "rest" && !answeredHere.has(row.ticket))
}

/**
 * The row the panel shows, of the table's `rows` by attention, those with no room among them, with `needs` not answered here of `all` the run's:
 * `chosen` while it is a row and isn't answered here (the dashboard lets it go as its ticket stops
 * needing you); else by itself the first Blocked or Asked row, then a ticket with a need and no row
 * (a conflict hand-back waiting keeps its card); else none, as a row only set aside is read by
 * choosing it and leaves Up next showing (tutti-149z.6). A ticket that comes in more urgent bumps the
 * count, and takes no chosen row's place.
 */
export const selectedTicket = (
  rows: ReadonlyArray<Row>,
  chosen: TicketId | null,
  needs: ReadonlyArray<Need>,
  all: ReadonlyArray<Need>,
): TicketId | null => {
  const answeredHere = answeredHereOf(needs, all)
  if (rows.some((row) => row.ticket === chosen && !answeredHere.has(row.ticket))) return chosen
  const asks = wantingRows(rows, needs, all).find((row) => row.attention !== "setAside")
  const unrowed = needs.find((need) => !rows.some((row) => row.ticket === need.ticket))
  return asks?.ticket ?? unrowed?.ticket ?? null
}

/** What the panel shows of `ticket`: its need, if it has one, else its row. */
export const detailOf = (
  ticket: TicketId | null,
  needs: ReadonlyArray<Need>,
  rows: ReadonlyArray<Row>,
): Need | Row | undefined =>
  needs.find((need) => need.ticket === ticket) ?? rows.find((row) => row.ticket === ticket)

/** Whether the focus, gone into the panel, has something to do on what it shows. */
export const goesIn = (detail: Need | Row | undefined): boolean =>
  detail !== undefined && ("_tag" in detail || detail.hasWorker)

/** Whether the panel, on what it shows, waits on you, which its frame's colour says. */
const waitsOnYou = (detail: Need | Row | undefined): boolean =>
  detail !== undefined &&
  ("_tag" in detail || detail.attention === "blocked" || detail.attention === "asked")

/** Whether the focus is on the panel or gone into it, at which choice. */
export interface PanelAt {
  readonly focused: boolean
  readonly inside: boolean
  /** The focused choice: an option's index, or the options' count for Other. */
  readonly choice: number
  /** How many of `1`–`9`, from 1, a card's question takes from it: the focus is on that card. */
  readonly taken?: number
}

type Blocked = Extract<Need, { _tag: "Blocked" }>

/** What comes of a ticket left on its conflict that nothing takes up meanwhile. */
const afterConflict =
  "The run's end labels it unmerged; the next run checks and merges it once it rebases cleanly."

/** Whether the run takes it back, fixed by hand (§ 5 item 8): none while it winds down or stops. */
const ifFixed: Record<RunGoes, string> = {
  on: "The run takes it back once its branch has moved on, its worktree is clean and it rebases cleanly.",
  windingDown: "The run is winding down, so it takes nothing back.",
  stopping: "The run is stopping, so it takes nothing back.",
}

/** What `h` does for a ticket left on its conflict with no hand-back waiting; null where it can't. */
const handBackOffer = ({ about, mergesOver }: Blocked): string | null =>
  mergesOver
    ? null
    : about?.handBacksOff === true
      ? "Press h to try its merge again: hand-backs are off, so no worker takes it should it conflict."
      : "Press h to hand it back to its worker, with one more hand-back."

/** What comes of a ticket whose merge stopped the merges: the run holds, then ends (§ 5 item 10). */
const afterStop =
  "The merges have stopped and no new ticket starts. The run's end labels it unmerged; the next run checks and merges it."

/** The most of a merge's reason a need says: a stop's line can list every file in its way. */
const reasonLimit = 300

/** `reason`, cut at reasonLimit, whose line is in the log whole. */
const briefly = (reason: string): string => {
  const chars = [...reason]
  return chars.length <= reasonLimit
    ? reason
    : `${chars.slice(0, reasonLimit).join("")}${ellipsis} (the log has it all)`
}

/** What the panel's foot says of `h`, by what it does for `need`. */
const handBackKey = (need: Blocked): string => {
  if (!isConflict(need) || need.mergesOver) return ""
  return !need.handBack && need.about?.handBacksOff === true
    ? "h tries its merge again"
    : "h hands it back"
}

/**
 * What a Blocked ticket's need says, a paragraph each, what to do first, as a short panel cuts the
 * end: what to run, the worktree, the first files, why it is so and what comes next. A hand-back is
 * offered only where an action does it: `h` or 'Hand it the conflict now' for a steered worker's, `h`
 * for one left on its conflict (§ 4.3), which the run also takes back, fixed by hand (§ 5 item 8);
 * neither once no merge comes.
 */
export const clearsOf = (need: Blocked): ReadonlyArray<string> => {
  const { base, about, handBack } = need
  const rebase = `git rebase ${base} in ${about?.worktree ?? "its worktree"}`
  const reason = about === null ? null : briefly(about.reason)
  const stopped = (fallback: string) => `Its merge stopped: ${reason ?? fallback}`
  switch (need.why) {
    case "MERGE_CONFLICT": {
      const files = about?.files ?? []
      const offer = handBackOffer(need)
      const conflict =
        files.length > 0
          ? `Its rebase onto ${base} conflicts in ${someFiles(files)}.`
          : about === null
            ? `Its rebase onto ${base} conflicts.`
            : `Its branch can't merge onto ${base}.`
      if (handBack && need.mergesOver) {
        return [
          `Run ${rebase} to take it up yourself.`,
          conflict,
          "No merge comes in this run, so its worker's hand-back can't be handed over now.",
          afterConflict,
        ]
      }
      return handBack
        ? [
            "Press h, or 'Hand it the conflict now' in its worker view, to hand it over: you steered its worker, so its conflict's hand-back waits for you.",
            `Or run ${rebase} to take it up yourself, then press h: it merges once it rebases cleanly.`,
            conflict,
            "An overnight run doesn't wait for it; any other waits at its end until you hand it over, release its worker or press q.",
            afterConflict,
          ]
        : [
            `Run ${rebase} to take it up yourself.`,
            conflict,
            ...(offer === null ? [] : [offer]),
            ifFixed[need.run],
            ...(reason === null ? [] : [`Set aside: ${reason}.`]),
            afterConflict,
          ]
    }
    case "DIRTY_TREE":
      return [
        `Leave the main checkout clean, on ${base}.`,
        stopped(`${base}'s checkout has changes the run didn't make`),
        afterStop,
      ]
    case "MERGE_FAILED":
      return [
        `Rebase it: ${rebase}.`,
        stopped(`its branch doesn't fast-forward onto ${base}`),
        afterStop,
      ]
    case "GIT_FAILED":
      // What to do is what git said.
      return [stopped("git failed: the log says how"), "Put right what git says.", afterStop]
    default:
      return ["The log says what happened."]
  }
}

/**
 * Whether a panel `width` wide and `lines` tall cuts what clears `need`: its Enter then opens the
 * box saying all of it (Box.Blocked), rather than the worker view.
 */
export const blockedCut = (need: Blocked, width: number, lines: number): boolean => {
  const inner = frameInner(width)
  const height = (text: string, limit?: number) =>
    wrap([seg(text, null)], inner, limit === undefined ? {} : { limit }).length
  const said = clearsOf(need).reduce((total, text) => total + height(text), 0)
  return said > Math.max(lines - 3, 1) - 2 - height(need.title, 2)
}

/**
 * What the panel, or its box in a pane with no panel, says of a selected row with no need (§ 7.2), a
 * paragraph each: its state, its title, triage's verdict, and what comes of it or what to do. A
 * Review ticket is closed, not deferred, so `bd undefer` is only a Deferred one's, and of those
 * only one bd could defer: one it couldn't says what its line says instead.
 */
export const rowParagraphs = (row: Row, theme: Theme): ReadonlyArray<Segment> => {
  const { styles } = theme
  const { detail } = row
  const head = (why?: string) =>
    seg(
      `${marks[row.mark]} ${row.label} ${row.word}${why === undefined ? "" : `: ${why}`}`,
      lookOf(row.tone, theme),
    )
  const title = seg(row.title, styles.key)
  const said = (text: string) => seg(text, styles.dim)
  const verdict = row.verdict === null ? [] : [seg(`${marks.verdict} ${row.verdict}`, styles.organ)]
  const log = (path: string | null) => (path === null ? [] : [said(`Check log: ${path}`)])
  switch (detail._tag) {
    case "Answered":
      return [head(), title, said(`Its question is answered; it resumes at ${detail.resumes}.`)]
    case "Deferred":
      return [
        head(detail.why),
        title,
        ...verdict,
        ...log(detail.checkLog),
        said(detail.deferFailed ?? `Run bd undefer ${row.label} to bring it back.`),
      ]
    case "Review":
      return [
        head(detail.why),
        title,
        ...verdict,
        ...log(detail.checkLog),
        said(
          "Its worktree is left for review. The run's end labels it unmerged: the tickets it blocks wait until its branch is on the base.",
        ),
      ]
    case "Stopped":
      return [head(detail.why), title, said("The next run resumes it.")]
    case "Merged":
      return [
        head(),
        title,
        said(`Merged as ${detail.commit} into ${detail.base} at ${clock(row.since)}.`),
      ]
    case "NoChange":
      return [head(), title, said(`No change to merge; closed at ${clock(row.since)}.`)]
    case "Other":
      return [
        head(),
        title,
        ...(row.note === row.title ? [] : [said(row.note)]),
        ...(row.attention === "asked"
          ? [said("Its worker waits on you, in its worker view.")]
          : []),
      ]
  }
}

/**
 * The Needs you panel's lines, `width` wide, `lines` tall with its label: `Needs you · 2`, the words
 * following the focus as every panel's label does, `count` as the totals count it, in the stop style
 * while anything needs you, wherever the focus is, faint at 0, then what it shows of the selected row in a frame in the
 * needsYou colour while that waits on you, heavy while the focus is on it.
 */
export const needsLines = (
  detail: Need | Row | undefined,
  count: number,
  at: PanelAt,
  theme: Theme,
  width: number,
  lines: number,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  const need = detail !== undefined && "_tag" in detail ? detail : undefined
  const label = sectionLabel("Needs you", theme, {
    lit: at.focused,
    count: seg(`${count}`, count === 0 ? styles.dim : styles.stop),
  })
  const inner = frameInner(width)
  const room = Math.max(lines - 3, 1)
  const dim = (text: string, target?: number) => seg(text, styles.dim, target)
  const wrapped = (segments: Segments, limit?: number) =>
    wrap(segments, inner, limit === undefined ? {} : { limit }) as ReadonlyArray<Segments>
  const body: Array<Segments> = []
  if (need?._tag === "Question") {
    const question = need.question
    const title = wrapped([seg(question?.title ?? need.title, styles.key, panelTargets.read)], 2)
    const about = [dim(`${need.id}${separator}${need.label} waits on it`)]
    if (question === null) {
      body.push(...title, about, [dim("reading its question…")])
    } else {
      const options = question.options ?? []
      const choice = (i: number, text: Segments, target: number): Segments => {
        const focused = at.inside && at.choice === i
        return [seg(focused ? "> " : unpointed, styles.key, target), ...text]
      }
      const choices = [
        ...options.map((option, i) =>
          choice(
            i,
            [
              seg(`${i + 1} `, styles.key, i),
              seg(option.label, at.inside && at.choice === i ? styles.key : null, i),
              ...(i === 0 ? [dim("  recommended", i)] : []),
            ],
            i,
          ),
        ),
        choice(
          options.length,
          [seg(options.length === 0 ? "Answer…" : "Other…", null, panelTargets.other)],
          panelTargets.other,
        ),
      ]
      // What is true from where the focus is: the digits left it from elsewhere, Enter once it is on
      // the panel.
      const first = (at.taken ?? 0) + 1
      const digits =
        first > options.length
          ? ""
          : first === options.length
            ? `${first} answers`
            : `${first}–${options.length} answer`
      const keys = at.inside
        ? options.length === 0
          ? "Enter answer"
          : `${arrowKeys.upDown} 1–${options.length}${separator}Enter answer`
        : at.focused
          ? [digits, "Enter goes in"].filter((each) => each !== "").join(separator)
          : digits !== ""
            ? digits
            : options.length === 0
              ? "click to answer"
              : "move here to answer"
      const foot = [dim(keys)]
      const fixed = title.length + 1 + choices.length + 1
      const space = room - fixed
      const description = question.description === "" ? [] : wrapped([dim(question.description)])
      const shown =
        description.length <= space
          ? description
          : space <= 0
            ? []
            : [
                ...description.slice(0, space - 1),
                [dim(`${ellipsis} click to read it all`, panelTargets.read)],
              ]
      body.push(...title, about, ...shown, ...choices, foot)
    }
  } else if (need?._tag === "Blocked") {
    const title = wrapped([seg(need.title, styles.key)], 2)
    const paragraphs = clearsOf(need).map((text) => wrapped([dim(text)]))
    const short = blockedCut(need, width, lines)
    // Too short for it all: what to do is its first paragraph, which goes before the title, as much
    // of it as fits, and the foot, to click, says how to read the rest.
    const spare = room - 2
    const titled = !short || spare - title.length >= (paragraphs[0]?.length ?? 0) ? title : []
    const clears = paragraphs.flat()
    // What is true from where the focus is: `h` from anywhere, Enter once it is on the panel.
    const handsBack = handBackKey(need)
    const andH = (enter: string) => [enter, handsBack].filter((each) => each !== "").join(separator)
    const reach = at.focused ? andH("Enter goes in") : handsBack || "move here to choose"
    const keys = !short
      ? at.inside
        ? andH("Enter opens its worker view")
        : reach
      : at.inside
        ? andH(`${ellipsis} click or Enter reads it all`)
        : `${ellipsis} click reads it all${separator}${reach}`
    body.push(
      [seg(`${marks.waitsForYou} ${need.label} blocked: ${need.why}`, styles.stop)],
      ...titled,
      ...(short ? clears.slice(0, Math.max(spare - titled.length, 0)) : clears),
      [short ? dim(keys, panelTargets.read) : dim(keys)],
    )
  } else if (detail !== undefined && !("_tag" in detail)) {
    body.push(...rowParagraphs(detail, theme).flatMap((each) => wrapped([each])))
    if (detail.hasWorker) {
      body.push([
        dim(at.inside ? "Enter opens its worker view" : at.focused ? "Enter goes in" : ""),
      ])
    }
  }
  const kept = body.slice(0, room)
  while (kept.length < room) kept.push([])
  const border: Border = at.focused ? "heavy" : "rounded"
  const frame = theme.look(waitsOnYou(detail) ? "needsYou" : "frame")
  return [padded(cut(label, width), width), ...boxed(kept, width, frame, border)]
}
