// The start question and the plan confirmation in the renderer (§ 5 item 3, § 7.1): the choices,
// cancelling, the description's new lines, the plan's lines, and the form roles they are drawn in.
import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Exit, Fiber } from "effect"
import { act } from "react"
import { PlanConfirmation } from "../src/ui/PlanConfirmation.tsx"
import {
  FormCancelled,
  type Plan,
  planLines,
  startOnQuestion,
  TicketCount,
  ticketsOption,
  type Work,
} from "../src/ui/questions.ts"
import { rendererConfig, type Shell } from "../src/ui/renderer.ts"
import { askStart, descriptionKeys, StartQuestion } from "../src/ui/StartQuestion.tsx"
import {
  type Appearance,
  type FormStyleName,
  formStyleNames,
  formStyleSpecs,
  makeTheme,
  orchestra,
} from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const dark = themeOf("dark")

const size = { width: 100, height: 24 }

/** What a form said: its answers, and how often it was cancelled. */
const recorder = <A,>() => {
  const answers: Array<A> = []
  let cancelled = 0
  return {
    answers,
    cancelled: () => cancelled,
    props: {
      answer: (value: A) => {
        answers.push(value)
      },
      cancel: () => {
        cancelled++
      },
    },
  }
}

/** The colour of the first span holding `text`. */
const colourOf = (frame: Frame, text: string) =>
  frame.spans.lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes(text))
    ?.fg.toInts()
    .slice(0, 3)

/** The colour a form style draws its text in. */
const hex = (style: FormStyleName) => dark.form[style].fg?.toInts().slice(0, 3)

const start = (count: TicketCount = TicketCount.Ready({ n: 3 })) => {
  const said = recorder<Work>()
  const node = <StartQuestion theme={dark} count={count} {...said.props} />
  return { said, node }
}

const press = (rendered: Rendered, drive: Parameters<Rendered["input"]>[0]) => rendered.input(drive)

describe("the start question in the renderer", () => {
  test("offers the current tickets, with their count, then a new feature", async () => {
    const { node } = start()
    await withRender(node, size, async (rendered) => {
      const frame = await rendered.capture()
      expect(frame.chars).toContain("What should this run work on?")
      expect(frame.chars).toContain("> Current tickets: 3 ready")
      expect(frame.chars).toContain("  New feature: describe it, talk it through, run its tickets")
      // The form roles: the title, the selector, the selected option, the others.
      expect(colourOf(frame, "What should this run")).toEqual(hex("fieldTitle"))
      expect(colourOf(frame, "> ")).toEqual(hex("selector"))
      expect(colourOf(frame, "Current tickets")).toEqual(hex("selected"))
      expect(colourOf(frame, "┃")).toEqual(hex("bar"))
    })
  })

  test("Enter on the current tickets chooses them", async () => {
    const { said, node } = start()
    await withRender(node, size, async (rendered) => {
      await press(rendered, (setup) => setup.mockInput.pressEnter())
    })
    expect(said.answers.map((work) => work._tag)).toEqual(["Tickets"])
  })

  test("a new feature asks for its description, with its new lines", async () => {
    const { said, node } = start()
    await withRender(node, size, async (rendered) => {
      await press(rendered, (setup) => setup.mockInput.pressArrow("down"))
      expect((await rendered.capture()).chars).toContain("> New feature")
      await press(rendered, (setup) => setup.mockInput.pressEnter())
      const frame = await rendered.capture()
      expect(frame.chars).toContain("Describe the feature")
      expect(frame.chars).toContain("Alt+Enter or Ctrl+J starts a new line.")
      expect(said.answers).toEqual([])
      await press(rendered, async (setup) => {
        await setup.mockInput.typeText("undo stack")
        setup.mockInput.pressEnter({ meta: true })
        await setup.mockInput.typeText("for edits")
        setup.mockInput.pressKey("j", { ctrl: true })
        await setup.mockInput.typeText("  and drags  ")
      })
      expect(said.answers).toEqual([])
      await press(rendered, (setup) => setup.mockInput.pressEnter())
    })
    expect(said.answers).toEqual([
      { _tag: "Feature", description: "undo stack\nfor edits\n  and drags" },
    ] as Array<Work>)
  })

  test("an empty description is refused, in the error role, until one is typed", async () => {
    const { said, node } = start()
    await withRender(node, size, async (rendered) => {
      await press(rendered, (setup) => setup.mockInput.pressKey("j"))
      await press(rendered, (setup) => setup.mockInput.pressEnter())
      await press(rendered, async (setup) => {
        await setup.mockInput.typeText("   ")
        setup.mockInput.pressEnter()
      })
      const frame = await rendered.capture()
      expect(frame.chars).toContain("describe the feature first, or press Esc to cancel")
      expect(colourOf(frame, "describe the feature first")).toEqual(hex("error"))
      expect(said.answers).toEqual([])
      await press(rendered, async (setup) => {
        await setup.mockInput.typeText("x")
        setup.mockInput.pressEnter()
      })
    })
    expect(said.answers).toEqual([{ _tag: "Feature", description: "x" }] as Array<Work>)
  })

  test("Shift+Tab goes back from the description to the select", async () => {
    const { said, node } = start()
    await withRender(node, size, async (rendered) => {
      await press(rendered, (setup) => setup.mockInput.pressArrow("down"))
      await press(rendered, (setup) => setup.mockInput.pressEnter())
      await press(rendered, (setup) => setup.mockInput.pressTab({ shift: true }))
      await press(rendered, (setup) => setup.mockInput.pressArrow("up"))
      await press(rendered, (setup) => setup.mockInput.pressEnter())
    })
    expect(said.answers.map((work) => work._tag)).toEqual(["Tickets"])
  })

  test.each([
    ["Esc at the select", [] as const, "escape"],
    ["Ctrl+C at the select", [] as const, "ctrl+c"],
    ["Esc in the description", ["down", "enter"] as const, "escape"],
    ["Ctrl+C in the description", ["down", "enter"] as const, "ctrl+c"],
  ])("%s cancels", async (_, before, key) => {
    const { said, node } = start()
    await withRender(node, size, async (rendered) => {
      for (const step of before) {
        await press(rendered, (setup) =>
          step === "down" ? setup.mockInput.pressArrow("down") : setup.mockInput.pressEnter(),
        )
      }
      await press(rendered, async (setup) => {
        if (key === "escape") await pressEscape(setup)
        else setup.mockInput.pressCtrlC()
      })
    })
    expect(said.cancelled()).toBe(1)
    expect(said.answers).toEqual([])
  })

  test("the description's keys: Enter submits, Alt+Enter and Ctrl+J start a new line", () => {
    const action = (binding: Partial<(typeof descriptionKeys)[number]>) =>
      descriptionKeys.find(
        (key) =>
          key.name === binding.name &&
          (key.meta ?? false) === (binding.meta ?? false) &&
          (key.ctrl ?? false) === (binding.ctrl ?? false),
      )?.action
    expect(action({ name: "return" })).toBe("submit")
    expect(action({ name: "return", meta: true })).toBe("newline")
    expect(action({ name: "linefeed" })).toBe("newline")
    expect(action({ name: "j", ctrl: true })).toBe("newline")
  })
})

