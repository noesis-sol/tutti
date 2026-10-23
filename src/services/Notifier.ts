// The Notifier service (§ 3.3, § 7.9): desktop notifications for the run's events, as orchestra's
// (merged, set aside, needs your answer, stopped, finished), plus needs you (§ 4.5) and usage limit
// (§ 4.12). A notice is a few words; the line it is about goes to the log.
//
// How one is shown depends on where tutti runs. In a local session it is the desktop's own: on macOS
// `osascript`, titled with the repository's folder name in Notification Center, and on Linux
// `notify-send` when it is installed. Otherwise, over ssh or where neither is there, it is OSC 9 or
// OSC 777 written to the terminal, where the terminal is one known to show them (iTerm2, kitty,
// Ghostty, WezTerm, foot), so that notifications work over ssh. Not both: a local iTerm2 would
// show each notice twice. Over ssh the desktop command would show on the remote machine, if
// anywhere, so the terminal's notification is used instead.
//
// Notifications are off with `--notify=false`, `TUTTI_NOTIFY=0` or `"notify": false` in the user
// config: AppConfig's `notify`. Text is sanitised (§ 7.10). A notice is shown in the background,
// so a slow `osascript` doesn't hold up the loop; one that fails is logged, never fatal.
import { basename } from "node:path"
import { Context, Duration, Effect, FiberSet, type FileSystem, Layer } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { AppConfig } from "../cli/AppConfig.ts"
import { Log, Tag, tagged } from "../run/log.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import {
  type Command,
  type CommandFailed,
  type CommandNotRun,
  type CommandTimedOut,
  run,
} from "./exec.ts"
import { Tty, type TtyValue } from "./Tty.ts"

export class Notifier extends Context.Service<
  Notifier,
  {
    /**
     * Shows `notice` as a notification titled with the repository's folder name, if they are on.
     * It returns at once and never fails: the notice is shown in the background, and a failure to
     * show it is logged.
     */
    notify(notice: string): Effect.Effect<void>
  }
>()("tutti/services/Notifier") {}

/** How long a notification may take to show before its command is stopped, as in orchestra. */
export const notifyLimit: Duration.Duration = Duration.seconds(10)

/** The desktop's own notification command. */
export type Desktop = "osascript" | "notify-send"

/** The terminal's notification sequence: iTerm2's OSC 9, or rxvt's OSC 777 with a title. */
export type Osc = "9" | "777"

/** How notices are shown: through the desktop's command, or written to the terminal. */
export type Route =
  | { readonly _tag: "Desktop"; readonly command: Desktop }
  | { readonly _tag: "Osc"; readonly osc: Osc }
  | { readonly _tag: "None" }

/** What the environment tells of where tutti runs. */
export interface Where {
  readonly platform: NodeJS.Platform
  readonly env: (name: string) => string | undefined
  /** Whether a command of this name is on the PATH. */
  readonly installed: (command: string) => boolean
  readonly tty: Pick<TtyValue, "stdoutIsTty" | "dumb" | "term">
}

const set = (env: Where["env"], name: string): boolean => {
  const value = env(name)
  return value !== undefined && value !== ""
}

/** Whether the session is over ssh: sshd sets these for the session's processes. */
export const overSsh = (env: Where["env"]): boolean =>
  set(env, "SSH_CONNECTION") || set(env, "SSH_CLIENT") || set(env, "SSH_TTY")

/**
 * Whether `command` is on process.env's PATH, the one a command is run with. Bun.which alone reads
 * the PATH the process started with, and doesn't see process.env.PATH changed since (tutti-xj3t).
 */
export const installedOnPath = (command: string): boolean =>
  Bun.which(command, { PATH: process.env.PATH ?? "" }) !== null

/**
 * The notification sequence the terminal shows, read from the environment: undefined for one not
 * known to show either. TERM and LC_TERMINAL reach an ssh session (iTerm2 sets LC_TERMINAL, which
 * ssh sends with the other LC_ variables); TERM_PROGRAM and the terminals' own variables tell a
 * local one, and inside tmux, whose TERM_PROGRAM and TERM are its own, they are what is left.
 */
export const oscOf = (env: Where["env"]): Osc | undefined => {
  const term = (env("TERM") ?? "").toLowerCase()
  const program = (env("TERM_PROGRAM") ?? "").toLowerCase()
  if (
    program === "iterm.app" ||
    env("LC_TERMINAL") === "iTerm2" ||
    set(env, "ITERM_SESSION_ID") ||
    term === "xterm-kitty" ||
    set(env, "KITTY_WINDOW_ID")
  ) {
    return "9"
  }
  if (
    program === "ghostty" ||
    program === "wezterm" ||
    term === "xterm-ghostty" ||
    term === "wezterm" ||
    term === "foot" ||
    term.startsWith("foot-") ||
    set(env, "GHOSTTY_RESOURCES_DIR") ||
    set(env, "WEZTERM_PANE")
  ) {
    return "777"
  }
  return undefined
}

/**
 * How notices are shown where tutti runs: the desktop's command in a local session on macOS, or on
 * Linux with `notify-send` installed; otherwise the terminal's sequence, when stdout is a terminal
 * known to show one; otherwise not at all.
 */
