// Opening an MCP URL elicitation's URL (§ 4.5): the opener chosen per platform and session, which
// URLs the browser is asked to open, the desktop's command run with the URL, copying when it can't
// open, and Open URL on a card, which opens the URL with a toast before it answers Accept.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Queue } from "effect"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { settle, urlToOpen } from "../src/ui/attentionKeys.ts"
import type { Clipboard, Where } from "../src/ui/clipboard.ts"
import {
  makeUrlOpener,
  type Opened,
  type Opener,
  openedToast,
  openerOf,
  opensInBrowser,
  runOpen,
  type UrlOpener,
  urlCopiedToast,
  urlFailedToast,
} from "../src/ui/openUrl.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const where = (
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string>> = {},
  installed: ReadonlyArray<string> = [],
): Where => ({
  platform,
  env: (name) => env[name],
  overSsh: false,
  installed: (command) => installed.includes(command),
})

/** `local` over ssh, as Tty reads it. */
const overSsh = (local: Where): Where => ({ ...local, overSsh: true })

const open: Opener = { _tag: "Command", command: "open" }
const xdgOpen: Opener = { _tag: "Command", command: "xdg-open" }
const copy: Opener = { _tag: "Copy" }

describe("the opener", () => {
  test("is open on macOS in a local session", () => {
    expect(openerOf(where("darwin"))).toEqual(open)
  })

  test("copies over ssh", () => {
    expect(openerOf(overSsh(where("darwin")))).toEqual(copy)
    expect(openerOf(overSsh(where("linux", { DISPLAY: ":0" }, ["xdg-open"])))).toEqual(copy)
  })

  test("takes ssh from Tty's overSsh, not the ssh variables", () => {
    expect(openerOf(where("darwin", { SSH_TTY: "/dev/ttys004" }))).toEqual(open)
  })

  test("is xdg-open on Linux in a Wayland or X session with it installed", () => {
    expect(openerOf(where("linux", { WAYLAND_DISPLAY: "wayland-0" }, ["xdg-open"]))).toEqual(
      xdgOpen,
    )
    expect(openerOf(where("linux", { DISPLAY: ":0" }, ["xdg-open"]))).toEqual(xdgOpen)
  })

  test("copies on Linux without xdg-open or a display, and on any other platform", () => {
    expect(openerOf(where("linux", { DISPLAY: ":0" }))).toEqual(copy)
    expect(openerOf(where("linux", { DISPLAY: "" }, ["xdg-open"]))).toEqual(copy)
    expect(openerOf(where("freebsd", { DISPLAY: ":0" }, ["xdg-open"]))).toEqual(copy)
    expect(openerOf(where("win32"))).toEqual(copy)
  })
})

describe("the URLs opened", () => {
  test("are http and https ones", () => {
    expect(opensInBrowser("https://docs.example/login?next=%2F")).toBe(true)
    expect(opensInBrowser("http://localhost:8080/callback")).toBe(true)
    expect(opensInBrowser("HTTPS://docs.example/")).toBe(true)
  })

  test("are never a file, an app's scheme, a flag or no URL at all", () => {
    expect(opensInBrowser("file:///etc/passwd")).toBe(false)
    expect(opensInBrowser("javascript:alert(1)")).toBe(false)
    expect(opensInBrowser("x-apple.systempreferences:com.apple.preference")).toBe(false)
    expect(opensInBrowser("-a Calculator")).toBe(false)
    expect(opensInBrowser("docs.example/login")).toBe(false)
    expect(opensInBrowser("")).toBe(false)
  })

  // The URL as the parser reads it: without the spaces and control characters before it, nor any
  // tab or line break.
  const asParsed = (url: string) => {
    let from = 0
    while (from < url.length && url.charCodeAt(from) <= 0x20) from += 1
    return url.slice(from).replace(/[\t\n\r]/g, "")
  }

  test("never one an MCP server sends that isn't http or https", () => {
    fc.assert(
      fc.property(fc.string(), (url) => {
        fc.pre(!/^https?:/i.test(asParsed(url)))
        expect(opensInBrowser(url)).toBe(false)
      }),
    )
  })
})

