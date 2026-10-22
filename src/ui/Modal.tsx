// A box over the middle of the view, as orchestra draws its stop question: a rounded frame, its
// paragraphs wrapped to its width, then the keys it answers to, named as the hint names its own (each key `emphasis` bold,
// its words faint, ` · ` faint). Each key's words are a click target too, a single click (D9).
// The box's keys are bound in the box layer apart from it (keys.ts useLayer), from before it opens.
// Under it, a backdrop over the whole screen takes the mouse: a click beside the box doesn't reach
// the view under it (tutti-por).
import { type MouseEvent, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import {
  cut,
  Line,
  type Look,
  padded,
  plainFg,
  type Segment,
  type Segments,
  seg,
  styled,
  widthOf,
  wrap,
} from "./line.tsx"
import { useTheme } from "./useRunView.ts"

/** A key the box answers to, as it names it, and what a click on it does. */
export interface Choice {
  /** The key as the box names it: `s`, `Esc`. */
  readonly name: string
  readonly does: string
  readonly run: () => void
}

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

export const Modal = ({
  frame,
  paragraphs,
  choices,
}: {
  readonly frame: Look
  /** Each wrapped to the box's width; one with no text is a blank line. */
  readonly paragraphs: ReadonlyArray<Segment>
  readonly choices: ReadonlyArray<Choice>
}) => {
  const theme = useTheme()
  const { width, height } = useTerminalDimensions()
  const outer = Math.max(Math.min(width - 4, modalMaxWidth), 8)
  const inner = outer - 4
  const lines = paragraphs.flatMap((paragraph) => wrap([paragraph], inner))
  const tall = lines.length + 4
  const bar = seg("│", frame)
  const row = (segments: Segments): Segments => [
    bar,
    seg(" "),
    ...padded(cut(segments, inner), inner),
    seg(" "),
    bar,
  ]
  const keys = choices.map((choice, i) => [
    ...(i === 0 ? [] : [seg(" · ", theme.styles.dim)]),
    seg(choice.name, theme.styles.key),
    seg(` ${choice.does}`, theme.styles.dim),
  ])
  const rest = Math.max(inner - widthOf(keys.flat()), 0)
  return (
    <>
      <Backdrop />
      <box
        position="absolute"
        zIndex={10}
        left={Math.max(Math.floor((width - outer) / 2), 0)}
        top={Math.max(Math.floor((height - tall) / 2), 0)}
        width={outer}
        height={tall}
        // Opaque, in the terminal's own background: the view's text doesn't show through its spaces.
        backgroundColor={RGBA.defaultBackground()}
        flexDirection="column"
      >
        <Line segments={[seg(`╭${"─".repeat(outer - 2)}╮`, frame)]} />
        {lines.map((segments, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are drawn anew in order
          <Line key={i} segments={row(segments)} />
        ))}
        <Line segments={row([])} />
        <box flexDirection="row" height={1}>
          <Line segments={[bar, seg(" ")]} />
          {choices.map((choice, i) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: a terminal's text, not the DOM's; its key is bound in the box layer
            <text
              key={choice.name}
              wrapMode="none"
              height={1}
              fg={plainFg}
              onMouseDown={(event: MouseEvent) => {
                if (event.button === 0) choice.run()
              }}
            >
              {(keys[i] ?? []).map((each, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a key's segments are drawn anew in order
                <span key={j} {...(each.look === null ? {} : styled(each.look))}>
                  {each.text}
                </span>
              ))}
            </text>
          ))}
          <Line segments={[seg(" ".repeat(rest)), seg(" "), bar]} />
        </box>
        <Line segments={[seg(`╰${"─".repeat(outer - 2)}╯`, frame)]} />
      </box>
    </>
  )
}
