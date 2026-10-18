// Copying selected text (§ 7.3): the copier chosen per platform and session, the OSC 52 sequence
// the renderer writes, the desktop's command run with the text and what it forks left running, and
// a drag that copies on release with a toast.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { createCliRenderer } from "@opentui/core"
import { Effect } from "effect"
import fc from "fast-check"
import { createElement } from "react"
import { makeCommands } from "../src/run/commands.ts"
import { emptyView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import {
  type Clipboard,
  type Copier,
  copiedToast,
  copierOf,
  copyFailedToast,
  copyText,
  makeClipboard,
  rendererOsc52,
  runCopy,
  type Where,
} from "../src/ui/clipboard.ts"
import { Line, seg, selectionLookOf } from "../src/ui/line.tsx"
import { rendererConfig } from "../src/ui/renderer.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const where = (
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string>> = {},
  installed: ReadonlyArray<string> = [],
): Where => ({
  platform,
  env: (name) => env[name],
  installed: (command) => installed.includes(command),
})

const pbcopy: Copier = { _tag: "Command", command: "pbcopy", args: [] }
const wlCopy: Copier = { _tag: "Command", command: "wl-copy", args: [] }
const xclip: Copier = { _tag: "Command", command: "xclip", args: ["-selection", "clipboard"] }
const osc52: Copier = { _tag: "Osc52" }

const wayland = { WAYLAND_DISPLAY: "wayland-0" }
const x11 = { DISPLAY: ":0" }

describe("the copier", () => {
  test("is pbcopy on macOS in a local session", () => {
    expect(copierOf(where("darwin"))).toEqual(pbcopy)
  })

  test("is OSC 52 on macOS over ssh, from SSH_CONNECTION or SSH_TTY", () => {
    expect(copierOf(where("darwin", { SSH_CONNECTION: "10.0.0.2 51234 10.0.0.1 22" }))).toEqual(
      osc52,
    )
    expect(copierOf(where("darwin", { SSH_TTY: "/dev/ttys004" }))).toEqual(osc52)
  })

  test("takes an empty ssh variable for a local session", () => {
    expect(copierOf(where("darwin", { SSH_CONNECTION: "", SSH_TTY: "" }))).toEqual(pbcopy)
  })

  test("is wl-copy on Linux in a Wayland session with it installed", () => {
    expect(copierOf(where("linux", { ...wayland, ...x11 }, ["wl-copy", "xclip"]))).toEqual(wlCopy)
  })

  test("is xclip on Linux in an X session with it installed", () => {
    expect(copierOf(where("linux", x11, ["xclip"]))).toEqual(xclip)
    expect(copierOf(where("linux", { ...wayland, ...x11 }, ["xclip"]))).toEqual(xclip)
  })

  test("is OSC 52 on Linux with neither installed, or no display to copy to", () => {
    expect(copierOf(where("linux", { ...wayland, ...x11 }))).toEqual(osc52)
    expect(copierOf(where("linux", {}, ["wl-copy", "xclip"]))).toEqual(osc52)
  })

  test("is OSC 52 on Linux over ssh, whatever is installed", () => {
    expect(
      copierOf(where("linux", { ...x11, SSH_TTY: "/dev/pts/3" }, ["wl-copy", "xclip"])),
    ).toEqual(osc52)
  })

  test("is OSC 52 on any other platform", () => {
    expect(copierOf(where("freebsd", x11, ["xclip"]))).toEqual(osc52)
    expect(copierOf(where("win32"))).toEqual(osc52)
  })
})

