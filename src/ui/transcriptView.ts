// What the worker view and the Interview view share (§ 7.5, § 4.10): a session's transcript open
// while the view is, with your messages queued over it, bounded and scrolled (useTranscriptWindow);
// the attention panel's requests and their answering (usePanel); the selection over the items and
// the panel (useSelection); the composer (useComposer); and the keys of both (useTranscriptKeys).
// Each view adds its own: the worker view the hand-back, Ctrl+X and Ctrl+R; the Interview view its
// leave question.
import type { MouseEvent, Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { AttentionRequest } from "../agent/Attention.ts"
import type { Card } from "../run/runView.ts"
import { answerBindings } from "./AttentionCard.tsx"
import { type Answering, optionKeys, useAnswering } from "./attentionKeys.ts"
import { useSends } from "./Composer.tsx"
import { Box, type KeyBinding, useInput, useLayer } from "./keys.ts"
import {
  bounded,
  type Entry,
  emptyTranscript,
  entriesOf,
  mounted,
  type OpenTranscript,
  type TranscriptState,
} from "./transcriptItems.ts"
import { useKeyState } from "./useKeyState.ts"
import { external, useRunView, useTranscripts } from "./useRunView.ts"

/** The most requests the panel shows whole; the rest are counted under them. */
export const panelRequests = 2

/** The id of an entry's renderable in the scrollbox, to find it by. */
export const entryId = (key: string): string => `entry-${key}`

/** The selection key of a request in the panel. */
export const requestKey = (request: AttentionRequest): string => `request:${request.id}`

/** Whether the selection can rest on `entry`: one that expands. */
export const selectable = (entry: Entry): boolean => entry._tag !== "Text"

/** The store a view without a transcript reads. */
const noTranscript = external<TranscriptState>(emptyTranscript)

/**
 * The transcript of `ticket`, open while the view shows it, and the window of it mounted: your
 * messages sent while a turn is under way are queued until the transcript says they were taken,
 * and those sent while its ticket is `holding` them, merging, are held (useSends). Scrolling past
 * the top loads older items, keeping your place; the bottom follows the session.
 */
export const useTranscriptWindow = (
  ticket: string | undefined,
  underWay: boolean,
  holding = false,
  finished = false,
) => {
  const feed = useTranscripts()
  const renderer = useRenderer()
  const [transcript, setTranscript] = useState<OpenTranscript | null>(null)
  useEffect(() => {
    if (feed === undefined || ticket === undefined) return
    const opened = feed.open(ticket)
    setTranscript(opened)
    return () => {
      opened.close()
      setTranscript(null)
    }
  }, [feed, ticket])
  const store = transcript?.state ?? noTranscript
  const state = useSyncExternalStore(store.subscribe, store.get)
  const window = state.window
  // The composer shows your queued messages till they are taken, the transcript after.
  const sends = useSends(ticket, window.latest, underWay, holding, finished)
  const queuedKey = sends.queued.map((send) => send.uuid).join(" ")
  const queued = useMemo(() => new Set(queuedKey === "" ? [] : queuedKey.split(" ")), [queuedKey])
  const entries = useMemo(
    () => entriesOf(window.items, state.live, queued),
    [window.items, state.live, queued],
  )
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const shown = bounded(entries, expanded, window.following)
  const flat = mounted(shown, expanded)
  const toggle = useCallback(
    (key: string) =>
      setExpanded((open) => {
        const next = new Set(open)
        if (!next.delete(key)) next.add(key)
        return next
      }),
    [],
  )

  const scroll = useRef<ScrollBoxRenderable>(null)
  const anchor = useRef<string | null>(null)
  const atTop = () => (scroll.current?.scrollTop ?? 0) <= 0
  const atEnd = () => {
    const box = scroll.current
    return box === null || box.scrollTop >= box.scrollHeight - box.viewport.height - 1
  }
  const older = () => {
    if (transcript === null || state.loading || window.start) return
    anchor.current = shown[0]?.key ?? null
    transcript.older()
  }
  const settled = () => {
    if (transcript === null) return
    if (atEnd()) transcript.follow()
    else transcript.scrolledBack()
  }
  const firstSeq = window.items[0]?.seq
  // biome-ignore lint/correctness/useExhaustiveDependencies: the place is kept once the older items are in
  useEffect(() => {
    const key = anchor.current
    if (key === null) return
    anchor.current = null
    let tries = 0
    const keep = () => {
      const box = scroll.current
      if (box === null || box.isDestroyed) return
      const child = box.content.getChildren().find((each) => each.id === entryId(key))
      const offset = child === undefined ? 0 : child.y - box.content.y
      if (offset > 0) box.scrollTop = offset
      else if (tries++ < 10) renderer.requestAnimationFrame(keep)
    }
    renderer.requestAnimationFrame(keep)
  }, [firstSeq])
  /** PgUp or PgDn: a page less a line. */
  const page = (step: 1 | -1) => {
    const box = scroll.current
    if (box === null) return
    if (step === -1 && atTop()) older()
    box.scrollBy(step * Math.max(box.viewport.height - 1, 1))
    settled()
  }
  /** `g`: the top, loading older items when already there. */
  const top = () => {
    if (atTop()) older()
    scroll.current?.scrollTo(0)
    settled()
  }
  /** `G`: the end, following the session. */
  const end = () => {
    transcript?.follow()
    const box = scroll.current
    box?.scrollTo(box.scrollHeight)
  }
  /** The wheel, over the scrollbox. */
  const wheel = (event: MouseEvent) => {
    if (event.scroll?.direction === "up" && atTop()) older()
    queueMicrotask(settled)
  }
  return {
    loading: state.loading,
    sends,
    shown,
    flat,
    expanded,
    toggle,
    scroll,
    page,
    top,
    end,
    wheel,
  }
}

export type TranscriptWindow = ReturnType<typeof useTranscriptWindow>

/** The attention panel of `card`'s session. */
export interface Panel {
  /** Its oldest open requests, those drawn: only they can be selected or answered. */
  readonly requests: ReadonlyArray<AttentionRequest>
  /** How many more are waiting, counted under them; each comes in as one before it is answered. */
  readonly more: number
  /** Each request drawn as a card of its own, for the card's answering. */
  readonly cards: ReadonlyArray<Card>
  readonly answering: Answering
}

/** The panel of `card`'s requests; Answer in view opens the answer form over the view. */
export const usePanel = (card: Card | undefined): Panel => {
  const view = useRunView()
  const input = useInput()
  const waiting = card === undefined ? [] : view.requests.filter((r) => r.ticket === card.ticket)
  const requests = waiting.slice(0, panelRequests)
  const cards: ReadonlyArray<Card> =
    card === undefined ? [] : requests.map((request) => ({ ...card, requests: [request] }))
  const answering = useAnswering(cards, undefined, (request) =>
    input.box.set(Box.Form({ requestId: request.id, ticket: request.ticket })),
  )
  return { requests, more: waiting.length - requests.length, cards, answering }
}

/**
 * The selection: it names an entry, one of `own` (the view's own notices, above the requests) or a
 * request; with none chosen, the oldest request is the target. It is key state, so that keys
 * arriving together each see the one before them.
 */
export const useSelection = (
  transcript: TranscriptWindow,
  panel: Panel,
  own: ReadonlyArray<string> = [],
) => {
  const [, setChosen, chosen] = useKeyState<string | null>(() => null)
  const notEntries = [...own, ...panel.requests.map(requestKey)]
  const selectables = [
    ...transcript.flat.filter(selectable).map((entry) => entry.key),
    ...notEntries,
  ]
  const current = (): string | null => {
    const key = chosen()
    if (key !== null && selectables.includes(key)) return key
    const oldest = panel.requests[0]
    return oldest !== undefined ? requestKey(oldest) : null
  }
  const choose = (key: string | null) => {
    setChosen(() => key)
    if (key !== null && !notEntries.includes(key)) {
      transcript.scroll.current?.scrollChildIntoView(entryId(key))
    }
  }
  /** The request selected, as its card. */
  const selectedCard = (): Card | undefined => {
    const key = current()
    return panel.cards.find((each) => each.requests[0] && requestKey(each.requests[0]) === key)
  }
  const targetCard = () => selectedCard() ?? panel.cards[0]
  // Its guard starts again as the target moves: on to the next request once one is answered.
  panel.answering.target(targetCard())
  const move = (step: 1 | -1) => {
    if (selectables.length === 0) return
    // From none, the newest item: you're at the bottom.
    const at = selectables.indexOf(current() ?? "")
    const next =
      at === -1 ? selectables.length - 1 : Math.min(Math.max(at + step, 0), selectables.length - 1)
    panel.answering.reset()
    choose(selectables[next] ?? null)
  }
  // A click, the same function from one drawing to the next, so that the entries' memo holds
  // (tutti-k2n1): it chooses as this drawing's selectables say.
  const chooseNow = useRef(choose)
  chooseNow.current = choose
  const { toggle } = transcript
  const click = useCallback(
    (key: string) => {
      chooseNow.current(key)
      toggle(key)
    },
    [toggle],
  )
  return {
    selected: current(),
    current,
    selectedCard,
    /** The request the answer keys answer: the one selected, or the oldest. */
    targetCard,
    move,
    /** Between the selected request's buttons, then on to the next selectable. */
    stepOrMove: (step: 1 | -1) => {
      const target = selectedCard()
      if (target !== undefined && panel.answering.step(target, step)) return
      move(step)
    },
    /** Selects the entry and expands or collapses it, as a click does. */
    click,
    /** Presses the selected request's focused button, or expands or collapses the selected entry. */
    enter: () => {
      const key = current()
      if (key === null) return
      const target = selectedCard()
      if (target !== undefined) panel.answering.pressFocused(target)
      else transcript.toggle(key)
    },
    /** Picks option `n` of the selected question. */
    pick: (n: number) => {
      const target = selectedCard()
      if (target !== undefined) panel.answering.pick(target, n)
    },
  }
}

export type Selection = ReturnType<typeof useSelection>

/**
 * The composer: you write in it while it is chosen and no box is open over the view. It takes the
 * focus, or gives it up, as the key is pressed, so that the keys after it go where it says. With no
 * box open it follows the renderer's focus too: a click that moves the focus elsewhere leaves it, as
 * the keys go there then (tutti-yzkg), and one on the field chooses it.
 */
export const useComposer = () => {
  const renderer = useRenderer()
  const input = useInput()
  const box = useSyncExternalStore(input.box.subscribe, input.box.get)
  const field = useRef<TextareaRenderable>(null)
  const [composing, setComposingState, composingNow] = useKeyState(() => false)
  const setComposing = (on: boolean) => {
    setComposingState(() => on)
    if (!on) field.current?.blur()
    else if (input.box.get() === null) field.current?.focus()
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: composingNow and setComposingState read and change the value as it is then
  useEffect(() => {
    // A blur moves the focus to none, and a box takes it once it is open: neither leaves it.
    const moved = (next: Renderable | null) => {
      if (next === null || input.box.get() !== null) return
      const mine = next === field.current
      if (mine !== composingNow()) setComposingState(() => mine)
    }
    renderer.on("focused_renderable", moved)
    return () => {
      renderer.off("focused_renderable", moved)
    }
  }, [renderer, input.box])
  return {
    /** The box open over the view, if any. */
    box,
    field,
    /** Whether you write in the composer now. */
    typing: composing && box === null,
    composing: composingNow,
    setComposing,
    /** Gives up the focus for a box the view opens. */
    blur: () => field.current?.blur(),
    /** Takes the focus back once the view's box closes, when it was chosen. */
    refocus: () => {
      if (composingNow()) field.current?.focus()
    },
  }
}

export type ComposerState = ReturnType<typeof useComposer>

/**
 * The keys of a transcript's view, in its layer: `own` (the view's own) first, then the
 * transcript's and the panel's. `Esc` closes the key help, leaves the composer, then does `back`.
 * With the key help open, `?` and `Esc` close it and the other keys do nothing. While you write,
 * the composer takes the printable keys, Enter, Tab and the arrows (keys.ts). Gives whether the
 * key help is open.
 */
export const useTranscriptKeys = (options: {
  readonly transcript: TranscriptWindow
  readonly panel: Panel
  readonly selection: Selection
  readonly composer: ComposerState
  readonly back: () => void
  readonly enter?: () => void
  readonly own?: ReadonlyArray<KeyBinding>
}): boolean => {
  const { transcript, panel, selection, composer, back } = options
  const [help, setHelp, helpOpen] = useKeyState(() => false)
  const showHelp = (on: boolean) => setHelp(() => on)
  const enter = options.enter ?? selection.enter
  const keys: ReadonlyArray<KeyBinding> = [
    ...(options.own ?? []),
    { key: "pageup", run: () => transcript.page(-1) },
    { key: "pagedown", run: () => transcript.page(1) },
    { key: "i", run: () => composer.setComposing(true) },
    { key: "down", run: () => selection.move(1) },
    { key: "up", run: () => selection.move(-1) },
    ...["tab", "right"].map((key) => ({ key, run: () => selection.stepOrMove(1) })),
    ...["shift+tab", "left"].map((key) => ({ key, run: () => selection.stepOrMove(-1) })),
    ...["return", "enter"].map((key) => ({ key, run: enter })),
    ...answerBindings(panel.answering, selection.targetCard),
    ...Array.from({ length: optionKeys }, (_, i) => ({
      key: String(i + 1),
      run: () => selection.pick(i + 1),
    })),
    { key: "g", run: transcript.top },
    { key: "shift+g", run: transcript.end },
  ]
  useLayer("view", [
    { key: "?", run: () => showHelp(!helpOpen()) },
    {
      key: "escape",
      run: () =>
        helpOpen() ? showHelp(false) : composer.composing() ? composer.setComposing(false) : back(),
    },
    ...keys.map((binding) => ({
      key: binding.key,
      run: () => (helpOpen() ? undefined : binding.run()),
    })),
  ])
  return help
}
