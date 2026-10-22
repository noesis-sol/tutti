// The worker view (§ 7.5, § 7.3, § 7.11): tutti's transcript of a worker under its chrome. Each item
// kind collapsed and expanded, subagent work nested under its Agent call, thinking hidden, live
// text; the attention panel with the card's buttons and rules, and the hand-back notice; the
// window it mounts (200 at the bottom, 200 older at a time, never more than 600); the keys.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Queue, Scope } from "effect"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { type Item, type Live, Transcripts, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  appended,
  atBottom,
  type Entry,
  editOf,
  emptyTranscript,
  entriesOf,
  followed,
  lineDiff,
  markOf,
  mounted,
  mountLimit,
  type OpenTranscript,
  olderPage,
  prepended,
  readRange,
  scrolledBack,
  type ToolEntry,
  type TranscriptFeed,
  type TranscriptState,
  transcriptFeed,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable, type ShellValue } from "../src/ui/useRunView.ts"
import { entryId } from "../src/ui/WorkerView.tsx"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

// SDK messages with only the fields tutti reads, cast as the SDK's types allow.
const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

const assistant = (content: ReadonlyArray<unknown>, parent: string | null = null) =>
  sdk({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: parent })

const said = (words: string, parent: string | null = null) =>
  assistant([{ type: "text", text: words }], parent)

const thought = (words: string) => assistant([{ type: "thinking", thinking: words }])

const call = (id: string, name: string, input: unknown, parent: string | null = null) =>
  assistant([{ type: "tool_use", id, name, input }], parent)

const answered = (id: string, content: unknown, error = false, parent: string | null = null) =>
  sdk({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: error }],
    },
    parent_tool_use_id: parent,
  })

const prompt = (words: string) =>
  sdk({ type: "user", message: { role: "user", content: words }, parent_tool_use_id: null })

const result = sdk({ type: "result", subtype: "success", is_error: false })

/** `messages` as transcript items, numbered from `from`. */
const itemsOf = (messages: ReadonlyArray<SDKMessage>, from = 1): ReadonlyArray<Item> =>
  messages.map((message, i) => ({
    v: transcriptVersion,
    seq: from + i,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message,
  }))

const tools = (entries: ReadonlyArray<Entry>): ReadonlyArray<ToolEntry> =>
  entries.filter((entry): entry is ToolEntry => entry._tag === "Tool")

const edit = {
  file_path: "internal/history/undo.ts",
  old_string: "const stack = []\nexport const undo = () => stack.pop()\n",
  new_string:
    "const stack: Array<Group> = []\nexport const undo = () => stack.pop()\nexport const group = () => {}\n",
}

/** A worker's work: a prompt, text, thinking, a read, an edit, a command, a failure, a result. */
const work: ReadonlyArray<SDKMessage> = [
  prompt("Work on tut-zq4.\nRead the ticket first."),
  thought("Let me look at the history module."),
  said("I'll read the **undo** module first."),
  call("read-1", "Read", { file_path: "internal/history/undo.ts", offset: 40, limit: 3 }),
  answered(
    "read-1",
    "    40→const stack = []\n    41→export const undo = () => stack.pop()\n    42→",
  ),
  call("edit-1", "Edit", edit),
  answered("edit-1", "The file internal/history/undo.ts has been updated."),
  call("bash-1", "Bash", { command: "scripts/check-fast.sh" }),
  answered("bash-1", [{ type: "text", text: "SUITE: unit\n✓ 214 tests (3.1s)\n" }]),
  call("bash-2", "Bash", { command: "bun x nope" }),
  answered("bash-2", "Exit code 1\nerror: nope not found", true),
  said(
    "## Done\n\nThe undo stack now records `edits` in groups. See [the spec](https://x.test/spec).",
  ),
  result,
]

