// The Needs you list (Box.Needs, § 7.2, tutti-fdv1): on a dashboard without the panel beside the
// tickets table, Enter on the totals' Needs you cell, or a click on it, opens a list of what needs
// you, the panel's needs one a line (`? <question> <title>`, `■ <ticket> blocked: <why>`), a question
// once however many tickets ask it (tutti-fnvd.20), then,
// faint, the open questions in the run's scope no ticket in the run waits on, which the list reads
// as it opens (ReadQuestions, under a quiet uuid: having none open needs no toast). ↑↓ or Tab move
// between them, Enter or a click opens one: a question in the questions box at it (QuestionsBox.tsx),
// which opens the list again once it is answered, the next one chosen, that question left out unless
// bd refuses the answer (RefusedAnswers); a Blocked ticket in a box
// saying what clears it, Enter there opening its worker view, `h` handing back one blocked on its
// merge conflict (§ 4.3), Esc back to the list at the next one, as is its leaving Blocked, the box
// drawing it as the run has it now.
// A list with nothing in it once the questions are read says Nothing needs you for `emptyLife`, on
// the toasts' timer, and closes by itself, unless a need comes in meanwhile; Esc, Enter or a click
// anywhere closes it sooner. A read that failed has its own toast, and the empty list closes at
// once. Esc closes it. A question it had as it opened that its read doesn't find open was answered
// outside the dashboard (tutti answer, bd) before the look took its ticket back: it leaves the list
// (tutti-fnvd.9).
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { QuestionNews } from "../run/questionNews.ts"
import { isConflict, type Need } from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import { arrowKeys, marks, separator } from "../text/marks.ts"
import { clickable } from "./click.ts"
import { type Command, isOn, useCommands } from "./keyCommands.ts"
import { Box, type NeedsAt, useInput } from "./keys.ts"
import {
  boxed,
  boxWidth,
  cut,
  fit,
  frameInner,
  Lines,
  type Segments,
  sectionLabel,
  seg,
  separatorOf,
} from "./line.tsx"
import { Backdrop, choiceRows, Modal, modalMaxWidth } from "./Modal.tsx"
import { quietUuid } from "./QuestionsBox.tsx"
import type { OpenQuestion } from "./questions.ts"
import { clearsOf, nothingNeedsYou } from "./SidePanel.tsx"
import { unpointed } from "./spacing.ts"
import type { Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"
import { useCommand, useQuestionNews, useRunViewPart, useTheme } from "./useRunView.ts"

/** How long a list with nothing in it stays open, in ms, before it closes by itself. */
export const emptyLife = 2000

/** What the list says, faint, under what needs you until the run has read the open questions. */
export const listReadingText = "reading the open questions…"

/**
 * An item of the list: a need, with the needs `also` of the other tickets asking its question, or an
 * open question no ticket in the run waits on.
 */
export type NeedsItem =
  | { readonly _tag: "Need"; readonly need: Need; readonly also: ReadonlyArray<Need> }
  | { readonly _tag: "Open"; readonly question: OpenQuestion }

/** The question an item puts, by its ID; none for a Blocked ticket. */
export const questionOf = (item: NeedsItem): string | null =>
  item._tag === "Open"
    ? item.question.id
    : item.need._tag === "Question"
      ? (item.need.question?.id ?? item.need.id)
      : null

/**
 * The list's items: `needs` in the run's order, one a question however many tickets ask it, the
 * questions `answered` left out, then the open questions `read` that no need puts, those answered
 * left out too. A question answered from the list takes one item out, so the list opens again at
 * the one after it (tutti-fnvd.20).
 */
export const needsItems = (
  needs: ReadonlyArray<Need>,
  answered: ReadonlySet<string>,
  read: ReadonlyArray<OpenQuestion> | undefined,
): ReadonlyArray<NeedsItem> => {
  // Each question's needs, by its ID; a Blocked ticket's alone, by its ticket.
  const asking = new Map<string, Array<Need>>()
  for (const need of needs) {
    const question = questionOf({ _tag: "Need", need, also: [] })
    if (question !== null && answered.has(question)) continue
    const key = question ?? `blocked ${need.ticket}`
    asking.set(key, [...(asking.get(key) ?? []), need])
  }
  const items = [...asking.values()].flatMap(
    ([need, ...also]): ReadonlyArray<NeedsItem> =>
      need === undefined ? [] : [{ _tag: "Need", need, also }],
  )
  const put = new Set(items.flatMap((item) => questionOf(item) ?? []))
  for (const need of needs) if (need._tag === "Question") put.add(need.id)
  const open = (read ?? [])
    .filter((question) => !put.has(question.id) && !answered.has(question.id))
    .map((question): NeedsItem => ({ _tag: "Open", question }))
  return [...items, ...open]
}

/**
 * The questions the needs `asked` put as the list opened that the open questions `read` since
 * don't have: closed meanwhile, answered outside the dashboard. None until they are read; a need
 * come in since the list opened isn't among `asked`, as the read may have been before it.
 */
export const closedSince = (
  asked: ReadonlyArray<Need>,
  read: ReadonlyArray<OpenQuestion> | undefined,
): ReadonlyArray<string> => {
  if (read === undefined) return []
  const open = new Set<string>(read.map((question) => question.id))
  return asked.flatMap((need) => {
    const question = questionOf({ _tag: "Need", need, also: [] })
    return question === null || open.has(question) ? [] : [question]
  })
}

/** An item's line, `width` wide: `> ` before the chosen one; an open question faint whole. */
export const itemLine = (
  item: NeedsItem,
  theme: Theme,
  chosen: boolean,
  width: number,
): Segments => {
  const { styles } = theme
  const mark = seg(chosen ? "> " : unpointed, styles.key)
  if (item._tag === "Open") {
    const { id, title } = item.question
    return cut([mark, seg(`? ${id} ${title}`, styles.dim)], width)
  }
  const { need } = item
  if (need._tag === "Blocked") {
    return cut(
      [mark, seg(`${marks.waitsForYou} ${need.label} blocked: ${need.why}`, styles.stop)],
      width,
    )
  }
  const labels = [need, ...item.also].map((each) => each.label)
  const title =
    need.question?.title ?? `${labels.join(", ")} ${labels.length === 1 ? "waits" : "wait"} on it`
  return cut(
    [
      mark,
      seg("? ", styles.stop),
      seg(need.id, styles.key),
      seg(` ${title}`, chosen ? styles.key : null),
    ],
    width,
  )
}

/** The list's click targets for its items: an item's index past this; below it, its keys'. */
const itemTarget = 1000

/** What a box says of a Blocked ticket: why it is blocked, its title, and what clears it. */
const blockedParagraphs = (need: Extract<Need, { _tag: "Blocked" }>, { styles }: Theme) => [
  seg(`${marks.waitsForYou} ${need.label} blocked: ${need.why}`, styles.stop),
  seg(need.title, styles.key),
  ...clearsOf(need).map((text) => seg(text, styles.dim)),
]

/**
 * A Blocked ticket's box over the dashboard (Box.Blocked), from the panel whose lines cut what clears
 * it: Enter opens its worker view, `h` hands back one blocked on its merge conflict (§ 4.3), Esc
 * closes it, as does its leaving Blocked.
 */
export const BlockedBox = ({ ticket }: { readonly ticket: TicketId }) => {
  const theme = useTheme()
  const command = useCommand()
  const { box } = useInput()
  const needs = useRunViewPart((view) => view.needs)
  const need = needs.find((each) => each._tag === "Blocked" && each.ticket === ticket)
  const gone = need?._tag !== "Blocked"
  useEffect(() => {
    if (gone) box.set(null)
  }, [gone, box])
  const commands: ReadonlyArray<Command> = [
    {
      keys: ["return", "enter"],
      run: () => {
        box.set(null)
        command(UiCommand.OpenWorker({ ticket }))
      },
      hint: { keys: "Enter", does: "open its worker view" },
    },
    ...(isConflict(need)
      ? [
          {
            keys: ["h"],
            run: () => {
              box.set(null)
              command(UiCommand.HandBackNow({ ticket }))
            },
            hint: { keys: "h", does: "hand it back" },
          },
        ]
      : []),
    { keys: ["escape"], run: () => box.set(null), hint: { keys: "Esc", does: "close" } },
  ]
  useCommands("box", commands, "Blocked")
  if (need?._tag !== "Blocked") return null
  return (
    <Modal
      frame={theme.look("needsYou")}
      paragraphs={blockedParagraphs(need, theme)}
      choices={commands}
    />
  )
}

/**
 * The list's label, `Needs you · 2 of 5`, the place of the chosen item among `count` when no more
 * than `room` of them fit, `inner` wide at most: in the stop style whatever has the focus, as the
 * list is all it has, and not indented, as its box's side sets it in.
 */
export const needsListLabel = (
  index: number,
  count: number,
  room: number,
  inner: number,
  theme: Theme,
): Segments =>
  sectionLabel("Needs you", theme, {
    lit: true,
    look: theme.styles.stop,
    indented: false,
    ...(count > room
      ? {
          count: seg(
            fit(`${index + 1} of ${count}`, inner - Bun.stringWidth(separator)),
            theme.styles.dim,
          ),
        }
      : {}),
  })

/** The list, the Blocked ticket's box over it once one is opened. */
export const NeedsList = ({ at, answered }: NeedsAt) => {
  const theme = useTheme()
  const command = useCommand()
  const { box, toasts } = useInput()
  const { width, height } = useTerminalDimensions()
  const needs = useRunViewPart((view) => view.needs)
  const news = useQuestionNews()
  const [uuid] = useState(quietUuid)
  // The needs as it opens, before it offers its read.
  const [asked] = useState(needs)
  useEffect(() => command(UiCommand.ReadQuestions({ uuid })), [command, uuid])
  const found = news.find(
    (each): each is Extract<QuestionNews, { _tag: "Read" | "NotRead" }> =>
      each.uuid === uuid && (each._tag === "Read" || each._tag === "NotRead"),
  )
  // Kept once read: news of answers and talks comes in, and past newsKept the read falls off it.
  const [kept, setKept] = useState(found)
  useEffect(() => {
    if (found !== undefined) setKept(found)
  }, [found])
  const read = kept ?? found
  const questions = read?._tag === "Read" ? read.questions : undefined
  // The questions answered from the list, recorded since, or closed outside the dashboard: left out
  // until the look has them.
  const done = new Set([
    ...answered.map((each) => each.question),
    ...closedSince(asked, questions),
    ...news.flatMap((each) =>
      each._tag === "Answered" || each._tag === "AlreadyAnswered" ? [each.question] : [],
    ),
  ])
  const items = needsItems(needs, done, questions)
  const [chosen, setChosen, chosenNow] = useKeyState(() => at)
  const [blockedOn, setBlockedOn] = useState<TicketId | null>(null)
  const blocked =
    needs.find(
      (each): each is Extract<Need, { _tag: "Blocked" }> =>
        each._tag === "Blocked" && each.ticket === blockedOn,
    ) ?? null
  // The ticket left Blocked: back to the list, where the next one is at its place.
  const gone = blockedOn !== null && blocked === null
  useEffect(() => {
    if (gone) setBlockedOn(null)
  }, [gone])
  const index = Math.min(Math.max(chosen, 0), Math.max(items.length - 1, 0))
  // Nothing in it once the questions are read: it says so, and closes after `emptyLife` on the
  // toasts' timer, which a need coming in stops. A read that failed has its own toast, and the list
  // closes at once.
  const empty = items.length === 0 && read !== undefined
  const readTag = read?._tag
  useEffect(() => {
    if (!empty) return
    if (readTag !== "Read") return box.set(null)
    return toasts.timer(() => box.set(null), emptyLife)
  }, [empty, readTag, box, toasts])

  const close = () => box.set(null)
  const move = (by: 1 | -1) => {
    if (items.length === 0) return
    setChosen(
      (now) => (Math.min(Math.max(now, 0), items.length - 1) + by + items.length) % items.length,
    )
  }
  const open = (i: number) => {
    const item = items[i]
    if (item === undefined) return
    const question = questionOf(item)
    if (question !== null) {
      return box.set(
        Box.Questions({ first: question as TicketId, back: { at: i, answered: [...answered] } }),
      )
    }
    if (item._tag === "Need" && item.need._tag === "Blocked") {
      // Opened by a click, it is chosen too: Esc comes back at the one after it.
      setChosen(() => i)
      setBlockedOn(item.need.ticket)
    }
  }
  const back = () => {
    setBlockedOn(null)
    setChosen(() => Math.min(Math.max(chosenNow(), 0), Math.max(items.length - 1, 0)) + 1)
  }
  const commands: ReadonlyArray<Command> =
    blocked !== null
      ? [
          {
            keys: ["return", "enter"],
            run: () => {
              box.set(null)
              command(UiCommand.OpenWorker({ ticket: blocked.ticket }))
            },
            hint: { keys: "Enter", does: "open its worker view" },
          },
          ...(isConflict(blocked)
            ? [
                {
                  keys: ["h"],
                  run: () => {
                    command(UiCommand.HandBackNow({ ticket: blocked.ticket }))
                    back()
                  },
                  hint: { keys: "h", does: "hand it back" },
                },
              ]
            : []),
          { keys: ["escape"], run: back, hint: { keys: "Esc", does: "back" } },
        ]
      : empty
        ? [
            { keys: ["return", "enter"], run: close },
            { keys: ["escape"], run: close, hint: { keys: "Esc", does: "close" } },
          ]
        : [
            { keys: ["down", "tab"], run: () => move(1) },
            {
              keys: ["up", "shift+tab"],
              run: () => move(-1),
              hint: { keys: arrowKeys.upDown, does: "choose" },
            },
            {
              keys: ["return", "enter"],
              run: () => open(Math.min(Math.max(chosenNow(), 0), items.length - 1)),
              hint: { keys: "Enter", does: "open" },
            },
            { keys: ["escape"], run: close, hint: { keys: "Esc", does: "close" } },
          ]
  useCommands("box", commands, "Needs")

  if (blocked !== null) {
    return (
      <Modal
        frame={theme.look("needsYou")}
        paragraphs={blockedParagraphs(blocked, theme)}
        choices={commands}
      />
    )
  }
  if (empty && readTag !== "Read") return null
  const outer = boxWidth(width, { max: modalMaxWidth, least: 8 })
  const inner = frameInner(outer)
  const keys = choiceRows(
    commands.flatMap((each) =>
      each.hint !== undefined && isOn(each)
        ? [[seg(each.hint.keys, theme.styles.key), seg(` ${each.hint.does}`, theme.styles.dim)]]
        : [],
    ),
    separatorOf(theme),
    inner,
  )
  const drawn = commands.filter((each) => each.hint !== undefined && isOn(each))
  // The items that fit the pane, a window around the chosen one.
  const room = Math.max(height - keys.length - 6, 1)
  const first = Math.min(Math.max(index - room + 1, 0), Math.max(items.length - room, 0))
  const lines: Array<Segments> = items.slice(first, first + room).map((item, i) =>
    itemLine(item, theme, first + i === index, inner).map((each) => ({
      ...each,
      target: itemTarget + first + i,
    })),
  )
  if (read === undefined) lines.push([seg(`  ${listReadingText}`, theme.styles.dim)])
  if (empty) lines.push([seg(`  ${nothingNeedsYou}`, theme.styles.dim)])
  const label = needsListLabel(index, items.length, room, inner, theme)
  const rows = boxed([label, [], ...lines, [], ...keys], outer, theme.look("needsYou"))
  const press = (target: number) =>
    target >= itemTarget ? open(target - itemTarget) : drawn[target]?.run()
  return (
    <>
      <Backdrop {...(empty ? { press: close } : {})} />
      <box
        position="absolute"
        zIndex={10}
        left={Math.max(Math.floor((width - outer) / 2), 0)}
        top={Math.max(Math.floor((height - rows.length) / 2), 0)}
        width={outer}
        height={rows.length}
        // Opaque, in the terminal's own background: the dashboard doesn't show through its spaces.
        backgroundColor={RGBA.defaultBackground()}
        flexDirection="column"
        {...(empty ? clickable(close) : {})}
      >
        <Lines lines={rows} press={press} />
      </box>
    </>
  )
}
