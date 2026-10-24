// The Transcripts service (§ 3.3, § 4.4): tutti's own log of each worker. Every SDK message a
// worker's session sends, other than the partial `stream_event`s, is appended to
// .tutti/run/workers/<id>/messages.jsonl in the main checkout as one line in tutti's schema: the
// SDK message inside, with tutti's sequence number, the session ID and the time. The worker's
// stderr goes to stderr.log beside it. The files outlive the worktree and the session: a resumed
// session, or the next run, appends to the same file, numbering on from its last line.
//
// In memory, each worker keeps its last 200 items for its view, the live item partial messages are
// folded into while its view is open, and the latest action its card shows: a call Claude Code
// denied (`permission_denied`, § 4.5) is that for 10 seconds. Reading back goes to the
// file, 200 items at a time, for the view's scrolling and for triage.
//
// Nothing here fails: a file that can't be opened or written is warned about once per worker, and
// the worker's transcript goes on in memory.
import { fstatSync, readSync, writeSync } from "node:fs"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  Clock,
  Context,
  Effect,
  FiberSet,
  Layer,
  PubSub,
  Result,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { close, LibcError, makeFoldersUnder, O, openUnder } from "../native/libc.ts"
import { terminalSafe } from "../run/events.ts"
import { timestamp } from "../run/localTime.ts"
import { denier, unknownDenier } from "../run/log.ts"
import { runFolder, ticketIdProblem } from "../services/Worktrees.ts"
import { aboutOf } from "./tools.ts"
import { asRecord, asString } from "./untrusted.ts"

/** The folder of the workers' transcripts, relative to the main checkout's top level (§ 9.1). */
export const workersFolder = ".tutti/run/workers"

/** A worker's transcript, relative to the main checkout. */
export const messagesFile = (worker: string): string => `${workersFolder}/${worker}/messages.jsonl`

/** Its Claude Code's stderr, relative to the main checkout. */
export const stderrFile = (worker: string): string => `${workersFolder}/${worker}/stderr.log`

/** How many items each worker keeps in memory, and how many a page read back holds (§ 4.4). */
export const ringSize = 200
export const pageSize = 200

/** The latest action is cut to this many characters, an ellipsis included. */
export const actionLimit = 200

/** How long a denied call is the latest action (§ 4.5), in milliseconds. */
export const deniedShownFor = 10_000

/** The version of the transcript's lines this tutti writes. */
export const transcriptVersion = 1

/** One line of a transcript, as the file holds it. */
const ItemSchema = Schema.Struct({
  v: Schema.Literal(transcriptVersion),
  /** tutti's sequence number for the worker, from 1, going on across sessions and runs. */
  seq: Schema.Number,
  /** The session that sent the message. */
  session: Schema.String,
  /** When tutti received it, RFC 3339. */
  time: Schema.String,
  /** The SDK message, as the SDK sent it. */
  message: Schema.Record(Schema.String, Schema.Unknown),
})

/** An item of a worker's transcript. */
export interface Item {
  readonly v: typeof transcriptVersion
  readonly seq: number
  readonly session: string
  readonly time: string
  readonly message: SDKMessage
}

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(ItemSchema))

/** `item` as its line in messages.jsonl, without the newline; undefined for one JSON can't hold. */
export const encodeItem = (item: Item): string | undefined => {
  try {
    const line = JSON.stringify(item)
    return line === undefined ? undefined : terminalSafe(line)
  } catch {
    return undefined
  }
}

/** A line of messages.jsonl as an item; undefined for a line that isn't one (a torn last write). */
export const decodeItem = (line: string): Item | undefined => {
  const decoded = decodeJson(line)
  if (Result.isFailure(decoded)) return undefined
  const item = decoded.success
  return typeof item.message.type === "string" && Number.isSafeInteger(item.seq) && item.seq > 0
    ? (item as unknown as Item)
    : undefined
}