describe("transcript items", () => {
  test("text, tool calls with their results, and the prompt; thinking and results hidden", () => {
    const entries = entriesOf(itemsOf(work))
    expect(entries.map((entry) => entry._tag)).toEqual([
      "Prompt",
      "Text",
      "Tool",
      "Tool",
      "Tool",
      "Tool",
      "Text",
    ])
    expect(tools(entries).map((tool) => `${tool.name}  ${tool.summary}`)).toEqual([
      "Read  internal/history/undo.ts",
      "Edit  internal/history/undo.ts",
      "Bash  scripts/check-fast.sh",
      "Bash  bun x nope",
    ])
    expect(tools(entries).map(markOf)).toEqual([
      { _tag: "Done" },
      { _tag: "Edit", added: 2, removed: 1 },
      { _tag: "Done" },
      { _tag: "Error", line: "Exit code 1" },
    ])
  })

  test("a call without its result yet is pending", () => {
    const [tool] = tools(entriesOf(itemsOf([call("b", "Bash", { command: "sleep 9" })])))
    expect(tool === undefined ? undefined : markOf(tool)).toEqual({ _tag: "Pending" })
  })

  test("subagent work nests under its Agent call by parent_tool_use_id", () => {
    const entries = entriesOf(
      itemsOf([
        call("agent-1", "Agent", { description: "Find the callers", prompt: "…" }),
        said("Looking for callers.", "agent-1"),
        call("grep-1", "Grep", { pattern: "undo\\(" }, "agent-1"),
        answered("grep-1", "src/a.ts\nsrc/b.ts", false, "agent-1"),
        answered("agent-1", "Two callers."),
        said("Two callers found."),
      ]),
    )
    expect(entries.map((entry) => entry._tag)).toEqual(["Tool", "Text"])
    const [agent] = tools(entries)
    expect(agent?.summary).toBe("Find the callers")
    expect(agent?.children.map((child) => child._tag)).toEqual(["Text", "Tool"])
    // Collapsed by default: only the Agent call is mounted until it is expanded.
    expect(mounted(entries, new Set()).length).toBe(2)
    expect(mounted(entries, new Set(["agent-1"])).length).toBe(4)
  })

  test("a subagent's items whose Agent call is older than the window are kept together, nested", () => {
    const entries = entriesOf(
      itemsOf([
        said("Still looking.", "agent-0"),
        call("g", "Glob", { pattern: "*.ts" }, "agent-0"),
      ]),
    )
    expect(entries.map((entry) => entry._tag)).toEqual(["Nested"])
    expect(entries[0]?._tag === "Nested" ? entries[0].children.length : 0).toBe(2)
  })

  test("live text and a live call come last, or under their Agent call; live thinking is hidden", () => {
    const live: ReadonlyArray<Live> = [
      {
        parent: null,
        blocks: [
          { kind: "thinking", text: "" },
          { kind: "text", text: "Now the " },
        ],
      },
      { parent: "agent-1", blocks: [{ kind: "tool_use", name: "Read", text: '{"file' }] },
    ]
    const entries = entriesOf(itemsOf([call("agent-1", "Agent", { description: "Look" })]), live)
    expect(entries.map((entry) => entry._tag)).toEqual(["Tool", "Text"])
    expect(entries[1]).toMatchObject({ _tag: "Text", text: "Now the ", live: true })
    expect(tools(entries)[0]?.children).toMatchObject([{ _tag: "Tool", name: "Read", live: true }])
  })

  test("an edit's diff and counts; a Write counts its lines added", () => {
    const change = editOf("Edit", edit)
    expect(change).toMatchObject({ added: 2, removed: 1 })
    expect(change?.diff).toBe(
      [
        "--- a/internal/history/undo.ts",
        "+++ b/internal/history/undo.ts",
        "@@ -1,2 +1,3 @@",
        "-const stack = []",
        "+const stack: Array<Group> = []",
        " export const undo = () => stack.pop()",
        "+export const group = () => {}",
        "",
      ].join("\n"),
    )
    expect(editOf("Write", { file_path: "a.ts", content: "a\nb\n" })).toMatchObject({
      added: 2,
      removed: 0,
    })
    expect(editOf("Bash", { command: "ls" })).toBeUndefined()
  })

  test("the line diff keeps every line of both sides, in order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 12 }),
        fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 12 }),
        (before, after) => {
          const diff = lineDiff(before, after)
          expect(diff.filter((l) => l.op !== "+").map((l) => l.line)).toEqual(before)
          expect(diff.filter((l) => l.op !== "-").map((l) => l.line)).toEqual(after)
        },
      ),
    )
  })

  test("a read's range: the lines it gave back, else what it asked for", () => {
    const [read] = tools(entriesOf(itemsOf(work)))
    expect(read === undefined ? "" : readRange(read)).toBe("lines 40–42")
    const [asked] = tools(entriesOf(itemsOf([call("r", "Read", { file_path: "a", offset: 5 })])))
    expect(asked === undefined ? "" : readRange(asked)).toBe("from line 5")
  })

  test("text from a model or a tool is sanitised as it comes in", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.string({ unit: "binary" }), (words, out) => {
        const entries = entriesOf(
          itemsOf([said(words), call("t", words, { command: words }), answered("t", out, true)]),
        )
        const texts = entries.flatMap((entry) =>
          entry._tag === "Tool"
            ? [entry.name, entry.summary, entry.result?.text ?? ""]
            : entry._tag === "Text" || entry._tag === "Prompt"
              ? [entry.text]
              : [],
        )
        for (const text of texts) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: what sanitising removes
          expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/)
        }
      }),
    )
  })
})

