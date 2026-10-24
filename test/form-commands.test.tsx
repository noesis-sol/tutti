// The forms' keys as commands (§ 7.3, tutti-1und): init's form, the start question and the plan
// confirmation each draw their hint from the list of commands they bind, on a keymap of their own,
// without the run's input layers; a key whose command isn't there now goes on to the focused field.
import { describe, expect, test } from "bun:test"
import type { InputRenderable } from "@opentui/core"
import { useRef, useState } from "react"
import {
  type Asking,
  checklistCommands,
  confirmCommands,
  emptyScreen,
  InitView,
  scoutCommands,
  selectCommands,
  textCommands,
} from "../src/ui/InitForm.tsx"
import { type Command, hintOf, useFormCommands } from "../src/ui/keyCommands.ts"
import { PlanConfirmation, planCommands } from "../src/ui/PlanConfirmation.tsx"
import { type Plan, TicketCount, Work } from "../src/ui/questions.ts"
import { type StartActions, StartQuestion, startCommands } from "../src/ui/StartQuestion.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { type Frame, withRender } from "./render.ts"

const dark = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const size = { width: 90, height: 30 }

const nothing = () => {}

/** The hint as drawn: each key and its words, ` · ` between them. */
const drawn = (commands: ReadonlyArray<Command>) =>
  hintOf(commands)
    .map((key) => `${key.keys} ${key.does}`)
    .join(" · ")

/** The frame's line holding `text`, trimmed. */
const lineWith = (frame: Frame, text: string) =>
  frame.chars
    .split("\n")
    .find((line) => line.includes(text))
    ?.trim()

/** What a field said, in order. */
const said = () => {
  const all: Array<unknown> = []
  return { all, say: (value: unknown) => all.push(value) }
}

/** init's form asking `asking`, its clock stopped, without the run's input layers or guards. */
const initForm = (asking: Asking) => (
  <InitView
    theme={dark}
    repo="/work/shop"
    screen={{ ...emptyScreen, steps: ["Workers", "Checks"], at: 0, asking }}
    now={0}
  />
)

describe("a form's commands", () => {
  /** A focused line, and `x` bound while `on` is ticked; a click on `toggle` ticks it. */
  const Field = ({ ran }: { readonly ran: () => void }) => {
    const [on, setOn] = useState(false)
    const input = useRef<InputRenderable>(null)
    const hint = useFormCommands([
      { keys: ["x"], run: ran, when: () => on, hint: { keys: "x", does: "run" } },
      { keys: ["ctrl+t"], run: () => setOn((now) => !now) },
    ])
    return (
      <box flexDirection="column">
        <input ref={input} focused />
        <text>{`hint: ${hint.map((key) => `${key.keys} ${key.does}`).join(" · ")}`}</text>
      </box>
    )
  }

  test("bind without the run's input layers; a key whose command isn't there goes to the field", async () => {
    let runs = 0
    await withRender(<Field ran={() => runs++} />, size, async (rendered) => {
      const field = () => rendered.setup.renderer.currentFocusedRenderable as InputRenderable
      await rendered.input((setup) => setup.mockInput.typeText("x"))
      expect(runs).toBe(0)
      expect(field().value).toBe("x")
      expect(lineWith(await rendered.capture(), "hint:")).toBe("hint:")
      await rendered.input((setup) => setup.mockInput.pressKey("t", { ctrl: true }))
      await rendered.input((setup) => setup.mockInput.typeText("x"))
      expect(runs).toBe(1)
      expect(field().value).toBe("x")
      expect(lineWith(await rendered.capture(), "hint:")).toBe("hint: x run")
    })
  })
})

