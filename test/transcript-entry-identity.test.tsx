// A transcript's entries keep their identity (tutti-rvzn.2): the items' entries are worked out as
// the items change and kept while each is the same, the partial messages laid over them as each
// token comes; each entry is drawn with only what concerns it. So a streamed token redraws the one
// entry it grows, and an arrow key the two whose selection changed, not the whole transcript.

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import fc from "fast-check"
import type { ReactNode } from "react"
import {
  type Item,
  type Live,
  type LiveBlock,
  transcriptVersion,
} from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  bounded,
  type Entry,
  emptyTranscript,
  entriesOf,
  keptEntries,
  mounted,
  type OpenTranscript,
  type TranscriptState,
  windowOf,
  withLive,
} from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { EntryView } from "../src/ui/worker/Story.tsx"
import { type Rendered, withRender } from "./render.ts"

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

/** `messages` as transcript items, numbered from 1. */
const itemsOf = (messages: ReadonlyArray<SDKMessage>): ReadonlyArray<Item> =>
  messages.map((message, i) => ({
    v: transcriptVersion,
    seq: i + 1,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message,
  }))

// The model-written messages the properties are about: few IDs and uuids, so that calls nest,
// results answer them and sent messages are queued or cancelled.
const ids = ["t1", "t2", "t3", "t4"]
const uuids = ["u1", "u2", "u3"]
const anyText = fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.constant("  \n"))
const parentArb = fc.option(fc.constantFrom(...ids), { nil: null })

const assistantArb = fc
  .record({
    parent: parentArb,
    blocks: fc.array(
      fc.oneof(
        fc.record({ type: fc.constant("text"), text: anyText }),
        fc.record({
          type: fc.constantFrom("tool_use", "server_tool_use"),
          id: fc.constantFrom(...ids),
          name: fc.constantFrom("Agent", "Task", "Bash", "Read"),
          input: fc.record({ command: anyText }),
        }),
        fc.record({ type: fc.constant("thinking"), thinking: anyText }),
      ),
      { maxLength: 3 },
    ),
  })
  .map(({ parent, blocks }) =>
    sdk({
      type: "assistant",
      message: { role: "assistant", content: blocks },
      parent_tool_use_id: parent,
    }),
  )

const resultArb = fc
  .record({
    parent: parentArb,
    id: fc.constantFrom(...ids),
    content: anyText,
    error: fc.boolean(),
  })
  .map(({ parent, id, content, error }) =>
    sdk({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content, is_error: error }],
      },
      parent_tool_use_id: parent,
    }),
  )

const sentArb = fc
  .record({ uuid: fc.constantFrom(...uuids), text: anyText, parent: parentArb })
  .map(({ uuid, text, parent }) =>
    sdk({
      type: "user",
      uuid,
      message: { role: "user", content: text },
      parent_tool_use_id: parent,
    }),
  )

const cancelledArb = fc
  .constantFrom(...uuids)
  .map((uuid) => sdk({ type: "command_lifecycle", command_uuid: uuid, state: "cancelled" }))

const itemsArb = fc
  .array(fc.oneof(assistantArb, assistantArb, resultArb, sentArb, cancelledArb), {
    maxLength: 14,
  })
  .map(itemsOf)

const blockArb: fc.Arbitrary<LiveBlock | undefined> = fc.option(
  fc.oneof(
    fc.record({ kind: fc.constantFrom("text" as const, "thinking" as const), text: anyText }),
    fc.record({
      kind: fc.constant("tool_use" as const),
      name: fc.constantFrom("Agent", "Bash", "Read"),
      text: anyText,
    }),
    fc.record({ kind: fc.constant("tool_use" as const), text: anyText }),
  ),
  { nil: undefined },
)

// One partial message for each parent, as Transcripts keeps them.
const liveArb: fc.Arbitrary<ReadonlyArray<Live>> = fc.uniqueArray(
  fc.record({ parent: parentArb, blocks: fc.array(blockArb, { maxLength: 3 }) }),
  { maxLength: 3, selector: (message) => message.parent },
)

const queuedArb = fc.subarray(uuids).map((each) => new Set(each))

/** Every entry of `entries`, those under calls and groups too. */
const everyEntry = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> =>
  entries.flatMap((entry) => [
    entry,
    ...(entry._tag === "Tool" || entry._tag === "Nested" ? everyEntry(entry.children) : []),
  ])