describe("the text copied", () => {
  test("drops the spaces after each line, which padded lines and frames leave", () => {
    expect(copyText("tutti-1  merged   \n  tutti-2 \t\nend")).toBe(
      "tutti-1  merged\n  tutti-2\nend",
    )
  })

  test("is nothing for a selection of spaces", () => {
    expect(copyText("")).toBe("")
    expect(copyText("   \n  ")).toBe("")
  })

  test("never ends a line in a space, and keeps every line's text", () => {
    fc.assert(
      fc.property(fc.string(), (selected) => {
        const text = copyText(selected)
        expect(/[ \t]$/m.test(text)).toBe(false)
        if (text !== "") {
          expect(text.split("\n").length).toBe(selected.split("\n").length)
        }
      }),
    )
  })
})

/** A renderer drawing to a terminal that is a buffer, and what it has written so far. */
const bufferedRenderer = async () => {
  const written: Array<string> = []
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin })
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        written.push(Buffer.from(chunk).toString("latin1"))
        done()
      },
    }),
    { isTTY: true, columns: 40, rows: 10 },
  )
  const renderer = await createCliRenderer({
    ...rendererConfig,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  return { renderer, written }
}

describe("OSC 52", () => {
  test("writes the text, base64 of its UTF-8, to the system clipboard", async () => {
    const { renderer, written } = await bufferedRenderer()
    try {
      written.length = 0
      const text = "tutti-nrg.5.7 ✓ merged"
      const clipboard = await Effect.runPromise(
        makeClipboard(osc52, rendererOsc52(renderer)).pipe(Effect.provide(BunServices.layer)),
      )
      expect(await clipboard.copy(text)).toBe(true)
      await Bun.sleep(50)
      const base64 = Buffer.from(text, "utf8").toString("base64")
      expect(written.join("")).toContain(`\x1b]52;c;${base64}\x1b\\`)
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  })

  test("says it couldn't copy when the renderer can't write it", () => {
    expect(rendererOsc52({ copyToClipboardOSC52: () => false })("text")).toBe(false)
    const throwing = {
      copyToClipboardOSC52: (): boolean => {
        throw new Error("ot_session_clipboard failed: InvalidPhase")
      },
    }
    expect(rendererOsc52(throwing)("text")).toBe(false)
  })
})

const runCopyWith = (command: string, args: ReadonlyArray<string>, text: string) =>
  Effect.runPromise(runCopy({ command, args }, text).pipe(Effect.provide(BunServices.layer)))

describe("the desktop's command", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "tutti-clipboard-"))

  test("takes the text on its stdin", async () => {
    const out = join(dir(), "copied")
    expect(await runCopyWith("sh", ["-c", `cat > "${out}"`], "line one\nline ✓")).toBe(true)
    expect(readFileSync(out, "utf8")).toBe("line one\nline ✓")
  })

  test("leaves what it forked to serve the clipboard running once it exits", async () => {
    const out = join(dir(), "served")
    const script = `cat > /dev/null; (sleep 0.3; echo served > "${out}") & exit 0`
    expect(await runCopyWith("sh", ["-c", script], "text")).toBe(true)
    await Bun.sleep(800)
    expect(existsSync(out)).toBe(true)
  })

  test("couldn't copy when it fails or can't be started", async () => {
    expect(await runCopyWith("sh", ["-c", "cat > /dev/null; exit 3"], "text")).toBe(false)
    expect(await runCopyWith("tutti-no-such-copy-command", [], "text")).toBe(false)
  })
})

describe("the selection's colours", () => {
  const themeOf = (appearance: Appearance, noColor = false) =>
    makeTheme(orchestra, { appearance, depth: "truecolor", noColor })

  test("are the selection and selectionText roles", () => {
    const theme = themeOf("dark")
    expect(selectionLookOf(theme)).toEqual({
      selectionBg: theme.rgba("selection"),
      selectionFg: theme.rgba("selectionText"),
    })
  })

  test("are OpenTUI's own under NO_COLOR, so the selection still shows", () => {
    expect(selectionLookOf(themeOf("dark", true))).toEqual({})
  })
})