describe("init's form", () => {
  const confirm: Extract<Asking, { _tag: "Confirm" }> = {
    _tag: "Confirm",
    id: 1,
    field: { question: "Merge CHANGELOG.md by union?" },
    answer: nothing,
    cancel: nothing,
  }
  const select: Extract<Asking, { _tag: "Select" }> = {
    _tag: "Select",
    id: 1,
    field: { title: "Tickets at the same time", options: ["1", "2"] },
    answer: nothing,
    cancel: nothing,
  }
  const text: Extract<Asking, { _tag: "Text" }> = {
    _tag: "Text",
    id: 1,
    field: { title: "The fast check" },
    answer: nothing,
    cancel: nothing,
  }
  const checklist: Extract<Asking, { _tag: "Checklist" }> = {
    _tag: "Checklist",
    id: 1,
    field: { title: "Suites", description: "", options: ["bun test", "biome"], ticked: [0] },
    answer: nothing,
    cancel: nothing,
  }
  const scout: Extract<Asking, { _tag: "Scout" }> = {
    _tag: "Scout",
    id: 1,
    since: 0,
    skip: nothing,
    cancel: nothing,
  }
  const lists: ReadonlyArray<readonly [string, Asking, ReadonlyArray<Command>, string]> = [
    [
      "confirm",
      confirm,
      confirmCommands(confirm, { toggle: nothing, confirm: nothing }),
      "←→ choose · y yes · n no · Enter confirm · Esc cancel",
    ],
    [
      "select",
      select,
      selectCommands(select, { move: nothing, confirm: nothing }),
      "↑↓ choose · Enter confirm · Esc cancel",
    ],
    ["text", text, textCommands(text), "Enter confirm · Esc cancel"],
    [
      "checklist",
      checklist,
      checklistCommands(checklist, { move: nothing, tick: nothing, confirm: nothing }),
      "↑↓ move · Space tick · Enter confirm · Esc cancel",
    ],
    ["scout", scout, scoutCommands(scout), "Esc skip · Ctrl+C cancel"],
  ]

  test.each(lists)(
    "draws under a %s field the hint its commands give",
    async (_, asking, commands, hint) => {
      expect(drawn(commands)).toBe(hint)
      await withRender(initForm(asking), size, async (rendered) => {
        expect(lineWith(await rendered.capture(), hint.slice(0, 6))).toBe(hint)
      })
    },
  )

  test("every field cancels on Esc and Ctrl+C, but the scout, whose Esc skips it", () => {
    for (const [, asking, commands] of lists) {
      const esc = commands.find((command) => command.keys.includes("escape"))
      const ctrlC = commands.find((command) => command.keys.includes("ctrl+c"))
      expect(ctrlC?.run).toBe(asking.cancel)
      expect(esc?.run).toBe(asking._tag === "Scout" ? asking.skip : asking.cancel)
    }
  })

  test("a checklist's bound keys move, tick and confirm", async () => {
    const { all, say } = said()
    const asking: Asking = { ...checklist, answer: say }
    await withRender(initForm(asking), size, async (rendered) => {
      await rendered.input((setup) => {
        setup.mockInput.pressKey("j")
        setup.mockInput.pressKey("x")
        setup.mockInput.pressKey("k")
        setup.mockInput.pressKey(" ")
        setup.mockInput.pressEnter()
      })
    })
    expect(all).toEqual([[1]])
  })
})

describe("the start question", () => {
  const act = (step: "choose" | "describe"): StartActions => ({
    step: () => step,
    move: nothing,
    choose: nothing,
    back: nothing,
    cancel: nothing,
  })

  test("names the select's keys while it chooses, the description's while it is typed in", () => {
    expect(drawn(startCommands(act("choose")))).toBe("↑↓ choose · Enter confirm · Esc cancel")
    expect(drawn(startCommands(act("describe")))).toBe(
      "Enter submit · Alt+Enter or Ctrl+J new line · Shift+Tab back · Esc cancel",
    )
  })

  test("leaves the select's keys to the description while it is typed in", async () => {
    const { all, say } = said()
    const node = (
      <StartQuestion
        theme={dark}
        count={TicketCount.Ready({ n: 3 })}
        answer={say}
        cancel={nothing}
      />
    )
    await withRender(node, size, async (rendered) => {
      await rendered.input((setup) => {
        setup.mockInput.pressKey("j")
        setup.mockInput.pressEnter()
      })
      expect(lineWith(await rendered.capture(), "Shift+Tab")).toBe(
        drawn(startCommands(act("describe"))),
      )
      await rendered.input((setup) => setup.mockInput.typeText("jk"))
      await rendered.input((setup) => setup.mockInput.pressEnter())
    })
    expect(all).toEqual([Work.Feature({ description: "jk" })])
  })
})

describe("the plan confirmation", () => {
  const plan: Plan = {
    epic: { title: "Checkout", description: "Pay for the basket." },
    tickets: [],
    notes: [],
  }

  test("draws the hint its commands give, and Enter says no", async () => {
    const { all, say } = said()
    const answers = { answer: say, cancel: nothing }
    const hint = drawn(planCommands(answers))
    expect(hint).toBe("y yes · n or Enter no · ↑↓ scroll · Esc cancel")
    const node = <PlanConfirmation theme={dark} plan={plan} question="Start?" {...answers} />
    await withRender(node, size, async (rendered) => {
      expect(lineWith(await rendered.capture(), "y yes")).toBe(hint)
      await rendered.input((setup) => setup.mockInput.pressEnter())
    })
    expect(all).toEqual([false])
  })
})
