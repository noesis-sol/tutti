// State that keys read as it is now: the views' choices, open flags and fields, kept in a ref for
// their key handlers and in React's state for drawing them.
import { useRef, useState } from "react"

/**
 * A value drawn as it changes, which a key handler reads as it is now: a key pressed before the
 * last change was drawn still sees it. Gives the value drawn, a change, and the value now.
 */
export const useKeyState = <A>(initial: () => A) => {
  const latest = useRef<{ readonly value: A } | null>(null)
  if (latest.current === null) latest.current = { value: initial() }
  const [shown, setShown] = useState(latest.current.value)
  const now = () => (latest.current as { readonly value: A }).value
  const change = (next: (value: A) => A) => {
    const value = next(now())
    latest.current = { value }
    setShown(value)
  }
  return [shown, change, now] as const
}
