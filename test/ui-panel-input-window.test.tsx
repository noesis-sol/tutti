// A request's long input in the worker view's panel (tutti-x4wu): wrapped once a request and width,
// apart from its selection and focused button, and drawn only as far as its room shows it, the
// wheel moving that window.
import { describe, expect, test } from "bun:test"
import type { BaseRenderable } from "@opentui/core"
import { useState } from "react"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import type { Segments } from "../src/ui/line.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { PanelBox, panelInput, panelParts, usePanelParts } from "../src/ui/worker/Panel.tsx"
import { withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/** A Write of `count` numbered lines. */
const write = (count: number): AttentionRequest => ({
  id: "r1",
  ticket: "t-1",
  kind: {
    _tag: "Permission",
    tool: "Write",
    input: {
      file_path: "/tmp/long.txt",
      content: Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n"),
    },
    suggestions: [],
    summary: "",
  },
  displayName: "Write",
  description: "Write a long file",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

/** How many renderables there are under node, itself included. */
const mounted = (node: BaseRenderable): number =>
  1 + node.getChildren().reduce((sum, child) => sum + mounted(child), 0)

/** The frame's lines that show `line N` of the input, by N. */
const numbers = (chars: string): ReadonlyArray<number> =>
  [...chars.matchAll(/line (\d+)\b/g)].map((match) => Number(match[1]))

const textOf = (lines: ReadonlyArray<Segments>): ReadonlyArray<string> =>
  lines.map((line) => line.map((each) => each.text).join(""))

describe("a request's long input in the panel", () => {
  const width = 60

  test("a 3,000-line Write mounts only the lines its room shows", async () => {
    const parts = panelParts(write(3000), theme, { width, selected: false, focus: 0 })
    expect(parts.input.length).toBeGreaterThan(3000)
    const room = 10
    const height = parts.head.length + room + parts.foot.length
    await withRender(
      <PanelBox parts={parts} room={room} press={() => {}} />,
      { width, height },
      async (rendered) => {
        const frame = await rendered.capture()
        expect(frame.chars).toContain("line 1")
        expect(frame.chars).not.toContain("line 3000")
        // Each line is a <text> with a span or few: far fewer than the input's 3,000 lines.
        expect(mounted(rendered.setup.renderer.root)).toBeLessThan(height * 6)
      },
    )
  })

  test("the wheel moves the window, line by line, no further than the input's ends", async () => {
    const parts = panelParts(write(40), theme, { width, selected: false, focus: 0 })
    const room = 5
    const height = parts.head.length + room + parts.foot.length
    /** The input's lines from `top`, as the box draws them in its room. */
    const window = (top: number) => [...textOf(parts.sides(parts.input.slice(top, top + room)))]
    await withRender(
      <PanelBox parts={parts} room={room} press={() => {}} />,
      { width, height },
      async (rendered) => {
        const y = parts.head.length + 1
        /** The rows the box draws its input in. */
        const drawn = async () =>
          (await rendered.capture()).chars
            .split("\n")
            .slice(parts.head.length, parts.head.length + room)
            .map((line) => line.trimEnd())
        const wheel = (direction: "up" | "down", times: number) =>
          rendered.input(async (setup) => {
            for (let i = 0; i < times; i++) await setup.mockMouse.scroll(10, y, direction)
          })
        expect(await drawn()).toEqual(window(0))
        await wheel("down", 1)
        expect(await drawn()).toEqual(window(1))
        await wheel("down", 100)
        expect(await drawn()).toEqual(window(parts.input.length - room))
        expect(numbers((await rendered.capture()).chars).at(-1)).toBe(40)
        await wheel("up", 100)
        expect(await drawn()).toEqual(window(0))
      },
    )
  })

  test("the input is wrapped once: panelParts takes it as given, and frames it as selected", () => {
    const request = write(30)
    const input = panelInput(request, theme, width)
    const plain = panelParts(request, theme, { width, selected: false, focus: 0, input })
    const selected = panelParts(request, theme, { width, selected: true, focus: 1, input })
    expect(plain.input).toBe(input)
    expect(selected.input).toBe(input)
    expect(textOf(plain.sides(input))).toEqual(
      textOf(panelParts(request, theme, { width, selected: false, focus: 0 }).sides(input)),
    )
    for (const line of textOf(selected.sides(input.slice(0, 3)))) {
      expect(line.startsWith("┃")).toBe(true)
      expect(line.endsWith("┃")).toBe(true)
      expect(Bun.stringWidth(line)).toBe(width)
    }
    expect(textOf(plain.sides(input.slice(0, 1)))[0]?.startsWith("│")).toBe(true)
  })

  test("a Tab or a moved selection draws the box anew without wrapping its input again", async () => {
    let reads = 0
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")
    const base = write(0)
    const request: AttentionRequest = {
      ...base,
      kind: {
        _tag: "Permission",
        tool: "Write",
        input: {
          file_path: "/tmp/long.txt",
          get content() {
            reads++
            return content
          },
        },
        suggestions: [],
        summary: "",
      },
    }
    type Shown = { readonly width: number; readonly selected: boolean; readonly focus: number }
    let show: (shown: Shown) => void = () => {}
    /** The request's box as the panel draws it, with what `show` gives it. */
    const Probe = () => {
      const [shown, setShown] = useState<Shown>({ width, selected: false, focus: 0 })
      show = setShown
      const parts = usePanelParts(request, theme, shown)
      return <PanelBox parts={parts} room={5} press={() => {}} />
    }
    await withRender(<Probe />, { width: 80, height: 12 }, async (rendered) => {
      const first = await rendered.capture()
      expect(first.chars).toContain("╭")
      const wrapped = reads
      expect(wrapped).toBeGreaterThan(0)
      await rendered.input(() => show({ width, selected: true, focus: 1 }))
      expect((await rendered.capture()).chars).toContain("┏")
      await rendered.input(() => show({ width, selected: false, focus: 0 }))
      await rendered.input(() => show({ width, selected: true, focus: 0 }))
      await rendered.capture()
      expect(reads).toBe(wrapped)
      // A new width wraps it again.
      await rendered.input(() => show({ width: width - 10, selected: true, focus: 0 }))
      await rendered.capture()
      expect(reads).toBeGreaterThan(wrapped)
    })
  })
})