describe("the current tickets' option", () => {
  test("says how many are ready, or why none is", () => {
    expect(ticketsOption(TicketCount.Ready({ n: 1 }))).toBe("Current tickets: 1 ready")
    expect(ticketsOption(TicketCount.AllDone())).toBe("Current tickets: none, all done")
    expect(ticketsOption(TicketCount.NoneReady({ open: 4 }))).toBe(
      "Current tickets: none ready (4 open)",
    )
    expect(ticketsOption(TicketCount.Unknown())).toBe("Current tickets")
  })
})

describe("askStart", () => {
  /** `effect` running, its first render committed. */
  const forked = async <A, E>(effect: Effect.Effect<A, E>) => {
    let fiber: Fiber.Fiber<A, E> | undefined
    await act(async () => {
      fiber = Effect.runFork(effect)
    })
    return fiber as Fiber.Fiber<A, E>
  }

  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

  /** A shell over a test renderer, in React's act() environment as testRender has it. */
  const shellOf = async () => {
    const setup = await createTestRenderer({
      ...rendererConfig,
      ...size,
      onDestroy: () => {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
      },
    })
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const shell: Shell = { renderer: setup.renderer, appearance: external<Appearance>("dark") }
    return { setup, shell }
  }

  test("shows the question in the renderer and unmounts it once answered", async () => {
    const { setup, shell } = await shellOf()
    try {
      const fiber = await forked(askStart(shell, themeOf, TicketCount.Ready({ n: 2 })))
      await act(async () => {
        await setup.renderOnce()
      })
      expect(setup.captureCharFrame()).toContain("Current tickets: 2 ready")
      await act(async () => {
        setup.mockInput.pressEnter()
      })
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.isSuccess(exit) && exit.value._tag).toBe("Tickets")
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain("Current tickets")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("fails with FormCancelled on Esc", async () => {
    const { setup, shell } = await shellOf()
    try {
      const fiber = await forked(askStart(shell, themeOf, TicketCount.Unknown()))
      await act(async () => {
        await setup.renderOnce()
        await pressEscape(setup)
      })
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("FormCancelled")
      expect(new FormCancelled()._tag).toBe("FormCancelled")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("interrupted, it unmounts the question", async () => {
    const { setup, shell } = await shellOf()
    try {
      const fiber = await forked(askStart(shell, themeOf, TicketCount.Unknown()))
      await act(async () => {
        await setup.renderOnce()
      })
      expect(setup.captureCharFrame()).toContain("What should this run work on?")
      await act(async () => {
        await Effect.runPromise(Fiber.interrupt(fiber))
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain("What should this run work on?")
    } finally {
      setup.renderer.destroy()
    }
  })
})

const plan: Plan = {
  epic: { title: "Undo stack", description: "Record property edits\nin groups." },
  tickets: [
    {
      key: "undo",
      type: "feature",
      priority: 1,
      title: "Add an undo stack",
      files: ["src/history/undo.ts"],
      after: [],
    },
    {
      key: "keys",
      type: "task",
      priority: 2,
      title: "Bind Ctrl+Z",
      files: ["src/keys.ts", "src/app.ts"],
      after: ["undo"],
    },
  ],
  notes: ["linked keys after undo"],
}

describe("the plan confirmation in the renderer", () => {
  const confirmation = (question = startOnQuestion("tut-1", 2)) => {
    const said = recorder<boolean>()
    const node = <PlanConfirmation theme={dark} plan={plan} question={question} {...said.props} />
    return { said, node }
  }

  test("shows the epic and its tickets with type, priority, files and after:, then [y/N]", async () => {
    const { node } = confirmation()
    await withRender(node, size, async (rendered) => {
      const frame = await rendered.capture()
      expect(frame.chars).toContain("Epic: Undo stack")
      expect(frame.chars).toContain("  Record property edits")
      expect(frame.chars).toContain("2 tickets:")
      expect(frame.chars).toContain("  undo  feature P1  Add an undo stack")
      expect(frame.chars).toContain("  keys  task    P2  Bind Ctrl+Z")
      expect(frame.chars).toContain("        files: src/keys.ts, src/app.ts")
      expect(frame.chars).toContain("        after: undo")
      expect(frame.chars).toContain("Checking the plan:")
      expect(frame.chars).toContain("Start the run on tut-1 (2 tickets)? [y/N]")
      expect(colourOf(frame, "Start the run on")).toEqual(hex("fieldTitle"))
      expect(colourOf(frame, "[y/N]")).toEqual(hex("description"))
    })
  })

  test.each([
    ["y", true],
    ["n", false],
    ["Enter", false],
  ])("%s answers %p", async (key, expected) => {
    const { said, node } = confirmation()
    await withRender(node, size, async (rendered) => {
      await press(rendered, (setup) =>
        key === "Enter" ? setup.mockInput.pressEnter() : setup.mockInput.pressKey(key),
      )
    })
    expect(said.answers).toEqual([expected])
  })

  test("Esc cancels", async () => {
    const { said, node } = confirmation()
    await withRender(node, size, async (rendered) => {
      await press(rendered, pressEscape)
    })
    expect(said.cancelled()).toBe(1)
    expect(said.answers).toEqual([])
  })
})

describe("the plan's lines", () => {
  test("are sanitised and each on one line", () => {
    const hostile: Plan = {
      epic: { title: "a\nb\x1b]52;c;aGk=\x07", description: "" },
      tickets: [{ key: "k‮", type: "task", priority: 2, title: "t\x1b[2J", files: [], after: [] }],
      notes: [],
    }
    const text = planLines(hostile, dark).map((line) => line.map((s) => s.text).join(""))
    expect(text[0]).toBe("Epic: a b")
    for (const line of text) {
      expect(line).not.toContain("\x1b")
      expect(line).not.toContain("‮")
      expect(line).not.toContain("\n")
    }
  })
})

describe("the form styles", () => {
  test("take the form roles, as huh's Charm theme does", () => {
    expect(formStyleSpecs).toEqual({
      option: { fg: "formText", bg: null, bold: false, faint: false, focus: false },
      fieldTitle: { fg: "formTitle", bg: null, bold: true, faint: false, focus: false },
      selector: { fg: "formAccent", bg: null, bold: false, faint: false, focus: false },
      selected: { fg: "formSelected", bg: null, bold: false, faint: false, focus: false },
      selectedMark: { fg: "formSelectedMark", bg: null, bold: false, faint: false, focus: false },
      error: { fg: "formError", bg: null, bold: false, faint: false, focus: false },
      description: { fg: "formMuted", bg: null, bold: false, faint: false, focus: false },
      faint: { fg: "formFaint", bg: null, bold: false, faint: true, focus: false },
      helpKey: { fg: "formHelpKey", bg: null, bold: false, faint: false, focus: false },
      helpDesc: { fg: "formHelpDesc", bg: null, bold: false, faint: false, focus: false },
      helpSeparator: { fg: "formHelpSeparator", bg: null, bold: false, faint: false, focus: false },
      placeholder: { fg: "formPlaceholder", bg: null, bold: false, faint: false, focus: false },
      bar: { fg: "formFrame", bg: null, bold: false, faint: false, focus: false },
      focusedButton: {
        fg: "formAccentText",
        bg: "formAccent",
        bold: false,
        faint: false,
        focus: true,
      },
      button: { fg: "formText", bg: "formButton", bold: false, faint: false, focus: false },
    })
    expect(Object.keys(dark.form)).toEqual([...formStyleNames])
    expect(dark.form.fieldTitle.paint("Go?")).toBe("\x1b[1m\x1b[38;2;117;113;249mGo?\x1b[0m")
  })
})