/** A content block a partial message is building: text, thinking, or a tool call's input JSON. */
export interface LiveBlock {
  readonly kind: "text" | "thinking" | "tool_use"
  /** The tool's name, for a tool call. */
  readonly name?: string
  /** The text so far: the text, or the tool call's input JSON. Thinking keeps none. */
  readonly text: string
}

/** The assistant message partial messages are building, for an open view (§ 4.4). */
export interface Live {
  /** The Agent call a subagent's message belongs to, or null for the worker's own. */
  readonly parent: string | null
  /** Its content blocks so far, by index; a block the SDK has sent complete is left out. */
  readonly blocks: ReadonlyArray<LiveBlock | undefined>
}

/** What an open view is told. */
export type Update =
  /** An item was appended. */
  | { readonly _tag: "Appended"; readonly item: Item }
  /** The live message for `parent` changed, or has nothing more to show (`live` undefined). */
  | { readonly _tag: "Live"; readonly parent: string | null; readonly live: Live | undefined }

/** What a view starts from, and what it is told after. */
export interface View {
  /** The last items in memory, oldest first: at most `ringSize`. */
  readonly items: ReadonlyArray<Item>
  /** The live messages being built, if any. */
  readonly live: ReadonlyArray<Live>
  /** Every change after `items` and `live`, in order, while the view's scope is open. */
  readonly updates: Stream.Stream<Update>
}

/**
 * Where transcripts are kept: the files, or memory for tests. Its operations never throw. It is
 * asked only of workers whose ID can name a folder: makeTranscripts tells it of the others.
 */
export interface Storage {
  /** Appends `line`, an encoded item, to the worker's transcript. */
  readonly append: (worker: string, line: string) => void
  /** Appends `text` to the worker's stderr. */
  readonly stderr: (worker: string, text: string) => void
  /** The lines of the worker's transcript, the last first, read as they are asked for. */
  readonly linesBackward: (worker: string) => Iterable<string>
  /** Lets go of what it holds for the worker (open files). */
  readonly release: (worker: string) => void
  /** Told of a write to the worker's `file` not made, as its ID can't name a folder: `problem`. */
  readonly refused: (worker: string, file: string, problem: string) => void
}

// checked asks `storage` only of workers whose ID can name a folder, as a worker's files are under
// one named after it: a write for any other is refused, and it has nothing to read back.
const checked = (storage: Storage): Storage => {
  const write =
    (fileOf: (worker: string) => string, to: (worker: string, text: string) => void) =>
    (worker: string, text: string) => {
      const problem = ticketIdProblem(worker)
      if (problem === undefined) to(worker, text)
      else storage.refused(worker, fileOf(worker), problem)
    }
  return {
    append: write(messagesFile, storage.append),
    stderr: write(stderrFile, storage.stderr),
    linesBackward: (worker) =>
      ticketIdProblem(worker) === undefined ? storage.linesBackward(worker) : [],
    release: storage.release,
    refused: storage.refused,
  }
}

const lineBreak = /\r\n|[\n\r\u2028\u2029]/

