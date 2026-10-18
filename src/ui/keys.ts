// Keys and the mouse (§ 7.3, § 7.4, § 7.8): the input layers, in the order § 7.3 gives them, over
// @opentui/keymap. A focused text field takes every printable key; then an open box (the quit box,
// the stop question, an answer form) takes its keys; then the view's keys; then the global ones.
// Ctrl+C and Ctrl+Z are keys in raw mode, global wherever the focus is (D15, D18).
//
// The keymap sees each key before the focused renderable does, so a layer below the text field
// leaves printable keys alone while one has the focus, and the view's and global layers are off
// while a box is open: the box is modal. A binding runs the handler of the latest render, never a
// closure of an earlier one (OpenTUI #1660).
//
// Two guards sit in front of the input: mouse reports split by a late read (OpenTUI #1661) are kept
// from becoming keys, and a bracketed paste left unterminated (#1270) is ended after `pasteLimit`.
import { type CliRenderer, type KeyEvent, type Renderable, TextareaRenderable } from "@opentui/core"
import type { Keymap, ReactiveMatcher } from "@opentui/keymap"
import { useBindings } from "@opentui/keymap/react"
import { useRenderer } from "@opentui/react"
import { Data } from "effect"
import { createContext, useContext, useRef } from "react"
import type { ToastStore } from "./Toasts.tsx"
import type { Settable } from "./useRunView.ts"

/** The layers, highest first: each one's keys win over those of the layers below it. */
export const priorities = {
  /** Ctrl+C and Ctrl+Z: global, but over every layer. */
  always: 500,
  /** The focused composer or another text field: its own keys, and every printable key. */
  field: 400,
  /** An open box: the quit box, the stop question, an answer form. */
  box: 300,
  /** The keys of the view shown: the dashboard's or a worker view's. */
  view: 200,
  /** The keys of every view. */
  global: 100,
} as const

export type LayerName = keyof typeof priorities

/** A box open over the view, which takes the keys until it closes. */
export type Box = Data.TaggedEnum<{
  /** Ctrl+C's: stop after current, quit now, or cancel (D15). */
  Quit: Record<never, never>
  /** `s`'s: stop after the current tickets, or, `windingDown`, take tickets again. */
  Stop: { readonly windingDown: boolean }
  /** Enter's on a compact card waiting for you: the worker's request and its buttons (§ 7.2). */
  Answer: { readonly worker: number }
  /** Shift+D's: a reason to deny the request `requestId` with, typed in a small field. */
  Reason: { readonly requestId: string; readonly ticket: string }
}>

export const Box = Data.taggedEnum<Box>()

/** What the input layers share: the box open, and the toasts. */
export interface InputState {
  readonly box: Settable<Box | null>
  readonly toasts: ToastStore
}

export const InputContext = createContext<InputState | null>(null)

/** The input layers' state, inside the Input provider. */
export const useInput = (): InputState => {
  const input = useContext(InputContext)
  if (input === null) throw new Error("tutti's keys are bound outside its Input provider")
  return input
}

/** Whether `target` is a text field: an input or a textarea, which types printable keys. */
export const isTextField = (target: Renderable | null): boolean =>
  target instanceof TextareaRenderable

/** Whether `renderer`'s focus is in a text field. */
export const fieldFocused = (renderer: CliRenderer): boolean =>
  isTextField(renderer.currentFocusedRenderable)

/**
 * Whether the binding `key` (keymap syntax: `s`, `shift+d`, `?`, `ctrl+c`, `escape`) is a key a
 * text field types: one character or the space bar, with no modifier but Shift.
 */
export const printable = (key: string): boolean => {
  const at = key.length > 1 ? key.lastIndexOf("+", key.length - 2) : -1
  const name = key.slice(at + 1).toLowerCase()
  const modifiers = at < 0 ? [] : key.slice(0, at).toLowerCase().split("+")
  return (
    modifiers.every((modifier) => modifier === "shift") &&
    (Bun.stringWidth(name) === 1 || name === "space")
  )
}

/** A key a layer binds, and what pressing it does. */
export interface KeyBinding {
  readonly key: string
  readonly run: () => void
}

/** A reactive matcher over `box`: `when` of the box open now. */
const boxMatcher = (box: Settable<Box | null>, when: (open: Box | null) => boolean) =>
  ({
    get: () => when(box.get()),
    subscribe: (onChange) => box.subscribe(onChange),
  }) satisfies ReactiveMatcher

/** `matcher`, and also `also` at the moment the key is pressed. */
const andAlso = (matcher: ReactiveMatcher, also: () => boolean): ReactiveMatcher => ({
  get: () => matcher.get() && also(),
  subscribe: matcher.subscribe,
})

/**
 * Binds `bindings` in `layer` while the component is mounted: in the box layer while the box
 * `which` is open (any box when left out), in the view's and the global layer while no box is
 * open, in `always` always. A printable key is left to a focused text field. Each key runs the
 * `run` of the latest render.
 *
 * A box's keys are bound before it opens, so they work from the moment it opens, before React has
 * drawn it.
 */