describe("the partial messages laid over the items' entries", () => {
  test("are the entries of the items and the partial messages together", () => {
    fc.assert(
      fc.property(itemsArb, liveArb, queuedArb, (items, live, queued) => {
        expect(withLive(entriesOf(items, [], queued), live)).toEqual(entriesOf(items, live, queued))
      }),
    )
  })

  test("keep every entry not along the way to a partial message", () => {
    fc.assert(
      fc.property(itemsArb, liveArb, (items, live) => {
        const settled = entriesOf(items)
        const shown = new Set(everyEntry(withLive(settled, live)))
        // The entries a partial message is placed under: its call, or the group of its call's
        // subagent work, and those above it.
        const parents = new Set(
          live.flatMap((message) =>
            message.parent === null ? [] : [message.parent, `nested:${message.parent}`],
          ),
        )
        const along = (entry: Entry): boolean =>
          parents.has(entry.key) ||
          ((entry._tag === "Tool" || entry._tag === "Nested") && entry.children.some(along))
        for (const entry of everyEntry(settled)) {
          if (!along(entry)) expect(shown.has(entry)).toBe(true)
        }
      }),
    )
  })
})

describe("entries kept from one working out to the next", () => {
  test("are the new entries, each the previous one where it is the same", () => {
    fc.assert(
      fc.property(itemsArb, itemsArb, liveArb, (before, after, live) => {
        const previous = entriesOf(before)
        const next = entriesOf(
          [...before, ...after].map((item, i) => ({ ...item, seq: i + 1 })),
          live,
        )
        const kept = keptEntries(previous, next)
        expect(kept).toEqual(next)
        const old = new Map(previous.map((entry) => [entry.key, entry]))
        for (const entry of kept) {
          const was = old.get(entry.key)
          if (was !== undefined && Bun.deepEquals(was, entry, true)) expect(entry).toBe(was)
        }
      }),
    )
  })

  test("are the previous list itself when nothing changed", () => {
    fc.assert(
      fc.property(itemsArb, liveArb, (items, live) => {
        const previous = entriesOf(items, live)
        expect(keptEntries(previous, entriesOf(items, live))).toBe(previous)
      }),
    )
  })

  test("keep the unchanged children of a call whose subagent work grew", () => {
    const call = sdk({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "a-1", name: "Agent", input: { prompt: "look" } }],
      },
      parent_tool_use_id: null,
    })
    const said = (text: string) =>
      sdk({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
        parent_tool_use_id: "a-1",
      })
    const previous = entriesOf(itemsOf([call, said("One.")]))
    const kept = keptEntries(previous, entriesOf(itemsOf([call, said("One."), said("Two.")])))
    const [agent] = kept
    const [was] = previous
    expect(agent).not.toBe(was as Entry)
    expect(agent?._tag === "Tool" && agent.children[0]).toBe(
      was?._tag === "Tool" ? (was.children[0] as Entry) : (undefined as never),
    )
  })
})

describe("the entries mounted within the bound", () => {
  /** What bounded gave before it counted each entry once. */
  const dropping = (
    entries: ReadonlyArray<Entry>,
    expanded: ReadonlySet<string>,
    following: boolean,
    limit: number,
  ): ReadonlyArray<Entry> => {
    let kept = entries
    while (kept.length > 0 && mounted(kept, expanded).length > limit) {
      kept = following ? kept.slice(1) : kept.slice(0, -1)
    }
    return kept
  }

  test("are those dropping the oldest, or the newest, one at a time gives", () => {
    fc.assert(
      fc.property(
        itemsArb,
        fc.subarray([...ids, ...ids.map((id) => `nested:${id}`)]),
        fc.boolean(),
        fc.nat(12),
        (items, open, following, limit) => {
          const entries = entriesOf(items)
          const expanded = new Set(open)
          expect(bounded(entries, expanded, following, limit)).toEqual(
            dropping(entries, expanded, following, limit),
          )
        },
      ),
    )
  })
})

// The view, counting each entry's drawings.

const call = (id: string, name: string, input: unknown, parent: string | null = null) =>
  sdk({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: parent,
  })

const answered = (id: string, content: string, parent: string | null = null) =>
  sdk({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }],
    },
    parent_tool_use_id: parent,
  })

const said = (text: string) =>
  sdk({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  })