describe("the window", () => {
  const many = (count: number, from = 1) =>
    itemsOf(
      Array.from({ length: count }, (_, i) => said(`item ${from + i}`)),
      from,
    )

  test("at the bottom it follows the worker with the last 200 items", () => {
    let window = windowOf(many(150))
    for (const item of many(100, 151)) window = appended(window, item)
    expect(window.items.length).toBe(atBottom)
    expect(window.items[0]?.seq).toBe(51)
    expect(window.items.at(-1)?.seq).toBe(250)
  })

  test("past the top it loads 200 older at a time, letting the newest beyond 600 go", () => {
    const file = many(1000)
    let window = windowOf(file.slice(-atBottom))
    const older = () => {
      const first = window.items[0]?.seq ?? Number.POSITIVE_INFINITY
      window = prepended(window, file.filter((item) => item.seq < first).slice(-olderPage))
    }
    older()
    expect(window.items.length).toBe(400)
    expect(window.following).toBe(false)
    older()
    older()
    expect(window.items.length).toBe(mountLimit)
    expect(window.items[0]?.seq).toBe(201)
    expect(window.items.at(-1)?.seq).toBe(800)
    older()
    older()
    expect(window.items.length).toBeLessThanOrEqual(mountLimit)
    expect(window.items[0]?.seq).toBe(1)
    older()
    expect(window.start).toBe(true)
    // Scrolled back, a new item waits for the bottom; back there, the latest items again.
    window = appended(window, many(1, 1001)[0] as Item)
    expect(window.items.at(-1)?.seq).toBe(600)
    window = followed(window)
    expect(window.items.map((item) => item.seq)).toEqual(
      Array.from({ length: atBottom }, (_, i) => 802 + i),
    )
  })

  test("scrolled back within the window, new items join it while it has room", () => {
    let window = scrolledBack(windowOf(many(10)))
    window = appended(window, many(1, 11)[0] as Item)
    expect(window.items.length).toBe(11)
    expect(window.following).toBe(false)
  })
})

const working = TicketPhase.Working({ activity: "working" })

const ledgerEntry = (ticket: string, worker: number, steered = false): LedgerEntry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: working,
  since: began,
  worker,
  row: worker - 1,
  rechecking: false,
  steered,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView for workers 1 to `workers` on tickets t-1, t-2, …, with `requests` open. */
const viewOf = (requests: ReadonlyArray<AttentionRequest> = [], workers = 2): RunView =>
  project({
    ledger: {
      tickets: new Map(
        Array.from({ length: workers }, (_, i) => [`t-${i + 1}`, ledgerEntry(`t-${i + 1}`, i + 1)]),
      ),
      rows: workers,
      windDown: null,
      bugs: [],
    },
    workers: new Map(
      Array.from({ length: workers }, (_, i) => [`t-${i + 1}`, WS.Idle({ at: began })]),
    ),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: workers },
    actions: new Map(),
  })

const permission = (id: string, over: Partial<AttentionRequest> = {}): AttentionRequest => ({
  id,
  ticket: "t-1",
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build", description: "Remove the build cache" },
    suggestions: [],
    summary: "rm -rf build",
  },
  displayName: "Bash",
  description: "Remove the build cache",
  decisionReason: "Path is outside allowed working directories",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
  ...over,
})