export const useLayer = (
  layer: Exclude<LayerName, "field">,
  bindings: ReadonlyArray<KeyBinding>,
  which?: Box["_tag"],
): void => {
  const renderer = useRenderer()
  const { box } = useInput()
  const latest = useRef(bindings)
  latest.current = bindings
  const keys = bindings.map((binding) => binding.key)
  const shape = keys.join("\n")
  // Two keymap layers at the layer's priority: the printable keys', off while a text field has the
  // focus, and the others'.
  const bind = (typed: boolean) => () => {
    const open = boxMatcher(box, (shown) => {
      switch (layer) {
        case "always":
          return true
        case "box":
          return which === undefined ? shown !== null : shown?._tag === which
        default:
          return shown === null
      }
    })
    return {
      priority: priorities[layer],
      enabled: typed ? andAlso(open, () => !fieldFocused(renderer)) : open,
      bindings: keys
        .filter((key) => printable(key) === typed)
        .map((key) => ({
          key,
          cmd: () => latest.current.find((binding) => binding.key === key)?.run(),
        })),
    }
  }
  useBindings(bind(false), [renderer, box, layer, which, shape])
  useBindings(bind(true), [renderer, box, layer, which, shape])
}

/** How long a mouse report's start waits for the rest of it, in ms. */
export const mouseWindow = 1000

// What follows an SGR mouse report's `ESC [`: a prefix of the report, then the whole of it. The
// stdin parser gives a report's start alone (`ESC [`, `ESC [<6`) when the rest comes late.
const csi = "\x1b["
const reportPrefix = /^(<\d*(;\d*){0,2})?$/
const report = /^<\d+;\d+;\d+[Mm]$/

/**
 * A filter of the raw sequences the renderer reads, true for those that are a mouse report's rest
 * (OpenTUI #1661): when a report arrives in two reads, split after `ESC [`, and the second comes
 * after the parser's 20 ms timeout, the start becomes a response and the rest (`<64;87;26M`) keys,
 * one a character, which a focused input would type. After a lone start, the keys that continue a
 * report are kept out, up to its final `M` or `m`, within `window` ms; the first key that can't
 * continue one goes through.
 */
export const mouseFilter = (
  now: () => number = Date.now,
  window: number = mouseWindow,
): ((sequence: string) => boolean) => {
  let pending: string | null = null
  let since = 0
  return (sequence) => {
    if (pending !== null && now() - since > window) pending = null
    if (pending === null) {
      if (sequence.startsWith(csi) && reportPrefix.test(sequence.slice(csi.length))) {
        pending = sequence.slice(csi.length)
        since = now()
      }
      return false
    }
    const so = pending + sequence
    if (report.test(so)) {
      pending = null
      return true
    }
    if (reportPrefix.test(so)) {
      pending = so
      return true
    }
    pending = null
    return false
  }
}

/** Keeps the rest of split mouse reports out of `keymap`'s keys; the returned function stops it. */
export const filterMouse = (keymap: Keymap<Renderable, KeyEvent>): (() => void) => {
  const filter = mouseFilter()
  return keymap.intercept("raw", ({ sequence, stop }) => {
    if (filter(sequence)) stop()
  })
}

/** How long a bracketed paste may go without its end, in ms, before what arrived is inserted. */
export const pasteLimit = 2000

export const pasteStart = "\x1b[200~"
export const pasteEnd = "\x1b[201~"

/** What a paste guard reads from: the renderer's stdin. */
export interface PasteInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown
  emit(event: "data", chunk: Buffer): boolean
}

/**
 * Ends a bracketed paste left open (OpenTUI #1270): once `stdin` has given a paste's start and no
 * end for `limit` ms since its last bytes, it gives the end marker itself, so the renderer's parser
 * ends the paste and the focused composer or textarea gets what arrived, in one piece, and keys
 * work again. The returned function stops it.
 */
export const guardPaste = (stdin: PasteInput, limit: number = pasteLimit): (() => void) => {
  let open = false
  // The last bytes read, for a marker split between two reads: one byte short of a marker.
  let tail = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = () => {
    timer = undefined
    stdin.emit("data", Buffer.from(pasteEnd))
  }
  const onData = (chunk: Buffer | string) => {
    const text = tail + (typeof chunk === "string" ? chunk : chunk.toString("latin1"))
    const started = text.lastIndexOf(pasteStart)
    const ended = text.lastIndexOf(pasteEnd)
    if (started > ended) open = true
    else if (ended > started) open = false
    tail = text.slice(-(pasteStart.length - 1))
    clearTimeout(timer)
    timer = open ? setTimeout(end, limit) : undefined
  }
  stdin.on("data", onData)
  return () => {
    clearTimeout(timer)
    stdin.off("data", onData)
  }
}
