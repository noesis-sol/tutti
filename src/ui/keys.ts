// Keys and the mouse (§ 7.3, § 7.4, § 7.8): the input layers, in the order § 7.3 gives them, over
// @opentui/keymap. A focused text field takes every printable key; then an open box (the quit box,
// the stop question, an answer form) takes its keys; then the view's keys; then the global ones.
// Ctrl+C and Ctrl+Z are keys in raw mode, global wherever the focus is (D15, D18).
//
// The keymap sees each key before the focused renderable does, so a layer below the text field
// leaves its keys alone while one has the focus when the key is pressed: a box's layer the printable
// keys, since a box moves between its own fields with Enter, Tab and the arrows; the view's and the
// global layer those too (fieldTakes), for the composer to edit and move with. The view's and global
// layers are off while a box is open: the box is modal. A binding runs the handler of the latest render, never
// a closure of an earlier one (OpenTUI #1660).
//
// Three guards sit in front of the input: mouse reports split by a late read (OpenTUI #1661) are
// kept from becoming keys, a lone Esc waits `escapeHold` in case it is a split report's start, and
// a bracketed paste left unterminated (#1270) is ended after `pasteLimit`.
import {
  type CliRenderer,
  type KeyEvent,
  parseKeypress,
  type Renderable,
  TextareaRenderable,
} from "@opentui/core"
import type { Keymap, ReactiveMatcher } from "@opentui/keymap"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import { useBindings } from "@opentui/keymap/react"
import { useRenderer } from "@opentui/react"
import { Data } from "effect"
import { createContext, useContext, useEffect, useRef } from "react"
import type { ToastStore } from "./Toasts.tsx"
import type { Settable } from "./useRunView.ts"

/** The layers, highest first: each one's keys win over those of the layers below it. */
export const priorities = {
  /** Ctrl+C and Ctrl+Z: global, but over every layer. */
  always: 500,
  /** The focused composer or another text field: its own keys, and every printable key. */
  field: 400,
  /** An open box: the quit box, the stop question, an answer form, a confirmation. */
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
  Answer: { readonly ticket: string }
  /** Shift+D's: a reason to deny the request `requestId` with, typed in a small field. */
  Reason: { readonly requestId: string; readonly ticket: string }
  /** Answer in view's in the worker view: the answer form for the request `requestId` (§ 4.5). */
  Form: { readonly requestId: string; readonly ticket: string }
  /** Ctrl+X's in a worker view: whether to interrupt the turn of the ticket's worker (§ 7.5). */
  Interrupt: { readonly ticket: string }
  /** Leaving the Interview view with nothing filed: whether to end the interview (§ 4.10). */
  Leave: Record<never, never>
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

/** The keys a text field edits or moves with besides the printable ones, in keymap syntax. */
const fieldKeys = new Set([
  "return",
  "enter",
  "linefeed",
  "tab",
  "shift+tab",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "backspace",
  "delete",
])

/** Whether a focused text field takes the binding `key`: a printable key, Enter, Tab or an arrow. */
export const fieldTakes = (key: string): boolean => printable(key) || fieldKeys.has(key)

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
 * open, in `always` always. A focused text field is left the printable keys of a box's layer, and
 * every key it takes (fieldTakes) of the view's and the global layer. Each key runs the `run` of
 * the latest render.
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
  // Two keymap layers at the layer's priority: those of the keys left to a text field, off while one
  // has the focus, and the others'.
  const leaves = layer === "box" ? printable : fieldTakes
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
        .filter((key) => leaves(key) === typed)
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

/** How long a lone Esc is held, in ms, for the rest of a mouse report it may have started. */
export const escapeHold = 30

/** A held Esc: the key, and what to do with it. */
export interface EscapeHolder {
  /** Whether the key `sequence` is held, a lone Esc; a key while one is held presses that first. */
  readonly key: (sequence: string) => boolean
  /** Bytes read from stdin, before the renderer's parser reads them. */
  readonly read: (bytes: string) => void
  /** Drops a held Esc, and holds no more. */
  readonly stop: () => void
}

/**
 * Holds a lone Esc (OpenTUI #1661): when an SGR mouse report arrives in two reads, split after its
 * ESC, and the second comes after the parser's 20 ms timeout, the ESC becomes an Esc key and the
 * parser joins the rest (`[<64;87;26M`) to it as the mouse event. The Esc would close an open box
 * or leave the composer. A lone Esc waits `hold` ms: it is dropped when the next bytes read start
 * the rest of a report (`[<`, or `[M` in X10), the test the parser makes, and `press`ed when other
 * bytes or another key come first, or when the wait ends.
 */
export const escapeHolder = (press: () => void, hold: number = escapeHold): EscapeHolder => {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The bytes read since the Esc: a lone `[` waits for the next read.
  let rest = ""
  const release = (pressed: boolean) => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    rest = ""
    if (pressed) press()
  }
  return {
    key: (sequence) => {
      release(true)
      if (sequence !== "\x1b") return false
      timer = setTimeout(() => release(true), hold)
      return true
    },
    read: (bytes) => {
      if (timer === undefined) return
      const so = rest + bytes
      if (so.startsWith("[<") || so.startsWith("[M")) release(false)
      else if (so === "[") rest = so
      else release(true)
    },
    stop: () => release(false),
  }
}

/**
 * Holds `keymap`'s lone Esc keys for `hold` ms, dropping one that starts a mouse report
 * (`escapeHolder`), and presses those it keeps on `renderer`. Reads `renderer`'s stdin before the
 * parser does. The returned function stops it.
 */
export const holdEscape = (
  keymap: Keymap<Renderable, KeyEvent>,
  renderer: CliRenderer,
  hold: number = escapeHold,
): (() => void) => {
  const holder = escapeHolder(() => {
    const key = parseKeypress("\x1b")
    if (key !== null) renderer.keyInput.processParsedKey(key)
  }, hold)
  const onData = (chunk: Buffer | string) =>
    holder.read(typeof chunk === "string" ? chunk : chunk.toString("latin1"))
  renderer.stdin.prependListener("data", onData)
  const unintercept = keymap.intercept("raw", ({ sequence, stop }) => {
    if (holder.key(sequence)) stop()
  })
  return () => {
    unintercept()
    renderer.stdin.off("data", onData)
    holder.stop()
  }
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

/**
 * The guards in front of `keymap`'s keys: split mouse reports filtered out, a lone Esc held, an
 * unterminated paste ended after `limit` ms. The returned function stops them.
 */
export const guardInput = (
  keymap: Keymap<Renderable, KeyEvent>,
  renderer: CliRenderer,
  limit: number = pasteLimit,
): (() => void) => {
  const unfilter = filterMouse(keymap)
  const unhold = holdEscape(keymap, renderer)
  const unguard = guardPaste(renderer.stdin, limit)
  return () => {
    unguard()
    unhold()
    unfilter()
  }
}

/**
 * guardInput over the renderer for a screen without the run's input layers, as init's form: on a
 * keymap of their own, which the guards stop raw input on before any key handler hears it.
 */
export const InputGuards = () => {
  const renderer = useRenderer()
  useEffect(() => guardInput(createOpenTuiKeymap(renderer), renderer), [renderer])
  return null
}