/** A feed of fixed transcripts, by ticket, that counts what the view asks of it. */
const fixedFeed = (by: Readonly<Record<string, ReadonlyArray<Item>>>) => {
  const opened: Array<string> = []
  const closed: Array<string> = []
  const feed: TranscriptFeed = {
    open: (ticket): OpenTranscript => {
      opened.push(ticket)
      const state = external<TranscriptState>({
        ...emptyTranscript,
        window: windowOf(by[ticket] ?? []),
      })
      return {
        state,
        older: () => {},
        scrolledBack: () => state.set({ ...state.get(), window: scrolledBack(state.get().window) }),
        follow: () => state.set({ ...state.get(), window: followed(state.get().window) }),
        close: () => {
          closed.push(ticket)
        },
      }
    },
  }
  return { feed, opened, closed }
}

/** The shell's clock, which the tests move past the panel's guard. */
const clock = (() => {
  const start = began + 67_000
  let at = start
  return {
    now: () => at,
    pass: (millis: number) => (at += millis),
    reset: () => (at = start),
  }
})()

const shellOf = (
  view: Settable<RunView>,
  commands: Commands,
  feed: TranscriptFeed,
  extra: Partial<ShellValue> = {},
): ShellValue => ({
  view,
  screen: external<Screen>(Screen.Worker({ worker: 1 })),
  commands,
  appearance: external<Appearance>("dark"),
  themeOf,
  now: clock.now,
  transcripts: feed,
  ...extra,
})

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

const shownOf = (frame: Frame): string =>
  `\n${linesOf(frame)
    .filter((line) => line !== "")
    .join("\n")}\n`

/** Captures frames until `ready` holds of one: Markdown is drawn once it has been highlighted. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** The commands sent since the last call. */
const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      switch (key) {
        case "tab":
          setup.mockInput.pressTab()
          break
        case "enter":
          setup.mockInput.pressEnter()
          break
        case "escape":
          await pressEscape(setup)
          break
        case "up":
        case "down":
        case "left":
        case "right":
          setup.mockInput.pressArrow(key)
          break
        default:
          await setup.mockInput.typeText(key)
      }
    }
  })

/** Renders the view of worker 1 over `items` and runs `body`. */
const scene = async (
  items: ReadonlyArray<Item>,
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly rendered: Rendered
    readonly feed: ReturnType<typeof fixedFeed>
  }) => Promise<void>,
  options: {
    readonly requests?: ReadonlyArray<AttentionRequest>
    readonly size?: { readonly width: number; readonly height: number }
    readonly extra?: Partial<ShellValue>
  } = {},
) => {
  clock.reset()
  const view = external(viewOf(options.requests))
  const commands = Effect.runSync(makeCommands)
  const feed = fixedFeed({ "t-1": items, "t-2": itemsOf([said("Worker two here.")]) })
  await withRender(
    <Root value={shellOf(view, commands, feed.feed, options.extra)} />,
    options.size ?? { width: 80, height: 30 },
    (rendered) => body({ view, commands, rendered, feed }),
  )
}

