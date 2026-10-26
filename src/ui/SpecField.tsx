// The start question's Spec file field (§ 5 item 3, § 7.1), as orchestra's spec field: a line to
// type or paste a spec's path in, or its https:// URL. Tab completes folders and spec files in the
// folder typed so far, filling in the part the completions share and listing them under the field,
// where ↓ or Ctrl+N goes to the next and ↑ or Ctrl+P to the one before. Ctrl+O opens the file
// browser (FileBrowser.tsx) over the question. Enter goes on only once the path names a file of text
// with something in it, and says why not under the field; a URL is fetched on Enter, a spinner in the
// field's place, Esc stopping it, and its problem said under the field, the URL kept for fixing.
//
// The field's state and actions are a hook (useSpecField), its keys commands of the start question's
// list (specFieldCommands), so that its hint names each key only where it works.
import type { InputRenderable } from "@opentui/core"
import { Duration, Effect, Exit, type Fiber } from "effect"
import { type RefObject, useEffect, useRef, useState } from "react"
import { isSpecUrl } from "../run/specSource.ts"
import { clickable } from "./click.ts"
import { type Browsing, enterRow, moveBy, openBrowser, scrollBy, upFolder } from "./FileBrowser.tsx"
import type { Command } from "./keyCommands.ts"
import { Lines, type Segments, seg, styled, targeting } from "./line.tsx"
import { fetchingLine, noSpecPath, type SpecAsk } from "./questions.ts"
import { sanitizeLine } from "./sanitize.ts"
import { exists, fileProblem, isFolderPath, readFolder } from "./specFiles.ts"
import {
  completeHome,
  completing,
  completions,
  readTyped,
  sharedStart,
  shownPath,
  unquoted,
} from "./specPath.ts"
import { frameInterval, spinnerFrames } from "./spinner.ts"
import type { Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"

/** Tab's completions listed under the field, and the one ↓ or ↑ went to, if any. */
export interface Listed {
  readonly items: ReadonlyArray<string>
  readonly at: number | null
}

/** The most completions listed under the field at once. */
export const listedShown = 6

/** The field's state and what its keys do. */
export interface SpecFieldState {
  readonly input: RefObject<InputRenderable | null>
  /** What is typed, as drawn. */
  readonly typed: string
  readonly error: string | null
  readonly listed: Listed | null
  readonly browsing: Browsing | null
  /** The URL being fetched, if one is. */
  readonly fetching: string | null
  /** Called by the input on each change: typed, or put there by a key. */
  readonly changed: (text: string) => void
  readonly act: SpecFieldActions
}

/** What the field's keys do. */
export interface SpecFieldActions {
  readonly browsingNow: () => boolean
  readonly fetchingNow: () => boolean
  /** Whether what is typed now is a URL, which nothing completes. */
  readonly urlNow: () => boolean
  readonly listedNow: () => boolean
  readonly complete: () => void
  /** To the next completion (1), or the one before (-1). */
  readonly step: (by: number) => void
  /** Puts completion `index` in the field. */
  readonly take: (index: number) => void
  readonly browse: () => void
  readonly submit: () => void
  readonly stopFetch: () => void
  readonly browser: {
    readonly move: (by: number) => void
    readonly up: () => void
    readonly enter: () => void
    readonly press: (index: number) => void
    readonly scroll: (by: number) => void
    readonly close: () => void
  }
  /** Leaves the field: a fetch stopped, the browser closed. */
  readonly leave: () => void
}

/**
 * The field's state, for `spec`; `chosen` takes the spec once Enter finds it can be run, its path
 * absolute or its URL; `rows` is how many rows the browser shows.
 */
export const useSpecField = (
  spec: SpecAsk,
  chosen: (given: string) => void,
  rows: () => number,
): SpecFieldState => {
  const { where } = spec
  const input = useRef<InputRenderable>(null)
  // Set while a key puts text in the input, whose change isn't typing.
  const putting = useRef(false)
  const [typed, setTyped, typedNow] = useKeyState(() => "")
  const [error, setError] = useKeyState<string | null>(() => null)
  const [listed, setListed, listedNow] = useKeyState<Listed | null>(() => null)
  const [browsing, setBrowsing, browsingNow] = useKeyState<Browsing | null>(() => null)
  const [fetching, setFetching, fetchingNow] = useKeyState<{
    readonly url: string
    readonly fiber: Fiber.Fiber<string | null>
  } | null>(() => null)

  // A fetch going on as the field goes is stopped.
  useEffect(() => () => fetchingNow()?.fiber.interruptUnsafe(), [fetchingNow])

  const put = (text: string) => {
    const field = input.current
    if (field === null) return
    putting.current = true
    try {
      field.value = text
    } finally {
      putting.current = false
    }
    setTyped(() => text)
  }

  const changed = (text: string) => {
    setTyped(() => text)
    if (putting.current) return
    setListed(() => null)
    setError(() => null)
  }

  const urlNow = () => isSpecUrl(unquoted(typedNow()))

  /** The completions of what is typed, or null where nothing completes it. */
  const completionsNow = (): ReadonlyArray<string> | null => {
    const at = completing(typedNow(), where, exists)
    if (at === null) return null
    const entries = readFolder(at.folder)
    return entries._tag === "Success" ? completions(at, entries.success) : null
  }

  const complete = () => {
    const home = completeHome(typedNow(), where)
    if (home !== null) {
      put(home)
      setListed(() => null)
      return
    }
    const list = completionsNow()
    if (list === null || list.length === 0) {
      setListed(() => null)
      return
    }
    const [only] = list
    if (list.length === 1 && only !== undefined) {
      put(only)
      setListed(() => null)
      return
    }
    const shared = sharedStart(list)
    if (shared.length > typedNow().length) put(shared)
    setListed(() => ({ items: list, at: null }))
  }

  const step = (by: number) => {
    const now = listedNow()
    const items = now?.items ?? completionsNow() ?? []
    if (items.length === 0) return
    const from = now?.at ?? (by > 0 ? -1 : items.length)
    const at = (((from + by) % items.length) + items.length) % items.length
    const item = items[at]
    if (item === undefined) return
    put(item)
    setListed(() => ({ items, at }))
  }

  const take = (index: number) => {
    const item = listedNow()?.items[index]
    if (item === undefined) return
    put(item)
    setListed((now) => (now === null ? now : { ...now, at: index }))
    input.current?.focus()
  }

  const closeBrowser = () => {
    setBrowsing(() => null)
    input.current?.focus()
  }

  const browse = () => {
    const read = readTyped(typedNow(), where, exists)
    let from: string | null = null
    if (read._tag === "Path") {
      const parent = read.path.replace(/\/[^/]*$/, "") || "/"
      from = isFolderPath(read.path) ? read.path : isFolderPath(parent) ? parent : null
    }
    setListed(() => null)
    setBrowsing(() => openBrowser(from, where.repo, readFolder, where.home))
    // The browser's keys aren't the field's: what isn't one of them types nothing meanwhile.
    input.current?.blur()
  }

  const inBrowser = (change: (now: Browsing) => Browsing) =>
    setBrowsing((now) => (now === null ? now : change(now)))

  const enter = () => {
    const now = browsingNow()
    if (now === null) return
    const done = enterRow(now, readFolder, where.home, rows())
    if (done._tag === "Browsing") {
      setBrowsing(() => done.browsing)
      return
    }
    put(shownPath(done.path, where))
    setError(() => null)
    closeBrowser()
  }

  const stopFetch = () => {
    const now = fetchingNow()
    if (now === null) return
    setFetching(() => null)
    now.fiber.interruptUnsafe()
    input.current?.focus()
  }

  const fetch = (url: string) => {
    const fiber = Effect.runFork(spec.checkUrl(url))
    setFetching(() => ({ url, fiber }))
    input.current?.blur()
    fiber.addObserver((exit) => {
      if (fetchingNow()?.fiber !== fiber) return
      setFetching(() => null)
      if (Exit.isSuccess(exit) && exit.value === null) {
        chosen(url)
        return
      }
      setError(() =>
        Exit.isSuccess(exit) ? exit.value : `cannot fetch ${sanitizeLine(url)}: it failed`,
      )
      input.current?.focus()
    })
  }

  const submit = () => {
    const text = typedNow()
    const read = readTyped(text, where, exists)
    setListed(() => null)
    switch (read._tag) {
      case "Empty":
        setError(() => noSpecPath(true))
        return
      case "Url":
        setError(() => null)
        fetch(read.url)
        return
      case "Path": {
        const problem = fileProblem(read.path, unquoted(text))
        setError(() => problem)
        if (problem === null) chosen(read.path)
      }
    }
  }

  return {
    input,
    typed,
    error,
    listed,
    browsing,
    fetching: fetching?.url ?? null,
    changed,
    act: {
      browsingNow: () => browsingNow() !== null,
      fetchingNow: () => fetchingNow() !== null,
      urlNow,
      listedNow: () => listedNow() !== null,
      complete,
      step,
      take,
      browse,
      submit,
      stopFetch,
      browser: {
        move: (by) => inBrowser((now) => moveBy(now, by, rows())),
        up: () => inBrowser((now) => upFolder(now, readFolder, where.home, rows())),
        enter,
        press: (index) => {
          inBrowser((now) => ({ ...now, at: index }))
          enter()
        },
        scroll: (by) => inBrowser((now) => scrollBy(now, by, rows())),
        close: closeBrowser,
      },
      leave: () => {
        stopFetch()
        setBrowsing(() => null)
        setListed(() => null)
      },
    },
  }
}

/**
 * The field's keys, while `active` says the field is answered: the browser's while it is open, Esc
 * while a URL is fetched, else the field's; `back` goes back a step, keeping what was typed.
 */
export const specFieldCommands = (
  act: SpecFieldActions,
  active: () => boolean,
  back: () => void,
): ReadonlyArray<Command> => {
  const browsing = () => active() && act.browsingNow()
  const fetching = () => active() && !act.browsingNow() && act.fetchingNow()
  const typing = () => active() && !act.browsingNow() && !act.fetchingNow()
  const completes = () => typing() && !act.urlNow()
  return [
    {
      keys: ["up", "k"],
      run: () => act.browser.move(-1),
      when: browsing,
      hint: { keys: "↑↓", does: "move" },
    },
    { keys: ["down", "j"], run: () => act.browser.move(1), when: browsing },
    {
      keys: ["left", "h", "backspace"],
      run: act.browser.up,
      when: browsing,
      hint: { keys: "←", does: "up a folder" },
    },
    {
      keys: ["return", "kpenter", "right"],
      run: act.browser.enter,
      when: browsing,
      hint: { keys: "Enter", does: "open or choose" },
    },
    {
      keys: ["escape"],
      run: act.browser.close,
      when: browsing,
      hint: { keys: "Esc", does: "close" },
    },
    { keys: ["escape"], run: act.stopFetch, when: fetching, hint: { keys: "Esc", does: "stop" } },
    {
      keys: ["return", "kpenter"],
      run: act.submit,
      when: typing,
      hint: { keys: "Enter", does: "confirm" },
    },
    { keys: ["tab"], run: act.complete, when: completes, hint: { keys: "Tab", does: "complete" } },
    {
      keys: ["down", "ctrl+n"],
      run: () => act.step(1),
      when: completes,
      hint: { keys: "↓↑", does: "completions" },
    },
    { keys: ["up", "ctrl+p"], run: () => act.step(-1), when: completes },
    { keys: ["ctrl+o"], run: act.browse, when: typing, hint: { keys: "Ctrl+O", does: "browse" } },
    {
      keys: ["shift+tab"],
      run: back,
      when: typing,
      hint: { keys: "Shift+Tab", does: "back" },
    },
  ]
}

/** The lines under the field: the completions listed, a window of them around the one gone to. */
export const listedLines = (listed: Listed | null, theme: Theme): ReadonlyArray<Segments> => {
  if (listed === null) return []
  const { form } = theme
  const at = listed.at ?? 0
  const first = Math.min(
    Math.max(at - listedShown + 1, 0),
    Math.max(listed.items.length - listedShown, 0),
  )
  const shown = listed.items.slice(first, first + listedShown)
  const more = listed.items.length - shown.length
  return [
    ...shown.map((item, i) =>
      targeting(
        first + i === listed.at
          ? [seg("  > ", form.selector), seg(sanitizeLine(item), form.selected)]
          : [seg(`    ${sanitizeLine(item)}`, form.option)],
        first + i,
      ),
    ),
    ...(more > 0 ? [[seg(`    ${listed.items.length} in all`, form.description)]] : []),
  ]
}

/** The spinner's frame while a URL is fetched, turning at frameInterval. */
const useSpinner = (on: boolean): string => {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!on) return
    const timer = setInterval(
      () => setFrame((at) => (at + 1) % spinnerFrames.length),
      Duration.toMillis(frameInterval),
    )
    return () => clearInterval(timer)
  }, [on])
  return spinnerFrames[frame] ?? ""
}

