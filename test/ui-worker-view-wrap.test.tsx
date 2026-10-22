// Wrapping the worker view's items (§ 7.5): a message sent to the worker and a tool call's summary
// wrap to the pane's width, each item a fixed height computed from it, so that scrolling back
// through the transcript stays where you put it rather than jumping to the bottom (#1514).
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Scope } from "effect"
import fc from "fast-check"
import { Transcripts, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { type Segments, seg, widthOf, wrap } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { atBottom, entriesOf, type ToolEntry, transcriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { entryId, itemLines, toolLines } from "../src/ui/WorkerView.tsx"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

const call = (id: string, name: string, input: unknown) =>
  sdk({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: null,
  })

const answered = (id: string, content: unknown, error = false) =>
  sdk({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: error }],
    },
    parent_tool_use_id: null,
  })

const prompt = (words: string) =>
  sdk({ type: "user", message: { role: "user", content: words }, parent_tool_use_id: null })

const textOf = (line: Segments): string => line.map((each) => each.text).join("")

const textsOf = (lines: ReadonlyArray<Segments>): ReadonlyArray<string> => lines.map(textOf)

/** The words of `text`, as a wrap that keeps them whole leaves them. */
const wordsOf = (text: string): ReadonlyArray<string> => text.split(/\s+/).filter((w) => w !== "")

describe("wrap", () => {
  test("breaks before a word that doesn't fit, within one longer than a line, and at each \\n", () => {
    expect(
      textsOf(wrap([seg("  Bash  "), seg("scripts/check-fast.sh && bun test --coverage")], 30)),
    ).toEqual(["  Bash  scripts/check-fast.sh", "&& bun test --coverage"])
    expect(textsOf(wrap([seg("x".repeat(25))], 10, { indent: 2 }))).toEqual([
      "xxxxxxxxxx",
      "  xxxxxxxx",
      "  xxxxxxx",
    ])
    expect(textsOf(wrap([seg("one\n\ntwo")], 10, { indent: 4 }))).toEqual([
      "one",
      "    ",
      "    two",
    ])
  })

  test("keeps each segment's look on the lines it lands on", () => {
    const key = theme.styles.key
    const lines = wrap([seg("Read", key), seg("  a/b/c.ts and more words")], 12)
    expect(lines[0]?.[0]).toEqual(seg("Read", key))
    expect(lines.flat().filter((each) => each.look === key)).toEqual([seg("Read", key)])
  })

  test("at most `limit` lines, the last cut with … when there is more", () => {
    expect(textsOf(wrap([seg("aaa bbb ccc ddd eee")], 8, { limit: 2 }))).toEqual([
      "aaa bbb",
      "ccc ddd…",
    ])
    expect(textsOf(wrap([seg("a\nb\nc")], 8, { limit: 2 }))).toEqual(["a", "b …"])
    expect(textsOf(wrap([seg("aaa bbb")], 8, { limit: 1 }))).toEqual(["aaa bbb"])
  })

  test("wide characters take their columns", () => {
    expect(textsOf(wrap([seg("日本語のテキスト")], 9))).toEqual(["日本語の", "テキスト"])
  })

  test("its lines fit the width and keep every word, in order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z\-/.]{1,15}$/), { maxLength: 30 }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 20 }),
        (words, width, indent) => {
          const text = words.join(" ")
          const lines = wrap([seg(text)], width, { indent })
          for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(width)
          // Joined back, with the breaks within words undone, the text's words.
          const longest = Math.max(width - indent, 1)
          const joined = lines.map((line) => textOf(line).trim())
          const whole = joined.reduce(
            (out, line, i) =>
              i === 0
                ? line
                : (joined[i - 1]?.length ?? 0) >= longest
                  ? out + line
                  : `${out} ${line}`,
            "",
          )
          expect(wordsOf(whole).join("")).toBe(words.join(""))
        },
      ),
    )
  })

  test("never more than `limit` lines, each within the width, whatever the text", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 400 }),
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 8 }),
        (text, width, indent, limit) => {
          const clean = text.replace(/[\p{C}]/gu, (c) => (c === "\n" ? c : " "))
          const lines = wrap([seg(clean)], width, { indent, limit })
          expect(lines.length).toBeGreaterThanOrEqual(1)
          expect(lines.length).toBeLessThanOrEqual(limit)
          // A grapheme wider than the whole line can only overrun a line of its own.
          for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(Math.max(width, 2))
        },
      ),
    )
  })
})

