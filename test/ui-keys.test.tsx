// Keys and the mouse (§ 7.3, § 7.4, § 7.8, D15, D18): the input layers' order, the quit box's
// paths, Ctrl+Z's toast, the stop question, mouse reports kept out of input, pastes in one piece
// and the unterminated paste's time limit, and --no-mouse.
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { type CliRenderer, TextAttributes, type TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Exit, Option, Queue, Scope } from "effect"
import fc from "fast-check"
import { makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyView, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import {
  guardPaste,
  isTextField,
  mouseFilter,
  mouseWindow,
  pasteEnd,
  pasteLimit,
  pasteStart,
  printable,
  priorities,
  useInput,
  useLayer,
} from "../src/ui/keys.ts"
import { modalMaxWidth, wrap } from "../src/ui/Modal.tsx"
import { quitQuestion } from "../src/ui/QuitBox.tsx"
import { open, rendererConfig, rendererConfigFor } from "../src/ui/renderer.ts"
import { stopWords } from "../src/ui/StopQuestion.tsx"
import {
  makeToasts,
  suspendToast,
  type ToastStore,
  toastLife,
  toastsShown,
} from "../src/ui/Toasts.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const size = { width: 80, height: 24 }

const shellOf = (view: RunView = emptyView): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => 0,
})

/** The commands the screen has sent since the last call, oldest first. */
const sent = (value: ShellValue): ReadonlyArray<UiCommand> => {
  const out: Array<UiCommand> = []
  for (;;) {
    const next = Effect.runSync(Queue.poll(value.commands))
    if (Option.isNone(next)) return out
    out.push(next.value)
  }
}

const tags = (value: ShellValue) => sent(value).map((command) => command._tag)

const frameOf = async (rendered: Rendered) => (await rendered.capture()).chars

/** How long a lone ESC waits to be a key: the stdin parser's 20 ms, and some. */
const escWait = 40

/**
 * Presses `keys`, one after another with no wait for React: a character, `tab`, `ctrl+<k>`, or
 * `escape`, after which the parser waits to tell a lone ESC from a sequence's start.
 */
const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key.startsWith("ctrl+")) setup.mockInput.pressKey(key.slice(5), { ctrl: true })
      else if (key === "escape") {
        setup.mockInput.pressEscape()
        await Bun.sleep(escWait)
      } else setup.mockInput.pressKey(key === "tab" ? "TAB" : key)
    }
  })

/** The dashboard over `view`, as the run shows it. */
const onDashboard = <A,>(
  body: (rendered: Rendered, value: ShellValue) => Promise<A>,
  view: RunView = emptyView,
  input: { readonly pasteLimit?: number; readonly toastLife?: number } = {},
) => {
  const value = shellOf(view)
  return withRender(<Root value={value} input={input} />, size, (rendered) => body(rendered, value))
}

/** A textarea with the focus, handed to `onRef` once mounted. */
const Field = ({ onRef }: { readonly onRef: (field: TextareaRenderable) => void }) => (
  <textarea
    ref={(field: TextareaRenderable | null) => {
      if (field !== null) onRef(field)
    }}
    focused
    width={30}
    height={4}
  />
)

/** A probe that binds `keys` in `layer`, noting `name` in `heard` when it runs. */
const Probe = ({
  layer,
  keys,
  name,
  heard,
}: {
  readonly layer: "always" | "box" | "view" | "global"
  readonly keys: ReadonlyArray<string>
  readonly name: string
  readonly heard: Array<string>
}) => {
  useLayer(
    layer,
    keys.map((key) => ({ key, run: () => heard.push(`${name}:${key}`) })),
  )
  return null
}

/** `children` under Root, with a field focused when `field`, and what it holds. */
const withProbes = async (
  children: React.ReactNode,
  body: (rendered: Rendered, value: ShellValue, field: () => string) => Promise<void>,
  options: { readonly field?: boolean; readonly pasteLimit?: number } = {},
) => {
  const value = shellOf()
  let field: TextareaRenderable | null = null
  await withRender(
    <Root
      value={value}
      input={options.pasteLimit === undefined ? {} : { pasteLimit: options.pasteLimit }}
    >
      <box flexDirection="column">
        {options.field ? <Field onRef={(made) => (field = made)} /> : null}
        {children}
      </box>
    </Root>,
    size,
    (rendered) => body(rendered, value, () => field?.plainText ?? ""),
  )
}

