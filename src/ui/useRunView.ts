// The bridge between the run and React (§ 3.5). A fiber consumes a SubscriptionRef's changes and
// stores the latest value in a plain variable, notifying the listeners React subscribed; React
// reads it with useSyncExternalStore, whose getSnapshot returns that variable, the same object
// until the next change. React writes only UiCommands: its handlers put them in the command queue
// with Queue.offerUnsafe (commands.ts's offer) and never run an Effect.
import { Effect, type Scope, Stream, SubscriptionRef } from "effect"
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react"
import { type Commands, offer, type UiCommand } from "../run/commands.ts"
import type { RunView } from "../run/runView.ts"
import type { Screen } from "../run/screen.ts"
import type { Appearance, Theme } from "./theme.ts"

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
}

export const ShellContext = createContext<ShellValue | null>(null)

const useShell = (): ShellValue => {
  const shell = useContext(ShellContext)
  if (shell === null) throw new Error("tutti's screen is drawn outside its ShellContext")
  return shell
}

/** The value of `store`, re-rendering on each change. */
const useExternal = <A>(store: External<A>): A => useSyncExternalStore(store.subscribe, store.get)

/** The run's RunView now. */
export const useRunView = (): RunView => useExternal(useShell().view)

/** Which screen the run shows: the dashboard, a worker's view, the interview. */
export const useScreen = (): Screen => useExternal(useShell().screen)

/** The theme, in the appearance the terminal has now. */
export const useTheme = (): Theme => {
  const shell = useShell()
  const appearance = useExternal(shell.appearance)
  return useMemo(() => shell.themeOf(appearance), [shell, appearance])
}

/** Sends a command to the run, from a handler: it is queued at once, and no Effect runs. */
export const useCommand = (): ((command: UiCommand) => void) => {
  const { commands } = useShell()
  return useCallback((command: UiCommand) => offer(commands, command), [commands])
}
