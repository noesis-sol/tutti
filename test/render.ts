// The one way the UI tests render a tree (§ 13): with @opentui/react/test-utils' testRender at a
// fixed size, driving input and disposing inside React's act(). testRender's dispose() unmounts
// the root from the renderer's destroy event, outside act(), and a key or click that updates state
// does so outside act() too: React then warns "An update to … inside a test was not wrapped in
// act(…)", and the frame doesn't show the update (docs/spikes/05-opentui-soak.md § 5).
import {
  type BaseRenderable,
  type CapturedFrame,
  CodeRenderable,
  type KeyEvent,
  type TimerHandle,
} from "@opentui/core"
import { ManualClock, type TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { act, type ReactNode } from "react"
import { escapeHold } from "../src/ui/keys.ts"

export type Size = { readonly width: number; readonly height: number }

/** A frame as the terminal would show it: its characters, and its spans with their colours. */
export type Frame = { readonly chars: string; readonly spans: CapturedFrame }

export type Rendered = {
  readonly setup: TestRendererSetup
  /** Runs input (setup.mockInput, setup.mockMouse, setup.resize) inside act(), then flushes. */
  readonly input: (drive: (setup: TestRendererSetup) => void | Promise<void>) => Promise<void>
  /** Captures the frame once the renderer is idle and no text is still being highlighted. */
  readonly capture: () => Promise<Frame>
}

/** How long `capture` waits for text still being highlighted before it fails, in ms. */
const highlightDeadline = 4000

/** The <code> renderables under node still highlighting, as <markdown> draws its blocks with. */
const highlighting = (node: BaseRenderable): ReadonlyArray<CodeRenderable> => [
  ...(node instanceof CodeRenderable && node.isHighlighting ? [node] : []),
  ...node.getChildren().flatMap(highlighting),
]

/**
 * Waits until the renderer is idle and no text is still being highlighted. A <markdown> block is a
 * <code> renderable that draws nothing until tree-sitter has highlighted it, off the render loop: a
 * loaded machine finishes after the renderer went idle, and the frame lacks the text (tutti-8wh).
 */
const settle = async (setup: TestRendererSetup): Promise<void> => {
  const deadline = Date.now() + highlightDeadline
  await setup.waitForVisualIdle()
  for (let busy = highlighting(setup.renderer.root); busy.length > 0; ) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`text still highlighting ${highlightDeadline} ms on`)
    await Promise.race([Promise.all(busy.map((code) => code.highlightingDone)), Bun.sleep(left)])
    await setup.waitForVisualIdle()
    busy = highlighting(setup.renderer.root)
  }
}

/**
 * A renderer's clock for the tests: OpenTUI's ManualClock kept in step with real time, which a test
 * may move ahead (`leap`) to fire the timers due by then at once, in order, without waiting for
 * them. A ManualClock alone stops the renderer: its frames are timers on the clock too, and flush()
 * and waitForVisualIdle() wait for a frame no one advances the clock to. Each timer here also sets
 * a real one that, when it fires, brings the clock up to real time and its own due timers with it.
 */
export class TestClock extends ManualClock {
  private readonly start = performance.now()
  /** How far the clock has leapt ahead of real time, in ms. */
  private leapt = 0
  /** The real timer behind each of the clock's. */
  private readonly real = new Map<TimerHandle, ReturnType<typeof setTimeout>>()

  private readonly catchUp = () => {
    const time = Math.ceil(performance.now() - this.start) + this.leapt
    if (time > this.now()) this.advance(time - this.now())
  }

  override setTimeout(fn: () => void, delayMs: number): TimerHandle {
    const handle = super.setTimeout(() => {
      this.real.delete(handle)
      fn()
    }, delayMs)
    this.real.set(handle, globalThis.setTimeout(this.catchUp, delayMs))
    return handle
  }

  override clearTimeout(handle: TimerHandle): void {
    super.clearTimeout(handle)
    globalThis.clearTimeout(this.real.get(handle))
    this.real.delete(handle)
  }

  override setInterval(fn: () => void, delayMs: number): TimerHandle {
    const handle = super.setInterval(fn, delayMs)
    this.real.set(handle, globalThis.setInterval(this.catchUp, delayMs))
    return handle
  }

  /** Moves the clock `ms` ahead, firing at once the timers due by then. */
  leap(ms: number): void {
    this.leapt += ms
    this.advance(ms)
  }
}

/** The renderer's clock, a TestClock: fails for a renderer made without one. */
const testClock = (setup: TestRendererSetup): TestClock => {
  const clock = setup.renderer.clock
  if (!(clock instanceof TestClock))
    throw new Error("the renderer has no TestClock: make it with { clock: new TestClock() }")
  return clock
}

/** Moves the renderer's clock, a TestClock, `ms` ahead: its timers due by then fire at once. */
export const leap = (setup: TestRendererSetup, ms: number): void => testClock(setup).leap(ms)

/** Renders node at size, runs body, and disposes inside act(), whether body succeeds or not. */
export const withRender = async <A>(
  node: ReactNode,
  size: Size,
  body: (rendered: Rendered) => Promise<A>,
): Promise<A> => {
  const setup = await testRender(node, {
    width: size.width,
    height: size.height,
    clock: new TestClock(),
  })
  const rendered: Rendered = {
    setup,
    input: async (drive) => {
      await act(async () => {
        await drive(setup)
      })
      await setup.flush()
    },
    capture: async () => {
      await settle(setup)
      return { chars: setup.captureCharFrame(), spans: setup.captureSpans() }
    },
  }
  try {
    await setup.flush()
    return await body(rendered)
  } finally {
    await act(async () => {
      await setup.dispose()
    })
  }
}

/** Renders node at size and returns its first frame. */
export const renderFrame = (node: ReactNode, size: Size): Promise<Frame> =>
  withRender(node, size, (rendered) => rendered.capture())

/** How long the stdin parser waits before a lone ESC is a key, in ms: OpenTUI's 20 ms. */
export const parserWait = 20

/**
 * Presses a lone Esc and hands it on as a key at once: leaps the renderer's clock (a TestClock) past
 * the stdin parser's wait to tell it from a sequence's start, and the Esc hold (`escapeHold`), both
 * timers on that clock. Listens ahead of the keymap, which stops the keys it binds from reaching
 * later listeners. Fails if no Esc came.
 */
export const pressEscape = (setup: TestRendererSetup): void => {
  const keyInput = setup.renderer.keyInput
  let pressed = false
  const heard = (key: KeyEvent) => {
    if (key.name === "escape") pressed = true
  }
  keyInput.prependListener("keypress", heard)
  try {
    setup.mockInput.pressEscape()
    leap(setup, parserWait + escapeHold)
    if (!pressed) throw new Error("no Esc key once its timers were due")
  } finally {
    keyInput.off("keypress", heard)
  }
}