describe("a tool call's lines", () => {
  const toolOf = (messages: ReadonlyArray<SDKMessage>): ToolEntry => {
    const entries = entriesOf(
      messages.map((message, i) => ({
        v: transcriptVersion,
        seq: i + 1,
        session,
        time: "2026-10-20T13:00:00.000Z",
        message,
      })),
    )
    const tool = entries.find((entry): entry is ToolEntry => entry._tag === "Tool")
    if (tool === undefined) throw new Error("no tool call")
    return tool
  }
  const command = "scripts/check-fast.sh && bun test test/ui-worker-view-wrap.test.tsx --bail"

  test("wrap under the summary, the mark at the end of the last line", () => {
    const tool = toolOf([call("b", "Bash", { command }), answered("b", "ok")])
    expect(textsOf(toolLines(tool, theme, 44, false))).toEqual([
      "  Bash  scripts/check-fast.sh && bun test",
      "        test/ui-worker-view-wrap.test.tsx",
      `${"        --bail".padEnd(41)}  ✓`,
    ])
  })

  test("the mark on a line of its own when the last line has no room for it", () => {
    const tool = toolOf([
      call("b", "Bash", { command: "scripts/check-fast.sh && bun x tsc --noEmit --pretty-for-ci" }),
      answered("b", "error: no tsc, no bun x", true),
    ])
    expect(textsOf(toolLines(tool, theme, 50, false))).toEqual([
      "  Bash  scripts/check-fast.sh && bun x tsc",
      "        --noEmit --pretty-for-ci",
      `${" ".repeat(25)}  error: no tsc, no bun x`,
    ])
  })

  test("a summary cut short leaves the last of its lines to a mark that doesn't fit beside it", () => {
    const input = { command: "word ".repeat(80) }
    const pending = textsOf(toolLines(toolOf([call("b", "Bash", input)]), theme, 40, false))
    const done = textsOf(
      toolLines(toolOf([call("b", "Bash", input), answered("b", "ok")]), theme, 40, false),
    )
    expect(pending.length).toBe(itemLines)
    expect(pending.at(-1)).toEndWith("…")
    expect(done.length).toBe(itemLines)
    expect(done.at(-2)).toEndWith("…")
    expect(done.at(-1)).toBe(`${" ".repeat(37)}  ✓`)
  })

  test("as many lines with its result as without, or one more: never fewer", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 300 }),
        fc.integer({ min: 8, max: 120 }),
        fc.constantFrom("ok", "error: it failed"),
        (text, width, output) => {
          const input = { command: text.replace(/[\p{C}]/gu, " ") }
          const pending = toolLines(toolOf([call("b", "Bash", input)]), theme, width, false)
          const done = toolLines(
            toolOf([call("b", "Bash", input), answered("b", output, output !== "ok")]),
            theme,
            width,
            false,
          )
          expect(done.length - pending.length).toBeGreaterThanOrEqual(0)
          expect(done.length - pending.length).toBeLessThanOrEqual(1)
          expect(pending.length).toBeLessThanOrEqual(itemLines)
          expect(done.length).toBeLessThanOrEqual(itemLines)
        },
      ),
    )
  })
})

/** Worker 1 on t-1, working. */
const view: RunView = project({
  ledger: {
    tickets: new Map([
      [
        "t-1",
        {
          ticket: "t-1",
          title: "Title of t-1",
          phase: TicketPhase.Working({ activity: "working" }),
          since: began,
          worker: 1,
          row: 0,
          rechecking: false,
          steered: false,
          lastMessage: null,
          tallies: emptyTallies,
        },
      ],
    ]),
    rows: 1,
    windDown: null,
    bugs: [],
  },
  workers: new Map([["t-1", WS.Idle({ at: began })]]),
  requests: [],
  status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
  actions: new Map(),
})

/** The worker view of t-1 over `messages`, `width` wide. */
const viewing = async (
  messages: ReadonlyArray<SDKMessage>,
  size: { readonly width: number; readonly height: number },
  body: (rendered: Rendered) => Promise<void>,
) => {
  const lines = messages.map((message, i) =>
    JSON.stringify({
      v: transcriptVersion,
      seq: i + 1,
      session,
      time: "2026-10-20T13:00:00.000Z",
      message,
    }),
  )
  const transcripts = Effect.runSync(
    Effect.gen(function* () {
      return yield* Transcripts
    }).pipe(Effect.provide(memoryLayer({ "t-1": lines }))),
  )
  const scope = Effect.runSync(Scope.make())
  const feed = Effect.runSync(transcriptFeed(transcripts).pipe(Scope.provide(scope)))
  const shell: ShellValue = {
    view: external(view),
    screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 67_000,
    transcripts: feed,
  }
  try {
    await withRender(<Root value={shell} />, size, body)
  } finally {
    Effect.runSync(Scope.close(scope, Exit.void))
  }
}

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** The frame's first `count` lines under the rule below the header, which a narrow pane wraps. */
const itemsIn = (frame: Frame, count: number): ReadonlyArray<string> => {
  const lines = linesOf(frame)
  const from = lines.findIndex((line) => line.startsWith("─")) + 1
  return lines.slice(from, from + count)
}

