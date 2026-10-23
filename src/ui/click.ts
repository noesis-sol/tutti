// Clicks (D9, § 7.3): a click target acts on the left button's release, on the cell it was
// pressed on, with no text selected by a drag. OpenTUI starts a selection on a press over text and
// hands that same press to the targets under it, so a target that acted on the press would act on
// every drag that selects text to copy: the card's title would open its worker's view mid-drag, a
// tool line would toggle.
import type { MouseEvent } from "@opentui/core"

/** Where the left button was last pressed on a click target, until its release. */
let pressed: { readonly x: number; readonly y: number } | null = null

const sameCell = (a: { readonly x: number; readonly y: number }, b: typeof a) =>
  a.x === b.x && a.y === b.y

/**
 * Whether `event` releases the press on the cell it was made on, with no selection dragged from
 * another cell. A second press on the cell soon after selects its word (OpenTUI's double click):
 * that selection starts and ends on the cell, and the release is still a click.
 */
const clickedAt = (event: MouseEvent): boolean => {
  const press = pressed
  pressed = null
  if (press === null || !sameCell(press, event)) return false
  const selection = event.target?.ctx.getSelection() ?? null
  return (
    selection === null || (sameCell(selection.anchor, press) && sameCell(selection.focus, press))
  )
}

/**
 * A click target's props: a click with the left button runs `run`, as the target's key does. The
 * targets around it see neither its press nor its release. A renderer that leaves the mouse to the
 * terminal (--no-mouse) sends it none.
 */
export const clickable = (run: () => void) => ({
  onMouseDown: (event: MouseEvent) => {
    if (event.button !== 0) return
    event.stopPropagation()
    pressed = { x: event.x, y: event.y }
  },
  onMouseUp: (event: MouseEvent) => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (clickedAt(event)) run()
  },
})
