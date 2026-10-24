// The bridge between the run and React (§ 3.5). A fiber consumes a SubscriptionRef's changes and
// stores the latest value in a plain variable, notifying the listeners React subscribed; React
// reads it with useSyncExternalStore, whose getSnapshot returns that variable, the same object
// until the next change. React writes only UiCommands: its handlers put them in the command queue
// with Queue.offerUnsafe (commands.ts's offer) and never run an Effect.
//
// A component reads the part of RunView it draws (useRunViewPart), so that another part changing
// doesn't draw it anew. The times and spinners on screen read two tickers, one for the clock and one
// for the spinner, each an interval for the shell, running while anything draws it: a tick draws
// every spinner in step, and with no time or spinner drawn, nothing ticks.
import { Duration, Effect, type Scope, Stream, SubscriptionRef } from "effect"
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"
import { type Commands, offer, type UiCommand } from "../run/commands.ts"
import type { TicketFiling } from "../run/fileTicket.ts"
import type { RunView } from "../run/runView.ts"
import type { Screen } from "../run/screen.ts"
import type { Clipboard } from "./clipboard.ts"
import type { UrlOpener } from "./openUrl.ts"
import { frameInterval, spinnerFrames } from "./spinner.ts"
import type { Appearance, Theme } from "./theme.ts"
import type { TranscriptFeed } from "./transcriptItems.ts"

/** A value outside React, for useSyncExternalStore: the latest, and a way to hear of the next. */
export interface External<A> {
  /** The value now: the same object until it changes. */
  readonly get: () => A
  /** Calls `listener` on each change, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void
}

/** An External that can be set. */
export interface Settable<A> extends External<A> {
  /** Stores `next` and notifies the listeners, unless it is the value already there. */
  readonly set: (next: A) => void
}

/** An External holding `initial`. */
export const external = <A>(initial: A): Settable<A> => {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * An External following `ref`: a fiber, living as long as the scope, stores each of its changes
 * and notifies the listeners.
 */
export const bridge = <A>(
  ref: SubscriptionRef.SubscriptionRef<A>,
): Effect.Effect<External<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const store = external(yield* SubscriptionRef.get(ref))
    yield* SubscriptionRef.changes(ref).pipe(
      Stream.runForEach((value) => Effect.sync(() => store.set(value))),
      Effect.forkScoped,
    )
    return store
  })

/** What the screen reads and writes, given to the React tree once. */
export interface ShellValue {
  readonly view: External<RunView>
  readonly screen: External<Screen>
  readonly commands: Commands
  readonly appearance: External<Appearance>
  /** The theme in an appearance. */
  readonly themeOf: (appearance: Appearance) => Theme
  /** The time, in epoch milliseconds, for elapsed times; Date.now when left out. */
  readonly now?: () => number
  /** What runs the clock's and the spinner's tickers; setInterval when left out. */
  readonly interval?: Interval
  /** Where a drag's selection is copied (§ 7.3); nothing is copied when left out. */
  readonly clipboard?: Clipboard
  /** Where Open URL opens an elicitation's URL (§ 4.5); it only answers Accept when left out. */
  readonly urlOpener?: UrlOpener
  /** Where a worker view reads its transcript; the view shows none when left out. */
  readonly transcripts?: TranscriptFeed
  /** The tickets whose steered worker has a conflict hand-back waiting (§ 4.3); none when left out. */
  readonly handBacks?: External<ReadonlyArray<string>>
  /** How the tickets filed from finished workers' views went (§ 7.5); none when left out. */
  readonly filings?: External<ReadonlyArray<TicketFiling>>
}

export const ShellContext = createContext<ShellValue | null>(null)

const useShell = (): ShellValue => {
  const shell = useContext(ShellContext)
  if (shell === null) throw new Error("tutti's screen is drawn outside its ShellContext")
  return shell
}

/** The value of `store`, re-rendering on each change. */
const useExternal = <A>(store: External<A>): A => useSyncExternalStore(store.subscribe, store.get)

/** The run's RunView now, re-rendering on each change: for a component that reads most of it. */
export const useRunView = (): RunView => useExternal(useShell().view)

/**
 * The part of the run's RunView `select` picks, re-rendering only when that part changes. project()
 * keeps each part's identity until it changes, so a selector picks parts (view.cards, a card, a
 * request), never builds an array or an object, which would be new at every read.
 */
export const useRunViewPart = <A>(select: (view: RunView) => A): A => {
  const { view } = useShell()
  return useSyncExternalStore(view.subscribe, () => select(view.get()))
}

/** The RunView now, for a handler: newer than the last render's when it changed since. */
export const useLatestRunView = (): (() => RunView) => useShell().view.get

/** Where the worker view reads transcripts, if the shell has them. */
export const useTranscripts = (): TranscriptFeed | undefined => useShell().transcripts

