import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fc from "fast-check"
import type { Command } from "../src/services/exec.ts"
import { CommandExitedNonZero } from "../src/services/exec.ts"
import {
  type Environment,
  make,
  Notifier,
  notifySendArgs,
  osascriptArgs,
  oscOf,
  oscSequence,
  type Route,
  routeOf,
  type Where,
} from "../src/services/Notifier.ts"
import { appConfig, layer as appConfigLayer } from "../src/testing/AppConfig.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { Captured, layer as capturedLayer } from "../src/testing/Notifier.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"

const ESC = "\x1b"
const BEL = "\x07"

const envOf =
  (variables: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    variables[name]

const where = (
  overrides: Partial<Omit<Where, "env">> & { env?: Readonly<Record<string, string>> } = {},
): Where => ({
  platform: overrides.platform ?? "darwin",
  env: envOf(overrides.env ?? {}),
  installed: overrides.installed ?? (() => false),
  tty: overrides.tty ?? { stdoutIsTty: true, dumb: false, term: "xterm-256color" },
})

const ssh = { SSH_CONNECTION: "10.0.0.2 52144 10.0.0.1 22" }

describe("routeOf", () => {
  const cases: ReadonlyArray<[string, Where, Route]> = [
    ["macOS, local", where(), { _tag: "Desktop", command: "osascript" }],
    [
      "macOS, local in iTerm2: the desktop's alone, not twice",
      where({ env: { TERM_PROGRAM: "iTerm.app" } }),
      { _tag: "Desktop", command: "osascript" },
    ],
    [
      "macOS over ssh from iTerm2",
      where({ env: { ...ssh, LC_TERMINAL: "iTerm2" } }),
      { _tag: "Osc", osc: "9" },
    ],
    [
      "Linux with notify-send",
      where({ platform: "linux", installed: (c) => c === "notify-send" }),
      { _tag: "Desktop", command: "notify-send" },
    ],
    [
      "Linux without notify-send, in kitty",
      where({ platform: "linux", env: { TERM: "xterm-kitty" } }),
      { _tag: "Osc", osc: "9" },
    ],
    [
      "Linux over ssh with notify-send, from Ghostty",
      where({
        platform: "linux",
        installed: () => true,
        env: { SSH_TTY: "/dev/pts/3", TERM: "xterm-ghostty" },
      }),
      { _tag: "Osc", osc: "777" },
    ],
    [
      "Linux over ssh from WezTerm",
      where({ platform: "linux", env: { SSH_CLIENT: "10.0.0.2 52144 22", TERM: "wezterm" } }),
      { _tag: "Osc", osc: "777" },
    ],
    [
      "Linux over ssh from foot",
      where({ platform: "linux", env: { ...ssh, TERM: "foot-extra" } }),
      { _tag: "Osc", osc: "777" },
    ],
    [
      "Linux over ssh from a terminal not known to show them",
      where({ platform: "linux", env: { ...ssh, TERM: "xterm-256color" } }),
      { _tag: "None" },
    ],
    [
      "over ssh from kitty, stdout not a terminal",
      where({
        platform: "linux",
        env: { ...ssh, TERM: "xterm-kitty" },
        tty: { stdoutIsTty: false, dumb: false, term: "xterm-kitty" },
      }),
      { _tag: "None" },
    ],
    [
      "over ssh with TERM=dumb",
      where({
        platform: "linux",
        env: { ...ssh, LC_TERMINAL: "iTerm2" },
        tty: { stdoutIsTty: true, dumb: true, term: "dumb" },
      }),
      { _tag: "None" },
    ],
    [
      "another platform, in WezTerm",
      where({ platform: "win32", env: { TERM_PROGRAM: "WezTerm" } }),
      { _tag: "Osc", osc: "777" },
    ],
  ]
  for (const [name, at, route] of cases) {
    test(name, () => {
      expect(routeOf(at)).toEqual(route)
    })
  }
})

describe("oscOf", () => {
  const cases: ReadonlyArray<[Record<string, string>, "9" | "777" | undefined]> = [
    [{ TERM_PROGRAM: "iTerm.app" }, "9"],
    [{ LC_TERMINAL: "iTerm2" }, "9"],
    [{ ITERM_SESSION_ID: "w0t0p0:1" }, "9"],
    [{ TERM: "xterm-kitty" }, "9"],
    // inside tmux, whose TERM and TERM_PROGRAM are its own
    [{ TERM: "tmux-256color", TERM_PROGRAM: "tmux", KITTY_WINDOW_ID: "1" }, "9"],
    [{ TERM_PROGRAM: "ghostty" }, "777"],
    [{ TERM: "xterm-ghostty" }, "777"],
    [{ TERM: "tmux-256color", TERM_PROGRAM: "tmux", GHOSTTY_RESOURCES_DIR: "/x" }, "777"],
    [{ TERM_PROGRAM: "WezTerm" }, "777"],
    [{ TERM: "screen", WEZTERM_PANE: "0" }, "777"],
    [{ TERM: "foot" }, "777"],
    [{ TERM: "xterm-256color" }, undefined],
    [{ TERM_PROGRAM: "Apple_Terminal" }, undefined],
    [{ TERM_PROGRAM: "vscode" }, undefined],
    [{}, undefined],
  ]
  for (const [env, osc] of cases) {
    test(`${JSON.stringify(env)} is ${osc ?? "none"}`, () => {
      expect(oscOf(envOf(env))).toBe(osc)
    })
  }
})

describe("osascriptArgs", () => {
  test("the notice and title are arguments, not AppleScript", () => {
    const notice = `tut-1 needs you · Allow Bash(echo "hi" & say \\"x\\")?`
    const title = `it's "mine"`
    expect(osascriptArgs(title, notice)).toEqual([
      "-e",
      "on run argv",
      "-e",
      "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e",
      "end run",
      "--",
      notice,
      title,
    ])
  })

  test("any text leaves the script as it is, and is the last two arguments after --", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (title, notice) => {
        const args = osascriptArgs(title, notice)
        expect(args.slice(0, 7)).toEqual(osascriptArgs("", "").slice(0, 7))
        expect(args.slice(7)).toEqual([notice, title])
      }),
    )
  })
})

