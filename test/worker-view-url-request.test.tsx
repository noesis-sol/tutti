// A URL elicitation in the worker view's panel (§ 4.5): its URL above the buttons, whole, so that
// you see where Open URL goes before you press it, as the dashboard's card shows it.

import { describe, expect, test } from "bun:test"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { PanelBox, panelParts } from "../src/ui/worker/Panel.tsx"
import { renderFrame } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const elicitation = (url: string | undefined): AttentionRequest => ({
  id: "r1",
  ticket: "t-1" as TicketId,
  kind: {
    _tag: "Elicitation",
    server: "linear",
    message: "Log in to Linear",
    mode: "url",
    ...(url === undefined ? {} : { url }),
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

/** `request`'s box in a pane `width` wide, drawn, with room for all its input. */
const drawn = async (request: AttentionRequest, width: number): Promise<ReadonlyArray<string>> => {
  const parts = panelParts(request, theme, { width, selected: false, focus: 0 })
  const height = parts.head.length + parts.input.length + parts.foot.length
  const frame = await renderFrame(
    <PanelBox parts={parts} room={parts.input.length} press={() => {}} />,
    { width, height },
  )
  return frame.chars
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
}

describe("a URL request in the worker view", () => {
  test("shows its URL above Open URL", async () => {
    const lines = await drawn(elicitation("https://linear.app/login"), 60)
    expect(`\n${lines.join("\n")}\n`).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────╮
      │ linear: Log in to Linear                                 │
      │ https://linear.app/login                                 │
      │ [ Decline ]  [ Open URL ]                                │
      │ Log in to Linear                                         │
      ╰──────────────────────────────────────────────────────────╯
      "
    `)
  })

  test("a URL longer than the pane is wrapped whole, above the buttons", async () => {
    const url = `https://example.test/${"a".repeat(80)}/login`
    const lines = await drawn(elicitation(url), 40)
    const buttons = lines.findIndex((line) => line.includes("[ Open URL ]"))
    const above = lines
      .slice(1, buttons)
      .map((line) => line.slice(2, -2).trim())
      .join("")
    expect(above).toContain(url)
  })

  test("one with no URL shows none", async () => {
    const lines = await drawn(elicitation(undefined), 60)
    expect(lines.some((line) => line.includes("https://"))).toBe(false)
  })

  test("the URL is in the box's head, not its scrolled input", () => {
    const parts = panelParts(elicitation("https://linear.app/login"), theme, {
      width: 60,
      selected: false,
      focus: 0,
    })
    const text = (lines: typeof parts.head) =>
      lines.map((line) => line.map((each) => each.text).join("")).join("\n")
    expect(text(parts.head)).toContain("https://linear.app/login")
    expect(text(parts.input)).not.toContain("https://linear.app/login")
  })
})