describe("the worker view's wrapped items", () => {
  test("a sent message and a tool call's summary wrap to the pane's width", async () => {
    const messages = [
      prompt(
        "Carry on with the ticket, and when the checks pass, have the verifier look at the change.\nThen close it.",
      ),
      call("b", "Bash", {
        command: "scripts/check-own.sh > .orchestra/run/worker-check.log 2>&1; echo exit",
      }),
      answered("b", "exit 0"),
    ]
    await viewing(messages, { width: 48, height: 16 }, async (rendered) => {
      const frame = await rendered.capture()
      expect(itemsIn(frame, 7)).toEqual([
        "  › Carry on with the ticket, and when the",
        "    checks pass, have the verifier look at the",
        "    change.",
        "    Then close it.",
        "  Bash  scripts/check-own.sh >",
        "        .orchestra/run/worker-check.log 2>&1;",
        `${"        echo exit".padEnd(45)}  ✓`,
      ])
      for (const line of linesOf(frame)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(48)
    })
  })

  test("a resize wraps them anew to the new width", async () => {
    const messages = [prompt("Carry on with the ticket, and close it once the checks pass.")]
    await viewing(messages, { width: 40, height: 16 }, async (rendered) => {
      expect(itemsIn(await rendered.capture(), 2)).toEqual([
        "  › Carry on with the ticket, and close",
        "    it once the checks pass.",
      ])
      await rendered.input((setup) => setup.resize(80, 16))
      expect(itemsIn(await rendered.capture(), 2)).toEqual([
        "  › Carry on with the ticket, and close it once the checks pass.",
        "",
      ])
    })
  })
})

/** `count` calls, `item 1` to `item <count>`, each wrapping over a few lines, and their results. */
const wrappingCalls = (count: number): ReadonlyArray<SDKMessage> =>
  Array.from({ length: count }, (_, i) => [
    call(`b${i + 1}`, "Bash", {
      command: `item ${i + 1} && scripts/check-own.sh > .orchestra/run/worker-check.log 2>&1`,
    }),
    i % 3 === 0 ? prompt(`Message ${i + 1}: carry on with the ticket and close it.`) : null,
    answered(`b${i + 1}`, "exit 0"),
  ]).flatMap((each) => each.filter((message) => message !== null))

/** The calls the frame shows, by number, top to bottom. */
const shownItems = (frame: Frame): ReadonlyArray<number> =>
  [...frame.chars.matchAll(/item (\d+)/g)].map((match) => Number(match[1]))

/** How many transcript entries are mounted. */
const mountedIn = (rendered: Rendered): number => {
  let count = 0
  const walk = (node: { readonly id: string; getChildren(): ReadonlyArray<unknown> }) => {
    if (node.id.startsWith(entryId(""))) count++
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(rendered.setup.renderer.root as never)
  return count
}

const pageUp = "\x1b[5~"

const press = (rendered: Rendered, key: string) =>
  rendered.input(async (setup) => {
    setup.mockInput.pressKey(key)
    await Bun.sleep(30)
  })

const wheel = (rendered: Rendered, direction: "up" | "down") =>
  rendered.input(async (setup) => {
    await setup.mockMouse.scroll(20, 8, direction)
    await Bun.sleep(30)
  })

/** The items the next `frames` frames show, a frame every 20 ms, each frame's own. */
const framesOf = async (rendered: Rendered, frames: number) => {
  const seen: Array<ReadonlyArray<number>> = []
  for (let i = 0; i < frames; i++) {
    await rendered.input(() => Bun.sleep(20))
    seen.push(shownItems(await rendered.capture()))
  }
  return seen
}

describe("scrolling back through wrapped items", () => {
  test("PgUp and the wheel keep the place, through 200 and more items, and past the top", async () => {
    await viewing(wrappingCalls(250), { width: 60, height: 20 }, async (rendered) => {
      const bottom = shownItems(await rendered.capture())
      expect(bottom.at(-1)).toBe(250)
      expect(mountedIn(rendered)).toBeGreaterThan(0)

      // A few pages back, the view stays there frame after frame.
      for (let i = 0; i < 4; i++) await press(rendered, pageUp)
      const back = shownItems(await rendered.capture())
      expect(back.at(-1) ?? 250).toBeLessThan(bottom[0] ?? 0)
      for (const frame of await framesOf(rendered, 10)) expect(frame).toEqual(back)

      // The wheel too.
      for (let i = 0; i < 5; i++) await wheel(rendered, "up")
      const wheeled = shownItems(await rendered.capture())
      expect(wheeled[0] ?? 0).toBeLessThan(back[0] ?? 0)
      for (const frame of await framesOf(rendered, 10)) expect(frame).toEqual(wheeled)

      // Back to the window's first item and past it: the older items load, the place is kept,
      // and it stays there.
      const before = mountedIn(rendered)
      for (let i = 0; i < 400 && mountedIn(rendered) === before; i++) await press(rendered, pageUp)
      expect(mountedIn(rendered)).toBeGreaterThan(before)
      const frames = await framesOf(rendered, 15)
      const settled = frames.at(-1) ?? []
      expect(settled.length).toBeGreaterThan(0)
      expect(Math.max(...settled)).toBeLessThan(250 - atBottom / 3)
      for (const frame of frames.slice(-5)) expect(frame).toEqual(settled)
    })
  }, 60_000)
})