const scenario = itemsOf([
  said("Looking at the code first."),
  call("b-1", "Bash", { command: "ls src" }),
  answered("b-1", "a.ts\nb.ts"),
  call("r-1", "Read", { file_path: "src/a.ts" }),
  answered("r-1", "1→const a = 1"),
  call("a-1", "Agent", { description: "look around", prompt: "Look." }),
  call("g-1", "Grep", { pattern: "a" }, "a-1"),
  answered("g-1", "src/a.ts", "a-1"),
  call("b-2", "Bash", { command: "bun test" }),
  answered("b-2", "ok"),
])

const view: RunView = project({
  ledger: {
    tickets: new Map([
      [
        "t-1" as TicketId,
        {
          ticket: "t-1" as TicketId,
          title: "Title of t-1",
          phase: TicketPhase.Working(),
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

/** The shell over worker 1's view, its transcript `state`. */
const shellOf = (state: ReturnType<typeof external<TranscriptState>>): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf: (appearance) => makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false }),
  now: () => began,
  transcripts: {
    open: (): OpenTranscript => ({
      state,
      older: () => {},
      scrolledBack: () => {},
      follow: () => {},
      close: () => {},
    }),
  },
})

type Counted = { type: (props: { readonly entry: Entry }) => ReactNode }

/** Runs `body` with each EntryView drawing's entry key put in `drawn`. */
const counting = async (body: (drawn: Array<string>) => Promise<void>) => {
  // A memo's component is its `type`, called for each drawing that the memo doesn't hold.
  const memoised = EntryView as unknown as Counted
  const draw = memoised.type
  const drawn: Array<string> = []
  memoised.type = (props) => {
    drawn.push(props.entry.key)
    return draw(props)
  }
  try {
    await body(drawn)
  } finally {
    memoised.type = draw
  }
}

const arrow = (rendered: Rendered, key: "up" | "down") =>
  rendered.input((setup) => setup.mockInput.pressArrow(key))

/** The keys drawn while `drive` runs. */
const drawnBy = async (drawn: Array<string>, drive: () => Promise<void>) => {
  drawn.length = 0
  await drive()
  return [...drawn].sort()
}

describe("the worker view as its worker streams", () => {
  test("a token redraws the entry it grows, and an arrow key the two whose selection changed", async () => {
    await counting(async (drawn) => {
      const state = external<TranscriptState>({ ...emptyTranscript, window: windowOf(scenario) })
      const live = (...blocks: ReadonlyArray<LiveBlock>) =>
        state.set({ ...state.get(), live: [{ parent: null, blocks }] })
      const under = (parent: string, text: string) =>
        state.set({
          ...state.get(),
          live: [...state.get().live, { parent, blocks: [{ kind: "text", text }] }],
        })
      await withRender(<Root value={shellOf(state)} />, { width: 80, height: 30 }, async (r) => {
        expect((await r.capture()).chars).toContain("bun test")
        expect(drawn).toContain("b-1")
        expect(
          await drawnBy(drawn, () => r.input(() => live({ kind: "text", text: "Al" }))),
        ).toEqual(["live::0"])
        expect(
          await drawnBy(drawn, () => r.input(() => live({ kind: "text", text: "All tests pass" }))),
        ).toEqual(["live::0"])
        // A second block: the first, unchanged, isn't drawn again.
        const first: LiveBlock = { kind: "text", text: "All tests pass." }
        await r.input(() => live(first))
        expect(
          await drawnBy(drawn, () =>
            r.input(() => live(first, { kind: "tool_use", name: "Bash", text: '{"comm' })),
          ),
        ).toEqual(["live::1"])
        // The tool call's input growing changes nothing it draws.
        expect(
          await drawnBy(drawn, () =>
            r.input(() => live(first, { kind: "tool_use", name: "Bash", text: '{"command":' })),
          ),
        ).toEqual([])
        // Subagent work streaming redraws its Agent call, collapsed, and nothing else.
        expect(await drawnBy(drawn, () => r.input(() => under("a-1", "Found it")))).toEqual(["a-1"])
        await r.input(() => state.set({ ...state.get(), live: [] }))

        // From none, ↑ selects the newest call; ↑ again the one before it.
        expect(await drawnBy(drawn, () => arrow(r, "up"))).toEqual(["b-2"])
        expect(await drawnBy(drawn, () => arrow(r, "up"))).toEqual(["a-1", "b-2"])
        expect(await drawnBy(drawn, () => arrow(r, "up"))).toEqual(["a-1", "r-1"])
        expect((await r.capture()).chars).toContain("src/a.ts")
      })
    })
  })
})