const none: ReadonlyArray<string> = []
const noHandBacks: External<ReadonlyArray<string>> = {
  get: () => none,
  subscribe: () => () => {},
}

/** The tickets whose steered worker has a hand-back waiting, re-rendering on each change. */
export const useHandBacks = (): ReadonlyArray<string> =>
  useExternal(useShell().handBacks ?? noHandBacks)

const noneFiled: ReadonlyArray<TicketFiling> = []
const noFilings: External<ReadonlyArray<TicketFiling>> = {
  get: () => noneFiled,
  subscribe: () => () => {},
}

/** How the tickets filed from finished workers' views went, re-rendering on each change. */
export const useFilings = (): ReadonlyArray<TicketFiling> =>
  useExternal(useShell().filings ?? noFilings)

/** The shell's clock, in epoch milliseconds: Date.now when it has none. */
export const useClock = (): (() => number) => useShell().now ?? Date.now

/** Which screen the run shows: the dashboard, a worker's view, the interview. */
export const useScreen = (): Screen => useExternal(useShell().screen)

/** The theme, in the appearance the terminal has now. */
export const useTheme = (): Theme => {
  const shell = useShell()
  const appearance = useExternal(shell.appearance)
  return useMemo(() => shell.themeOf(appearance), [shell, appearance])
}

/** How often elapsed times are drawn anew: every 3 seconds, as orchestra's (§ 7.2). */
export const tick = 3000

/** Runs `run` every `ms` milliseconds, until the returned function is called. */
export type Interval = (run: () => void, ms: number) => () => void

const realInterval: Interval = (run, ms) => {
  const timer = setInterval(run, ms)
  return () => clearInterval(timer)
}

/**
 * The time from `clock` every `period` milliseconds while anyone listens: one interval for every
 * listener, started with the first and stopped with the last. A listener joining reads the clock
 * afresh, so that it draws the time now, and the others with it, in step.
 */
export const ticker = (
  clock: () => number,
  period: number,
  every: Interval = realInterval,
): External<number> => {
  const time = external(clock())
  let listening = 0
  let stop: (() => void) | null = null
  return {
    get: time.get,
    subscribe: (listener) => {
      const unsubscribe = time.subscribe(listener)
      listening++
      stop ??= every(() => time.set(clock()), period)
      time.set(clock())
      let left = false
      return () => {
        if (left) return
        left = true
        unsubscribe()
        listening--
        if (listening === 0) {
          stop?.()
          stop = null
        }
      }
    },
  }
}

// The spinner, Bubbles' `Dot` (§ 7.11): its frames, the printer's too, and how long each is shown.
export { spinnerFrames }
export const spinnerTick = Duration.toMillis(frameInterval)

/** The spinner's frame at `now`, from the shell's clock: ten a second. */
export const spinnerAt = (now: number): string =>
  spinnerFrames[Math.floor(now / spinnerTick) % spinnerFrames.length] ?? "⣾"

/** The shell's two tickers: the clock's, every `tick`, and the spinner's, every `spinnerTick`. */
interface Tickers {
  readonly clock: External<number>
  readonly spinner: External<number>
}

const tickers = new WeakMap<ShellValue, Tickers>()

/** The shell's tickers, made as it first draws a time or a spinner, on its clock. */
const tickersOf = (shell: ShellValue): Tickers => {
  const known = tickers.get(shell)
  if (known !== undefined) return known
  const clock = shell.now ?? Date.now
  const made = {
    clock: ticker(clock, tick, shell.interval),
    spinner: ticker(clock, spinnerTick, shell.interval),
  }
  tickers.set(shell, made)
  return made
}

/** The time now, in epoch milliseconds, drawn anew every `tick`, as every other time on screen. */
export const useNow = (): number => {
  const { clock } = tickersOf(useShell())
  return useSyncExternalStore(clock.subscribe, clock.get)
}

const still = () => () => {}

/** The spinner's frame now, drawn anew every `spinnerTick` while `active`, in step with the others. */
export const useSpinner = (active: boolean): string => {
  const { spinner } = tickersOf(useShell())
  return useSyncExternalStore(active ? spinner.subscribe : still, () => spinnerAt(spinner.get()))
}

/**
 * `run` as one function from one render to the next, which calls the latest render's `run`: for a
 * handler given to a memoised component, or bound once.
 */
export const useEvent = <A extends ReadonlyArray<unknown>, R>(
  run: (...args: A) => R,
): ((...args: A) => R) => {
  const latest = useRef(run)
  latest.current = run
  return useCallback((...args: A) => latest.current(...args), [])
}

/** Sends a command to the run, from a handler: it is queued at once, and no Effect runs. */
export const useCommand = (): ((command: UiCommand) => void) => {
  const { commands } = useShell()
  return useCallback((command: UiCommand) => offer(commands, command), [commands])
}
