import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import {
  actionLimit,
  decodeItem,
  encodeItem,
  type Item,
  type LiveBlock,
  lastLine,
  messagesFile,
  notRecorded,
  pageSize,
  ringSize,
  stderrFile,
  Transcripts,
  toolCall,
  type Update,
} from "../src/agent/Transcripts.ts"
import { Files, layer as memoryLayer } from "../src/testing/Transcripts.ts"

const worker = "tut-zq4"
const first = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"
const second = "0a4f5c3e-2222-4c8e-9a51-6f0d1f0b2a02"

// SDK messages with only the fields tutti reads, cast as the SDK's types allow.
const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

const init = (session = first) =>
  sdk({ type: "system", subtype: "init", session_id: session, uuid: crypto.randomUUID() })

const assistant = (content: ReadonlyArray<unknown>, parent: string | null = null) =>
  sdk({
    type: "assistant",
    message: { role: "assistant", content },
    parent_tool_use_id: parent,
    session_id: first,
    uuid: crypto.randomUUID(),
  })

const text = (words: string, parent: string | null = null) =>
  assistant([{ type: "text", text: words }], parent)

const toolUse = (id: string, name: string, input: unknown, parent: string | null = null) =>
  assistant([{ type: "tool_use", id, name, input }], parent)

const toolResult = (id: string, parent: string | null = null) =>
  sdk({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    parent_tool_use_id: parent,
    session_id: first,
  })

const result = () =>
  sdk({ type: "result", subtype: "success", is_error: false, session_id: first, result: "done" })

const partial = (event: Record<string, unknown>, parent: string | null = null) =>
  sdk({
    type: "stream_event",
    event,
    parent_tool_use_id: parent,
    session_id: first,
    uuid: crypto.randomUUID(),
  })

const streamed = (words: ReadonlyArray<string>) => [
  partial({ type: "message_start", message: {} }),
  partial({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ...words.map((w) =>
    partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } }),
  ),
  partial({ type: "content_block_stop", index: 0 }),
  partial({ type: "message_stop" }),
]

const record = (message: SDKMessage, session = first, id = worker) =>
  Effect.gen(function* () {
    yield* (yield* Transcripts).record(id, session, message)
  })

const recordAll = (messages: ReadonlyArray<SDKMessage>, session = first, id = worker) =>
  Effect.forEach(messages, (m) => record(m, session, id), { discard: true })

const latest = (id = worker) =>
  Effect.gen(function* () {
    return yield* (yield* Transcripts).latestAction(id)
  })

const tempRepo = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-transcripts-")))

const fileLines = (repo: string, id = worker) =>
  readFileSync(join(repo, messagesFile(id)), "utf8")
    .split("\n")
    .slice(0, -1)

/** Runs `effect` with the transcripts in `repo`, as one run would, collecting its warnings. */
const inRepo = async <A>(repo: string, effect: Effect.Effect<A, never, Transcripts>) => {
  const warnings: Array<string> = []
  const value = await Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Transcripts.layer({
          repo,
          warn: (message) => Effect.sync(() => warnings.push(message)),
        }),
      ),
    ),
  )
  return { value, warnings }
}

/** Runs `effect` with the test layer. */
const inMemory = <A>(
  effect: Effect.Effect<A, never, Transcripts | Files>,
  earlier: Readonly<Record<string, ReadonlyArray<string>>> = {},
) => Effect.runPromise(effect.pipe(Effect.provide(memoryLayer(earlier))))

