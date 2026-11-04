// The panel beside the tickets table (§ 7.2, tutti-h2o9): in a pane at least 130 columns wide, the
// table gives up its right side, which its last column rarely fills, to a panel of the same height,
// under the totals strip's In queue cell, the gap between them under the strip's bar before In queue
// (tutti-ebra, tutti-nsw2), its label on the `Tickets` label's line and its rounded frame beside the
// table's. While nothing needs you it shows Up next: the tickets
// waiting in the queue, those only a free slot holds back first (an Asked ticket whose question is
// answered, then `ready`), then each held back or
// waiting with why, as the log says it (`› after t-1: both touch scripts/check.sh`, tutti-zv69), the
// tickets it waits for in the live role, wrapped under its text; `+N more` for those that don't fit. While something needs you (tutti-07nj) it shows
// that instead, one at a time: an Asked ticket's question, its title, which ticket waits on it, as
// much of its description as fits and its options, the recommended one first, to answer in place;
// or a Blocked ticket, why, and what clears it. The dashboard's keys and clicks act on it
// (Dashboard.tsx); a click target names an option by its index, or one of panelTargets.
// A narrower pane has no panel, and the table its whole width, as before.
import { afterParts } from "../run/after.ts"
import { someFiles } from "../run/merge.ts"
import { isConflict, type Need, type QueueRow, type RunGoes, type Totals } from "../run/runView.ts"
import { type Border, boxed, cut, fit, padded, type Segments, seg, wrap } from "./line.tsx"
import { marks } from "./marks.ts"
import { queueDivider } from "./Totals.tsx"
import type { Style, Theme } from "./theme.ts"

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
 * then the queue in its frame, blank rows filling it.
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
    seg("  "),
    seg("Up next", styles.tickets),
    ...(held > 0 ? [seg(` · ${held} held back`, styles.heldBack)] : []),
  ]
  const inner = Math.max(width - 4, 1)
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
      const word = each.answered === undefined ? readyWord : `answered · ${each.answered}`
      return [[...id, seg("  "), seg(word, styles.quiet)]]
    }
    const reason = afterParts(each.held).map((part) =>
      seg(part.text, part.id ? waitedFor : styles.quiet),
    )
    const why = wrap(reason, whyWidth)
    return why.map((part, i) => [
      ...(i === 0
        ? [...id, seg("  "), seg(lead, styles.quiet)]
        : [seg(" ".repeat(idWidth + 2 + lead.length))]),
      ...(part as Segments),
    ])
  })
  const body: Array<Segments> = []
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

/** Which need the panel shows, whether the focus is on it or gone into it, at which choice. */
export interface PanelAt {
  readonly index: number
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
    : `${chars.slice(0, reasonLimit).join("")}… (the log has it all)`
}

/** What the panel's foot says of `h`, by what it does for `need`. */
const handBackKey = (need: Blocked): string => {
  if (!isConflict(need) || need.mergesOver) return ""
  return !need.handBack && need.about?.handBacksOff === true
    ? " · h tries its merge again"
    : " · h hands it back"
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
  const inner = Math.max(width - 4, 1)
  const height = (text: string, limit?: number) =>
    wrap([seg(text, null)], inner, limit === undefined ? {} : { limit }).length
  const said = clearsOf(need).reduce((total, text) => total + height(text), 0)
  return said > Math.max(lines - 3, 1) - 2 - height(need.title, 2)
}

/** The keys the panel's foot names, with the needs it can go to. */
const footOf = (keys: string, count: number): Segments => [
  seg(count > 1 ? `${keys} · ] next` : keys, null),
]

/**
 * The Needs you panel's lines, `width` wide, `lines` tall with its label: `Needs you · 1 of 2`,
 * then the need `at.index` shows in a frame in the needsYou colour, heavy while the focus is on it.
 */
export const needsLines = (
  needs: ReadonlyArray<Need>,
  at: PanelAt,
  theme: Theme,
  width: number,
  lines: number,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  const index = Math.min(Math.max(at.index, 0), needs.length - 1)
  const need = needs[index]
  const label: Segments = [
    seg("  "),
    seg("Needs you", styles.stop),
    seg(` · ${index + 1} of ${needs.length}`, styles.dim),
  ]
  const inner = Math.max(width - 4, 1)
  const room = Math.max(lines - 3, 1)
  const dim = (text: string, target?: number) => seg(text, styles.dim, target)
  const wrapped = (segments: Segments, limit?: number) =>
    wrap(segments, inner, limit === undefined ? {} : { limit }) as ReadonlyArray<Segments>
  const body: Array<Segments> = []
  if (need?._tag === "Question") {
    const question = need.question
    const title = wrapped([seg(question?.title ?? need.title, styles.key, panelTargets.read)], 2)
    const about = [dim(`${need.id} · ${need.label} waits on it`)]
    if (question === null) {
      body.push(...title, about, [dim("reading its question…")])
    } else {
      const options = question.options ?? []
      const choice = (i: number, text: Segments, target: number): Segments => {
        const focused = at.inside && at.choice === i
        return [seg(focused ? "> " : "  ", styles.key, target), ...text]
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
          : `↑↓ 1–${options.length} · Enter answer`
        : at.focused
          ? [digits, "Enter goes in"].filter((each) => each !== "").join(" · ")
          : digits !== ""
            ? digits
            : options.length === 0
              ? "click to answer"
              : "move here to answer"
      const foot = footOf(keys, needs.length).map((each) => ({ ...each, look: styles.dim }))
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
                [dim("… click to read it all", panelTargets.read)],
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
    const handsBack = at.focused ? handBackKey(need) : ""
    const reach = at.focused ? `Enter goes in${handsBack}` : "move here to choose"
    const keys = !short
      ? at.inside
        ? `Enter opens its worker view${handsBack}`
        : reach
      : at.inside
        ? `… click or Enter reads it all${handsBack}`
        : `… click reads it all · ${reach}`
    body.push(
      [seg(`■ ${need.label} blocked: ${need.why}`, styles.stop)],
      ...titled,
      ...(short ? clears.slice(0, Math.max(spare - titled.length, 0)) : clears),
      footOf(keys, needs.length).map((each) => ({
        ...each,
        look: styles.dim,
        ...(short ? { target: panelTargets.read } : {}),
      })),
    )
  }
  const kept = body.slice(0, room)
  while (kept.length < room) kept.push([])
  const border: Border = at.focused ? "heavy" : "rounded"
  return [padded(cut(label, width), width), ...boxed(kept, width, theme.look("needsYou"), border)]
}