describe("the input layers", () => {
  test("go always, field, box, view, global, highest first", () => {
    const order = Object.entries(priorities)
      .sort(([, a], [, b]) => b - a)
      .map(([name]) => name)
    expect(order).toEqual(["always", "field", "box", "view", "global"])
  })

  test("printable keys are those a text field types", () => {
    for (const key of ["s", "?", "1", "shift+d", "D", "+", "space", "é"]) {
      expect(printable(key)).toBe(true)
    }
    for (const key of ["ctrl+c", "ctrl+z", "escape", "return", "tab", "up", "meta+s", "ctrl++"]) {
      expect(printable(key)).toBe(false)
    }
  })

  test("a key bound in two layers runs the higher layer's", async () => {
    const heard: Array<string> = []
    await withProbes(
      <>
        <Probe layer="global" keys={["x", "y", "z"]} name="global" heard={heard} />
        <Probe layer="view" keys={["x", "y"]} name="view" heard={heard} />
        <Probe layer="always" keys={["x"]} name="always" heard={heard} />
      </>,
      async (rendered) => {
        await press(rendered, "x", "y", "z")
        expect(heard).toEqual(["always:x", "view:y", "global:z"])
      },
    )
  })

  test("a focused text field takes every printable key; Ctrl+C stays global", async () => {
    const heard: Array<string> = []
    await withProbes(
      <>
        <Probe layer="view" keys={["s", "?", "escape"]} name="view" heard={heard} />
        <Probe layer="global" keys={["1", "shift+d"]} name="global" heard={heard} />
      </>,
      async (rendered, _value, field) => {
        await rendered.input(async (setup) => {
          await setup.mockInput.typeText("s?1D")
        })
        expect(field()).toBe("s?1D")
        await press(rendered, "escape")
        expect(heard).toEqual(["view:escape"])
        await press(rendered, "ctrl+c")
        expect(await frameOf(rendered)).toContain(quitQuestion)
      },
      { field: true },
    )
  })

  test("while a box is open, the view's and global keys are off; Ctrl+C, Ctrl+Z stay", async () => {
    const heard: Array<string> = []
    await withProbes(
      <>
        <Probe layer="view" keys={["x"]} name="view" heard={heard} />
        <Probe layer="global" keys={["tab"]} name="global" heard={heard} />
      </>,
      async (rendered, value) => {
        await press(rendered, "ctrl+c", "x", "tab", "ctrl+z")
        expect(heard).toEqual([])
        expect(await frameOf(rendered)).toContain(suspendToast)
        await press(rendered, "escape", "x", "tab")
        expect(heard).toEqual(["view:x", "global:tab"])
        expect(tags(value)).toEqual([])
      },
    )
  })

  test("a text field is an input or a textarea", async () => {
    await withProbes(<input focused width={10} />, async (rendered) => {
      expect(isTextField(rendered.setup.renderer.currentFocusedRenderable)).toBe(true)
      expect(isTextField(rendered.setup.renderer.root)).toBe(false)
      expect(isTextField(null)).toBe(false)
    })
  })
})

