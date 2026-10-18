// test/render.ts, the UI tests' render helper: a frame of the requested size, input and dispose
// inside act() so that React doesn't warn, and the renderer disposed even when a test fails.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { useKeyboard } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { useState } from "react"
import { renderFrame, withRender } from "./render.ts"

const actWarning = "not wrapped in act"

// React reports the warning through console.error. The spy keeps it out of the suite's output and
// lets each test say whether it came.
let errors: ReturnType<typeof spyOn<Console, "error">>
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  errors.mockRestore()
})
const actWarnings = (): ReadonlyArray<string> =>
  errors.mock.calls.map((args) => args.map(String).join(" ")).filter((m) => m.includes(actWarning))

const Counter = () => {
  const [n, setN] = useState(0)
  useKeyboard((key) => {
    if (key.name === "a") setN((m) => m + 1)
  })
  return <text>count {n}</text>
}

describe("the UI tests' render helper", () => {
  test("renderFrame gives a frame of the requested size, without React's act() warning", async () => {
    const frame = await renderFrame(<text>hello</text>, { width: 20, height: 5 })
    const lines = frame.chars.split("\n").slice(0, 5)
    expect(lines[0]).toBe(`hello${" ".repeat(15)}`)
    expect(lines.every((l) => Bun.stringWidth(l) === 20)).toBe(true)
    expect(frame.spans.cols).toBe(20)
    expect(frame.spans.rows).toBe(5)
    expect(actWarnings()).toEqual([])
  })

  test("input runs inside act(): the frame shows the update, without the warning", async () => {
    const chars = await withRender(<Counter />, { width: 20, height: 3 }, async (rendered) => {
      await rendered.input((setup) => setup.mockInput.pressKey("a"))
      return (await rendered.capture()).chars
    })
    expect(chars.split("\n")[0]?.trimEnd()).toBe("count 1")
    expect(actWarnings()).toEqual([])
  })

  test("withRender disposes the renderer when the test's body throws", async () => {
    let renderer: { readonly isDestroyed: boolean } | undefined
    const failing = withRender(<text>hello</text>, { width: 20, height: 3 }, async (rendered) => {
      renderer = rendered.setup.renderer
      throw new Error("the test failed")
    })
    await expect(failing).rejects.toThrow("the test failed")
    expect(renderer?.isDestroyed).toBe(true)
    expect(actWarnings()).toEqual([])
  })

  // The control: what the helper is for. If OpenTUI stops warning here, the helper can go.
  test("a bare dispose() warns", async () => {
    const setup = await testRender(<text>hello</text>, { width: 20, height: 3 })
    await setup.flush()
    await setup.dispose()
    expect(actWarnings().length).toBeGreaterThan(0)
  })

  // Cards draw one line per field this way: a <text> that wraps inside a fixed-height box is drawn
  // over its siblings (docs/spikes/05-opentui-soak.md § 6).
  test("wrapMode none with truncate keeps each line of a fixed-height box on its own row", async () => {
    const long = "Card 1: Bash(scripts/check-fast.sh)"
    const frame = await renderFrame(
      <box border height={4} width={20}>
        <text wrapMode="none" truncate>
          {long}
        </text>
        <text wrapMode="none" truncate>
          second
        </text>
      </box>,
      { width: 20, height: 4 },
    )
    const [, first, second] = frame.chars.split("\n")
    expect(first).toBe("│Card 1:...fast.sh)│")
    expect(second).toBe(`│second${" ".repeat(12)}│`)
  })
})
