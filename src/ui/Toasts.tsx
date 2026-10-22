// Toasts (§ 7.3, § 7.11): a short line at the foot of the screen, over the view, that goes after a
// few seconds by itself. Faint, or `needsYou` for a failure (`couldn't copy`). Ctrl+Z shows one,
// since tutti can't be suspended (D18).
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useSyncExternalStore } from "react"
import { cut, Line, seg } from "./line.tsx"
import { type External, external, type Settable, useTheme } from "./useRunView.ts"

/** What Ctrl+Z says (D18). */
export const suspendToast =
  "tutti can't be suspended: s stops after the current tickets, Ctrl+C quits"

/** How long a toast is shown, in ms. */
export const toastLife = 4000

/** At most this many toasts are shown, the newest last. */
export const toastsShown = 3

export interface Toast {
  readonly id: number
  readonly text: string
  /** Something failed: drawn `needsYou`, not faint. */
  readonly failure: boolean
}

/** Runs `run` after `ms`, and returns what cancels it: setTimeout's, or a test's own clock. */
export type Timer = (run: () => void, ms: number) => () => void

const realTimer: Timer = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

/** The toasts shown, oldest first, and a way to show another. */
export interface ToastStore extends External<ReadonlyArray<Toast>> {
  /** Shows `text` for `life` ms. */
  readonly show: (text: string, options?: { readonly failure?: boolean }) => void
  /** Takes every toast down and stops their timers. */
  readonly dispose: () => void
  /** How many lines the hint at the screen's foot takes, which the toasts are drawn above. */
  readonly hint: Settable<number>
}

/** An empty ToastStore whose toasts are shown `life` ms each, timed by `timer`. */
export const makeToasts = (life: number = toastLife, timer: Timer = realTimer): ToastStore => {
  const store = external<ReadonlyArray<Toast>>([])
  const cancels = new Set<() => void>()
  let next = 0
  return {
    get: store.get,
    subscribe: store.subscribe,
    hint: external(1),
    show: (text, options = {}) => {
      const toast: Toast = { id: next++, text, failure: options.failure ?? false }
      store.set([...store.get(), toast].slice(-toastsShown))
      const cancel = timer(() => {
        cancels.delete(cancel)
        store.set(store.get().filter((each) => each.id !== toast.id))
      }, life)
      cancels.add(cancel)
    },
    dispose: () => {
      for (const cancel of cancels) cancel()
      cancels.clear()
      store.set([])
    },
  }
}

/** Has `store`'s toasts drawn above a hint `lines` tall while the caller is mounted. */
export const useHintHeight = (store: ToastStore, lines: number): void => {
  useEffect(() => {
    store.hint.set(lines)
    return () => store.hint.set(1)
  }, [store, lines])
}

/** The toasts of `store`, right-aligned above the hint's lines. */
export const Toasts = ({ store }: { readonly store: ToastStore }) => {
  const toasts = useSyncExternalStore(store.subscribe, store.get)
  const hint = useSyncExternalStore(store.hint.subscribe, store.hint.get)
  const theme = useTheme()
  const { width, height } = useTerminalDimensions()
  if (toasts.length === 0) return null
  const room = Math.max(width - 2, 0)
  const lines = toasts.map((toast) =>
    cut(
      [
        seg(
          ` ${toast.text} `,
          toast.failure
            ? { fg: theme.rgba("needsYou"), bg: undefined, attributes: 0 }
            : theme.styles.dim,
        ),
      ],
      room,
    ),
  )
  return (
    <box
      position="absolute"
      zIndex={20}
      right={1}
      top={Math.max(height - hint - lines.length, 0)}
      flexDirection="column"
      alignItems="flex-end"
    >
      {lines.map((segments, i) => (
        // Opaque, in the terminal's own background: the view's text doesn't show through its spaces.
        <box key={toasts[i]?.id ?? i} height={1} backgroundColor={RGBA.defaultBackground()}>
          <Line segments={segments} />
        </box>
      ))}
    </box>
  )
}
