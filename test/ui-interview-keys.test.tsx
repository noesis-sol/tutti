// The Interview view's keys and mouse (§ 4.10, § 7.3; tutti-8iz.17): PgUp and PgDn scroll its
// transcript, PgUp past the top loading older items and keeping your place; ↑↓ move between the
// entries and the panel's requests, the oldest request chosen first; Tab and → step through a
// request's buttons and on past its end, Shift+Tab and ← back; Enter presses the focused button or
// expands the entry; 1–4 pick an option; g goes to the top, loading older there, G follows the
// session; a click on an entry chooses and expands it.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Queue, Scope } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { interviewWorker } from "../src/agent/interview.ts"
import { Filing } from "../src/agent/interviewTools.ts"
import { type Item, Transcripts, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { interviewCard, interviewView } from "../src/run/interview.ts"
import type { RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { InterviewContext } from "../src/ui/InterviewView.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  atBottom,
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  transcriptFeed,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { entryId } from "../src/ui/transcriptView.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"
const description = "Add a --json flag to list.\nIt prints the list as JSON."

// SDK messages with only the fields tutti reads.
const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage
const assistant = (content: ReadonlyArray<unknown>) =>
  sdk({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null })
const said = (words: string) => assistant([{ type: "text", text: words }])
const call = (id: string, name: string, input: unknown) =>
  assistant([{ type: "tool_use", id, name, input }])
const answered = (id: string, content: string) =>
  sdk({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }],
    },
    parent_tool_use_id: null,
  })

const itemsOf = (messages: ReadonlyArray<SDKMessage>): ReadonlyArray<Item> =>
  messages.map((message, i) => ({
    v: transcriptVersion,
    seq: i + 1,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message,
  }))

/** The interview reading the code before it asks: a read and a search, each one line to expand. */
const reading = itemsOf([
  said("Let me look at how list prints first."),
  call("read-1", "Read", { file_path: "src/list.ts" }),
  answered("read-1", "export const list = () => table(rows)"),
  call("grep-1", "Grep", { pattern: "table(" }),
  answered("grep-1", "src/list.ts\nsrc/show.ts"),
])

/** The search's result, shown once it is expanded. */
const grepResult = "src/show.ts"
/** The read's range, shown once it is expanded. */
const readResult = "the whole file"

/** A question AskUserQuestion asked the interview, with its two options. */
const question = (id: string, asked: string, options: readonly [string, string]) =>
  ({
    id,
    ticket: interviewWorker,
    kind: {
      _tag: "Question",
      questions: [
        {
          question: asked,
          options: options.map((label) => ({ label })),
          multiSelect: false,
        },
      ],
      input: {},
    },
    defaultToNo: false,
    suppressAlwaysAllowRule: true,
    createdAt: began,
  }) as AttentionRequest

const shape = question("q1", "One JSON object, or one per line?", ["One object", "One per line"])
const flag = question("q2", "Name the flag --json or --format?", ["--json", "--format"])

const viewOf = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  interviewView(interviewCard(description, began, WS.Idle({ at: began }), requests))

/** A feed with the interview's transcript fixed at `items`. */
const fixedFeed = (items: ReadonlyArray<Item>): TranscriptFeed => ({
  open: (ticket): OpenTranscript => ({
    state: external<TranscriptState>({
      ...emptyTranscript,
      window: windowOf(ticket === interviewWorker ? items : []),
    }),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
})

/** The shell's clock, which the tests move past the panel's guard. */
const clock = (() => {
  const start = began + 67_000
  let at = start
  return { now: () => at, pass: (millis: number) => (at += millis), reset: () => (at = start) }
})()

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    await rendered.input(() => Bun.sleep(20))
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)
const lacks = (text: string) => (frame: Frame) => !frame.chars.includes(text)

/** The commands sent since the last call. */
const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const pageUp = "\x1b[5~"
const pageDown = "\x1b[6~"

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      switch (key) {
        case "tab":
          setup.mockInput.pressTab()
          break
        case "shift+tab":
          setup.mockInput.pressTab({ shift: true })
          break
        case "enter":
          setup.mockInput.pressEnter()
          break
        case "up":
        case "down":
        case "left":
        case "right":
          setup.mockInput.pressArrow(key)
          break
        case "pageup":
          setup.mockInput.pressKey(pageUp)
          break
        case "pagedown":
          setup.mockInput.pressKey(pageDown)
          break
        default:
          await setup.mockInput.typeText(key)
      }
    }
    await Bun.sleep(30)
  })

