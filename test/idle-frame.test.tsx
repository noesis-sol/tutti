// test/render.ts's idleFrame, the one-shot capture: it reads the buffer only once no frame the
// renderer scheduled itself is drawing, as reading it then fails with OutputBusy (tutti-0c0z).
import { describe, expect, spyOn, test } from "bun:test"
import type { TestRendererSetup } from "@opentui/core/testing"
import { idleFrame, withRender } from "./render.ts"

/**
 * Has setup's renderer say it is drawing a frame of its own after each of its first `busy` draws
 * (renderOnce), and runs body; records the draws done by each capture of the buffer.
 */
const drawingFor = async <A,>(
  setup: TestRendererSetup,
  busy: number,
  body: (capturedAfter: ReadonlyArray<number>) => Promise<A>,
): Promise<A> => {
  let draws = 0
  const capturedAfter: Array<number> = []
  const renderOnce = setup.renderOnce
  const captureCharFrame = setup.captureCharFrame
  const scheduler = setup.renderer.getSchedulerState.bind(setup.renderer)
  const draw = spyOn(setup, "renderOnce").mockImplementation(async () => {
    await renderOnce()
    draws++
  })
  const capture = spyOn(setup, "captureCharFrame").mockImplementation(() => {
    capturedAfter.push(draws)
    return captureCharFrame()
  })
  const state = spyOn(setup.renderer, "getSchedulerState").mockImplementation(() => ({
    ...scheduler(),
    isRendering: draws <= busy,
  }))
  try {
    return await body(capturedAfter)
  } finally {
    draw.mockRestore()
    capture.mockRestore()
    state.mockRestore()
  }
}

describe("idleFrame", () => {
  test("draws again while the renderer draws a frame of its own, then captures once", async () => {
    await withRender(<text>hello</text>, { width: 20, height: 3 }, ({ setup }) =>
      drawingFor(setup, 2, async (capturedAfter) => {
        const frame = await idleFrame(setup)
        expect(frame.split("\n")[0]?.trimEnd()).toBe("hello")
        expect(capturedAfter).toEqual([3])
      }),
    )
  })

  test("fails, capturing nothing, while the renderer never stops drawing", async () => {
    await withRender(<text>hello</text>, { width: 20, height: 3 }, ({ setup }) =>
      drawingFor(setup, Number.POSITIVE_INFINITY, async (capturedAfter) => {
        await expect(idleFrame(setup)).rejects.toThrow("still drawing a frame of its own")
        expect(capturedAfter).toEqual([])
      }),
    )
  })
})