describe("the quit box", () => {
  test("Ctrl+C opens it over the dashboard", async () => {
    await onDashboard(async (rendered, value) => {
      expect(await frameOf(rendered)).not.toContain(quitQuestion)
      await press(rendered, "ctrl+c")
      const frame = await frameOf(rendered)
      expect(frame).toContain(quitQuestion)
      expect(frame).toContain("s stop after current · q quit now · Esc cancel")
      expect(tags(value)).toEqual([])
    })
  })

  test("s stops after the current tickets (Drain)", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "ctrl+c", "s")
      expect(tags(value)).toEqual(["Drain"])
      expect(await frameOf(rendered)).not.toContain(quitQuestion)
    })
  })

  test("q quits now (Quit{now})", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "ctrl+c", "q")
      expect(sent(value)).toEqual([{ _tag: "Quit", now: true }])
      expect(await frameOf(rendered)).not.toContain(quitQuestion)
    })
  })

  test("Esc cancels: nothing is sent", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "ctrl+c", "escape")
      expect(tags(value)).toEqual([])
      expect(await frameOf(rendered)).not.toContain(quitQuestion)
    })
  })

  test("a second Ctrl+C quits now; after Esc, Ctrl+C opens it again", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "ctrl+c", "ctrl+c")
      expect(sent(value)).toEqual([{ _tag: "Quit", now: true }])
      await press(rendered, "ctrl+c", "escape", "ctrl+c")
      expect(tags(value)).toEqual([])
      expect(await frameOf(rendered)).toContain(quitQuestion)
    })
  })

  test("each of its keys is a click target too", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "ctrl+c")
      const lines = (await frameOf(rendered)).split("\n")
      const y = lines.findIndex((line) => line.includes("q quit now"))
      const x = (lines[y] ?? "").indexOf("q quit now")
      await rendered.input((setup) => setup.mockMouse.click(x + 3, y))
      expect(sent(value)).toEqual([{ _tag: "Quit", now: true }])
    })
  })

  test("Ctrl+C replaces the stop question with it", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "s", "ctrl+c")
      const frame = await frameOf(rendered)
      expect(frame).toContain(quitQuestion)
      expect(frame).not.toContain("Stop after the running tickets?")
      await press(rendered, "y", "s")
      expect(tags(value)).toEqual(["Drain"])
    })
  })

  test("it is no wider than its maximum, and fits a 60-column pane", async () => {
    await withRender(<Root value={shellOf()} />, { width: 60, height: 16 }, async (rendered) => {
      await press(rendered, "ctrl+c")
      const lines = (await frameOf(rendered)).split("\n")
      const top = lines.find((line) => line.includes("╭─") && line.includes("╮")) ?? ""
      expect(top.trim().length).toBeLessThanOrEqual(modalMaxWidth)
      expect(lines.some((line) => line.includes("s stop after current · q quit now"))).toBe(true)
    })
  })
})

describe("Ctrl+Z", () => {
  test("shows a faint toast that tutti can't be suspended, then it goes", async () => {
    await onDashboard(
      async (rendered, value) => {
        await press(rendered, "ctrl+z")
        const frame = await rendered.capture()
        expect(frame.chars).toContain(suspendToast)
        const line = frame.spans.lines.find((each) =>
          each.spans.some((span) => span.text.includes("can't be suspended")),
        )
        const span = line?.spans.find((each) => each.text.includes("can't be suspended"))
        expect((span?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM)
        expect(tags(value)).toEqual([])
        await rendered.input(() => Bun.sleep(700))
        expect(await frameOf(rendered)).not.toContain(suspendToast)
      },
      emptyView,
      // Long enough to outlast the press and capture on a loaded machine, in real time.
      { toastLife: 500 },
    )
  })

  test("is the default toast life of 4 s, the newest three shown", () => {
    expect(toastLife).toBe(4000)
    const store = makeToasts(10_000)
    for (const text of ["a", "b", "c", "d"]) store.show(text)
    expect(store.get().map((toast) => toast.text)).toEqual(["b", "c", "d"])
    expect(store.get()).toHaveLength(toastsShown)
    store.show("couldn't copy", { failure: true })
    expect(store.get().at(-1)).toMatchObject({ text: "couldn't copy", failure: true })
    store.dispose()
    expect(store.get()).toEqual([])
  })

  test("a failure's toast is needsYou, not faint", async () => {
    const value = shellOf()
    let toasts: ToastStore | null = null
    const Fail = () => {
      toasts = useInput().toasts
      return null
    }
    await withRender(
      <Root value={value}>
        <Fail />
      </Root>,
      size,
      async (rendered) => {
        await rendered.input(() => toasts?.show("couldn't copy", { failure: true }))
        const frame = await rendered.capture()
        const span = frame.spans.lines
          .flatMap((line) => line.spans)
          .find((each) => each.text.includes("couldn't copy"))
        expect(span?.fg.toInts()).toEqual(theme.rgba("needsYou").toInts())
        expect((span?.attributes ?? 0) & TextAttributes.DIM).toBe(0)
      },
    )
  })
})

describe("the stop question", () => {
  const windingDown: RunView = {
    ...emptyView,
    windDown: { marks: [], running: 0 },
    totals: { ...emptyView.totals, queueHeld: true },
  }

  test("s asks to stop after current; y sends Drain", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "s")
      const frame = await frameOf(rendered)
      expect(frame).toContain("Stop after the running tickets?")
      expect(frame).toContain("y stop · n keep going")
      await press(rendered, "y")
      expect(tags(value)).toEqual(["Drain"])
      expect(await frameOf(rendered)).not.toContain("Stop after the running tickets?")
    })
  })

  test("n or Esc leaves things as they are", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "s", "n")
      expect(await frameOf(rendered)).not.toContain("Stop after the running tickets?")
      await press(rendered, "s", "escape")
      expect(await frameOf(rendered)).not.toContain("Stop after the running tickets?")
      expect(tags(value)).toEqual([])
    })
  })

  test("while the run winds down, s asks to keep taking tickets; y sends Undrain", async () => {
    await onDashboard(async (rendered, value) => {
      expect(await frameOf(rendered)).toContain("held")
      await press(rendered, "s")
      const frame = await frameOf(rendered)
      expect(frame).toContain("Keep taking tickets?")
      expect(frame).toContain("y keep going · n keep stopping")
      await press(rendered, "y")
      expect(tags(value)).toEqual(["Undrain"])
    }, windingDown)
  })

  test("a key the question doesn't take does nothing while it is open", async () => {
    await onDashboard(async (rendered, value) => {
      await press(rendered, "s", "s", "q")
      expect(await frameOf(rendered)).toContain("Stop after the running tickets?")
      expect(tags(value)).toEqual([])
    })
  })

  test("says which tickets it waits for, as orchestra's", () => {
    expect(stopWords(false, ["k-1"]).about).toBe(
      "Stopping after k-1 finishes: no new tickets will start. It merges as usual, then the run ends.",
    )
    expect(stopWords(false, ["k-1", "k-2"]).about).toBe(
      "Stopping after the 2 running tickets finish (k-1, k-2): no new tickets will start. They merge as usual, then the run ends.",
    )
    expect(stopWords(false, ["k-1"]).yes).toBe("stop after current")
    expect(stopWords(true, ["k-1"]).ask).toBe("Keep taking tickets?")
  })

  test("its words wrap to the box", () => {
    expect(wrap("a bb ccc dddd", 6)).toEqual(["a bb", "ccc", "dddd"])
    expect(wrap("", 6)).toEqual([""])
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{1,8}$/)),
        fc.integer({ min: 8, max: 40 }),
        (words, width) => {
          const lines = wrap(words.join(" "), width)
          expect(
            lines
              .join(" ")
              .split(" ")
              .filter((each) => each !== ""),
          ).toEqual(words)
          for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width)
        },
      ),
    )
  })
})