/** The Interview view over `feed`, with `requests` in its panel. */
const render = (
  feed: TranscriptFeed,
  requests: ReadonlyArray<AttentionRequest>,
  body: (rendered: Rendered, commands: Commands) => Promise<void>,
  size = { width: 80, height: 30 },
) => {
  clock.reset()
  const commands = Effect.runSync(makeCommands)
  const shell: ShellValue = {
    view: external(viewOf(requests)),
    screen: external<Screen>(Screen.Interview()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: clock.now,
    transcripts: feed,
  }
  return withRender(
    <InterviewContext.Provider value={{ description, filing: external(Filing.None()) }}>
      <Root value={shell} />
    </InterviewContext.Provider>,
    size,
    (rendered) => body(rendered, commands),
  )
}

/** The interview reading, then asking `requests`. */
const asking = (
  requests: ReadonlyArray<AttentionRequest>,
  body: (rendered: Rendered, commands: Commands) => Promise<void>,
) =>
  render(fixedFeed(reading), requests, async (rendered, commands) => {
    await until(rendered, has("how list prints"))
    clock.pass(settle)
    await body(rendered, commands)
  })

const chose = (id: string, answer: string) =>
  UiCommand.Answer({ requestId: id, answer: { _tag: "Choose", answers: [answer] } })

describe("the Interview view's selection", () => {
  test("the oldest request is chosen first: Enter on its picked option answers it", async () => {
    await asking([shape, flag], async (rendered, commands) => {
      await press(rendered, "2", "enter")
      expect(taken(commands)).toEqual([chose("q1", "One per line")])
    })
  })

  test("↓ moves from the oldest request to the next, and no further", async () => {
    await asking([shape, flag], async (rendered, commands) => {
      // The next request, as it becomes the target, is guarded again (tutti-14o5).
      await press(rendered, "down", "down")
      clock.pass(settle)
      await press(rendered, "1", "enter")
      expect(taken(commands)).toEqual([chose("q2", "--json")])
    })
  })

  test("↑ moves from the requests up the entries; Enter expands and collapses the one chosen", async () => {
    await asking([shape], async (rendered, commands) => {
      expect((await rendered.capture()).chars).not.toContain(grepResult)
      await press(rendered, "up", "enter")
      const grep = await until(rendered, has(grepResult))
      expect(linesOf(grep).find((line) => line.includes("Grep"))).toStartWith("▸")
      expect(grep.chars).not.toContain(readResult)
      await press(rendered, "up", "enter")
      expect((await until(rendered, has(readResult))).chars).toContain(grepResult)
      // Enter again collapses the read; ↓↓ comes back to the request, which 1 and Enter answer.
      await press(rendered, "enter")
      expect((await until(rendered, lacks(readResult))).chars).not.toContain(readResult)
      expect(taken(commands)).toEqual([])
      await press(rendered, "down", "down", "1", "enter")
      expect(taken(commands)).toEqual([chose("q1", "One object")])
    })
  })

  test("with no request, ↑ chooses the newest entry", async () => {
    await asking([], async (rendered) => {
      await press(rendered, "up", "enter")
      const frame = await until(rendered, has(grepResult))
      expect(frame.chars).not.toContain(readResult)
    })
  })

  test("a click on an entry chooses and expands it, and a second collapses it", async () => {
    await asking([shape], async (rendered, commands) => {
      const frame = await rendered.capture()
      const y = linesOf(frame).findIndex((line) => line.includes("Read  src/list.ts"))
      expect(y).toBeGreaterThan(0)
      await rendered.input((setup) => setup.mockMouse.click(6, y))
      const open = await until(rendered, has(readResult))
      expect(linesOf(open)[y]).toStartWith("▸")
      // Chosen: ↓ goes on from it, to the search below.
      await press(rendered, "down", "enter")
      expect((await until(rendered, has(grepResult))).chars).toContain(readResult)
      await rendered.input((setup) => setup.mockMouse.click(6, y))
      expect((await until(rendered, lacks(readResult))).chars).not.toContain(readResult)
      expect(taken(commands)).toEqual([])
    })
  })
})

describe("the Interview view's request card", () => {
  test("Tab steps through its options, and Enter presses the focused one", async () => {
    await asking([shape, flag], async (rendered, commands) => {
      await press(rendered, "tab", "tab", "enter")
      expect(taken(commands)).toEqual([chose("q1", "One per line")])
    })
  })

  test("→ steps as Tab does", async () => {
    await asking([shape, flag], async (rendered, commands) => {
      await press(rendered, "right", "enter")
      expect(taken(commands)).toEqual([chose("q1", "One object")])
    })
  })

  test("Tab past the card's last option moves on to the next request", async () => {
    await asking([shape, flag], async (rendered, commands) => {
      await press(rendered, "tab", "tab", "tab", "tab")
      clock.pass(settle)
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([chose("q2", "--json")])
    })
  })

  test("Shift+Tab and ← step back through the options, then on to the request before", async () => {
    await asking([shape, flag], async (rendered, commands) => {
      await press(rendered, "tab", "tab", "shift+tab", "enter")
      expect(taken(commands)).toEqual([chose("q1", "One object")])
      // On the second request, ← from its first option leaves it, back to the first request.
      await press(rendered, "down", "tab", "left", "left", "tab", "tab", "enter")
      expect(taken(commands)).toEqual([chose("q1", "One per line")])
    })
  })

  test("Shift+Tab before the first request's options moves up to the newest entry", async () => {
    await asking([shape], async (rendered, commands) => {
      await press(rendered, "shift+tab", "enter")
      expect((await until(rendered, has(grepResult))).chars).toContain(grepResult)
      expect(taken(commands)).toEqual([])
    })
  })

  test("Enter with no option focused answers nothing", async () => {
    await asking([shape], async (rendered, commands) => {
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([])
    })
  })

  test("a number beyond the question's options picks nothing", async () => {
    await asking([shape], async (rendered, commands) => {
      await press(rendered, "3", "enter", "1", "enter")
      expect(taken(commands)).toEqual([chose("q1", "One object")])
    })
  })

  test("the number keys pick nothing while an entry is chosen", async () => {
    await asking([shape], async (rendered, commands) => {
      await press(rendered, "up", "1")
      expect(taken(commands)).toEqual([])
      // Enter expands the entry still chosen, not an option.
      await press(rendered, "enter")
      expect((await until(rendered, has(grepResult))).chars).toContain(grepResult)
      expect(taken(commands)).toEqual([])
    })
  })
})

// Scrolling, with the interview's transcript in the Transcripts test layer, read through the feed.

/** The Transcripts test layer with `count` items of the interview's, `item 1` on, and its feed. */
const transcriptsWith = (count: number) => {
  const lines = itemsOf(Array.from({ length: count }, (_, i) => said(`item ${i + 1}`))).map(
    (item) => JSON.stringify(item),
  )
  const transcripts = Effect.runSync(
    Effect.gen(function* () {
      return yield* Transcripts
    }).pipe(Effect.provide(memoryLayer({ [interviewWorker]: lines }))),
  )
  const scope = Effect.runSync(Scope.make())
  const feed = Effect.runSync(transcriptFeed(transcripts).pipe(Scope.provide(scope)))
  return { transcripts, feed, scope }
}

/** The Interview view over `count` items, `item 1` to `item <count>`. */
const scrolling = async (
  count: number,
  body: (rendered: Rendered, transcripts: Transcripts["Service"]) => Promise<void>,
) => {
  const { transcripts, feed, scope } = transcriptsWith(count)
  try {
    await render(feed, [], (rendered) => body(rendered, transcripts), { width: 60, height: 20 })
  } finally {
    Effect.runSync(Scope.close(scope, Exit.void))
  }
}

/** The items the frame shows, by number, top to bottom. */
const shownItems = (frame: Frame): ReadonlyArray<number> =>
  [...frame.chars.matchAll(/item (\d+)/g)].map((match) => Number(match[1]))

const last = (items: ReadonlyArray<number>) => items.at(-1) ?? 0
const first = (items: ReadonlyArray<number>) => items[0] ?? 0

/** How many transcript entries are mounted, and the keys of the first and last. */
const mountedIn = (rendered: Rendered) => {
  const keys: Array<string> = []
  const walk = (node: { readonly id: string; getChildren(): ReadonlyArray<unknown> }) => {
    if (node.id.startsWith(entryId(""))) keys.push(node.id.slice(entryId("").length))
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(rendered.setup.renderer.root as never)
  return { count: keys.length, first: keys[0], last: keys.at(-1) }
}

const showing = (ready: (items: ReadonlyArray<number>) => boolean) => (frame: Frame) =>
  ready(shownItems(frame))

describe("scrolling the Interview view", () => {
  test("PgUp and PgDn move it a page at a time, PgDn back to the latest", async () => {
    await scrolling(250, async (rendered) => {
      const bottom = shownItems(
        await until(
          rendered,
          showing((items) => last(items) === 250),
        ),
      )
      expect(last(bottom)).toBe(250)
      await press(rendered, "pageup")
      const up = shownItems(
        await until(
          rendered,
          showing((items) => last(items) < 250),
        ),
      )
      // A page up: what was at the top is now at the bottom, or near it.
      expect(last(up)).toBeLessThan(250)
      expect(last(up)).toBeGreaterThanOrEqual(first(bottom) - 1)
      await press(rendered, "pagedown")
      const down = await until(
        rendered,
        showing((items) => last(items) === 250),
      )
      expect(last(shownItems(down))).toBe(250)
    })
  }, 30_000)

  test("PgUp at the top loads older items, keeping the place", async () => {
    await scrolling(250, async (rendered) => {
      await until(rendered, has("item 250"))
      expect(mountedIn(rendered)).toEqual({ count: atBottom, first: "51:0", last: "250:0" })
      for (let i = 0; i < 200 && mountedIn(rendered).count === atBottom; i++) {
        await press(rendered, "pageup")
      }
      expect(mountedIn(rendered)).toEqual({ count: 250, first: "1:0", last: "250:0" })
      // The item that was at the top before the load is still in view after it.
      const kept = await until(
        rendered,
        showing((items) => items.includes(51)),
      )
      expect(shownItems(kept)).toContain(51)
      expect(shownItems(kept)).not.toContain(1)
    })
  }, 60_000)

  test("g goes to the top, and there loads older items; G follows the session again", async () => {
    await scrolling(250, async (rendered, transcripts) => {
      await until(rendered, has("item 250"))
      await press(rendered, "g")
      const top = await until(
        rendered,
        showing((items) => first(items) === 51),
      )
      expect(first(shownItems(top))).toBe(51)
      expect(mountedIn(rendered).count).toBe(atBottom)
      await press(rendered, "g")
      await until(rendered, () => mountedIn(rendered).count === 250)
      expect(mountedIn(rendered)).toEqual({ count: 250, first: "1:0", last: "250:0" })
      expect(
        shownItems(
          await until(
            rendered,
            showing((items) => items.includes(51)),
          ),
        ),
      ).toContain(51)

      // Scrolled back, a new item waits; G goes to the latest, and the next one shows as it comes.
      await rendered.input(() =>
        Effect.runPromise(transcripts.record(interviewWorker, session, said("item 251"))),
      )
      expect((await rendered.capture()).chars).not.toContain("item 251")
      await press(rendered, "G")
      const end = await until(rendered, has("item 251"))
      expect(last(shownItems(end))).toBe(251)
      await rendered.input(() =>
        Effect.runPromise(transcripts.record(interviewWorker, session, said("item 252"))),
      )
      const next = await until(rendered, has("item 252"))
      expect(last(shownItems(next))).toBe(252)
    })
  }, 30_000)
})
