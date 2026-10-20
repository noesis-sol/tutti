// A Markdown quote in the worker view as its text streams (§ 7.11 "Markdown"): it grows as one
// quote, and the entry that replaces the live one when its message lands is drawn afresh.
// OpenTUI's <markdown> without `streaming` keeps the blocks whose text the new content starts
// with, so `> one` grown to `> one\n> two` there is two quotes; streaming, it parses the last
// two blocks again, and draws what a fresh <markdown> does.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { useSyncExternalStore } from "react"
import { type Item, type Live, transcriptVersion } from "../src/agent/Transcripts.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { entriesOf } from "../src/ui/transcriptItems.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { useSyntaxStyles } from "../src/ui/WorkerView.tsx"
import { type Frame, withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/** Markdown as the worker view draws an entry's text. */
const Markdown = ({
  content,
  streaming,
}: {
  readonly content: Settable<string>
  readonly streaming: Settable<boolean>
}) => {
  const looks = useSyntaxStyles(theme)
  const text = useSyncExternalStore(content.subscribe, content.get)
  const live = useSyncExternalStore(streaming.subscribe, streaming.get)
  return (
    <markdown
      content={text}
      syntaxStyle={looks.markdown}
      renderNode={looks.blocks}
      conceal
      streaming={live}
    />
  )
}

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/**
 * The lines `text` is drawn as once it has streamed through each of `steps` and then stopped
 * being live, its last text and the end landing together; with no steps, drawn fresh.
 */
const drawn = (text: string, steps: ReadonlyArray<string>) => {
  const content = external(steps[0] ?? text)
  const streaming = external(steps.length > 0)
  return withRender(
    <Markdown content={content} streaming={streaming} />,
    { width: 40, height: 16 },
    async (rendered) => {
      await rendered.capture()
      for (const step of steps.slice(1)) {
        await rendered.input(() => content.set(step))
        await rendered.capture()
      }
      await rendered.input(() => {
        content.set(text)
        streaming.set(false)
      })
      // Markdown is drawn once it has been highlighted: wait for each of its words, then for the
      // frame to hold.
      const words = text.match(/\w+/g) ?? []
      const deadline = Date.now() + 10_000
      let last: ReadonlyArray<string> = []
      for (;;) {
        const frame = await rendered.capture()
        const lines = linesOf(frame)
        const whole = words.every((word) => frame.chars.includes(word))
        if ((whole && lines.join("\n") === last.join("\n")) || Date.now() > deadline) return lines
        last = whole ? lines : []
        await Bun.sleep(30)
      }
    },
  )
}

const prefixes = (parts: ReadonlyArray<string>, joint: string) =>
  parts.map((_, i) => parts.slice(0, i + 1).join(joint))

const texts = [
  "Said.\n\n> one\n> two\n> three\n\nAfter.",
  "> one\n> two",
  "Intro.\n\n> a quote\n> - an item\n> - another\n\n> a second\n\nEnd.",
  "- a\n- b\n\n> q1\n> q2\nlazy\n\nPara.",
]

describe("a Markdown quote that streams", () => {
  test("is drawn as one quote, as if fresh, streamed a line or a character at a time", async () => {
    for (const text of texts) {
      const fresh = await drawn(text, [])
      const lines = text.split("\n")
      expect(await drawn(text, prefixes(lines, "\n"))).toEqual(fresh)
      expect(
        await drawn(
          text,
          prefixes(lines, "\n").map((step) => `${step}\n`),
        ),
      ).toEqual(fresh)
      expect(await drawn(text, prefixes(Array.from(text), ""))).toEqual(fresh)
    }
    expect((await drawn("Said.\n\n> one\n> two", [])).slice(0, 5)).toEqual([
      "Said.",
      "",
      "│ one",
      "│ two",
      "",
    ])
  }, 60_000)

  test("the entry its message lands as replaces the live one under a key of its own", () => {
    const live: ReadonlyArray<Live> = [{ parent: null, blocks: [{ kind: "text", text: "> one" }] }]
    const landed: Item = {
      v: transcriptVersion,
      seq: 1,
      session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
      time: "2026-10-20T13:00:00.000Z",
      message: {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "> one\n> two" }] },
        parent_tool_use_id: null,
      } as unknown as SDKMessage,
    }
    const [streaming] = entriesOf([], live)
    const [done] = entriesOf([landed])
    expect(streaming).toMatchObject({ _tag: "Text", live: true })
    expect(done).toMatchObject({ _tag: "Text", text: "> one\n> two", live: false })
    // React mounts a new <markdown> for it, which parses its text whole.
    expect(done?.key).not.toBe(streaming?.key)
  })
})
