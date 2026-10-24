// Key commands as data (§ 7.3): each screen's keys are one list of commands, and its hint, its key
// help and its bindings are all drawn from that list, so that none of them names a key the others
// don't have. A command is its keys, what pressing one does, whether it is there now, and how the
// hint and the key help name it.
import type { Key } from "../run/runView.ts"
import { type Box, type LayerName, useLayer } from "./keys.ts"

/** A row of the key help: the keys as it names them, and what they do. */
export type HelpRow = readonly [string, string]

/** A key command of a screen or a box. */
export interface Command {
  /**
   * Its keys in keymap syntax (`tab`, `shift+d`, `?`); none for one bound elsewhere, a text
   * field's or the mouse's, which the hint or the key help only names.
   */
  readonly keys: ReadonlyArray<string>
  readonly run: () => void
  /**
   * Whether it is there now, read as the key is pressed and as the hint is drawn: a key whose
   * command isn't goes to the next command in the list with that key, or does nothing. Always
   * there when left out.
   */
  readonly when?: () => boolean
  /** How the hint names it, in this render; not named when left out. */
  readonly hint?: Key | undefined
  /** Its row of the key help; commands whose rows name the same keys share one row. */
  readonly help?: HelpRow
}

/** Whether `command` is there now. */
export const isOn = (command: Command): boolean => command.when?.() ?? true

/** The hint's keys: those of the commands there now that the hint names, in the list's order. */
export const hintOf = (commands: ReadonlyArray<Command>): ReadonlyArray<Key> =>
  commands.flatMap((command) => (command.hint !== undefined && isOn(command) ? [command.hint] : []))

/** The key help's rows: every command's, there now or not, each row once, in the list's order. */
export const helpOf = (commands: ReadonlyArray<Command>): ReadonlyArray<HelpRow> => {
  const rows = new Map<string, HelpRow>()
  for (const { help } of commands) {
    if (help !== undefined && !rows.has(help[0])) rows.set(help[0], help)
  }
  return [...rows.values()]
}

/** The command `key` runs: the first of `commands` with it that is there now. */
export const commandFor = (commands: ReadonlyArray<Command>, key: string): Command | undefined =>
  commands.find((command) => command.keys.includes(key) && isOn(command))

/** Every key `commands` bind, each once, in the list's order. */
export const keysOf = (commands: ReadonlyArray<Command>): ReadonlyArray<string> => [
  ...new Set(commands.flatMap((command) => command.keys)),
]

/**
 * Binds `commands` in `layer` (keys.ts useLayer), in the box layer while the box `which` is open:
 * each key runs the command the latest render's list gives it (commandFor). The bindings are
 * registered again only when the keys change. Gives the hint's keys and the key help's rows.
 */
export const useCommands = (
  layer: Exclude<LayerName, "field">,
  commands: ReadonlyArray<Command>,
  which?: Box["_tag"],
): { readonly hint: ReadonlyArray<Key>; readonly help: ReadonlyArray<HelpRow> } => {
  useLayer(
    layer,
    keysOf(commands).map((key) => ({ key, run: () => commandFor(commands, key)?.run() })),
    which,
  )
  return { hint: hintOf(commands), help: helpOf(commands) }
}

/** What the global keys do. */
export interface GlobalActions {
  /** Ctrl+C: the quit box; a second Ctrl+C, the box still open, quits now (D15). */
  readonly quit: () => void
  /** Ctrl+Z: a toast, as tutti can't be suspended (D18). */
  readonly suspend: () => void
}

/** The keys of every view, over every layer, and the mouse's drag, which copies (clipboard.ts). */
export const globalCommands = (act: GlobalActions): ReadonlyArray<Command> => [
  { keys: ["ctrl+c"], run: act.quit, help: ["Ctrl+C", "quit: stop after current, or quit now"] },
  { keys: ["ctrl+z"], run: act.suspend, help: ["Ctrl+Z", "a toast: tutti can't be suspended"] },
  { keys: [], run: () => {}, help: ["a drag", "select text and copy it"] },
]

/** The global keys' rows, which end every view's key help. */
export const globalHelp: ReadonlyArray<HelpRow> = helpOf(
  globalCommands({ quit: () => {}, suspend: () => {} }),
)
