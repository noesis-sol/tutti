// A box over the middle of the view, as orchestra draws its stop question: a rounded frame, its
// paragraphs wrapped to its width, then the keys it answers to, named as the hint names its own (each key `emphasis` bold,
// its words faint, ` · ` faint) and wrapped as the hint wraps (Hint.tsx hintLines). Each key's
// words are a click target too, a single click (D9).
// Its keys are a list of commands (keyCommands.ts): it draws those the hint names, and binds none;
// whoever opens the box binds the same list in the box layer (useCommands), from before it opens.
// Under it, a backdrop over the whole screen takes the mouse: a click beside the box doesn't reach
// the view under it (tutti-por).
import { type MouseEvent, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { type Command, isOn } from "./keyCommands.ts"
import {
  boxed,
  Lines,
  type Look,
  type Segment,
  type Segments,
  seg,
  widthOf,
  wrap,
} from "./line.tsx"
import { useTheme } from "./useRunView.ts"

/**
 * Over the whole screen, under a box (zIndex 10) and over the view: it draws nothing, and every
 * mouse event on it, a click, a drag or a scroll, stops there, so that the view under an open box
 * takes none. Drawn with each box, beside it in the same parent, whose origin is the screen's.
 */
export const Backdrop = () => {
  const { width, height } = useTerminalDimensions()
  return (
    <box
      position="absolute"
      zIndex={9}
      left={0}
      top={0}
      width={width}
      height={height}
      onMouse={(event: MouseEvent) => event.stopPropagation()}
    />
  )
}

/** The widest a box gets, its frame included. */
export const modalMaxWidth = 64

/**
 * A box's keys, each its segments, on as many rows `width` wide as it takes to show every
 * one: a row breaks between two keys, and inside one only when it is wider than a row, between
 * its words, as hintLines breaks the hint. Each key's segments, and the separator before it, have
 * its index for their target, so that a click on them presses it (Line).
 */
export const choiceRows = (
  keys: ReadonlyArray<Segments>,
  separator: Segment,
  width: number,
): ReadonlyArray<Segments> => {
  const rows: Array<Segments> = []
  let row: Segments = []
  keys.forEach((words, choice) => {
    const segments = words.map((each) => ({ ...each, target: choice }))
    if (row.length > 0) {
      const joined = [{ ...separator, target: choice }, ...segments]
      if (widthOf(row) + widthOf(joined) <= width) {
        row = [...row, ...joined]
        return
      }
      rows.push(row)
      row = []
    }
    if (widthOf(segments) <= width) {
      row = segments
      return
    }
    rows.push(...wrap(segments, width, { indent: 2, long: "line" }))
  })
  if (row.length > 0) rows.push(row)
  return rows
}

export const Modal = ({
  frame,
  paragraphs,
  choices,
}: {
  readonly frame: Look
  /** Each wrapped to the box's width; one with no text is a blank line. */
  readonly paragraphs: ReadonlyArray<Segment>
  /** The box's commands: those there now that the hint names are drawn, each its click target. */
  readonly choices: ReadonlyArray<Command>
}) => {
  const theme = useTheme()
  const { width, height } = useTerminalDimensions()
  const outer = Math.max(Math.min(width - 4, modalMaxWidth), 8)
  const inner = outer - 4
  const lines = paragraphs.flatMap((paragraph) => wrap([paragraph], inner, { long: "line" }))
  const drawn = choices.flatMap((choice) =>
    choice.hint !== undefined && isOn(choice) ? [{ hint: choice.hint, run: choice.run }] : [],
  )
  const keys = choiceRows(
    drawn.map(({ hint }) => [
      seg(hint.keys, theme.styles.key),
      seg(` ${hint.does}`, theme.styles.dim),
    ]),
    seg(" · ", theme.styles.dim),
    inner,
  )
  const rows = boxed([...lines, [], ...keys], outer, frame)
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
        // Opaque, in the terminal's own background: the view's text doesn't show through its spaces.
        backgroundColor={RGBA.defaultBackground()}
        flexDirection="column"
      >
        <Lines lines={rows} press={(choice) => drawn[choice]?.run()} />
      </box>
    </>
  )
}