describe("mouse sequences", () => {
  // A mouse report split after `ESC [` (OpenTUI #1661): the start a response, the rest keys.
  const rest = [..."<64;87;26M"]

  test("the rest of a report split after ESC [ is kept out", () => {
    let now = 0
    const filter = mouseFilter(() => now)
    expect(filter("\x1b[")).toBe(false)
    now += 40
    expect(rest.map(filter)).toEqual(rest.map(() => true))
    expect(filter("x")).toBe(false)
  })

  test("so is the rest of one split later, and a release (m)", () => {
    const filter = mouseFilter(() => 0)
    expect(filter("\x1b[<6")).toBe(false)
    expect([..."4;1;2m"].map(filter)).toEqual([true, true, true, true, true, true])
  })

  test("a key that can't continue a report goes through, and ends the filter", () => {
    const filter = mouseFilter(() => 0)
    filter("\x1b[")
    expect(filter("<")).toBe(true)
    expect(filter("6")).toBe(true)
    expect(filter("x")).toBe(false)
    expect(filter("<")).toBe(false)
  })

  test("a start left alone longer than the window lets keys through", () => {
    let now = 0
    const filter = mouseFilter(() => now)
    filter("\x1b[")
    now += mouseWindow + 1
    expect(filter("<")).toBe(false)
  })

  test("text typed with no report's start goes through, whatever it is", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 1 })), (keys) => {
        const filter = mouseFilter(() => 0)
        expect(keys.filter((key) => !key.startsWith("\x1b")).map(filter)).toEqual(
          keys.filter((key) => !key.startsWith("\x1b")).map(() => false),
        )
      }),
    )
  })

  test("never reach a focused input: the report split after ESC [ types nothing", async () => {
    await withProbes(
      null,
      async (rendered, _value, field) => {
        await rendered.input(async (setup) => {
          setup.renderer.stdin.emit("data", Buffer.from("\x1b["))
          await Bun.sleep(60)
          setup.renderer.stdin.emit("data", Buffer.from(rest.join("")))
          await Bun.sleep(30)
        })
        expect(field()).toBe("")
        await rendered.input(async (setup) => {
          await setup.mockInput.typeText("ok<")
        })
        expect(field()).toBe("ok<")
      },
      { field: true },
    )
  })

  test("the wheel over a focused input types nothing", async () => {
    await withProbes(
      null,
      async (rendered, _value, field) => {
        await rendered.input((setup) => setup.mockMouse.scroll(5, 1, "down"))
        expect(field()).toBe("")
      },
      { field: true },
    )
  })
})