const seqs = (items: ReadonlyArray<Item>) => items.map((item) => item.seq)

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe("Transcripts in files", () => {
  test("appends each message with its sequence number and session, and reads them back across a resume", async () => {
    const repo = tempRepo()
    const firstRun = await inRepo(
      repo,
      Effect.gen(function* () {
        yield* recordAll([init(), text("one"), result()])
        // The session is resumed under a new ID: the same file, numbering on.
        yield* recordAll([init(second), text("two")], second)
      }),
    )
    // The next run resumes it again, and numbers on from the file's last line.
    const secondRun = await inRepo(
      repo,
      Effect.gen(function* () {
        const t = yield* Transcripts
        const before = yield* t.recent(worker)
        yield* recordAll([init(second), text("three")], second)
        return { before, page: yield* t.page(worker) }
      }),
    )
    expect([...firstRun.warnings, ...secondRun.warnings]).toEqual([])
    const lines = fileLines(repo).map((line) => JSON.parse(line))
    expect(lines.map((l) => [l.v, l.seq, l.session, l.message.type])).toEqual([
      [1, 1, first, "system"],
      [1, 2, first, "assistant"],
      [1, 3, first, "result"],
      [1, 4, second, "system"],
      [1, 5, second, "assistant"],
      [1, 6, second, "system"],
      [1, 7, second, "assistant"],
    ])
    expect(lines.every((l) => !Number.isNaN(Date.parse(l.time)))).toBe(true)
    expect(seqs(secondRun.value.before)).toEqual(range(1, 5))
    expect(seqs(secondRun.value.page)).toEqual(range(1, 7))
    expect(secondRun.value.page[6]?.message).toMatchObject({
      type: "assistant",
      message: { content: [{ type: "text", text: "three" }] },
    })
  })

  test("reads back 200 items at a time before a sequence number", async () => {
    const repo = tempRepo()
    const { value } = await inRepo(
      repo,
      Effect.gen(function* () {
        yield* recordAll(range(1, 450).map((i) => text(`line ${i}`)))
        const t = yield* Transcripts
        return yield* Effect.all([
          t.page(worker),
          t.page(worker, 251),
          t.page(worker, 51),
          t.page(worker, 1),
          t.page("tut-none"),
        ])
      }),
    )
    const [last, middle, oldest, none, unknown] = value
    expect(pageSize).toBe(200)
    expect(seqs(last)).toEqual(range(251, 450))
    expect(seqs(middle)).toEqual(range(51, 250))
    expect(seqs(oldest)).toEqual(range(1, 50))
    expect(none).toEqual([])
    expect(unknown).toEqual([])
  })

  test("reads lines longer than a chunk, and skips a torn last line", async () => {
    const repo = tempRepo()
    const long = "x".repeat(700 * 1024)
    await inRepo(repo, recordAll([text("short"), text(long), text("after")]))
    writeFileSync(join(repo, messagesFile(worker)), '{"v":1,"seq":4,"sess', { flag: "a" })
    const { value } = await inRepo(
      repo,
      Effect.gen(function* () {
        const t = yield* Transcripts
        yield* record(text("next"))
        return yield* t.page(worker)
      }),
    )
    expect(seqs(value)).toEqual([1, 2, 3, 4])
    expect(value[1]?.message).toMatchObject({ message: { content: [{ text: long }] } })
  })

  test("the worker's stderr goes to stderr.log beside its transcript", async () => {
    const repo = tempRepo()
    await inRepo(
      repo,
      Effect.gen(function* () {
        const write = (yield* Transcripts).stderr(worker)
        write("warning: one\n")
        write("warning: two\n")
      }),
    )
    expect(readFileSync(join(repo, stderrFile(worker)), "utf8")).toBe(
      "warning: one\nwarning: two\n",
    )
  })

  test("the last items for triage, at most N of them and M characters", async () => {
    const repo = tempRepo()
    const { value } = await inRepo(
      repo,
      Effect.gen(function* () {
        yield* recordAll(range(1, 20).map((i) => text(`${i} ${"y".repeat(100)}`)))
        const t = yield* Transcripts
        const size = (encodeItem((yield* t.recent(worker))[0] as Item) ?? "").length
        return yield* Effect.all([
          t.tail(worker, { items: 5, characters: 1_000_000 }),
          t.tail(worker, { items: 10, characters: size * 3 + 10 }),
          t.tail(worker, { items: 10, characters: 0 }),
        ])
      }),
    )
    expect(value.map(seqs)).toEqual([range(16, 20), range(18, 20), []])
  })

  test("a link in the transcripts' path is refused, warned about once, and nothing goes through it", async () => {
    const repo = tempRepo()
    const outside = tempRepo()
    mkdirSync(join(repo, ".tutti", "run"), { recursive: true })
    symlinkSync(outside, join(repo, ".tutti", "run", "workers"))
    const { value, warnings } = await inRepo(
      repo,
      Effect.gen(function* () {
        yield* recordAll([text("one"), text("two")])
        return yield* (yield* Transcripts).recent(worker)
      }),
    )
    expect(seqs(value)).toEqual([1, 2])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith(
      `${worker}'s transcript not recorded in ${messagesFile(worker)}`,
    )
    expect(readdirSync(outside)).toEqual([])
  })

  test("an ID that can't name a folder writes nothing, and is warned about", async () => {
    const repo = tempRepo()
    const { warnings } = await inRepo(repo, recordAll([text("one")], first, "../escape"))
    expect(warnings).toEqual([
      notRecorded("../escape", messagesFile("../escape"), "IDs with path characters can't be run"),
    ])
    expect(readdirSync(repo)).toEqual([])
  })
})