const cut = (text: string, limit: number): string => {
  const chars = Array.from(text)
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`
}

/** The last line of `text` with anything on it, trimmed; undefined when it has none. */
export const lastLine = (text: string): string | undefined =>
  text
    .split(lineBreak)
    .map((line) => line.trim())
    .findLast((line) => line !== "")

/** The first line of `text` with anything on it, trimmed, `…` after it when more lines follow. */
const firstLine = (text: string): string => {
  const lines = text
    .split(lineBreak)
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const first = lines[0] ?? ""
  return lines.length > 1 ? `${first} …` : first
}

/**
 * What a call of tool `name` is about (tools.ts's aboutOf), on one line; empty for none. The worker
 * view shows it beside the tool's name (§ 7.5).
 */
export const toolSummary = (name: string, input: unknown): string =>
  firstLine(aboutOf(name, input) ?? "")

/** A tool call as the card shows it: `Bash(scripts/check-fast.sh)`, or `TodoWrite`. */
export const toolCall = (name: string, input: unknown): string => {
  const summary = toolSummary(name, input)
  return cut(summary === "" ? name : `${name}(${summary})`, actionLimit)
}

const toolUseTypes = new Set(["tool_use", "server_tool_use", "mcp_tool_use"])

/** What the latest action is made from, folded over a worker's messages. */
interface Activity {
  /** The worker's own tool calls without a result yet, by tool_use ID, in the order they began. */
  readonly pending: Map<string, string>
  /** The last line of its own last assistant text. */
  text: string | undefined
  /** The last call Claude Code denied, as the card shows it, and when (epoch milliseconds). */
  denied: { readonly text: string; readonly at: number } | undefined
}

// follow folds one message into the activity behind the latest action (§ 4.4). Only the worker's
// own messages count, not a subagent's: while one works, its Agent call is the current one. A
// turn's start (system/init) and end (result) leave no call current: one interrupted is never
// answered. A denial counts whoever's call it was, a subagent's named by its tool alone; `at` is
// when the message came.
const follow = (activity: Activity, message: SDKMessage, at: number): void => {
  const m = message as unknown as Readonly<Record<string, unknown>>
  if (m.type === "result" || (m.type === "system" && m.subtype === "init")) {
    activity.pending.clear()
    return
  }
  if (m.type === "system" && m.subtype === "permission_denied") {
    const id = asString(m.tool_use_id)
    const call = (id === undefined ? undefined : activity.pending.get(id)) ?? asString(m.tool_name)
    const by = asString(m.decision_reason_type) ?? unknownDenier
    if (call !== undefined) {
      activity.denied = { text: cut(`${call} denied by ${denier(by)}`, actionLimit), at }
    }
    return
  }
  if (m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined) return
  if (m.type !== "assistant" && m.type !== "user") return
  const content = asRecord(m.message)?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    const b = asRecord(block)
    if (b === undefined) continue
    if (m.type === "assistant" && toolUseTypes.has(String(b.type))) {
      const id = asString(b.id)
      const name = asString(b.name)
      if (id !== undefined && name !== undefined) {
        activity.pending.delete(id)
        activity.pending.set(id, toolCall(name, b.input))
      }
    } else if (m.type === "assistant" && b.type === "text") {
      const line = lastLine(asString(b.text) ?? "")
      if (line !== undefined) activity.text = cut(line, actionLimit)
    } else if (m.type === "user" && b.type === "tool_result") {
      const id = asString(b.tool_use_id)
      if (id !== undefined) activity.pending.delete(id)
    }
  }
}

/** A card's latest action, and whether it is a call Claude Code denied, shown for 10 seconds. */
export interface LatestAction {
  readonly text: string
  readonly denied: boolean
}

/**
 * The latest action at `now`: a call denied in the last `deniedShownFor`, else the current tool
 * call, else the last line of assistant text (§ 4.4, § 4.5).
 */
const latestOf = (activity: Activity, now: number): LatestAction | undefined => {
  const denied = activity.denied
  if (denied !== undefined && now >= denied.at && now - denied.at < deniedShownFor) {
    return { text: denied.text, denied: true }
  }
  let current: string | undefined
  for (const call of activity.pending.values()) current = call
  const text = current ?? activity.text
  return text === undefined ? undefined : { text, denied: false }
}

const liveKinds: Readonly<Record<string, LiveBlock["kind"]>> = {
  text: "text",
  thinking: "thinking",
  redacted_thinking: "thinking",
  tool_use: "tool_use",
  server_tool_use: "tool_use",
  mcp_tool_use: "tool_use",
}

// fold folds one streaming event into the live message, returning the new one (a new object, so a
// view can tell it changed), or the same one when the event changes nothing shown.
const fold = (live: Live, event: Readonly<Record<string, unknown>>): Live => {
  const index = typeof event.index === "number" ? event.index : undefined
  if (event.type === "content_block_start" && index !== undefined) {
    const block = asRecord(event.content_block)
    const kind = liveKinds[String(block?.type)]
    if (kind === undefined) return live
    const name = asString(block?.name)
    const text = kind === "text" ? (asString(block?.text) ?? "") : ""
    const blocks = [...live.blocks]
    blocks[index] = name === undefined ? { kind, text } : { kind, name, text }
    return { parent: live.parent, blocks }
  }
  if (event.type === "content_block_delta" && index !== undefined) {
    const block = live.blocks[index]
    const delta = asRecord(event.delta)
    const more =
      delta?.type === "text_delta"
        ? asString(delta.text)
        : delta?.type === "input_json_delta"
          ? asString(delta.partial_json)
          : undefined
    if (block === undefined || more === undefined || more === "") return live
    const blocks = [...live.blocks]
    blocks[index] = { ...block, text: block.text + more }
    return { parent: live.parent, blocks }
  }
  return live
}

/** The live message, when it has a block to show: the complete ones have been appended. */
const shown = (live: Live | undefined): Live | undefined =>
  live?.blocks.some((block) => block !== undefined) ? live : undefined

/** What the service keeps of one worker. */
interface Worker {
  /** The last sequence number used. */
  seq: number
  /** The last `ringSize` items, oldest first. */
  ring: Array<Item>
  /** Open views. Partial messages are folded only while there is one. */
  views: number
  /** Released while a view was open: let go of as the last view closes. */
  released: boolean
  /** The live messages, by the Agent call they belong to (null: the worker's own). */
  readonly live: Map<string | null, Live>
  readonly activity: Activity
  readonly updates: PubSub.PubSub<Update>
}

// readBack reads up to `count` items of the worker's transcript before sequence number `before`
// (all of them when undefined), oldest first. Lines that aren't items are skipped.
const readBack = (
  storage: Storage,
  worker: string,
  before: number | undefined,
  count: number,
): Array<{ readonly item: Item; readonly length: number }> => {
  const found: Array<{ readonly item: Item; readonly length: number }> = []
  if (count <= 0) return found
  for (const line of storage.linesBackward(worker)) {
    const item = decodeItem(line)
    if (item === undefined || (before !== undefined && item.seq >= before)) continue
    found.push({ item, length: line.length })
    if (found.length >= count) break
  }
  return found.reverse()
}

export class Transcripts extends Context.Service<
  Transcripts,
  {
    /**
     * Records a message of the worker's session `session`. Any but a partial message is appended
     * to its transcript with the next sequence number and kept in memory; a partial message is
     * folded into the live message while a view of the worker is open, and dropped otherwise.
     */
    record(worker: string, session: string, message: SDKMessage): Effect.Effect<void>
    /** The callback for the worker's session's `stderr` option: appends to its stderr.log. */
    stderr(worker: string): (data: string) => void
    /** The worker's last items in memory, oldest first: at most `ringSize`. */
    recent(worker: string): Effect.Effect<ReadonlyArray<Item>>
    /**
     * What its card shows: `Bash(scripts/check-fast.sh)`, or the last line of its text; none once
     * it is released, until something starts it again.
     */
    latestAction(worker: string): Effect.Effect<string | undefined>
    /** The same, saying whether it is a denied call. */
    action(worker: string): Effect.Effect<LatestAction | undefined>
    /**
     * Opens a view of the worker for the scope: partial messages are folded while it is open. Its
     * updates follow on from its items and live messages, with none missed between.
     */
    view(worker: string): Effect.Effect<View, never, Scope.Scope>
    /**
     * Up to `pageSize` items of the worker's transcript before sequence number `before`, oldest
     * first, read from the file: the last ones when `before` is undefined.
     */
    page(worker: string, before?: number): Effect.Effect<ReadonlyArray<Item>>
    /**
     * The worker's last items, at most `items` of them and at most `characters` characters of
     * transcript lines in all, oldest first, read from the file: for triage (§ 6.2).
     */
    tail(
      worker: string,
      limits: { readonly items: number; readonly characters: number },
    ): Effect.Effect<ReadonlyArray<Item>>
    /**
     * Lets go of the worker's memory and open files, once its views have closed if any is open; a
     * later message starts them again, from its file.
     */
    release(worker: string): Effect.Effect<void>
  }
>()("tutti/agent/Transcripts") {
  /**
   * The transcripts in the main checkout at `repo`. `warn` is told a worker's first failure to
   * write its files; Effect's logger is by default.
   */
  static readonly layer = (options: {
    readonly repo: string
    readonly warn?: (message: string) => Effect.Effect<void>
  }) =>
    Layer.effect(
      Transcripts,
      Effect.gen(function* () {
        const warn = options.warn ?? ((message: string) => Effect.logWarning(message))
        // The warnings are fibers of the layer's scope, which ends any still under way.
        const warning = yield* FiberSet.runtime(yield* FiberSet.make())()
        const storage = yield* Effect.acquireRelease(
          Effect.sync(() =>
            fileStorage(options.repo, (message) => {
              warning(warn(message))
            }),
          ),
          (storage) => Effect.sync(() => storage.closeAll()),
        )
        return yield* makeTranscripts(storage)
      }),
    )
}

/** The service over `storage`: what the live layer and the test layer share. */
export const makeTranscripts = (given: Storage): Effect.Effect<Transcripts["Service"]> =>
  Effect.sync(() => {
    const storage = checked(given)
    const workers = new Map<string, Worker>()
    // The workers let go of, until something starts them again: their latest action is none, so
    // the dashboard's poll doesn't read them back into memory.
    const letGoOf = new Set<string>()

    const workerOf = (id: string): Worker => {
      const known = workers.get(id)
      if (known !== undefined) return known
      letGoOf.delete(id)
      // A worker seen before, in an earlier session or run, numbers on from its file's last line,
      // and starts its memory and latest action from the file's last items.
      const ring = readBack(storage, id, undefined, ringSize).map(({ item }) => item)
      const activity: Activity = { pending: new Map(), text: undefined, denied: undefined }
      for (const item of ring) follow(activity, item.message, Date.parse(item.time))
      const worker: Worker = {
        seq: ring.at(-1)?.seq ?? 0,
        ring,
        views: 0,
        released: false,
        live: new Map(),
        activity,
        updates: Effect.runSync(PubSub.unbounded<Update>()),
      }
      workers.set(id, worker)
      return worker
    }

    const letGo = (id: string): void => {
      if (workers.delete(id)) letGoOf.add(id)
      storage.release(id)
    }

    const publish = (worker: Worker, update: Update): void => {
      if (worker.views > 0) PubSub.publishUnsafe(worker.updates, update)
    }

    const partial = (id: string, message: SDKMessage): void => {
      // Dropped at once while no view is open: the session sends one per token (§ 4.4).
      const worker = workers.get(id)
      if (worker === undefined || worker.views === 0) return
      const m = message as unknown as Readonly<Record<string, unknown>>
      const event = asRecord(m.event)
      if (event === undefined) return
      const parent = asString(m.parent_tool_use_id) ?? null
      const current = worker.live.get(parent)
      if (event.type === "message_stop") {
        worker.live.delete(parent)
        if (shown(current) !== undefined) publish(worker, { _tag: "Live", parent, live: undefined })
        return
      }
      const before = event.type === "message_start" ? { parent, blocks: [] } : current
      if (before === undefined) return
      const after = fold(before, event)
      if (after === current) return
      worker.live.set(parent, after)
      publish(worker, { _tag: "Live", parent, live: shown(after) })
    }

    const append = (id: string, worker: Worker, item: Item, now: number): void => {
      const line = encodeItem(item)
      if (line !== undefined) storage.append(id, `${line}\n`)
      worker.seq = item.seq
      worker.ring.push(item)
      if (worker.ring.length > ringSize) worker.ring.splice(0, worker.ring.length - ringSize)
      follow(worker.activity, item.message, now)
      // The SDK sends each content block complete as it ends, as an assistant message of its own:
      // it replaces what the live message had built. The live message goes on, for the next block.
      if (item.message.type === "assistant") {
        const parent = item.message.parent_tool_use_id
        const live = worker.live.get(parent)
        if (live !== undefined) {
          worker.live.set(parent, { parent, blocks: live.blocks.map(() => undefined) })
          if (shown(live) !== undefined) publish(worker, { _tag: "Live", parent, live: undefined })
        }
      }
      publish(worker, { _tag: "Appended", item })
    }

    return Transcripts.of({
      record: (id, session, message) =>
        message.type === "stream_event"
          ? Effect.sync(() => partial(id, message))
          : Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Effect.sync(() => {
                const worker = workerOf(id)
                const time = timestamp(new Date(now))
                append(
                  id,
                  worker,
                  { v: transcriptVersion, seq: worker.seq + 1, session, time, message },
                  now,
                )
              }),
            ),
      stderr: (id) => (data) => storage.stderr(id, data),
      recent: (id) => Effect.sync(() => [...workerOf(id).ring]),
      latestAction: (id) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() =>
            letGoOf.has(id) ? undefined : latestOf(workerOf(id).activity, now)?.text,
          ),
        ),
      action: (id) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => (letGoOf.has(id) ? undefined : latestOf(workerOf(id).activity, now))),
        ),
      view: (id) =>
        Effect.gen(function* () {
          // A worker let go of is read back for the view, and let go of again as it closes.
          const back = letGoOf.has(id)
          const worker = workerOf(id)
          if (back) worker.released = true
          const subscription = yield* PubSub.subscribe(worker.updates)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              worker.views += 1
            }),
            () =>
              Effect.sync(() => {
                worker.views -= 1
                if (worker.views > 0) return
                worker.live.clear()
                if (worker.released && workers.get(id) === worker) letGo(id)
              }),
          )
          return {
            items: [...worker.ring],
            live: [...worker.live.values()].flatMap((live) => shown(live) ?? []),
            updates: Stream.fromSubscription(subscription),
          }
        }),
      page: (id, before) =>
        Effect.sync(() => readBack(storage, id, before, pageSize).map(({ item }) => item)),
      tail: (id, limits) =>
        Effect.sync(() => {
          const found = readBack(storage, id, undefined, limits.items)
          let total = found.reduce((sum, { length }) => sum + length, 0)
          let first = 0
          while (first < found.length && total > limits.characters) {
            total -= found[first]?.length ?? 0
            first += 1
          }
          return found.slice(first).map(({ item }) => item)
        }),
      // An open view keeps showing the worker: it is let go of as the last one closes.
      release: (id) =>
        Effect.sync(() => {
          const worker = workers.get(id)
          if (worker !== undefined && worker.views > 0) worker.released = true
          else letGo(id)
        }),
    })
  })

/** The warning for a worker's file that can't be opened or written. */
export const notRecorded = (worker: string, file: string, reason: string): string =>
  `${worker}'s transcript not recorded in ${file}: ${reason}; its worker goes on`

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error)