const run = <A,>(effect: Effect.Effect<A, never, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const dir = () => mkdtempSync(join(tmpdir(), "tutti-open-url-"))

describe("the desktop's command", () => {
  test("takes the URL as one argument", async () => {
    const out = join(dir(), "opened")
    const url = "https://docs.example/login?a=1&b='two words'"
    const script = `printf '%s' "$0" > "${out}"`
    expect(await run(runOpen({ command: "sh", args: ["-c", script] }, url))).toBe(true)
    expect(readFileSync(out, "utf8")).toBe(url)
  })

  test("couldn't open when it fails or can't be started", async () => {
    expect(await run(runOpen({ command: "sh", args: ["-c", "exit 3"] }, "https://x.test"))).toBe(
      false,
    )
    expect(await run(runOpen({ command: "tutti-no-such-open-command" }, "https://x.test"))).toBe(
      false,
    )
  })

  test("is left running, as opened, once the time to open has passed", async () => {
    const out = join(dir(), "browser")
    const script = `sleep 0.4; echo still > "${out}"`
    const opening = runOpen({ command: "sh", args: ["-c", script] }, "https://x.test", {
      limit: Duration.millis(100),
    })
    expect(await run(opening)).toBe(true)
    await Bun.sleep(900)
    expect(existsSync(out)).toBe(true)
  })
})

/** A Clipboard that keeps what it copies, and copies when `works`. */
const clipboardOf = (works: boolean) => {
  const copied: Array<string> = []
  const clipboard: Clipboard = {
    copy: (text) => {
      copied.push(text)
      return Promise.resolve(works)
    },
  }
  return { clipboard, copied }
}

// A command run as the desktop's would be: `sh -c <script> <url>`.
const shOpener = (script: string) =>
  ({ _tag: "Command", command: "sh", args: ["-c", script] }) as unknown as Opener

describe("a URL", () => {
  test("is opened by the desktop's command, not copied", async () => {
    const { clipboard, copied } = clipboardOf(true)
    const opener = await run(makeUrlOpener(shOpener("exit 0"), clipboard))
    expect(await opener.open("https://docs.example/login")).toBe("opened")
    expect(copied).toEqual([])
  })

  test("is copied when the command can't open it", async () => {
    const { clipboard, copied } = clipboardOf(true)
    const opener = await run(makeUrlOpener(shOpener("exit 1"), clipboard))
    expect(await opener.open("https://docs.example/login")).toBe("copied")
    expect(copied).toEqual(["https://docs.example/login"])
  })

  test("not http or https is copied, never given to the command", async () => {
    const out = join(dir(), "ran")
    const { clipboard, copied } = clipboardOf(true)
    const opener = await run(makeUrlOpener(shOpener(`touch "${out}"`), clipboard))
    expect(await opener.open("file:///etc/passwd")).toBe("copied")
    expect(copied).toEqual(["file:///etc/passwd"])
    expect(existsSync(out)).toBe(false)
  })

  test("is copied over ssh, and fails when it can't be copied", async () => {
    const works = clipboardOf(true)
    expect(await (await run(makeUrlOpener(copy, works.clipboard))).open("https://x.test")).toBe(
      "copied",
    )
    const fails = clipboardOf(false)
    expect(await (await run(makeUrlOpener(copy, fails.clipboard))).open("https://x.test")).toBe(
      "failed",
    )
    expect(await (await run(makeUrlOpener(copy, undefined))).open("https://x.test")).toBe("failed")
  })
})

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const elicitation = (id: string, mode: "form" | "url"): AttentionRequest => ({
  id,
  ticket: "t-1",
  kind: {
    _tag: "Elicitation",
    server: "docs",
    message: "Log in to the docs server",
    mode,
    ...(mode === "url" ? { url: "https://docs.example/login" } : {}),
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

describe("the URL Accept opens", () => {
  test("is a URL elicitation's, for Accept only", () => {
    expect(urlToOpen(elicitation("e1", "url"), { _tag: "Accept" })).toBe(
      "https://docs.example/login",
    )
    expect(urlToOpen(elicitation("e1", "url"), { _tag: "Decline" })).toBeUndefined()
    expect(urlToOpen(elicitation("e1", "form"), { _tag: "Accept" })).toBeUndefined()
  })
})

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const viewOf = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  project({
    ledger: {
      tickets: new Map([
        [
          "t-1",
          {
            ticket: "t-1",
            title: "Title of t-1",
            phase: TicketPhase.Working(),
            since: began,
            worker: 1,
            row: 0,
            rechecking: false,
            steered: false,
            lastMessage: null,
            tallies: emptyTallies,
          },
        ],
      ]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map([["t-1", WS.Idle({ at: began })]]),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

/** A UrlOpener whose every open waits for the test to say how it went. */
const heldOpener = () => {
  const urls: Array<string> = []
  let finish: (how: Opened) => void = () => {}
  const opener: UrlOpener = {
    open: (url) => {
      urls.push(url)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  }
  return { opener, urls, finish: (how: Opened) => finish(how) }
}

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const linesOf = async (rendered: Rendered) =>
  (await rendered.capture()).chars.split("\n").map((line) => line.trimEnd())

/**
 * The dashboard over a URL elicitation, Open URL pressed once it has settled, with `opener`; runs
 * `body` with the view, the commands sent and the rendered tree.
 */
const pressOpenUrl = async (
  opener: UrlOpener | undefined,
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(viewOf([elicitation("e1", "url")]))
  const commands = Effect.runSync(makeCommands)
  let at = began
  const value = {
    view,
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => at,
    ...(opener === undefined ? {} : { urlOpener: opener }),
  }
  await withRender(<Root value={value} />, { width: 80, height: 40 }, async (rendered) => {
    at += settle
    await rendered.input(async (setup) => {
      setup.mockInput.pressTab()
      setup.mockInput.pressEnter()
    })
    await body({ view, commands, rendered })
  })
}

const accept = UiCommand.Answer({ requestId: "e1", answer: { _tag: "Accept" } })

describe("Open URL", () => {
  test("opens the URL, toasts it, then answers Accept", async () => {
    const held = heldOpener()
    await pressOpenUrl(held.opener, async ({ commands, rendered }) => {
      expect(held.urls).toEqual(["https://docs.example/login"])
      expect(taken(commands)).toEqual([])
      await rendered.input(() => held.finish("opened"))
      expect(taken(commands)).toEqual([accept])
      expect((await linesOf(rendered)).some((line) => line.includes(openedToast))).toBe(true)
    })
  })

  test("over ssh copies the URL, toasts it, then answers Accept", async () => {
    const held = heldOpener()
    await pressOpenUrl(held.opener, async ({ commands, rendered }) => {
      await rendered.input(() => held.finish("copied"))
      expect(taken(commands)).toEqual([accept])
      expect((await linesOf(rendered)).some((line) => line.includes(urlCopiedToast))).toBe(true)
    })
  })

  test("leaves the request open, with a toast, when the URL was neither opened nor copied", async () => {
    const held = heldOpener()
    await pressOpenUrl(held.opener, async ({ commands, rendered }) => {
      await rendered.input(() => held.finish("failed"))
      expect(taken(commands)).toEqual([])
      expect((await linesOf(rendered)).some((line) => line.includes(urlFailedToast))).toBe(true)
    })
  })

  test("doesn't answer a request no longer open once the URL is opened", async () => {
    const held = heldOpener()
    await pressOpenUrl(held.opener, async ({ view, commands, rendered }) => {
      await rendered.input(() => {
        view.set(viewOf([]))
        held.finish("opened")
      })
      expect(taken(commands)).toEqual([])
      const lines = await linesOf(rendered)
      expect(lines.some((line) => line.includes("t-1's request is no longer open"))).toBe(true)
    })
  })

  test("only answers Accept in a shell with no UrlOpener", async () => {
    await pressOpenUrl(undefined, async ({ commands }) => {
      expect(taken(commands)).toEqual([accept])
    })
  })
})