describe("Transcripts in memory", () => {
  test("the ring buffer holds the last 200 items", async () => {
    const recent = await inMemory(
      Effect.gen(function* () {
        yield* recordAll(range(1, 250).map((i) => text(`${i}`)))
        return yield* (yield* Transcripts).recent(worker)
      }),
    )
    expect(ringSize).toBe(200)
    expect(seqs(recent)).toEqual(range(51, 250))
  })

  test("starts from the lines an earlier run left", async () => {
    const earlier = range(1, 3).map((seq) =>
      encodeItem({
        v: 1,
        seq,
        session: first,
        time: "2026-10-16T09:00:00Z",
        message: text(`${seq}`),
      }),
    ) as Array<string>
    const { recent, action, files } = await inMemory(
      Effect.gen(function* () {
        const t = yield* Transcripts
        const action = yield* t.latestAction(worker)
        yield* record(init(second), second)
        return {
          recent: yield* t.recent(worker),
          action,
          files: yield* (yield* Files).messages(worker),
        }
      }),
      { [worker]: earlier },
    )
    expect(action).toBe("3")
    expect(seqs(recent)).toEqual(range(1, 4))
    expect(files.map((item) => item.session)).toEqual([first, first, first, second])
  })

  test("partial messages are dropped while no view is open", async () => {
    const { recent, files } = await inMemory(
      Effect.gen(function* () {
        yield* recordAll([init(), ...streamed(["Hel", "lo"]), text("Hello")])
        return {
          recent: yield* (yield* Transcripts).recent(worker),
          files: yield* (yield* Files).messages(worker),
        }
      }),
    )
    expect(recent.map((item) => item.message.type)).toEqual(["system", "assistant"])
    expect(files.map((item) => item.message.type)).toEqual(["system", "assistant"])
  })

  test("partial messages fold into the live message while a view is open", async () => {
    const { opened, updates, after } = await inMemory(
      Effect.gen(function* () {
        const t = yield* Transcripts
        yield* record(init())
        const { opened, updates } = yield* Effect.scoped(
          Effect.gen(function* () {
            const view = yield* t.view(worker)
            yield* recordAll([
              partial({ type: "message_start", message: {} }),
              partial({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              }),
              partial({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Hel" },
              }),
              partial({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "lo" },
              }),
              partial({ type: "content_block_stop", index: 0 }),
              // The block, complete: it leaves the live message.
              text("Hello"),
              partial({
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
              }),
              partial({
                type: "content_block_delta",
                index: 1,
                delta: { type: "input_json_delta", partial_json: '{"command":' },
              }),
            ])
            const opened = view
            const updates = yield* Stream.runCollect(Stream.take(view.updates, 8))
            // A second view sees the live message as it stands.
            const again = yield* t.view(worker)
            yield* recordAll([
              partial({ type: "content_block_stop", index: 1 }),
              toolUse("t1", "Bash", { command: "ls" }),
              partial({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
              partial({ type: "message_stop" }),
            ])
            const more = yield* Stream.runCollect(Stream.take(view.updates, 2))
            return { opened: [opened, again], updates: [...updates, ...more] }
          }),
        )
        // Closed again: dropped.
        yield* recordAll(streamed(["later"]))
        return { opened, updates, after: yield* t.recent(worker) }
      }),
    )
    const tool: LiveBlock = { kind: "tool_use", name: "Bash", text: '{"command":' }
    expect(seqs(opened[0]?.items ?? [])).toEqual([1])
    expect(opened[0]?.live).toEqual([])
    expect(opened[1]?.live).toEqual([{ parent: null, blocks: [undefined, tool] }])
    const live = (blocks: ReadonlyArray<LiveBlock | undefined> | undefined): Update => ({
      _tag: "Live",
      parent: null,
      live: blocks === undefined ? undefined : { parent: null, blocks },
    })
    expect(updates.map((u): Update | number => (u._tag === "Appended" ? u.item.seq : u))).toEqual([
      live(undefined),
      live([{ kind: "text", text: "" }]),
      live([{ kind: "text", text: "Hel" }]),
      live([{ kind: "text", text: "Hello" }]),
      live(undefined),
      2,
      live([undefined, { kind: "tool_use", name: "Bash", text: "" }]),
      live([undefined, tool]),
      live(undefined),
      3,
    ])
    expect(seqs(after)).toEqual([1, 2, 3])
  })

  test("a view is told each item appended after it opened", async () => {
    const updates = await inMemory(
      Effect.scoped(
        Effect.gen(function* () {
          const view = yield* (yield* Transcripts).view(worker)
          yield* recordAll([init(), text("one")])
          return yield* Stream.runCollect(Stream.take(view.updates, 2))
        }),
      ),
    )
    expect(updates.map((u) => (u._tag === "Appended" ? u.item.seq : u._tag))).toEqual([1, 2])
  })

  test("the stderr callback writes the worker's stderr", async () => {
    const stderr = await inMemory(
      Effect.gen(function* () {
        ;(yield* Transcripts).stderr(worker)("boom\n")
        return yield* (yield* Files).stderr(worker)
      }),
    )
    expect(stderr).toBe("boom\n")
  })

  test("items carry the clock's time", async () => {
    const files = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 9, 16, 7, 12, 4, 510))
        yield* record(init())
        return yield* (yield* Files).messages(worker)
      }).pipe(Effect.provide(Layer.merge(memoryLayer(), TestClock.layer()))),
    )
    expect(new Date(files[0]?.time ?? "").getTime()).toBe(Date.UTC(2026, 9, 16, 7, 12, 4, 510))
  })
})

