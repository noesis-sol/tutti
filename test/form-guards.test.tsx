// The guards in front of the forms ask() shows (§ 7.3, OpenTUI #1661): taking the mouse, the start
// question and the plan confirmation have the run's input guards, so a mouse report split between
// two reads neither cancels them as a lone Esc nor types its rest into the description; and a
// renderer has one set of guards, however many roots on it ask for them.
import { describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createRoot } from "@opentui/react"
import { Effect, Exit, Fiber } from "effect"
import { act } from "react"
import { escapeHold, guardInput, InputGuards } from "../src/ui/keys.ts"
import { askPlan } from "../src/ui/PlanConfirmation.tsx"
import { type Plan, TicketCount, type Work } from "../src/ui/questions.ts"
import { rendererConfig, type Shell } from "../src/ui/renderer.ts"
import { askStart } from "../src/ui/StartQuestion.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { leap, parserWait, TestClock } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const size = { width: 100, height: 24 }

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

/** A shell over a test renderer, in React's act() environment as testRender has it. */
const shellOf = async () => {
  const setup = await createTestRenderer({
    ...rendererConfig,
    ...size,
    clock: new TestClock(),
    onDestroy: () => {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    },
  })
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const shell: Shell = { renderer: setup.renderer, appearance: external<Appearance>("dark") }
  return { setup, shell }
}

/** `effect` running, its first render committed. */
const forked = async <A, E>(effect: Effect.Effect<A, E>) => {
  let fiber: Fiber.Fiber<A, E> | undefined
  await act(async () => {
    fiber = Effect.runFork(effect)
  })
  return fiber as Fiber.Fiber<A, E>
}

/** Runs `drive` inside act(), then draws a frame. */
const input = async (setup: TestRendererSetup, drive: () => void | Promise<void>) => {
  await act(async () => {
    await drive()
  })
  await act(async () => {
    await setup.renderOnce()
  })
}

/**
 * Sends `start`, then `rest` a read later, as a terminal can split a mouse report (#1661): the read
 * after the stdin parser's wait and within the Esc hold, then the hold out. Both are timers on the
 * renderer's clock, a TestClock, which this leaps, so a loaded machine can't stretch the gap past
 * them.
 */
const split = (setup: TestRendererSetup, start: string, rest: string) =>
  input(setup, () => {
    setup.renderer.stdin.emit("data", Buffer.from(start))
    leap(setup, parserWait)
    setup.renderer.stdin.emit("data", Buffer.from(rest))
    leap(setup, escapeHold)
  })

/** The start question at its description, Feature chosen. */
const describing = async (setup: TestRendererSetup) => {
  await input(setup, () => setup.mockInput.pressArrow("down"))
  await input(setup, () => setup.mockInput.pressEnter())
}

const plan: Plan = {
  epic: { title: "Undo stack", description: "Record property edits." },
  tickets: [
    {
      key: "undo",
      type: "feature",
      priority: 1,
      title: "Add an undo stack",
      files: ["src/history/undo.ts"],
      after: [],
    },
  ],
  notes: [],
}

describe("the forms ask() shows, taking the mouse", () => {
  test("a mouse report split after its Esc doesn't cancel the start question", async () => {
    const { setup, shell } = await shellOf()
    try {
      const fiber = await forked(askStart(shell, themeOf, TicketCount.Ready({ n: 2 })))
      await input(setup, () => setup.renderOnce())
      await split(setup, "\x1b", "[<35;10;5M")
      expect(fiber.pollUnsafe()).toBeUndefined()
      await input(setup, () => setup.mockInput.pressEnter())
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.isSuccess(exit) && exit.value._tag).toBe("Tickets")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a mouse report split after its ESC [ types nothing into the description", async () => {
    const { setup, shell } = await shellOf()
    try {
      const fiber = await forked(askStart(shell, themeOf, TicketCount.Ready({ n: 2 })))
      await input(setup, () => setup.renderOnce())
      await describing(setup)
      await split(setup, "\x1b[", "<64;87;26M")
      await input(setup, () => setup.mockInput.typeText("x"))
      await input(setup, () => setup.mockInput.pressEnter())
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual({
        _tag: "Feature",
        description: "x",
      } as Work)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a mouse report split after its Esc doesn't cancel the plan confirmation", async () => {
    const { setup, shell } = await shellOf()
    try {
      const fiber = await forked(askPlan(shell, themeOf, plan, "Start the run? [y/N]"))
      await input(setup, () => setup.renderOnce())
      await split(setup, "\x1b", "[<35;10;5M")
      expect(fiber.pollUnsafe()).toBeUndefined()
      await input(setup, () => setup.mockInput.pressKey("y"))
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.isSuccess(exit) && exit.value).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("one set of guards a renderer", () => {
  test("a form beside other guards on its renderer doesn't filter a report's rest twice", async () => {
    const { setup, shell } = await shellOf()
    // Guards up on the renderer before the form, as the run's input layers put them up.
    const other = createRoot(setup.renderer)
    try {
      await act(async () => {
        other.render(<InputGuards />)
      })
      const fiber = await forked(askStart(shell, themeOf, TicketCount.Ready({ n: 2 })))
      await input(setup, () => setup.renderOnce())
      await describing(setup)
      await split(setup, "\x1b[", "<64;87;26M")
      // Keys that could continue a report, typed once the report is whole.
      await input(setup, () => setup.mockInput.typeText("<5"))
      await input(setup, () => setup.mockInput.pressEnter())
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual({
        _tag: "Feature",
        description: "<5",
      } as Work)
    } finally {
      await act(async () => {
        other.unmount()
      })
      setup.renderer.destroy()
    }
  })

  test("guardInput puts the guards up once, and down once every caller has stopped", async () => {
    const { setup } = await shellOf()
    try {
      const stdin = setup.renderer.stdin
      const before = stdin.listenerCount("data")
      const first = guardInput(createOpenTuiKeymap(setup.renderer), setup.renderer)
      const up = stdin.listenerCount("data")
      expect(up).toBeGreaterThan(before)
      const second = guardInput(createOpenTuiKeymap(setup.renderer), setup.renderer)
      expect(stdin.listenerCount("data")).toBe(up)
      first()
      first()
      expect(stdin.listenerCount("data")).toBe(up)
      second()
      expect(stdin.listenerCount("data")).toBe(before)
      const again = guardInput(createOpenTuiKeymap(setup.renderer), setup.renderer)
      expect(stdin.listenerCount("data")).toBe(up)
      again()
    } finally {
      setup.renderer.destroy()
    }
  })
})
