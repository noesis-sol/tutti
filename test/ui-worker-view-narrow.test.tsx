// The worker view in a narrow pane (§ 7.5, § 7.11; tutti-rfs): its header wraps the ticket's whole
// title onto more lines, and its hint every key, rather than cut them; neither is in the
// transcript's scrollbox. wrapped and hintLines, which lay them out, keep every word and key.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Scope } from "effect"
import fc from "fast-check"
import { Transcripts, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, type Key, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { hintLines } from "../src/ui/Hint.tsx"
import { type Segments, seg, widthOf, wrap } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { transcriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

const title = "Add tools/lint.sh to run Biome and shellcheck on the files a branch changed"

/** Worker 1 on t-1, working on `title`. */
const view: RunView = project({
  ledger: {
    tickets: new Map([
      [
        "t-1",
        {
          ticket: "t-1",
          title,
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

const said = (words: string) =>
  ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

/** The worker view of t-1 at `width` columns, its transcript one line of text. */
const narrow = async (width: number, body: (rendered: Rendered) => Promise<void>) => {
  const line = JSON.stringify({
    v: transcriptVersion,
    seq: 1,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message: said("Reading the scripts."),
  })
  const transcripts = Effect.runSync(
    Effect.gen(function* () {
      return yield* Transcripts
    }).pipe(Effect.provide(memoryLayer({ "t-1": [line] }))),
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
    await withRender(<Root value={shell} />, { width, height: 20 }, body)
  } finally {
    Effect.runSync(Scope.close(scope, Exit.void))
  }
}

const shownOf = (frame: Frame): string =>
  `\n${frame.chars
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n")}\n`

/** Captures frames until one shows `text`: Markdown is drawn once it has been highlighted. */
const until = async (rendered: Rendered, text: string): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (frame.chars.includes(text) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

describe("the worker view in a narrow pane", () => {
  test("at 60 columns the header wraps the whole title, the hint every key", async () => {
    await narrow(60, async (rendered) => {
      const frame = await until(rendered, "Reading the scripts.")
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   • t-1  done  1m07s   Add tools/lint.sh to run
            Biome and shellcheck on the files a branch changed
          1m07s  0 tokens  $0.00
        ────────────────────────────────────────────────────────────
          Reading the scripts.
        ────────────────────────────────────────────────────────────
         > i to write to the worker
          Esc dashboard · i write · t ticket · Ctrl+X interrupt
          ↑↓ select · Enter expand · ? keys · PgUp/PgDn scroll
          g/G top/end
        "
      `)
    })
  })

  test("at 40 columns, writing to the worker, the composer's keys wrap too", async () => {
    await narrow(40, async (rendered) => {
      await until(rendered, "Reading the scripts.")
      await rendered.input((setup) => setup.mockInput.typeText("i"))
      const frame = await until(rendered, "Enter send")
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   • t-1  done  1m07s   Add
            tools/lint.sh to run Biome and
            shellcheck on the files a branch
            changed
          1m07s  0 tokens  $0.00
        ────────────────────────────────────────
          Reading the scripts.
        ────────────────────────────────────────
         > your message to the worker
          Enter send · Alt+Enter/Ctrl+J new line
          Esc leave · Ctrl+X interrupt
        "
      `)
    })
  })

  test("a toast is drawn above the hint's lines, not over them", async () => {
    await narrow(60, async (rendered) => {
      await until(rendered, "Reading the scripts.")
      await rendered.input((setup) => setup.mockInput.pressKey("z", { ctrl: true }))
      const frame = await until(rendered, "can't be suspended")
      const lines = frame.chars.split("\n").map((line) => line.trimEnd())
      const hintAt = lines.findIndex((line) => line.startsWith("  Esc dashboard"))
      expect(lines[hintAt - 1]).toContain("tutti can't be suspended")
      expect(lines.slice(hintAt, hintAt + 3)).toEqual([
        "  Esc dashboard · i write · t ticket · Ctrl+X interrupt",
        "  ↑↓ select · Enter expand · ? keys · PgUp/PgDn scroll",
        "  g/G top/end",
      ])
    })
  })
})

const words = (segments: Segments): ReadonlyArray<string> =>
  segments
    .map((each) => each.text)
    .join("")
    .split(/\s+/)
    .filter((word) => word !== "")

describe("wrap, as the header and the hint take it", () => {
  test("keeps every word, in order, and no line is wider than the width", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ unit: fc.constantFrom("a", "b", " ", "é", "界", "-"), maxLength: 30 }),
        ),
        fc.integer({ min: 3, max: 40 }),
        fc.integer({ min: 0, max: 20 }),
        (texts, width, start) => {
          const segments = texts.map((text) => seg(text))
          const lines = wrap(segments, width, {
            indent: 1,
            start: Math.min(start, width),
            long: "line",
          })
          expect(words(lines.flat()).join("")).toBe(words(segments).join(""))
          lines.forEach((line, i) => {
            expect(widthOf(line) + (i === 0 ? Math.min(start, width) : 0)).toBeLessThanOrEqual(
              width,
            )
          })
        },
      ),
    )
  })

  test("breaks between words, the spaces at a break gone and the next line indented", () => {
    const lines = wrap([seg("one two three four")], 10, { indent: 2 })
    expect(lines.map((line) => line.map((each) => each.text).join(""))).toEqual([
      "one two",
      "  three",
      "  four",
    ])
  })

  test("a word wider than a line is broken at its edge", () => {
    const lines = wrap([seg("ab abcdefghij")], 6, { long: "line" })
    expect(lines.map((line) => line.map((each) => each.text).join(""))).toEqual([
      "ab",
      "abcdef",
      "ghij",
    ])
  })
})

describe("hintLines", () => {
  const key = fc.record({
    keys: fc.string({ unit: fc.constantFrom("a", "B", "+", "↑", "/"), minLength: 1, maxLength: 9 }),
    does: fc.string({ unit: fc.constantFrom("x", "y", "z"), minLength: 1, maxLength: 9 }),
  })

  test("shows every key on lines no wider than the width", () => {
    fc.assert(
      fc.property(
        fc.array(key, { maxLength: 12 }),
        fc.integer({ min: 6, max: 120 }),
        (keys: ReadonlyArray<Key>, width) => {
          const lines = hintLines(keys, theme, width)
          for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(width)
          const shown = lines.map((line) => line.map((each) => each.text).join("")).join(" ")
          const text = shown.replace(/[\s·]+/g, "")
          expect(text).toBe(keys.map((each) => `${each.keys}${each.does}`).join(""))
        },
      ),
    )
  })

  test("breaks between keys, the separator at a break gone", () => {
    const keys = [
      { keys: "Esc", does: "dashboard" },
      { keys: "i", does: "write" },
      { keys: "?", does: "keys" },
    ]
    const lines = hintLines(keys, theme, 28)
    expect(lines.map((line) => line.map((each) => each.text).join(""))).toEqual([
      "  Esc dashboard · i write",
      "  ? keys",
    ])
  })
})