export const routeOf = (where: Where): Route => {
  if (!overSsh(where.env)) {
    if (where.platform === "darwin") return { _tag: "Desktop", command: "osascript" }
    if (where.platform === "linux" && where.installed("notify-send")) {
      return { _tag: "Desktop", command: "notify-send" }
    }
  }
  const osc = where.tty.stdoutIsTty && !where.tty.dumb ? oscOf(where.env) : undefined
  return osc === undefined ? { _tag: "None" } : { _tag: "Osc", osc }
}

/**
 * `osascript`'s arguments showing `notice` titled `title`. Both go in as arguments rather than into
 * the script, so nothing in them is AppleScript and no quote in them can end a string; `--` keeps a
 * notice starting with `-` from being taken for an option.
 */
export const osascriptArgs = (title: string, notice: string): ReadonlyArray<string> => [
  "-e",
  "on run argv",
  "-e",
  "display notification (item 1 of argv) with title (item 2 of argv)",
  "-e",
  "end run",
  "--",
  notice,
  title,
]

/** Text a notification server that reads markup in the body shows as it is. */
const escapeMarkup = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** `notify-send`'s arguments showing `notice` titled `title`; its body may be read as markup. */
export const notifySendArgs = (title: string, notice: string): ReadonlyArray<string> => [
  "--app-name=tutti",
  "--",
  title,
  escapeMarkup(notice),
]

const BEL = "\x07"
const ESC = "\x1b"

/**
 * The sequence showing `notice` titled `title`, both already sanitised (so neither holds a BEL or
 * an ESC that would end it). OSC 9 has no title, so it leads the text; in OSC 777 a `;` ends the
 * title, so one in it becomes a `,`. Inside tmux the sequence is wrapped to pass through to the
 * terminal, which tmux does with `allow-passthrough on`.
 */
export const oscSequence = (osc: Osc, title: string, notice: string, tmux: boolean): string => {
  const sequence =
    osc === "9"
      ? `${ESC}]9;${title} · ${notice}${BEL}`
      : `${ESC}]777;notify;${title.replaceAll(";", ",")};${notice}${BEL}`
  return tmux ? `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ESC}\\` : sequence
}

/** What a failed notification command logs. */
const failure = (error: CommandFailed | CommandNotRun | CommandTimedOut): string => {
  switch (error._tag) {
    case "CommandFailed":
      return `exited with ${error.exitCode}${error.stderr.trim() === "" ? "" : `: ${error.stderr.trim()}`}`
    case "CommandTimedOut":
      return `took longer than ${Duration.format(notifyLimit)}`
    case "CommandNotRun":
      return error.reason
  }
}

/** What the Notifier needs from outside: where it runs, and how it runs a command and writes. */
export interface Environment extends Where {
  readonly run: (
    command: Command,
  ) => Effect.Effect<unknown, CommandFailed | CommandNotRun | CommandTimedOut>
  /** Writes text to the terminal (stdout). */
  readonly write: (text: string) => Effect.Effect<void, Error>
}

/**
 * The Notifier for AppConfig's repository and `notify`, in `environment`. Notices still being
 * shown when its scope closes have up to `notifyLimit` to finish, so the run's last one isn't lost
 * as tutti exits.
 */
export const make = Effect.fn("Notifier.make")(function* (environment: Environment) {
  const config = yield* AppConfig
  const log = yield* Log
  const route: Route = config.notify ? routeOf(environment) : { _tag: "None" }
  const title = sanitizeLine(basename(config.repo))
  const tmux = set(environment.env, "TMUX")
  const fibers = yield* FiberSet.make()
  // Added after the set, so it runs before the set's own finalizer interrupts what is left.
  yield* Effect.addFinalizer(() =>
    FiberSet.awaitEmpty(fibers).pipe(Effect.timeoutOption(notifyLimit), Effect.asVoid),
  )

  const show = (notice: string): Effect.Effect<void> => {
    switch (route._tag) {
      case "None":
        return Effect.void
      case "Desktop": {
        const args =
          route.command === "osascript"
            ? osascriptArgs(title, notice)
            : notifySendArgs(title, notice)
        return environment.run({ command: route.command, args, timeLimit: notifyLimit }).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            log.write(tagged(Tag.notifyFailed)`${route.command} ${failure(error)}`),
          ),
        )
      }
      case "Osc":
        return environment
          .write(oscSequence(route.osc, title, notice, tmux))
          .pipe(
            Effect.catch((error) =>
              log.write(tagged(Tag.notifyFailed)`OSC ${route.osc}: ${error.message}`),
            ),
          )
    }
  }

  return Notifier.of({
    notify: (notice) => {
      const text = sanitizeLine(notice).trim()
      return route._tag === "None" || text === ""
        ? Effect.void
        : FiberSet.run(fibers, show(text)).pipe(Effect.asVoid)
    },
  })
})

/** The live layer: this process's platform, environment, PATH and stdout. */
export const layer: Layer.Layer<
  Notifier,
  never,
  AppConfig | Log | Tty | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const tty = yield* Tty
    const context = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
    >()
    return yield* make({
      platform: process.platform,
      env: (name) => process.env[name],
      installed: installedOnPath,
      tty,
      run: (command) => run(command).pipe(Effect.provideContext(context)),
      write: (text) =>
        Effect.try({
          try: () => {
            process.stdout.write(text)
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
    })
  }),
)
