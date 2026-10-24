// Opening an MCP URL elicitation's URL (§ 4.5): its card's Open URL opens the URL in your browser,
// then answers Accept. The URL comes from an MCP server, so only an http or https one is opened.
//
// In a local session the URL is opened with the desktop's command: `open` on macOS, and on Linux
// `xdg-open` in a Wayland or X session, when it is installed. Over ssh, where neither would reach
// your browser, or where the URL can't be opened, it is copied instead (clipboard.ts), with a toast
// that says so; when it can't be copied either, the toast says that, and Accept isn't sent: the
// request stays open, to open the URL yourself from its card or decline it.
//
// The command is run detached, a process group of its own, which is left running once the time to
// open has passed: `xdg-open` may wait on the browser it started, which would go with its group.
import { Duration, Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { installedOnPath } from "../services/onPath.ts"
import { overSshOf } from "../services/Tty.ts"
import type { Clipboard, Where } from "./clipboard.ts"

/** What opening the URL in the browser toasts. */
export const openedToast = "opened the URL in your browser"

/** What copying the URL instead toasts. */
export const urlCopiedToast = "copied the URL: open it in your browser"

/** What a URL neither opened nor copied toasts. */
export const urlFailedToast = "couldn't open or copy the URL"

/** How long the desktop's command may take to open the URL, before it is left running. */
export const openLimit: Duration.Duration = Duration.seconds(5)

/** The desktop's command that opens a URL in the browser. */
export type OpenCommand = "open" | "xdg-open"

/** How a URL is opened: with the desktop's command, or copied. */
export type Opener =
  | { readonly _tag: "Command"; readonly command: OpenCommand }
  | { readonly _tag: "Copy" }

const set = (env: Where["env"], name: string): boolean => {
  const value = env(name)
  return value !== undefined && value !== ""
}

/**
 * How a URL is opened where tutti runs: `open` in a local session on macOS; on Linux, locally,
 * `xdg-open` in a Wayland or X session, when it is installed; otherwise copied.
 */
export const openerOf = (where: Where): Opener => {
  if (!overSshOf(where.env)) {
    if (where.platform === "darwin") return { _tag: "Command", command: "open" }
    const display = set(where.env, "WAYLAND_DISPLAY") || set(where.env, "DISPLAY")
    if (where.platform === "linux" && display && where.installed("xdg-open")) {
      return { _tag: "Command", command: "xdg-open" }
    }
  }
  return { _tag: "Copy" }
}

/** Whether `url` is one the browser is asked to open: an http or https URL. */
export const opensInBrowser = (url: string): boolean => {
  if (!URL.canParse(url)) return false
  const protocol = new URL(url).protocol
  return protocol === "http:" || protocol === "https:"
}

/**
 * Runs `command` with `url`: true once it has exited with 0, or is still running at `limit`
 * (left running); false when it can't be started or exits with another code.
 */
export const runOpen = (
  command: { readonly command: string; readonly args?: ReadonlyArray<string> },
  url: string,
  { limit = openLimit }: { readonly limit?: Duration.Duration } = {},
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(command.command, [...(command.args ?? []), url], {
          extendEnv: true,
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      const code = yield* handle.exitCode.pipe(Effect.timeoutOption(limit))
      if (code._tag === "Some" && code.value !== 0) return false
      // Left out of the spawner's clean-up, which would kill the group as the scope closes.
      yield* handle.unref
      return true
    }),
  ).pipe(Effect.orElseSucceed(() => false))

/** How a URL was handed to you: opened in the browser, copied, or neither. */
export type Opened = "opened" | "copied" | "failed"

/** Opens URLs in the browser, or copies them. */
export interface UrlOpener {
  readonly open: (url: string) => Promise<Opened>
}

/**
 * The UrlOpener that opens by `opener`, with the caller's spawner, and copies with `clipboard`: a
 * URL its command can't open, one not http or https, or every URL for Copy.
 */
export const makeUrlOpener = (
  opener: Opener,
  clipboard: Clipboard | undefined,
): Effect.Effect<UrlOpener, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.map(Effect.context<ChildProcessSpawner.ChildProcessSpawner>(), (context) => {
    const run = Effect.runPromiseWith(context)
    const copy = (url: string): Promise<Opened> =>
      clipboard === undefined
        ? Promise.resolve("failed")
        : clipboard.copy(url).then(
            (copied) => (copied ? "copied" : "failed"),
            () => "failed",
          )
    return {
      open: async (url) => {
        if (opener._tag === "Command" && opensInBrowser(url)) {
          if (await run(runOpen(opener, url))) return "opened"
        }
        return copy(url)
      },
    }
  })

/** The UrlOpener of this process: its platform, environment and PATH, copying with `clipboard`. */
export const liveUrlOpener = (
  clipboard: Clipboard,
): Effect.Effect<UrlOpener, never, ChildProcessSpawner.ChildProcessSpawner> =>
  makeUrlOpener(
    openerOf({
      platform: process.platform,
      env: (name) => process.env[name],
      installed: installedOnPath,
    }),
    clipboard,
  )