/**
 * The field's line: `> ` and the input, or the spinner and `Fetching <host>…` while a URL is
 * fetched; the input kept mounted, so that the keys of the read that chose Spec reach it.
 */
export const SpecInput = ({
  theme,
  field,
  focused,
}: {
  readonly theme: Theme
  readonly field: SpecFieldState
  readonly focused: boolean
}) => {
  const { form } = theme
  const frame = useSpinner(field.fetching !== null)
  return (
    <box flexDirection="column" height={1} flexShrink={0}>
      {field.fetching === null ? null : (
        <text height={1} {...styled(form.description)}>
          <span {...styled(form.selector)}>{`${frame} `}</span>
          {fetchingLine(field.fetching)}
        </text>
      )}
      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        visible={field.fetching === null}
        {...clickable(() => field.input.current?.focus())}
      >
        <text {...styled(form.selector)}>{"> "}</text>
        <input
          ref={field.input}
          focused={focused}
          flexGrow={1}
          onInput={field.changed}
          placeholder="docs/spec.md, ~/specs/app.md or https://…"
          {...(form.option.fg === undefined ? {} : { textColor: form.option.fg })}
          {...(form.option.fg === undefined ? {} : { focusedTextColor: form.option.fg })}
          {...(form.placeholder.fg === undefined ? {} : { placeholderColor: form.placeholder.fg })}
          {...(form.selected.fg === undefined ? {} : { cursorColor: form.selected.fg })}
        />
      </box>
    </box>
  )
}

/** The completions listed under the field; a click puts one in it. */
export const Listing = ({
  theme,
  field,
}: {
  readonly theme: Theme
  readonly field: SpecFieldState
}) => <Lines lines={listedLines(field.listed, theme)} press={field.act.take} />