describe("bracketed paste", () => {
  test("goes to the focused textarea in one piece", async () => {
    const heard: Array<string> = []
    await withProbes(
      <Probe layer="view" keys={["s", "return"]} name="view" heard={heard} />,
      async (rendered, _value, field) => {
        await rendered.input(async (setup) => {
          await setup.mockInput.pasteBracketedText("stop\nsend")
        })
        expect(field()).toBe("stop\nsend")
        expect(heard).toEqual([])
      },
      { field: true },
    )
  })

  test("left unterminated, it times out and what arrived is inserted", async () => {
    await withProbes(
      null,
      async (rendered, _value, field) => {
        await rendered.input(async (setup) => {
          setup.renderer.stdin.emit("data", Buffer.from(`${pasteStart}half a pa`))
          setup.renderer.stdin.emit("data", Buffer.from("ste"))
          await Bun.sleep(20)
        })
        expect(field()).toBe("")
        await rendered.input(() => Bun.sleep(80))
        expect(field()).toBe("half a paste")
        await rendered.input(async (setup) => {
          await setup.mockInput.typeText("!")
        })
        expect(field()).toBe("half a paste!")
      },
      { field: true, pasteLimit: 50 },
    )
  })

  test("the time limit is 2 s since its last bytes; a paste that ends is left alone", async () => {
    expect(pasteLimit).toBe(2000)
    const stdin = new EventEmitter()
    const seen: Array<string> = []
    stdin.on("data", (chunk: Buffer) => seen.push(chunk.toString()))
    const stop = guardPaste(stdin as never, 30)
    // An end marker split between two reads ends the paste.
    stdin.emit("data", Buffer.from(`${pasteStart}one${pasteEnd.slice(0, 3)}`))
    stdin.emit("data", Buffer.from(pasteEnd.slice(3)))
    await Bun.sleep(60)
    expect(seen.filter((chunk) => chunk === pasteEnd)).toEqual([])
    // A start split between two reads, and no end: the guard ends it.
    stdin.emit("data", Buffer.from(`x${pasteStart.slice(0, 4)}`))
    stdin.emit("data", Buffer.from(`${pasteStart.slice(4)}two`))
    await Bun.sleep(15)
    stdin.emit("data", Buffer.from("more"))
    await Bun.sleep(20)
    expect(seen.filter((chunk) => chunk === pasteEnd)).toEqual([])
    await Bun.sleep(40)
    expect(seen.filter((chunk) => chunk === pasteEnd)).toEqual([pasteEnd])
    stop()
    stdin.emit("data", Buffer.from(pasteStart))
    await Bun.sleep(60)
    expect(seen.filter((chunk) => chunk === pasteEnd)).toEqual([pasteEnd])
  })
})

describe("--no-mouse", () => {
  const scoped = async (mouse: boolean | undefined) => {
    const scope = Effect.runSync(Scope.make())
    let made: CliRenderer | null = null
    try {
      const shell = await Effect.runPromise(
        Scope.provide(scope)(
          open({
            chosen: "dark",
            ...(mouse === undefined ? {} : { mouse }),
            make: async (config) => {
              made = (await createTestRenderer({ ...config, width: 40, height: 10 })).renderer
              return made
            },
          }),
        ),
      )
      return shell.renderer.useMouse
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      expect(made).not.toBeNull()
    }
  }

  test("turns the renderer's mouse capture off; it is on by default", async () => {
    expect(rendererConfigFor(false)).toEqual({ ...rendererConfig, useMouse: false })
    expect(rendererConfigFor(true).useMouse).toBe(true)
    expect(await scoped(false)).toBe(false)
    expect(await scoped(true)).toBe(true)
    expect(await scoped(undefined)).toBe(true)
  })
})