describe("notifySendArgs", () => {
  test("the title is the summary and the notice the body, its markup escaped", () => {
    expect(notifySendArgs("project", "Closed tut-1 · <b>A & B</b>")).toEqual([
      "--app-name=tutti",
      "--",
      "project",
      "Closed tut-1 · &lt;b&gt;A &amp; B&lt;/b&gt;",
    ])
  })

  test("a notice starting with - comes after --", () => {
    expect(notifySendArgs("project", "-u critical").slice(-3)).toEqual([
      "--",
      "project",
      "-u critical",
    ])
  })
})

describe("oscSequence", () => {
  test("OSC 9 puts the title before the notice", () => {
    expect(oscSequence("9", "project", "Closed tut-1", false)).toBe(
      `${ESC}]9;project · Closed tut-1${BEL}`,
    )
  })

  test("OSC 777 carries the title, a ; in it made a ,", () => {
    expect(oscSequence("777", "my;project", "Stopped: a; b", false)).toBe(
      `${ESC}]777;notify;my,project;Stopped: a; b${BEL}`,
    )
  })

  test("inside tmux the sequence passes through, its ESC doubled", () => {
    expect(oscSequence("9", "project", "Finished the run", true)).toBe(
      `${ESC}Ptmux;${ESC}${ESC}]9;project · Finished the run${BEL}${ESC}\\`,
    )
  })

  test("sanitised text can't end the sequence early or start another", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("9" as const, "777" as const),
        fc.string(),
        fc.string(),
        (osc, title, notice) => {
          const sequence = oscSequence(osc, sanitizeLine(title), sanitizeLine(notice), false)
          expect(sequence.indexOf(ESC, 1)).toBe(-1)
          expect(sequence.indexOf(BEL)).toBe(sequence.length - 1)
          expect(sequence.startsWith(`${ESC}]${osc};`)).toBe(true)
        },
      ),
    )
  })
})

/** A Notifier's environment that records the commands it runs and what it writes. */
const recording = (
  at: Where,
  options: { readonly fail?: boolean; readonly slow?: boolean } = {},
) => {
  const ran: Array<Command> = []
  const written: Array<string> = []
  const environment: Environment = {
    ...at,
    run: (command) =>
      Effect.gen(function* () {
        if (options.slow) yield* Effect.sleep("30 millis")
        ran.push(command)
        if (options.fail) {
          return yield* new CommandExitedNonZero({
            command: command.command,
            exitCode: 1,
            stderr: "no notification server\n",
          })
        }
        return { exitCode: 0, stdout: "", stderr: "", truncated: { stdout: false, stderr: false } }
      }),
    write: (text) => Effect.sync(() => void written.push(text)),
  }
  return { ran, written, environment }
}

/** Builds a Notifier in `environment`, sends `notices`, closes it, and returns the log's lines. */
const notifyAll = (
  environment: Environment,
  notices: ReadonlyArray<string>,
  config = appConfig({}, "/work/my-project"),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const notifier = yield* make(environment)
          for (const notice of notices) yield* notifier.notify(notice)
        }),
      )
      return yield* texts
    }).pipe(Effect.provide(Layer.mergeAll(appConfigLayer(config), logLayer()))),
  )

