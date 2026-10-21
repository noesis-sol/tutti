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
} from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { act, type ReactNode } from "react"

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

/** Renders node at size, runs body, and disposes inside act(), whether body succeeds or not. */
export const withRender = async <A>(
  node: ReactNode,
  size: Size,
  body: (rendered: Rendered) => Promise<A>,
): Promise<A> => {
  const setup = await testRender(node, { width: size.width, height: size.height })
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

/** How long `pressEscape` waits for the Esc key before it fails, in ms. */
const escapeDeadline = 2000

/**
 * Presses a lone Esc and waits until the renderer hands it on as a key: after the stdin parser's
 * 20 ms wait to tell it from a sequence's start, and the Esc hold (`escapeHold`), both timers in
 * real time that a loaded machine runs late. Listens ahead of the keymap, which stops the keys it
 * binds from reaching later listeners. Fails if no Esc comes within `escapeDeadline`.
 */
export const pressEscape = async (setup: TestRendererSetup): Promise<void> => {
  const keyInput = setup.renderer.keyInput
  let heard: (key: KeyEvent) => void = () => {}
  const pressed = new Promise<boolean>((resolve) => {
    heard = (key) => {
      if (key.name === "escape") resolve(true)
    }
    keyInput.prependListener("keypress", heard)
  })
  try {
    setup.mockInput.pressEscape()
    const late = Bun.sleep(escapeDeadline).then(() => false)
    if (!(await Promise.race([pressed, late]))) {
      throw new Error(`no Esc key within ${escapeDeadline} ms of pressing it`)
    }
  } finally {
    keyInput.off("keypress", heard)
  }
}