const chunkSize = 256 * 1024

// linesFrom yields the lines of the file open at `fd`, the last first, reading it backwards a chunk
// at a time. Lines are split on the newline byte, which UTF-8 never uses inside a character.
function* linesFrom(fd: number): Generator<string> {
  let position = fstatSync(fd).size
  // The start of the line the chunks read so far end in, not yet reached.
  let rest = Buffer.alloc(0)
  while (position > 0) {
    const size = Math.min(chunkSize, position)
    position -= size
    const chunk = Buffer.alloc(size)
    let read = 0
    while (read < size) {
      const n = readSync(fd, chunk, read, size - read, position + read)
      if (n === 0) break
      read += n
    }
    const data = rest.length === 0 ? chunk : Buffer.concat([chunk, rest])
    let end = data.length
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] !== 0x0a) continue
      if (i + 1 < end) yield data.subarray(i + 1, end).toString("utf8")
      end = i
    }
    rest = data.subarray(0, end)
  }
  if (rest.length > 0) yield rest.toString("utf8")
}

/** The files, and closing them all as the layer ends. */
interface FileStorage extends Storage {
  readonly closeAll: () => void
}

/**
 * Transcripts in files under the main checkout at `repo`, opened below it with openUnder, so a
 * symbolic link in their path is refused rather than written through. `failed` is told a worker's
 * first failure for each file.
 */
