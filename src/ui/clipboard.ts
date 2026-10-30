// Copying selected text (§ 7.3). A drag selects text with OpenTUI's selection, drawn in the
// `selection` and `selectionText` roles (§ 7.11); on release the text selected is copied, with a
// toast: `copied`, or `couldn't copy` when it fails. A click on a ticket's ID in the tickets table
// copies the ID (useCopyOnClick, tutti-vkuj), its cell saying `✓ copied` for a moment, and toasts
// only `couldn't copy`.
//
// How it is copied depends on where tutti runs. In a local session it is the desktop's own
// clipboard: `pbcopy` on macOS, and on Linux `wl-copy` in a Wayland session or `xclip` in an X one,
// when it is installed. Otherwise, over ssh or where neither is there, it is OSC 52, which OpenTUI's
// renderer writes to the terminal in order with its frames, so that copying works over ssh.
// Terminal.app doesn't support OSC 52, and tmux passes it on only with `set-clipboard on`. Over
// ssh the desktop's command would copy on the remote machine, so OSC 52 is used instead.
//
// `wl-copy` and `xclip` fork a process that stays to hand the text to whoever pastes it. The
// command is started detached, a process group of its own, and once its leader has exited the
// group is left running, unlike exec's commands (src/services/exec.ts), whose groups go with their
// leader: the clipboard would go with it.
import type { CliRenderer, Selection } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { Duration, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { useCallback, useContext, useEffect, useRef, useState } from "react"
import { installedOnPath } from "../services/onPath.ts"
import type { Env } from "../services/Tty.ts"
import type { ToastStore } from "./Toasts.tsx"
import { ShellContext, useInterval } from "./useRunView.ts"

/** What a copy toasts. */
export const copiedToast = "copied"

/** What a copy that failed toasts. */
export const copyFailedToast = "couldn't copy"

/** How long what a click copied is marked copied, in ms (useCopyOnClick). */
export const copiedLife = 1500

/** How long the desktop's command may take to take the text, before it is stopped. */
export const copyLimit: Duration.Duration = Duration.seconds(5)

/** The desktop's own clipboard command. */
export type CopyCommand = "pbcopy" | "wl-copy" | "xclip"

/** How text is copied: through the desktop's command, its text on stdin, or by OSC 52. */
export type Copier =
  | {
      readonly _tag: "Command"
      readonly command: CopyCommand
      readonly args: ReadonlyArray<string>
    }
  | { readonly _tag: "Osc52" }

/** What the environment tells of where tutti runs. */
export interface Where {
  readonly platform: NodeJS.Platform
  readonly env: Env
  /** Whether the session is over ssh, as Tty read it (TtyValue.overSsh). */
  readonly overSsh: boolean
  /** Whether a command of this name is on the PATH. */
  readonly installed: (command: string) => boolean
}

const set = (env: Where["env"], name: string): boolean => {
  const value = env(name)
  return value !== undefined && value !== ""
}

/**
 * How text is copied where tutti runs: `pbcopy` in a local session on macOS; on Linux, locally,
 * `wl-copy` in a Wayland session (WAYLAND_DISPLAY) or `xclip` in an X one (DISPLAY), when it is
 * installed; otherwise OSC 52.
 */
export const copierOf = (where: Where): Copier => {
  if (!where.overSsh) {
    if (where.platform === "darwin") return { _tag: "Command", command: "pbcopy", args: [] }
    if (where.platform === "linux") {
      if (set(where.env, "WAYLAND_DISPLAY") && where.installed("wl-copy")) {
        return { _tag: "Command", command: "wl-copy", args: [] }
      }
      if (set(where.env, "DISPLAY") && where.installed("xclip")) {
        return { _tag: "Command", command: "xclip", args: ["-selection", "clipboard"] }
      }
    }
  }
  return { _tag: "Osc52" }
}

/**
 * The text a selection copies: each line without the spaces after it, which the dashboard's padded
 * lines and frames leave; empty when nothing but spaces was selected.
 */
export const copyText = (selected: string): string => {
  const text = selected.replace(/[ \t]+$/gm, "")
  return text.trim() === "" ? "" : text
}

/**
 * Runs `command` with `text` on its stdin: true once it has exited with 0, false when it can't be
 * started, exits with another code or runs past `copyLimit` (its group is then killed). What it
 * leaves running to serve the clipboard stays.
 */
export const runCopy = (
  command: { readonly command: string; readonly args: ReadonlyArray<string> },
  text: string,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          extendEnv: true,
          detached: true,
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(1),
          stdin: Stream.make(new TextEncoder().encode(text)),
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      const code = yield* handle.exitCode.pipe(Effect.timeout(copyLimit))
      if (code !== 0) return false
      // Left out of the spawner's clean-up, which would kill the group as the scope closes.
      yield* handle.unref
      return true
    }),
  ).pipe(Effect.orElseSucceed(() => false))

