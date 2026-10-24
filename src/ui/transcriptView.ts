// What the worker view and the Interview view share (§ 7.5, § 4.10): a session's transcript open
// while the view is, with your messages queued over it, bounded and scrolled (useTranscriptWindow);
// the attention panel's requests and their answering (usePanel); the selection over the items and
// the panel (useSelection); the composer (useComposer); and what the keys of both do
// (transcriptCommands, useTranscriptKeys).
// Each view adds its own: the worker view the hand-back, Ctrl+X and Ctrl+R; the Interview view its
// leave question.
import type { MouseEvent, Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { AttentionRequest } from "../agent/Attention.ts"
import type { Card } from "../run/runView.ts"
import { type Answering, type AnswerKey, optionKeys, useAnswering } from "./attentionKeys.ts"
import { useSends } from "./Composer.tsx"
import type { Command } from "./keyCommands.ts"
import { Box, useInput } from "./keys.ts"
import {
  bounded,
  type Entry,
  emptyTranscript,
  entriesOf,
  keptEntries,
  mounted,
  type OpenTranscript,
  type TranscriptState,
  withLive,
} from "./transcriptItems.ts"
import { useKeyState } from "./useKeyState.ts"
import { external, useEvent, useTranscripts } from "./useRunView.ts"

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
  // The items' entries, worked out as the items change and each kept while it is the same; the
  // partial messages laid over them as each token comes, the entries not along their way kept.
  const keptItems = useRef<ReadonlyArray<Entry>>([])
  const itemEntries = useMemo(() => {
    keptItems.current = keptEntries(keptItems.current, entriesOf(window.items, [], queued))
    return keptItems.current
  }, [window.items, queued])
  const keptLive = useRef<ReadonlyArray<Entry>>([])
  const entries = useMemo(() => {
    keptLive.current = keptEntries(keptLive.current, withLive(itemEntries, state.live))
    return keptLive.current
  }, [itemEntries, state.live])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const shown = useMemo(
    () => bounded(entries, expanded, window.following),
    [entries, expanded, window.following],
  )
  const flat = useMemo(() => mounted(shown, expanded), [shown, expanded])
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

/**
 * How many of the panel's oldest `requests` (at most `panelRequests`) the view has room for, `waiting`
 * open in all; one at least.
 */
export type PanelFit = (requests: ReadonlyArray<AttentionRequest>, waiting: number) => number

/**
 * The panel of `card`'s requests, as many as `fit` has room for; Answer in view opens the answer form
 * over the view.
 */
export const usePanel = (
  card: Card | undefined,
  fit: PanelFit = (requests) => requests.length,
): Panel => {
  const input = useInput()
  const waiting = card?.requests ?? []
  const oldest = waiting.slice(0, panelRequests)
  const requests = oldest.slice(0, Math.max(fit(oldest, waiting.length), 1))
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
  // (tutti-k2n1): it chooses as the latest drawing's selectables say.
  const click = useEvent((key: string) => {
    choose(key)
    transcript.toggle(key)
  })
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
  // Its height, which the view's request panel leaves room for (tutti-7nzv).
  const [lines, setLines] = useState(1)
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
    /** The composer's height, in lines, and its setter, which the composer calls as it fits. */
    lines,
    setLines,
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

/** What a transcript view's keys do (useTranscriptKeys). */
export interface TranscriptActions {
  /** `?`: opens or closes the key help. */
  readonly help: () => void
  /** `Esc`: closes the key help, leaves the composer, then leaves the view. */
  readonly escape: () => void
  /** `i`: the composer. */
  readonly write: () => void
  readonly page: (by: 1 | -1) => void
  /** Moves the selection between items. */
  readonly move: (by: 1 | -1) => void
  /** Moves the focus between a request's buttons, and on past them, or else the selection. */
  readonly stepOrMove: (by: 1 | -1) => void
  readonly enter: () => void
  /** Answers the target request as `key` does, if it answers it. */
  readonly answer: (key: AnswerKey) => void
  readonly denyWithReason: () => void
  /** Picks the question's option `n`, 1 to 4. */
  readonly pick: (n: number) => void
  readonly top: () => void
  readonly end: () => void
}

const nothing = () => {}

/** Keys that do nothing: a view's commands as its hint and key help name them, before they are bound. */
export const inertTranscript: TranscriptActions = {
  help: nothing,
  escape: nothing,
  write: nothing,
  page: nothing,
  move: nothing,
  stepOrMove: nothing,
  enter: nothing,
  answer: nothing,
  denyWithReason: nothing,
  pick: nothing,
  top: nothing,
  end: nothing,
}

/**
 * A transcript view's commands, as `act` binds them: each view gives them their hint and key help,
 * in its own words and order, with its own commands among them (WorkerView's workerViewCommands,
 * InterviewView's interviewCommands).
 */
export const transcriptCommands = (act: TranscriptActions) =>
  ({
    help: { keys: ["?"], run: act.help },
    escape: { keys: ["escape"], run: act.escape },
    write: { keys: ["i"], run: act.write },
    pageUp: { keys: ["pageup"], run: () => act.page(-1) },
    pageDown: { keys: ["pagedown"], run: () => act.page(1) },
    down: { keys: ["down"], run: () => act.move(1) },
    up: { keys: ["up"], run: () => act.move(-1) },
    next: { keys: ["tab", "right"], run: () => act.stepOrMove(1) },
    previous: { keys: ["shift+tab", "left"], run: () => act.stepOrMove(-1) },
    enter: { keys: ["return", "enter"], run: act.enter },
    deny: { keys: ["d"], run: () => act.answer("d") },
    denyWithReason: { keys: ["shift+d"], run: act.denyWithReason },
    allow: { keys: ["a"], run: () => act.answer("a") },
    forRun: { keys: ["r"], run: () => act.answer("r") },
    picks: Array.from({ length: optionKeys }, (_, i) => ({
      keys: [String(i + 1)],
      run: () => act.pick(i + 1),
    })),
    top: { keys: ["g"], run: act.top },
    end: { keys: ["shift+g"], run: act.end },
  }) satisfies Record<string, Command | ReadonlyArray<Command>>

/**
 * What the keys of a transcript's view do (transcriptCommands), which the view binds in its layer
 * with its own. `Esc` closes the key help, leaves the composer, then does `back`. With the key help
 * open, `?` and `Esc` close it and the other keys do nothing: `unlessHelp` keeps the view's own
 * keys from it too. While you write, the composer takes the printable keys, Enter, Tab and the
 * arrows (keys.ts). Gives whether the key help is open.
 */
export const useTranscriptKeys = (options: {
  readonly transcript: TranscriptWindow
  readonly panel: Panel
  readonly selection: Selection
  readonly composer: ComposerState
  readonly back: () => void
  readonly enter?: () => void
  /** PgUp's and PgDn's: the transcript's page by default. */
  readonly page?: (step: 1 | -1) => void
}): {
  readonly help: boolean
  readonly actions: TranscriptActions
  readonly unlessHelp: <A extends ReadonlyArray<unknown>>(
    run: (...args: A) => void,
  ) => (...args: A) => void
} => {
  const { transcript, panel, selection, composer, back } = options
  const [help, setHelp, helpOpen] = useKeyState(() => false)
  const showHelp = (on: boolean) => setHelp(() => on)
  const enter = options.enter ?? selection.enter
  const unlessHelp =
    <A extends ReadonlyArray<unknown>>(run: (...args: A) => void) =>
    (...args: A) => {
      if (!helpOpen()) run(...args)
    }
  const target = (run: (card: Card) => void) => {
    const card = selection.targetCard()
    if (card !== undefined) run(card)
  }
  return {
    help,
    unlessHelp,
    actions: {
      help: () => showHelp(!helpOpen()),
      escape: () =>
        helpOpen() ? showHelp(false) : composer.composing() ? composer.setComposing(false) : back(),
      write: unlessHelp(() => composer.setComposing(true)),
      page: unlessHelp(options.page ?? transcript.page),
      move: unlessHelp(selection.move),
      stepOrMove: unlessHelp(selection.stepOrMove),
      enter: unlessHelp(enter),
      answer: unlessHelp((key: AnswerKey) => target((card) => panel.answering.key(card, key))),
      denyWithReason: unlessHelp(() => target(panel.answering.denyWithReason)),
      pick: unlessHelp((n: number) => {
        selection.pick(n)
      }),
      top: unlessHelp(transcript.top),
      end: unlessHelp(transcript.end),
    },
  }
}
