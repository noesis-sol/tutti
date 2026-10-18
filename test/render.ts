// The one way the UI tests render a tree (§ 13): with @opentui/react/test-utils' testRender at a
// fixed size, driving input and disposing inside React's act(). testRender's dispose() unmounts
// the root from the renderer's destroy event, outside act(), and a key or click that updates state
// does so outside act() too: React then warns "An update to … inside a test was not wrapped in
// act(…)", and the frame doesn't show the update (docs/spikes/05-opentui-soak.md § 5).
import type { CapturedFrame } from "@opentui/core"
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
  /** Captures the frame once the renderer is idle. */
  readonly capture: () => Promise<Frame>
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
      await setup.waitForVisualIdle()
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