describe("the latest action", () => {
  test("is the current tool call, else the last line of assistant text", async () => {
    const actions = await inMemory(
      Effect.gen(function* () {
        const seen: Array<string | undefined> = [yield* latest()]
        const step = (message: SDKMessage) =>
          Effect.flatMap(record(message), () =>
            Effect.map(latest(), (action) => {
              seen.push(action)
            }),
          )
        yield* step(init())
        yield* step(text("Reading the ticket.\n\nNext I'll run the check.\n"))
        yield* step(toolUse("t1", "Bash", { command: "scripts/check-fast.sh" }))
        yield* step(toolUse("s1", "Read", { file_path: "src/a.ts" }, "t1"))
        yield* step(toolResult("t1"))
        yield* step(toolUse("t2", "Agent", { description: "Verify", prompt: "…" }))
        yield* step(text("Thinking aloud", "t2"))
        yield* step(toolUse("t3", "Edit", { file_path: "src/b.ts", old_string: "a" }))
        yield* step(toolResult("t3"))
        yield* step(result())
        return seen
      }),
    )
    expect(actions).toEqual([
      undefined,
      undefined,
      "Next I'll run the check.",
      "Bash(scripts/check-fast.sh)",
      "Bash(scripts/check-fast.sh)",
      "Next I'll run the check.",
      "Agent(Verify)",
      "Agent(Verify)",
      "Edit(src/b.ts)",
      "Agent(Verify)",
      "Next I'll run the check.",
    ])
  })

  test("a tool call is shown by what its input is about, on one line", () => {
    expect(toolCall("Bash", { command: "bun test\n  --retry 1" })).toBe("Bash(bun test …)")
    expect(toolCall("Grep", { pattern: "TODO", path: "src" })).toBe("Grep(TODO)")
    expect(toolCall("mcp__beads__show", { id: "tut-1" })).toBe("mcp__beads__show(tut-1)")
    expect(toolCall("TodoWrite", { todos: [] })).toBe("TodoWrite")
    expect(toolCall("Bash", "not an object")).toBe("Bash")
    expect(Array.from(toolCall("Bash", { command: "z".repeat(500) }))).toHaveLength(actionLimit)
  })

  test("is one line, at most its limit, whatever the text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 400 }), fc.string(), (words, name) => {
        for (const action of [lastLine(words), toolCall(name || "Bash", { command: words })]) {
          if (action === undefined) continue
          expect(action).not.toMatch(/[\n\r\u2028\u2029]/)
          expect(Array.from(action).length).toBeLessThanOrEqual(actionLimit)
        }
      }),
    )
  })
})

describe("transcript lines", () => {
  test("keep any text a worker wrote, on one line", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.integer({ min: 1 }), (words, seq) => {
        const item: Item = {
          v: 1,
          seq,
          session: first,
          time: "2026-10-16T09:00:00Z",
          message: text(words),
        }
        const line = encodeItem(item)
        expect(line).toBeDefined()
        expect(line).not.toMatch(/[\n\r\u2028\u2029]/)
        expect(line).not.toContain("\u001b")
        expect(decodeItem(line as string)).toEqual(JSON.parse(JSON.stringify(item)))
      }),
    )
  })

  test("a line that isn't an item is skipped, never thrown on", () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        expect(() => decodeItem(line)).not.toThrow()
      }),
    )
    for (const line of [
      "",
      "{}",
      '{"v":2,"seq":1,"session":"s","time":"t","message":{"type":"x"}}',
      '{"v":1,"seq":0,"session":"s","time":"t","message":{"type":"x"}}',
      '{"v":1,"seq":1,"session":"s","time":"t","message":{}}',
    ]) {
      expect(decodeItem(line)).toBeUndefined()
    }
  })
})