/** Copies text, with true when it was copied. */
export interface Clipboard {
  readonly copy: (text: string) => Promise<boolean>
}

/**
 * The Clipboard that copies by `copier`: its command, run with the caller's spawner, or `osc52`,
 * which writes the sequence and says whether it could.
 */
export const makeClipboard = (
  copier: Copier,
  osc52: (text: string) => boolean,
): Effect.Effect<Clipboard, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.map(Effect.context<ChildProcessSpawner.ChildProcessSpawner>(), (context) => {
    const run = Effect.runPromiseWith(context)
    return {
      copy: (text) =>
        copier._tag === "Osc52" ? Promise.resolve(osc52(text)) : run(runCopy(copier, text)),
    }
  })

/** OSC 52 through `renderer`: false when the terminal is known not to take it, or it can't write. */
export const rendererOsc52 =
  (renderer: Pick<CliRenderer, "copyToClipboardOSC52">) =>
  (text: string): boolean => {
    try {
      return renderer.copyToClipboardOSC52(text)
    } catch {
      return false
    }
  }

/**
 * The Clipboard of this process: its platform, environment and PATH, whether it runs over ssh
 * (Tty's `overSsh`), and `renderer`'s OSC 52.
 */
export const liveClipboard = (
  renderer: CliRenderer,
  overSsh: boolean,
): Effect.Effect<Clipboard, never, ChildProcessSpawner.ChildProcessSpawner> =>
  makeClipboard(
    copierOf({
      platform: process.platform,
      env: (name) => process.env[name],
      overSsh,
      installed: installedOnPath,
    }),
    rendererOsc52(renderer),
  )

/**
 * Copies what a drag selects, once it is released, with the shell's Clipboard, toasting in
 * `toasts` whether it was copied. Nothing without a Clipboard, or for a selection of nothing (a
 * click).
 */
export const useCopyOnSelect = (toasts: ToastStore): void => {
  const renderer = useRenderer()
  const clipboard = useContext(ShellContext)?.clipboard
  useEffect(() => {
    if (clipboard === undefined) return
    let mounted = true
    const toast = (copied: boolean) => {
      if (!mounted) return
      if (copied) toasts.show(copiedToast)
      else toasts.show(copyFailedToast, { failure: true })
    }
    const onSelection = (selection: Selection) => {
      const text = copyText(selection.getSelectedText())
      if (text === "") return
      clipboard.copy(text).then(toast, () => toast(false))
    }
    renderer.on("selection", onSelection)
    return () => {
      mounted = false
      renderer.off("selection", onSelection)
    }
  }, [renderer, clipboard, toasts])
}

/** What a click copies, and what it copied last, marked for `copiedLife` ms (useCopyOnClick). */
export interface CopyOnClick {
  /** What was copied, while it is marked copied; null once the mark has gone, or a copy failed. */
  readonly copied: string | null
  /** Copies `text`; to be called on the click's release, before OpenTUI ends its selection. */
  readonly copy: (text: string) => void
}

/**
 * Copies what a click names, a ticket's ID in the tickets table (tutti-vkuj), with the shell's
 * Clipboard: once copied it is `copied` for `copiedLife` ms, on the shell's intervals, a copy again
 * starting them over, and nothing is toasted; a copy that fails toasts `couldn't copy` in `toasts`,
 * as a drag's does. The click's selection is cleared, so that a second click soon after selects no
 * word (OpenTUI's double click) for useCopyOnSelect to copy over it. Nothing without a Clipboard.
 */
export const useCopyOnClick = (toasts: ToastStore): CopyOnClick => {
  const renderer = useRenderer()
  const clipboard = useContext(ShellContext)?.clipboard
  const interval = useInterval()
  const [copied, setCopied] = useState<string | null>(null)
  const stopMark = useRef<(() => void) | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stopMark.current?.()
      stopMark.current = null
    }
  }, [])
  const copy = useCallback(
    (text: string) => {
      renderer.clearSelection()
      if (clipboard === undefined) return
      const done = (ok: boolean) => {
        if (!mounted.current) return
        stopMark.current?.()
        stopMark.current = null
        setCopied(ok ? text : null)
        if (!ok) return toasts.show(copyFailedToast, { failure: true })
        const stop = interval(() => {
          stop()
          if (stopMark.current === stop) stopMark.current = null
          setCopied(null)
        }, copiedLife)
        stopMark.current = stop
      }
      clipboard.copy(text).then(done, () => done(false))
    },
    [renderer, clipboard, interval, toasts],
  )
  return { copied, copy }
}
