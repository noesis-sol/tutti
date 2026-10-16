// The bridge of spec § 3.5, reduced to what the soak needs: a producer writes immutable snapshots,
// notification is throttled to at most 30 Hz, and React reads the latest with
// useSyncExternalStore. getSnapshot returns the same object until the next write.

import { activities, type Item, makeItem, STREAMING_LENGTH, streamingText } from "./content.ts"

export class ExternalStore<T> {
  private value: T
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastNotify = 0

  constructor(
    initial: T,
    private readonly minIntervalMs = 1000 / 30,
  ) {
    this.value = initial
  }

  readonly getSnapshot = (): T => this.value

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(next: T): void {
    this.value = next
    if (this.timer !== null) return
    const wait = Math.max(0, this.lastNotify + this.minIntervalMs - performance.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.lastNotify = performance.now()
      for (const listener of this.listeners) listener()
    }, wait)
  }
}

export type Card = {
  readonly id: string
  readonly title: string
  readonly phase: string
  readonly elapsed: number
  readonly activity: string
  readonly tokens: number
}

export type RunView = { readonly tick: number; readonly cards: readonly Card[] }

export type Transcript = {
  readonly items: readonly Item[]
  /** The message being streamed, or null with --stream off. */
  readonly streaming: { readonly id: number; readonly chars: number } | null
  /** Items appended since the start, counting the preloaded ones. */
  readonly total: number
}

const phases = ["queued", "working", "testing", "merging", "settling"]

const card = (i: number, tick: number): Card => ({
  id: `tut-${(i * 7919).toString(36).slice(-3)}`,
  title: `Card ${i + 1}: ${activities[(i + 2) % activities.length]}`,
  phase: phases[Math.floor(tick / 50 + i) % phases.length] ?? "working",
  elapsed: Math.floor(tick / 10),
  activity: `${activities[Math.floor(tick / 7 + i) % activities.length]} #${tick}`,
  tokens: tick * (i + 1),
})

export type ProducerOptions = {
  readonly cards: number
  /** Items mounted at most; Infinity keeps every item (the unbounded control). */
  readonly window: number
  /** Items in the transcript at the start. */
  readonly preload: number
  readonly hz: number
  /** Ticks between appended items; 0 appends none. */
  readonly appendEvery: number
  /** Stream an assistant message into the transcript's tail, 24 characters a tick. */
  readonly stream: boolean
}

/** Starts the 10 Hz producer. Returns the two stores and a stop function. */
export const startProducer = (options: ProducerOptions) => {
  const cards = (tick: number) => Array.from({ length: options.cards }, (_, i) => card(i, tick))
  const runView = new ExternalStore<RunView>({ tick: 0, cards: cards(0) })
  const preload = Array.from({ length: options.preload }, (_, i) => makeItem(i))
  const transcript = new ExternalStore<Transcript>({
    items: preload.slice(-options.window),
    streaming: options.stream ? { id: options.preload, chars: 0 } : null,
    total: options.preload,
  })
  let window = options.window
  const trim = (items: readonly Item[]) =>
    items.length > window ? items.slice(items.length - window) : items

  let tick = 0
  const interval = setInterval(() => {
    tick++
    runView.set({ tick, cards: cards(tick) })
    const t = transcript.getSnapshot()
    let items = t.items
    let total = t.total
    let streaming = t.streaming && { id: t.streaming.id, chars: t.streaming.chars + 24 }
    if (streaming !== null && streaming.chars >= STREAMING_LENGTH) {
      // The streamed message is finished: it becomes an ordinary item and a new one starts.
      const text = streamingText(streaming.id, STREAMING_LENGTH)
      items = [...items, { kind: "markdown", id: total, text }]
      total++
      streaming = { id: total + 1_000_000, chars: 0 }
    }
    if (options.appendEvery > 0 && tick % options.appendEvery === 0) {
      items = [...items, makeItem(total)]
      total++
    }
    transcript.set({ items: trim(items), streaming, total })
  }, 1000 / options.hz)

  return {
    runView,
    transcript,
    stop: () => clearInterval(interval),
    ticks: () => tick,
    /** Mounts at most `next` items from the next tick on, as returning to the bottom would. */
    setWindow: (next: number) => {
      window = next
    },
  }
}