describe("the worker view", () => {
  test("its chrome and each item kind collapsed", async () => {
    await scene(itemsOf(work), async ({ rendered }) => {
      const frame = await until(rendered, has("The undo stack now records"))
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   1 •  t-1  done  1m07s   Title of t-1
        ────────────────────────────────────────────────────────────────────────────────
          › Work on tut-zq4.
            Read the ticket first.
          I'll read the undo module first.
          Read  internal/history/undo.ts                                               ✓
          Edit  internal/history/undo.ts                                           +2 −1
          Bash  scripts/check-fast.sh                                                  ✓
          Bash  bun x nope                                                   Exit code 1
          Done
          The undo stack now records edits in groups. See the spec (https://x.test/spec)
          .
        ────────────────────────────────────────────────────────────────────────────────
         > i to write to the worker
          Esc dashboard · i write · Ctrl+X interrupt · ↑↓ select · Enter expand · ? keys
          PgUp/PgDn scroll · g/G top/end · 1–9 workers
        "
      `)
    })
  })

  test("each tool call expanded: the read's range, the edit's diff, the command's output", async () => {
    await scene(itemsOf(work), async ({ rendered }) => {
      await until(rendered, has("The undo stack now records"))
      // From none, ↑ selects the newest item; Enter expands it, and so on up.
      await press(rendered, "up", "enter", "up", "enter", "up", "enter", "up", "enter")
      const frame = await until(rendered, has("214 tests"))
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   1 •  t-1  done  1m07s   Title of t-1
        ────────────────────────────────────────────────────────────────────────────────
          › Work on tut-zq4.
            Read the ticket first.
          I'll read the undo module first.
        ▸ Read  internal/history/undo.ts                                               ✓
            lines 40–42
          Edit  internal/history/undo.ts                                           +2 −1
             1 - const stack = []
             1 + const stack: Array<Group> = []
             2   export const undo = () => stack.pop()
             3 + export const group = () => {}
          Bash  scripts/check-fast.sh                                                  ✓
            SUITE: unit
            ✓ 214 tests (3.1s)
          Bash  bun x nope                                                   Exit code 1
            Exit code 1
            error: nope not found
          Done
          The undo stack now records edits in groups. See the spec (https://x.test/spec)
          .
        ────────────────────────────────────────────────────────────────────────────────
         > i to write to the worker
          Esc dashboard · i write · Ctrl+X interrupt · ↑↓ select · Enter expand · ? keys
          PgUp/PgDn scroll · g/G top/end · 1–9 workers
        "
      `)
      // Enter again collapses it, back to its one line.
      await press(rendered, "enter")
      const collapsed = await until(rendered, (f) => !f.chars.includes("lines 40–42"))
      expect(collapsed.chars).not.toContain("lines 40–42")
    })
  })

  test("the prompt expands to its whole text", async () => {
    const steps = Array.from({ length: 8 }, (_, i) => `Step ${i + 1}.`)
    await scene(
      itemsOf([prompt(`Work on tut-zq4.\n${steps.join("\n")}`)]),
      async ({ rendered }) => {
        // Collapsed, its first lines, the last ending ` …`.
        const collapsed = await until(rendered, has("Step 5."))
        expect(linesOf(collapsed).slice(2, 9)).toEqual([
          "  › Work on tut-zq4.",
          "    Step 1.",
          "    Step 2.",
          "    Step 3.",
          "    Step 4.",
          "    Step 5. …",
          "",
        ])
        expect(collapsed.chars).not.toContain("Step 6.")
        await press(rendered, "up", "enter")
        const frame = await until(rendered, has("Step 8."))
        expect(linesOf(frame).slice(2, 12)).toEqual([
          "▸ › Work on tut-zq4.",
          ...steps.map((step) => `    ${step}`),
          "",
        ])
      },
    )
  })

  test("a subagent's work is collapsed under its Agent call, and expands behind a faint bar", async () => {
    const items = itemsOf([
      call("agent-1", "Agent", { description: "Find the callers" }),
      said("Looking for callers.", "agent-1"),
      call("grep-1", "Grep", { pattern: "undo" }, "agent-1"),
      answered("grep-1", "src/a.ts", false, "agent-1"),
      answered("agent-1", "Two callers."),
    ])
    await scene(items, async ({ rendered }) => {
      const collapsed = await rendered.capture()
      expect(collapsed.chars).not.toContain("Looking for callers.")
      await press(rendered, "up", "enter")
      const frame = await until(rendered, has("Looking for callers."))
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Dashboard   1 •  t-1  done  1m07s   Title of t-1
        ────────────────────────────────────────────────────────────────────────────────
        ▸ Agent  Find the callers                                                      ✓
          │   Looking for callers.
          │   Grep  undo                                                               ✓
        ────────────────────────────────────────────────────────────────────────────────
         > i to write to the worker
          Esc dashboard · i write · Ctrl+X interrupt · ↑↓ select · Enter expand · ? keys
          PgUp/PgDn scroll · g/G top/end · 1–9 workers
        "
      `)
    })
  })

  test("a click on a call expands it; a click on ← Dashboard goes back", async () => {
    await scene(itemsOf(work), async ({ rendered, commands }) => {
      const frame = await until(rendered, has("The undo stack now records"))
      const y = linesOf(frame).findIndex((line) => line.includes("Bash  scripts/check-fast.sh"))
      await rendered.input((setup) => setup.mockMouse.click(6, y))
      expect((await until(rendered, has("214 tests"))).chars).toContain("SUITE: unit")
      await rendered.input((setup) => setup.mockMouse.click(3, 0))
      expect(taken(commands)).toEqual([UiCommand.CloseWorker()])
    })
  })

  test("Esc goes back to the dashboard; 1–9 switch workers", async () => {
    await scene(itemsOf(work), async ({ rendered, commands }) => {
      await press(rendered, "2", "1", "7", "escape")
      // 1 is this worker, and there is no worker 7.
      expect(taken(commands)).toEqual([
        UiCommand.OpenWorker({ worker: 2 }),
        UiCommand.CloseWorker(),
      ])
    })
  })

  test("? shows the view's keys, and while it is open only ? and Esc work", async () => {
    await scene(itemsOf(work), async ({ rendered, commands }) => {
      await press(rendered, "?")
      const frame = await rendered.capture()
      expect(frame.chars).toContain("switch to that worker")
      await press(rendered, "2", "escape")
      expect(taken(commands)).toEqual([])
      expect((await rendered.capture()).chars).not.toContain("switch to that worker")
      await press(rendered, "escape")
      expect(taken(commands)).toEqual([UiCommand.CloseWorker()])
    })
  })

  test("the view opens its worker's transcript and closes it as it goes", async () => {
    let feed: ReturnType<typeof fixedFeed> | undefined
    await scene(itemsOf(work), async (at) => {
      feed = at.feed
      expect(at.feed.opened).toEqual(["t-1"])
    })
    expect(feed?.closed).toEqual(["t-1"])
  })

  test("the chrome names neither Claude nor its product", async () => {
    await scene(itemsOf(work), async ({ rendered }) => {
      const frame = await until(rendered, has("The undo stack now records"))
      expect(frame.chars).not.toMatch(/claude/i)
      expect(frame.chars).not.toContain("⏺")
    })
  })

  test("in the theme's roles: tool names emphasis bold, ✓ done, an error needsYou, +N added", async () => {
    await scene(itemsOf(work), async ({ rendered }) => {
      const frame = await until(rendered, has("The undo stack now records"))
      const span = (text: string) => {
        for (const line of frame.spans.lines) {
          const found = line.spans.find((each) => each.text.trim() === text)
          if (found !== undefined) return found
        }
        throw new Error(`no span ${text}`)
      }
      const ints = (role: Parameters<typeof theme.rgba>[0]) => theme.rgba(role, "fg").toInts()
      expect(span("Edit").fg.toInts()).toEqual(ints("emphasis"))
      expect(span("+2").fg.toInts()).toEqual(ints("added"))
      expect(span("−1").fg.toInts()).toEqual(ints("removed"))
      expect(span("✓").fg.toInts()).toEqual(ints("done"))
      expect(span("Exit code 1").fg.toInts()).toEqual(ints("needsYou"))
      expect(span("Done").fg.toInts()).toEqual(ints("heading2"))
    })
  })
})

describe("the attention panel", () => {
  test("shows the request with its description, reason and whole input, and the card's buttons", async () => {
    await scene(
      itemsOf([said("I'll clean the build.")]),
      async ({ rendered }) => {
        const frame = await until(rendered, has("clean the build"))
        expect(shownOf(frame)).toMatchInlineSnapshot(`
          "
           ← Dashboard   1 •  t-1  permission — waiting for you  1m07s   Title of t-1
          ────────────────────────────────────────────────────────────────────────────────
            I'll clean the build.
          ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
          ┃ Bash: Remove the build cache                                               ┃
          ┃ Path is outside allowed working directories                                ┃
          ┃ [ Deny ]  [ Allow ]                                                        ┃
          ┃ rm -rf build                                                               ┃
          ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
          ────────────────────────────────────────────────────────────────────────────────
           > i to write to the worker
            Esc dashboard · i write · d deny · Ctrl+X interrupt · ↑↓ select · Enter expand
            ? keys · PgUp/PgDn scroll · g/G top/end · 1–9 workers
          "
        `)
      },
      { requests: [permission("r1")] },
    )
  })

  test("answers with the card's keys and rules: after the guard, d denies, a allows", async () => {
    await scene(
      itemsOf([said("I'll clean the build.")]),
      async ({ rendered, commands }) => {
        await press(rendered, "a")
        expect(taken(commands)).toEqual([])
        clock.pass(settle)
        await press(rendered, "a")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Allow" } }),
        ])
        await press(rendered, "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Deny" } }),
        ])
      },
      { requests: [permission("r1")] },
    )
  })

  test("with defaultToNo, a doesn't allow; Tab to Allow and Enter does", async () => {
    await scene(
      itemsOf([said("I'll clean the build.")]),
      async ({ rendered, commands }) => {
        clock.pass(settle)
        await press(rendered, "a")
        expect(taken(commands)).toEqual([])
        await press(rendered, "tab", "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Allow" } }),
        ])
      },
      { requests: [permission("r1", { defaultToNo: true })] },
    )
  })

  test("a click on a button answers it", async () => {
    await scene(
      itemsOf([said("I'll clean the build.")]),
      async ({ rendered, commands }) => {
        clock.pass(settle)
        const frame = await rendered.capture()
        const y = linesOf(frame).findIndex((line) => line.includes("[ Allow ]"))
        const x = (linesOf(frame)[y] ?? "").indexOf("[ Allow ]")
        await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r1", answer: { _tag: "Allow" } }),
        ])
      },
      { requests: [permission("r1")] },
    )
  })

  test("only the requests drawn can be selected or answered; the rest are counted under them", async () => {
    const third = permission("r3", {
      description: "Hidden third request",
      kind: {
        _tag: "Permission",
        tool: "Bash",
        input: { command: "rm -rf ~" },
        suggestions: [],
        summary: "rm -rf ~",
      },
    })
    await scene(
      itemsOf([said("Three things to do.")]),
      async ({ rendered, commands }) => {
        const frame = await rendered.capture()
        expect(frame.chars).toContain("+1 more requests")
        expect(frame.chars).not.toContain("Hidden third request")
        clock.pass(settle)
        // ↓ from the oldest goes to the second and no further: the third isn't drawn.
        await press(rendered, "down", "down", "down", "a")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({ requestId: "r2", answer: { _tag: "Allow" } }),
        ])
      },
      { requests: [permission("r1"), permission("r2"), third] },
    )
  })

  test("a long input is there whole, scrolled under the buttons, which stay in view", async () => {
    const input = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field${i + 1}`, `value ${i + 1}`]),
    )
    const long = permission("r1", {
      kind: { _tag: "Permission", tool: "Bash", input, suggestions: [], summary: "a long one" },
    })
    await scene(
      itemsOf([said("Long input ahead.")]),
      async ({ rendered }) => {
        const frame = await rendered.capture()
        expect(frame.chars).toContain("[ Deny ]")
        expect(frame.chars).toContain("field1: value 1")
        expect(frame.chars).not.toContain("field30: value 30")
        const y = linesOf(frame).findIndex((line) => line.includes("field1: value 1"))
        await rendered.input(async (setup) => {
          for (let i = 0; i < 40; i++) await setup.mockMouse.scroll(10, y, "down")
        })
        const scrolled = await rendered.capture()
        expect(scrolled.chars).toContain("field30: value 30")
        expect(scrolled.chars).toContain("[ Deny ]")
      },
      { requests: [long], size: { width: 80, height: 40 } },
    )
  })

  test("a pending hand-back for a steered worker shows as a notice with Hand it the conflict now", async () => {
    await scene(
      itemsOf([said("Waiting.")]),
      async ({ rendered, commands }) => {
        const frame = await rendered.capture()
        expect(frame.chars).toContain("A merge conflict waits for this worker")
        const y = linesOf(frame).findIndex((line) => line.includes("[ Hand it the conflict now ]"))
        const x = (linesOf(frame)[y] ?? "").indexOf("[ Hand it")
        await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
        expect(taken(commands)).toEqual([UiCommand.HandBackNow({ ticket: "t-1" })])
      },
      { extra: { handBacks: external<ReadonlyArray<string>>(["t-1"]) } },
    )
  })
})