export const fileStorage = (repo: string, failed: (message: string) => void): FileStorage => {
  // Per worker and file: its descriptor, or null once opening it failed.
  const open = new Map<string, number | null>()
  const warned = new Set<string>()

  const fail = (worker: string, file: string, reason: string): void => {
    if (warned.has(file)) return
    warned.add(file)
    failed(notRecorded(worker, file, reason))
  }

  const fdOf = (worker: string, file: string): number | undefined => {
    const known = open.get(file)
    if (known !== undefined) return known ?? undefined
    // Stops at a link, which openUnder then refuses, naming it.
    makeFoldersUnder(repo, `${runFolder}/workers/${worker}`)
    const result = Effect.runSync(
      Effect.result(openUnder(repo, file, O.RDWR | O.APPEND | O.CREAT, 0o644)),
    )
    if (Result.isFailure(result)) {
      open.set(file, null)
      fail(worker, file, result.failure.message)
      return undefined
    }
    const fd = result.success
    open.set(file, fd)
    if (file === messagesFile(worker)) endTornLine(worker, file, fd)
    return fd
  }

  // endTornLine ends a last line a crash left without its newline, so the next item starts a line
  // of its own rather than joining it: the torn line is then skipped when read back, alone.
  const endTornLine = (worker: string, file: string, fd: number): void => {
    try {
      const size = fstatSync(fd).size
      const last = Buffer.alloc(1)
      if (size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) {
        writeSync(fd, "\n")
      }
    } catch (error) {
      fail(worker, file, reasonOf(error))
    }
  }

  const write = (worker: string, file: string, text: string): void => {
    const fd = fdOf(worker, file)
    if (fd === undefined) return
    const bytes = Buffer.from(text, "utf8")
    try {
      // One write, so a reader never sees half a line, unless the system takes only part of it.
      for (let written = 0; written < bytes.length; ) {
        written += writeSync(fd, bytes, written)
      }
    } catch (error) {
      fail(worker, file, reasonOf(error))
    }
  }

  const closeFile = (file: string): void => {
    const fd = open.get(file)
    if (typeof fd === "number") Effect.runSync(Effect.ignore(close(fd)))
    open.delete(file)
    warned.delete(file)
  }

  return {
    append: (worker, line) => write(worker, messagesFile(worker), line),
    stderr: (worker, text) => write(worker, stderrFile(worker), text),
    linesBackward: function* (worker) {
      const result = Effect.runSync(Effect.result(openUnder(repo, messagesFile(worker), O.RDONLY)))
      if (Result.isFailure(result)) {
        const error = result.failure
        // A worker with no transcript yet has nothing to read; any other failure is warned about.
        if (!(error instanceof LibcError && error.code === "ENOENT")) {
          fail(worker, messagesFile(worker), error.message)
        }
        return
      }
      try {
        yield* linesFrom(result.success)
      } catch (error) {
        fail(worker, messagesFile(worker), reasonOf(error))
      } finally {
        Effect.runSync(Effect.ignore(close(result.success)))
      }
    },
    release: (worker) => {
      closeFile(messagesFile(worker))
      closeFile(stderrFile(worker))
    },
    refused: fail,
    closeAll: () => {
      for (const file of [...open.keys()]) closeFile(file)
    },
  }
}
