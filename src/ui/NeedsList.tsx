// The Needs you list (Box.Needs, § 7.2, tutti-fdv1): on a dashboard without the panel beside the
// tickets table, Enter on the totals' Needs you cell, or a click on it, opens a list of what needs
// you, the panel's needs one a line (`? <question> <title>`, `■ <ticket> blocked: <why>`), then,
// faint, the open questions in the run's scope no ticket in the run waits on, which the list reads
// as it opens (ReadQuestions, under a quiet uuid: having none open needs no toast). ↑↓ or Tab move
// between them, Enter or a click opens one: a question in the questions box at it (QuestionsBox.tsx),
// which opens the list again once it is answered, the next one chosen; a Blocked ticket in a box
// saying what clears it, Enter there opening its worker view, Esc back to the list at the next one.
// A list with nothing in it closes with a toast. Esc closes it.
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { QuestionNews } from "../run/questionNews.ts"
import type { Need } from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import { type Command, isOn, useCommands } from "./keyCommands.ts"
import { Box, type NeedsAt, useInput } from "./keys.ts"
import { boxed, cut, fit, Lines, type Segments, seg } from "./line.tsx"
import { Backdrop, choiceRows, Modal, modalMaxWidth } from "./Modal.tsx"
import { quietUuid } from "./QuestionsBox.tsx"
import type { OpenQuestion } from "./questions.ts"
import { clearsOf } from "./SidePanel.tsx"
import type { Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"
import { useCommand, useQuestionNews, useRunViewPart, useTheme } from "./useRunView.ts"

/** The toast of a list with nothing in it. */
export const nothingNeedsYou = "Nothing needs you"

/** What the list says, faint, under what needs you until the run has read the open questions. */
export const listReadingText = "reading the open questions…"

/** An item of the list: a need, or an open question no ticket in the run waits on. */
export type NeedsItem =
  | { readonly _tag: "Need"; readonly need: Need }
  | { readonly _tag: "Open"; readonly question: OpenQuestion }

/** The question an item puts, by its ID; none for a Blocked ticket. */
export const questionOf = (item: NeedsItem): string | null =>
  item._tag === "Open"
    ? item.question.id
    : item.need._tag === "Question"
      ? (item.need.question?.id ?? item.need.id)
      : null

/**
 * The list's items: `needs` in the run's order, the questions `answered` left out, then the open
 * questions `read` that no need puts, those answered left out too.
 */
export const needsItems = (
  needs: ReadonlyArray<Need>,
  answered: ReadonlySet<string>,
  read: ReadonlyArray<OpenQuestion> | undefined,
): ReadonlyArray<NeedsItem> => {
  const items = needs
    .map((need): NeedsItem => ({ _tag: "Need", need }))
    .filter((item) => !answered.has(questionOf(item) ?? ""))
  const put = new Set(items.flatMap((item) => questionOf(item) ?? []))
  for (const need of needs) if (need._tag === "Question") put.add(need.id)
  const open = (read ?? [])
    .filter((question) => !put.has(question.id) && !answered.has(question.id))
    .map((question): NeedsItem => ({ _tag: "Open", question }))
  return [...items, ...open]
}

/** An item's line, `width` wide: `> ` before the chosen one; an open question faint whole. */
export const itemLine = (
  item: NeedsItem,
  theme: Theme,
  chosen: boolean,
  width: number,
): Segments => {
  const { styles } = theme
  const mark = seg(chosen ? "> " : "  ", styles.key)
  if (item._tag === "Open") {
    const { id, title } = item.question
    return cut([mark, seg(`? ${id} ${title}`, styles.dim)], width)
  }
  const { need } = item
  if (need._tag === "Blocked") {
    return cut([mark, seg(`■ ${need.label} blocked: ${need.why}`, styles.stop)], width)
  }
  const title = need.question?.title ?? `${need.label} waits on it`
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

/** The list, the Blocked ticket's box over it once one is opened. */
export const NeedsList = ({ at, answered }: NeedsAt) => {
  const theme = useTheme()
  const command = useCommand()
  const { box, toasts } = useInput()
  const { width, height } = useTerminalDimensions()
  const needs = useRunViewPart((view) => view.needs)
  const news = useQuestionNews()
  const [uuid] = useState(quietUuid)
  useEffect(() => command(UiCommand.ReadQuestions({ uuid })), [command, uuid])
  const read = news.find(
    (each): each is Extract<QuestionNews, { _tag: "Read" | "NotRead" }> =>
      each.uuid === uuid && (each._tag === "Read" || each._tag === "NotRead"),
  )
  // The questions answered from the list, or recorded since: left out until the look has them.
  const done = new Set([
    ...answered,
    ...news.flatMap((each) => (each._tag === "Answered" ? [each.question] : [])),
  ])
  const items = needsItems(needs, done, read?._tag === "Read" ? read.questions : undefined)
  const [chosen, setChosen, chosenNow] = useKeyState(() => at)
  const [blocked, setBlocked] = useState<Extract<Need, { _tag: "Blocked" }> | null>(null)
  const index = Math.min(Math.max(chosen, 0), Math.max(items.length - 1, 0))
  // Nothing in it once the questions are read: a toast says so, and the list closes. A read that
  // failed has its own toast.
  const empty = items.length === 0 && read !== undefined
  useEffect(() => {
    if (!empty) return
    box.set(null)
    if (read?._tag === "Read") toasts.show(nothingNeedsYou)
  }, [empty, read, box, toasts])

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
      setBlocked(item.need)
    }
  }
  const back = () => {
    setBlocked(null)
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
          { keys: ["escape"], run: back, hint: { keys: "Esc", does: "back" } },
        ]
      : [
          { keys: ["down", "tab"], run: () => move(1) },
          { keys: ["up", "shift+tab"], run: () => move(-1), hint: { keys: "↑↓", does: "choose" } },
          {
            keys: ["return", "enter"],
            run: () => open(Math.min(Math.max(chosenNow(), 0), items.length - 1)),
            hint: { keys: "Enter", does: "open" },
          },
          { keys: ["escape"], run: close, hint: { keys: "Esc", does: "close" } },
        ]
  useCommands("box", commands, "Needs")

  if (blocked !== null) {
    const { styles } = theme
    return (
      <Modal
        frame={theme.look("needsYou")}
        paragraphs={[
          seg(`■ ${blocked.label} blocked: ${blocked.why}`, styles.stop),
          seg(blocked.title, styles.key),
          seg(clearsOf(blocked.why), styles.dim),
        ]}
        choices={commands}
      />
    )
  }
  if (empty) return null
  const outer = Math.max(Math.min(width - 4, modalMaxWidth), 8)
  const inner = outer - 4
  const keys = choiceRows(
    commands.flatMap((each) =>
      each.hint !== undefined && isOn(each)
        ? [[seg(each.hint.keys, theme.styles.key), seg(` ${each.hint.does}`, theme.styles.dim)]]
        : [],
    ),
    seg(" · ", theme.styles.dim),
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
  const label: Segments = [seg("Needs you", theme.styles.stop)]
  const counted =
    items.length > room
      ? [seg(fit(` · ${index + 1} of ${items.length}`, inner), theme.styles.dim)]
      : []
  const rows = boxed(
    [[...label, ...counted], [], ...lines, [], ...keys],
    outer,
    theme.look("needsYou"),
  )
  const press = (target: number) =>
    target >= itemTarget ? open(target - itemTarget) : drawn[target]?.run()
  return (
    <>
      <Backdrop />
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
      >
        <Lines lines={rows} press={press} />
      </box>
    </>
  )
}