describe("bounded rendering", () => {
  /** The Transcripts test layer, with `count` items of t-1's from an earlier run, and a feed over it. */
  const transcriptsWith = (count: number) => {
    const lines = itemsOf(
      Array.from({ length: count }, (_, i) => said(`item ${i + 1}`)),
      1,
    ).map((item) => JSON.stringify(item))
    const transcripts = Effect.runSync(
      Effect.gen(function* () {
        return yield* Transcripts
      }).pipe(Effect.provide(memoryLayer({ "t-1": lines }))),
    )
    const scope = Effect.runSync(Scope.make())
    const feed = Effect.runSync(transcriptFeed(transcripts).pipe(Scope.provide(scope)))
    return { transcripts, feed, scope }
  }

  /** How many transcript entries are mounted in the view, and the keys of the first and last. */
  const mountedIn = (rendered: Rendered) => {
    const keys: Array<string> = []
    const walk = (node: { readonly id: string; getChildren(): ReadonlyArray<unknown> }) => {
      if (node.id.startsWith(entryId(""))) keys.push(node.id.slice(entryId("").length))
      for (const child of node.getChildren()) walk(child as typeof node)
    }
    walk(rendered.setup.renderer.root as never)
    return { count: keys.length, first: keys[0], last: keys.at(-1) }
  }

  test("mounts the last 200, loads 200 older past the top, and never more than 600", async () => {
    const { feed, transcripts, scope } = transcriptsWith(1000)
    const view = external(viewOf())
    const commands = Effect.runSync(makeCommands)
    await withRender(
      <Root value={shellOf(view, commands, feed)} />,
      { width: 60, height: 20 },
      async (rendered) => {
        await until(rendered, has("item 1000"))
        expect(mountedIn(rendered)).toEqual({ count: atBottom, first: "801:0", last: "1000:0" })
        // `g` jumps to the top; at the top, it loads the page before it, as the wheel does.
        const seen: Array<ReturnType<typeof mountedIn>> = []
        for (let i = 0; i < 5; i++) {
          await press(rendered, "g", "g")
          await rendered.input(() => Bun.sleep(30))
          seen.push(mountedIn(rendered))
          if (i === 0) {
            // Your place is kept: what was the top before the load is still in view after it.
            const kept = await until(rendered, has("item 801 "))
            expect(kept.chars).toContain("item 801 ")
            expect(kept.chars).not.toContain("item 601 ")
          }
        }
        expect(seen).toEqual([
          { count: 400, first: "601:0", last: "1000:0" },
          { count: 600, first: "401:0", last: "1000:0" },
          { count: 600, first: "201:0", last: "800:0" },
          { count: 600, first: "1:0", last: "600:0" },
          { count: 600, first: "1:0", last: "600:0" },
        ])
        // A new item while scrolled back waits; G goes back to the latest 200, following.
        await rendered.input(() =>
          Effect.runPromise(transcripts.record("t-1", session, said("item 1001"))),
        )
        expect(mountedIn(rendered).last).toBe("600:0")
        await press(rendered, "G")
        await until(rendered, has("item 1001"))
        expect(mountedIn(rendered)).toEqual({ count: atBottom, first: "802:0", last: "1001:0" })
      },
    )
    Effect.runSync(Scope.close(scope, Exit.void))
  }, 30_000)

  test("while the view is open its partial text shows as it streams", async () => {
    const { feed, transcripts, scope } = transcriptsWith(3)
    const view = external(viewOf())
    const commands = Effect.runSync(makeCommands)
    const event = (e: Record<string, unknown>) =>
      transcripts.record(
        "t-1",
        session,
        sdk({ type: "stream_event", event: e, parent_tool_use_id: null }),
      )
    await withRender(
      <Root value={shellOf(view, commands, feed)} />,
      { width: 60, height: 20 },
      async (rendered) => {
        await until(rendered, has("item 3"))
        // The view hears of them through its stream, so they land inside act() after a moment.
        await rendered.input(async () => {
          await Effect.runPromise(
            Effect.gen(function* () {
              yield* event({ type: "message_start", message: {} })
              yield* event({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              })
              yield* event({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Streaming " },
              })
              yield* event({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "words" },
              })
            }),
          )
          await Bun.sleep(30)
        })
        const frame = await until(rendered, has("Streaming words"))
        expect(frame.chars).toContain("Streaming words")
      },
    )
    Effect.runSync(Scope.close(scope, Exit.void))
  })
})