/** A Clipboard that copies by answering `answer`, and what it was asked to copy. */
const fakeClipboard = (answer: boolean | "throw" = true) => {
  const copied: Array<string> = []
  const clipboard: Clipboard = {
    copy: (text) => {
      copied.push(text)
      return answer === "throw" ? Promise.reject(new Error("broken")) : Promise.resolve(answer)
    },
  }
  return { clipboard, copied }
}

const shellOf = (clipboard?: Clipboard): ShellValue => ({
  view: external(emptyView),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf: (appearance) => makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false }),
  now: () => 0,
  ...(clipboard === undefined ? {} : { clipboard }),
})

/** Two lines of text, the first padded with spaces as the dashboard's are. */
const text = createElement(
  "box",
  { flexDirection: "column" },
  createElement(Line, { segments: [seg("tutti-1 merged into main   ")] }),
  createElement(Line, { segments: [seg("tutti-2 set aside")] }),
)

/** The text under Root, with `clipboard` in the shell. */
const onText = (clipboard: Clipboard | undefined, body: (rendered: Rendered) => Promise<void>) =>
  withRender(
    createElement(Root, { value: shellOf(clipboard) }, text),
    { width: 60, height: 16 },
    body,
  )

const frameOf = async (rendered: Rendered) => (await rendered.capture()).chars

describe("a drag", () => {
  test("copies what it selects on release, with a toast", async () => {
    const { clipboard, copied } = fakeClipboard()
    await onText(clipboard, async (rendered) => {
      await rendered.input((setup) => setup.mockMouse.drag(0, 0, 14, 0))
      await Bun.sleep(20)
      expect(copied).toEqual(["tutti-1 merged"])
      expect(await frameOf(rendered)).toContain(copiedToast)
    })
  })

  test("over two lines copies both, without the spaces after them", async () => {
    const { clipboard, copied } = fakeClipboard()
    await onText(clipboard, async (rendered) => {
      await rendered.input((setup) => setup.mockMouse.drag(0, 0, 7, 1))
      await Bun.sleep(20)
      expect(copied).toEqual(["tutti-1 merged into main\ntutti-2"])
    })
  })

  test("toasts couldn't copy when the copy fails", async () => {
    for (const answer of [false, "throw"] as const) {
      const { clipboard } = fakeClipboard(answer)
      await onText(clipboard, async (rendered) => {
        await rendered.input((setup) => setup.mockMouse.drag(0, 0, 14, 0))
        await Bun.sleep(20)
        const frame = await frameOf(rendered)
        expect(frame).toContain(copyFailedToast)
        expect(frame).not.toContain(` ${copiedToast} `)
      })
    }
  })

  test("draws what it selects in the selection roles", async () => {
    const { clipboard } = fakeClipboard()
    await onText(clipboard, async (rendered) => {
      await rendered.input(async (setup) => {
        await setup.mockMouse.pressDown(0, 0)
        await setup.mockMouse.moveTo(7, 0)
      })
      const { spans } = await rendered.capture()
      const selection = makeTheme(orchestra, {
        appearance: "dark",
        depth: "truecolor",
        noColor: false,
      }).rgba("selection")
      const first = spans.lines[0]?.spans.find((span) => span.text.startsWith("tutti"))
      expect(first?.bg.toInts()).toEqual(selection.toInts())
    })
  })

  test("copies nothing for a click", async () => {
    const { clipboard, copied } = fakeClipboard()
    await onText(clipboard, async (rendered) => {
      await rendered.input((setup) => setup.mockMouse.click(3, 0))
      await Bun.sleep(20)
      expect(copied).toEqual([])
      expect(await frameOf(rendered)).not.toContain(copiedToast)
    })
  })

  test("copies nothing without a clipboard", async () => {
    await onText(undefined, async (rendered) => {
      await rendered.input((setup) => setup.mockMouse.drag(0, 0, 14, 0))
      await Bun.sleep(20)
      expect(await frameOf(rendered)).not.toContain(copiedToast)
    })
  })
})