describe("Notifier", () => {
  test("on macOS, osascript titled with the repository's folder name, the notice sanitised", async () => {
    const { ran, written, environment } = recording(where())
    await notifyAll(environment, [`tut-1 needs your answer · Pick ${ESC}]52;c;eA==${BEL}one?`])
    expect(ran).toHaveLength(1)
    expect(ran[0]?.command).toBe("osascript")
    expect(ran[0]?.args.slice(-2)).toEqual(["tut-1 needs your answer · Pick one?", "my-project"])
    expect(written).toEqual([])
  })

  test("on Linux, notify-send", async () => {
    const { ran, environment } = recording(where({ platform: "linux", installed: () => true }))
    await notifyAll(environment, ["Finished the run · 3 closed"])
    expect(ran.map((each) => [each.command, ...each.args])).toEqual([
      ["notify-send", "--app-name=tutti", "--", "my-project", "Finished the run · 3 closed"],
    ])
  })

  test("over ssh, OSC written to the terminal, wrapped inside tmux", async () => {
    const { ran, written, environment } = recording(
      where({ platform: "linux", env: { ...ssh, LC_TERMINAL: "iTerm2", TMUX: "/tmp/t,1,0" } }),
    )
    await notifyAll(environment, ["Usage limit reached · resets 14:05"])
    expect(ran).toEqual([])
    expect(written).toEqual([
      `${ESC}Ptmux;${ESC}${ESC}]9;my-project · Usage limit reached · resets 14:05${BEL}${ESC}\\`,
    ])
  })

  test("off when AppConfig's notify is false", async () => {
    const desktop = recording(where())
    const terminal = recording(where({ platform: "linux", env: { ...ssh, TERM: "xterm-kitty" } }))
    const off = appConfig({ notify: false }, "/work/my-project")
    await notifyAll(desktop.environment, ["Closed tut-1"], off)
    await notifyAll(terminal.environment, ["Closed tut-1"], off)
    expect(desktop.ran).toEqual([])
    expect(terminal.written).toEqual([])
  })

  test("a notice that is empty once sanitised shows nothing", async () => {
    const { ran, environment } = recording(where())
    await notifyAll(environment, ["", `  ${ESC}[2J‮ `])
    expect(ran).toEqual([])
  })

  test("a failure is logged, never fatal", async () => {
    const { ran, environment } = recording(where({ platform: "linux", installed: () => true }), {
      fail: true,
    })
    const lines = await notifyAll(environment, ["Closed tut-1", "Closed tut-2"])
    expect(ran).toHaveLength(2)
    expect(lines).toEqual([
      "NOTIFY_FAILED: notify-send exited with 1: no notification server",
      "NOTIFY_FAILED: notify-send exited with 1: no notification server",
    ])
  })

  test("a terminal write that fails is logged", async () => {
    const at = where({ platform: "linux", env: { ...ssh, TERM: "xterm-kitty" } })
    const environment: Environment = {
      ...recording(at).environment,
      write: () => Effect.fail(new Error("EPIPE")),
    }
    expect(await notifyAll(environment, ["Closed tut-1"])).toEqual(["NOTIFY_FAILED: OSC 9: EPIPE"])
  })

  test("notify returns at once, and closing waits for the notices still being shown", async () => {
    const { ran, environment } = recording(where(), { slow: true })
    const order: Array<string> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const notifier = yield* make(environment)
          yield* notifier.notify("Stopped")
          order.push(`returned with ${ran.length} shown`)
        }),
      ).pipe(Effect.provide(Layer.mergeAll(appConfigLayer(), logLayer()))),
    )
    order.push(`closed with ${ran.length} shown`)
    expect(order).toEqual(["returned with 0 shown", "closed with 1 shown"])
  })
})

describe("the test layer", () => {
  test("captures the notices, sanitised", async () => {
    const notices = await Effect.runPromise(
      Effect.gen(function* () {
        const notifier = yield* Notifier
        yield* notifier.notify(`tut-1 needs you · Allow Bash(rm -rf build)?${ESC}[2J`)
        yield* notifier.notify("")
        yield* notifier.notify("Finished the run\n· 2 closed")
        return yield* (yield* Captured).notices
      }).pipe(Effect.provide(capturedLayer.pipe(Layer.provide(appConfigLayer())))),
    )
    expect(notices).toEqual([
      "tut-1 needs you · Allow Bash(rm -rf build)?",
      "Finished the run · 2 closed",
    ])
  })
})
