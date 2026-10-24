// The worker view's items (§ 7.5): tutti's transcript of a worker (§ 4.4) as the view draws it, and
// the window of it the view mounts.
//
// Each SDK message becomes what the view shows of it: assistant text, to be drawn as Markdown; a
// tool call, one line, with its result folded into it from the user message that answers it; a
// message sent to the worker (tutti's prompt and nudges, or yours). Thinking is hidden (§ 15, Q7),
// and so are the system messages and results. A subagent's messages (`parent_tool_use_id`) are
// nested under the Agent call that started it; those whose call is older than the window are kept
// together at the top, still nested, behind the same bar.
//
// The window (bounded rendering): while you're at the bottom, the last `atBottom` items follow the
// worker; scrolling past the top loads `olderPage` items more from the file, and the newest beyond
// `mountLimit` are let go. Back at the bottom, the window is the latest items again.
//
// Every text here is a model's or a tool's, so it is sanitised as it comes in (§ 7.10).
import { Effect, Fiber, Predicate, type Scope, Stream } from "effect"
import {
  type Item,
  type Live,
  type LiveBlock,
  pageSize,
  ringSize,
  type Transcripts,
  toolSummary,
} from "../agent/Transcripts.ts"
import { keepAll } from "../run/same.ts"
import { sanitize, sanitizeLine } from "./sanitize.ts"
import { type External, external } from "./useRunView.ts"

/** How many transcript items are mounted while you're at the bottom (§ 7.5). */
export const atBottom = ringSize

/** How many older items scrolling past the top loads at a time. */
export const olderPage = pageSize

/** The most transcript items ever mounted. */
export const mountLimit = 600

/** A tool call's result, as the user message answering it carries it. */
export interface ToolResult {
  readonly text: string
  readonly error: boolean
}

/** What the view draws. */
export type Entry =
  /** Assistant text, as Markdown; `live` while partial messages are still building it. */
  | { readonly _tag: "Text"; readonly key: string; readonly text: string; readonly live: boolean }
  /** A message sent to the worker: tutti's prompt, a nudge, or yours. */
  | { readonly _tag: "Prompt"; readonly key: string; readonly text: string }
  /** A tool call; an Agent call's subagent work in `children`. */
  | {
      readonly _tag: "Tool"
      /** Its tool_use ID. */
      readonly key: string
      readonly name: string
      /** What it is about, on one line: `scripts/check-fast.sh`. */
      readonly summary: string
      readonly input: Readonly<Record<string, unknown>>
      /** Null until its result comes, and for a call still being written (`live`). */
      readonly result: ToolResult | null
      readonly children: ReadonlyArray<Entry>
      readonly live: boolean
    }
  /** A subagent's items whose Agent call is older than the window. */
  | { readonly _tag: "Nested"; readonly key: string; readonly children: ReadonlyArray<Entry> }

export type ToolEntry = Extract<Entry, { readonly _tag: "Tool" }>

// A value of an SDK message whose shape this tutti may not know, read without trusting it.
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isObject(value) ? value : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const toolUseTypes = new Set(["tool_use", "server_tool_use", "mcp_tool_use"])

/** The tools whose calls hold subagent work. */
const agentTools = new Set(["Agent", "Task"])

/** The text of a tool_result's content: a string, or text blocks; an image is `[image]`. */
const resultText = (content: unknown): string => {
  if (typeof content === "string") return sanitize(content)
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      const b = asRecord(block)
      if (b?.type === "text") return sanitize(asString(b.text) ?? "")
      return b?.type === "image" ? "[image]" : ""
    })
    .filter((text) => text !== "")
    .join("\n")
}

/** A tool entry as it is built: its children still being gathered. */
interface Building {
  readonly _tag: "Tool"
  readonly key: string
  readonly name: string
  readonly summary: string
  readonly input: Readonly<Record<string, unknown>>
  result: ToolResult | null
  readonly children: Array<Entry | Building>
  readonly live: boolean
}

type Node = Entry | Building

const finish = (node: Node): Entry =>
  node._tag === "Tool"
    ? { ...node, children: node.children.map((child) => finish(child as Node)) }
    : node._tag === "Nested"
      ? { ...node, children: node.children.map((child) => finish(child as Node)) }
      : node

const toolOf = (block: Readonly<Record<string, unknown>>, live: boolean): Building | undefined => {
  const id = asString(block.id)
  const name = asString(block.name)
  if (id === undefined || name === undefined) return undefined
  const input = asRecord(block.input) ?? {}
  return {
    _tag: "Tool",
    key: id,
    name: sanitizeLine(name),
    summary: sanitizeLine(toolSummary(name, input)),
    input,
    result: null,
    children: [],
    live,
  }
}

/**
 * The entries of `items`, oldest first, with `live` (the partial messages being built) at the end
 * of the worker's own or under their Agent call. A message sent to the worker is left out while its
 * uuid is in `queued` (the composer shows it below, § 7.5), and once a `command_lifecycle` in
 * `items` says the CLI cancelled it: it never reached the worker.
 */
export const entriesOf = (
  items: ReadonlyArray<Item>,
  live: ReadonlyArray<Live> = [],
  queued: ReadonlySet<string> = new Set(),
): ReadonlyArray<Entry> => {
  const cancelled = new Set<string>()
  for (const item of items) {
    const m = item.message as unknown as Readonly<Record<string, unknown>>
    const uuid = asString(m.command_uuid)
    if (m.type === "command_lifecycle" && m.state === "cancelled" && uuid !== undefined) {
      cancelled.add(uuid)
    }
  }
  const unsaid = (uuid: string | undefined) =>
    uuid !== undefined && (queued.has(uuid) || cancelled.has(uuid))
  const top: Array<Node> = []
  const tools = new Map<string, Building>()
  // The groups of a subagent's items whose Agent call isn't in the window, by that call's ID.
  const orphans = new Map<string, { readonly key: string; readonly children: Array<Node> }>()
  const place = (parent: string | null, node: Node): void => {
    if (parent === null) {
      top.push(node)
      return
    }
    const tool = tools.get(parent)
    if (tool !== undefined) {
      tool.children.push(node)
      return
    }
    let group = orphans.get(parent)
    if (group === undefined) {
      group = { key: `nested:${parent}`, children: [] }
      orphans.set(parent, group)
      top.push({ _tag: "Nested", key: group.key, children: group.children as Array<Entry> })
    }
    group.children.push(node)
  }
  const add = (parent: string | null, block: Readonly<Record<string, unknown>>, key: string) => {
    if (toolUseTypes.has(String(block.type))) {
      const tool = toolOf(block, false)
      if (tool === undefined || tools.has(tool.key)) return
      // Placed before it is known, so that a call that names itself its parent isn't under itself.
      place(parent, tool)
      tools.set(tool.key, tool)
    } else if (block.type === "text") {
      const text = sanitize(asString(block.text) ?? "")
      if (text.trim() !== "") place(parent, { _tag: "Text", key, text, live: false })
    }
  }
  for (const item of items) {
    const m = item.message as unknown as Readonly<Record<string, unknown>>
    const parent = asString(m.parent_tool_use_id) ?? null
    const content = asRecord(m.message)?.content
    if (m.type === "assistant" && Array.isArray(content)) {
      content.forEach((block, i) => {
        const b = asRecord(block)
        if (b !== undefined) add(parent, b, `${item.seq}:${i}`)
      })
    } else if (m.type === "user") {
      const blocks = Array.isArray(content) ? content.map(asRecord) : []
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue
        const tool = tools.get(asString(b.tool_use_id) ?? "")
        if (tool !== undefined) {
          tool.result = { text: resultText(b.content), error: b.is_error === true }
        }
      }
      // What was said to the worker itself; a subagent's prompt is its Agent call's input.
      if (
        parent === null &&
        !blocks.some((b) => b?.type === "tool_result") &&
        !unsaid(asString(m.uuid))
      ) {
        const text = resultText(content)
        if (text.trim() !== "") place(null, { _tag: "Prompt", key: `${item.seq}`, text })
      }
    }
  }
  for (const message of live) {
    message.blocks.forEach((block, i) => {
      const entry = liveEntry(message.parent, block, i)
      if (entry !== undefined) place(message.parent, entry)
    })
  }
  return top.map(finish)
}

/** What block `i` of a live message under `parent` draws as: none for thinking or empty text. */
const liveEntry = (
  parent: string | null,
  block: LiveBlock | undefined,
  i: number,
): Entry | undefined => {
  const key = `live:${parent ?? ""}:${i}`
  if (block === undefined || block.kind === "thinking") return undefined
  if (block.kind === "text") {
    const text = sanitize(block.text)
    return text.trim() === "" ? undefined : { _tag: "Text", key, text, live: true }
  }
  return {
    _tag: "Tool",
    key,
    name: sanitizeLine(block.name ?? "tool"),
    summary: "",
    input: {},
    result: null,
    children: [],
    live: true,
  }
}

/**
 * `entries` with `entry` added at the end of the children of tool call `parent`, wherever it is
 * nested; undefined when no call there has that ID. Only the entries along the way are new.
 */
const under = (
  entries: ReadonlyArray<Entry>,
  parent: string,
  entry: Entry,
): ReadonlyArray<Entry> | undefined => {
  for (const [i, each] of entries.entries()) {
    if (each._tag !== "Tool" && each._tag !== "Nested") continue
    const children =
      each._tag === "Tool" && each.key === parent
        ? [...each.children, entry]
        : under(each.children, parent, entry)
    if (children !== undefined) return entries.with(i, { ...each, children })
  }
  return undefined
}

/**
 * `settled` (the entries of the items alone, `entriesOf(items, [], queued)`) with `live` laid over
 * them as entriesOf places it: at the end of the worker's own, or under its Agent call, or in the
 * group of that call's subagent work when the call is older than the window. Only the entries along
 * the way to each live one are new; the others are `settled`'s own, so that a streamed token
 * redraws the entry it grows and the Agent calls it is under, not the transcript.
 */
export const withLive = (
  settled: ReadonlyArray<Entry>,
  live: ReadonlyArray<Live>,
): ReadonlyArray<Entry> => {
  let top = settled
  for (const message of live) {
    const parent = message.parent
    message.blocks.forEach((block, i) => {
      const entry = liveEntry(parent, block, i)
      if (entry === undefined) return
      if (parent === null) {
        top = [...top, entry]
        return
      }
      const placed = under(top, parent, entry)
      if (placed !== undefined) {
        top = placed
        return
      }
      const key = `nested:${parent}`
      const group = top.findIndex((each) => each._tag === "Nested" && each.key === key)
      const nested = top[group]
      top =
        nested?._tag === "Nested"
          ? top.with(group, { ...nested, children: [...nested.children, entry] })
          : [...top, { _tag: "Nested", key, children: [entry] }]
    })
  }
  return top
}

/**
 * `next` with each entry that is the same as `previous`' with its key kept by identity, and the
 * children of a call or group that changed kept likewise; `previous` itself when nothing changed.
 * Entries kept are what memo(EntryView) holds on.
 */
export const keptEntries = (
  previous: ReadonlyArray<Entry>,
  next: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> =>
  keepAll(
    previous,
    next,
    (entry) => entry.key,
    (old, entry) =>
      (entry._tag === "Tool" && old._tag === "Tool") ||
      (entry._tag === "Nested" && old._tag === "Nested")
        ? { ...entry, children: keptEntries(old.children, entry.children) }
        : entry,
  )

/** Whether `entry` is a tool call (or a group) whose children are drawn under it when expanded. */
export const nests = (entry: Entry): boolean =>
  entry._tag === "Nested" || (entry._tag === "Tool" && agentTools.has(entry.name))

/**
 * The entries mounted when those whose keys are in `expanded` are open: each entry drawn, and the
 * children of an open Agent call or group. A subagent's work is collapsed by default.
 */
export const mounted = (
  entries: ReadonlyArray<Entry>,
  expanded: ReadonlySet<string>,
): ReadonlyArray<Entry> =>
  entries.flatMap((entry) => [
    entry,
    ...((entry._tag === "Tool" || entry._tag === "Nested") && expanded.has(entry.key)
      ? mounted(entry.children, expanded)
      : []),
  ])

/** How many entries `mounted` gives for `entry` alone. */
const mountedCount = (entry: Entry, expanded: ReadonlySet<string>): number =>
  (entry._tag === "Tool" || entry._tag === "Nested") && expanded.has(entry.key)
    ? entry.children.reduce((sum, child) => sum + mountedCount(child, expanded), 1)
    : 1

/** An edit's change: the file, the lines added and removed, and the unified diff of them. */
export interface EditChange {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly diff: string
}

/** One line of a diff. */
interface DiffLine {
  readonly op: " " | "-" | "+"
  readonly line: string
}

/** The most cells the line diff fills before it calls every line changed. */
const diffCells = 250_000

const linesOf = (text: string): ReadonlyArray<string> => {
  if (text === "") return []
  const lines = sanitize(text).split("\n")
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines
}

/** The lines `before` and `after` differ in, with those they share, by their longest common run. */
export const lineDiff = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ReadonlyArray<DiffLine> => {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++
  }
  const a = before.slice(start, before.length - end)
  const b = after.slice(start, after.length - end)
  const middle: Array<DiffLine> = []
  if ((a.length + 1) * (b.length + 1) > diffCells) {
    middle.push(...a.map((line) => ({ op: "-" as const, line })))
    middle.push(...b.map((line) => ({ op: "+" as const, line })))
  } else {
    // lengths[i][j]: the longest common run of a[i..] and b[j..].
    const width = b.length + 1
    const lengths = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lengths[i * width + j] =
          a[i] === b[j]
            ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0)
      }
    }
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        middle.push({ op: " ", line: a[i] ?? "" })
        i++
        j++
      } else if (
        i < a.length &&
        (j >= b.length || (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))
      ) {
        // A removal before an addition, as unified diffs show them.
        middle.push({ op: "-", line: a[i] ?? "" })
        i++
      } else {
        middle.push({ op: "+", line: b[j] ?? "" })
        j++
      }
    }
  }
  return [
    ...before.slice(0, start).map((line) => ({ op: " " as const, line })),
    ...middle,
    ...before.slice(before.length - end).map((line) => ({ op: " " as const, line })),
  ]
}

/** The replacements an edit tool's input makes, old text to new: none for another tool. */
const replacements = (
  name: string,
  input: Readonly<Record<string, unknown>>,
): ReadonlyArray<readonly [string, string]> | undefined => {
  switch (name) {
    case "Edit":
      return [[asString(input.old_string) ?? "", asString(input.new_string) ?? ""]]
    case "MultiEdit":
      return (Array.isArray(input.edits) ? input.edits : []).flatMap((each) => {
        const edit = asRecord(each)
        return edit === undefined
          ? []
          : [[asString(edit.old_string) ?? "", asString(edit.new_string) ?? ""] as const]
      })
    case "Write":
      return [["", asString(input.content) ?? ""]]
  }
  return undefined
}

/**
 * The change an Edit, MultiEdit or Write call makes, from its input; undefined for another tool. A
 * Write is counted as all its lines added, since its input doesn't say what it replaced. Each
 * replacement is a hunk of its own, numbered from the replacement's own first line, since the input
 * doesn't say where in the file it is.
 */
const changeOf = (
  name: string,
  input: Readonly<Record<string, unknown>>,
): EditChange | undefined => {
  const edits = replacements(name, input)
  if (edits === undefined) return undefined
  const path = sanitizeLine(asString(input.file_path) ?? "file")
  let added = 0
  let removed = 0
  let line = 1
  const hunks: Array<string> = []
  for (const [before, after] of edits) {
    const diff = lineDiff(linesOf(before), linesOf(after))
    const old = diff.filter((each) => each.op !== "+").length
    const now = diff.filter((each) => each.op !== "-").length
    if (diff.length === 0) continue
    added += diff.filter((each) => each.op === "+").length
    removed += diff.filter((each) => each.op === "-").length
    const range = (count: number) => (count === 0 ? `${line - 1},0` : `${line},${count}`)
    hunks.push(`@@ -${range(old)} +${range(now)} @@`)
    hunks.push(...diff.map((each) => `${each.op}${each.line}`))
    line += Math.max(old, now) + 1
  }
  const diff =
    hunks.length === 0 ? "" : [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n").concat("\n")
  return { path, added, removed, diff }
}

/**
 * The changes made from each tool call's input, by its tool's name: an input never changes once its
 * message is in, and the view draws a call's mark each time it draws the call (tutti-k2n1).
 */
const changes = new WeakMap<
  Readonly<Record<string, unknown>>,
  { readonly name: string; readonly change: EditChange | undefined }
>()

/** `changeOf` the call's input, worked out once for each input. */
export const editOf = (
  name: string,
  input: Readonly<Record<string, unknown>>,
): EditChange | undefined => {
  const known = changes.get(input)
  if (known?.name === name) return known.change
  const change = changeOf(name, input)
  changes.set(input, { name, change })
  return change
}

/** What a collapsed tool call shows of its result, at the end of its line. */
export type Mark =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Done" }
  | { readonly _tag: "Error"; readonly line: string }
  | { readonly _tag: "Edit"; readonly added: number; readonly removed: number }

/** The first line of `text` with anything on it, trimmed. */
const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? ""

/** A tool call's result collapsed to one line: `✓`, an error's first line, or `+N −M` for an edit. */
export const markOf = (tool: ToolEntry): Mark => {
  if (tool.result === null) return { _tag: "Pending" }
  if (tool.result.error) {
    return { _tag: "Error", line: sanitizeLine(firstLine(tool.result.text)) || "failed" }
  }
  const edit = editOf(tool.name, tool.input)
  return edit === undefined
    ? { _tag: "Done" }
    : { _tag: "Edit", added: edit.added, removed: edit.removed }
}

/** A numbered line of a Read result: `    40→text`, or a tab after the number. */
const numbered = /^\s*(\d+)(→|\t)/

/**
 * The range a Read call read, as `lines 40–119`: its offset and the lines it gave back, else what
 * its input asked for; empty when neither says.
 */
export const readRange = (tool: ToolEntry): string => {
  const offset = tool.input.offset
  const limit = tool.input.limit
  const lines = (tool.result?.text ?? "").split("\n").filter((line) => numbered.test(line))
  const first = Number(numbered.exec(lines[0] ?? "")?.[1] ?? Number.NaN)
  const last = Number(numbered.exec(lines.at(-1) ?? "")?.[1] ?? Number.NaN)
  if (Number.isSafeInteger(first) && Number.isSafeInteger(last)) {
    return first === last ? `line ${first}` : `lines ${first}–${last}`
  }
  const start = typeof offset === "number" && Number.isSafeInteger(offset) ? offset : 1
  if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
    return `lines ${start}–${start + limit - 1}`
  }
  return typeof offset === "number" ? `from line ${start}` : "the whole file"
}

/** What an expanded tool call shows under its line. */
export type Expansion =
  /** An edit's diff, for <diff>. */
  | { readonly _tag: "Diff"; readonly diff: string }
  /** A command's output, or another tool's result, for <code>. */
  | { readonly _tag: "Output"; readonly text: string; readonly error: boolean }
  /** The range a read read. */
  | { readonly _tag: "Range"; readonly text: string }
  /** An Agent call's subagent work. */
  | { readonly _tag: "Children" }
  | { readonly _tag: "Nothing" }

/** What expanding `tool` shows. */
export const expansionOf = (tool: ToolEntry): Expansion => {
  if (agentTools.has(tool.name)) return { _tag: "Children" }
  const error = tool.result?.error === true
  const edit = error ? undefined : editOf(tool.name, tool.input)
  if (edit !== undefined && edit.diff !== "") return { _tag: "Diff", diff: edit.diff }
  if (tool.name === "Read" && !error) return { _tag: "Range", text: readRange(tool) }
  const text = tool.result?.text.replace(/\n+$/, "") ?? ""
  return text === "" ? { _tag: "Nothing" } : { _tag: "Output", text, error }
}

/** The part of a worker's transcript the view mounts. */
export interface Window {
  /** The items mounted, oldest first. */
  readonly items: ReadonlyArray<Item>
  /** You're at the bottom: the window follows the worker. */
  readonly following: boolean
  /** The worker's latest items, oldest first: at most `atBottom`, what the bottom shows. */
  readonly latest: ReadonlyArray<Item>
  /** The file has nothing older than the first item. */
  readonly start: boolean
}

/** The window over a view's first items (Transcripts.view's), at the bottom. */
export const windowOf = (items: ReadonlyArray<Item>): Window => {
  const latest = items.slice(-atBottom)
  return { items: latest, following: true, latest, start: false }
}

/**
 * The window once `item` was appended: at the bottom it follows, letting the oldest go; scrolled
 * back, it is mounted too when the window reaches the latest items and has room, and otherwise
 * waits for the bottom.
 */
export const appended = (window: Window, item: Item): Window => {
  const last = window.latest.at(-1)
  if (last !== undefined && item.seq <= last.seq) return window
  const latest = [...window.latest, item].slice(-atBottom)
  if (window.following) return { ...window, items: latest, latest }
  const reaches = window.items.at(-1) === last
  const items = reaches && window.items.length < mountLimit ? [...window.items, item] : window.items
  return { ...window, items, latest }
}

/**
 * The window with `older` before its first item, as scrolling past the top loads them: the newest
 * beyond `mountLimit` are let go, and the window no longer follows. No items older means the top.
 */
export const prepended = (window: Window, older: ReadonlyArray<Item>): Window => {
  const first = window.items[0]?.seq ?? Number.POSITIVE_INFINITY
  const before = older.filter((item) => item.seq < first)
  if (before.length === 0) return { ...window, start: true }
  return {
    ...window,
    items: [...before, ...window.items].slice(0, mountLimit),
    following: false,
    start: false,
  }
}

/** The window scrolled away from the bottom: it stops following and keeps what it has. */
export const scrolledBack = (window: Window): Window =>
  window.following ? { ...window, following: false } : window

/** The window back at the bottom: the latest items, following again. */
export const followed = (window: Window): Window =>
  window.following && window.items === window.latest
    ? window
    : { ...window, items: window.latest, following: true, start: false }

/** What a worker view shows of its transcript now. */
export interface TranscriptState {
  readonly window: Window
  /** The messages partial messages are building, while the view is open. */
  readonly live: ReadonlyArray<Live>
  /** Older items are being read from the file. */
  readonly loading: boolean
}

/** A worker's transcript, open for its view. */
export interface OpenTranscript {
  readonly state: External<TranscriptState>
  /** Loads `olderPage` items before the window's first, as scrolling past the top does. */
  readonly older: () => void
  /** The view left the bottom: the window stops following. */
  readonly scrolledBack: () => void
  /** The view is back at the bottom: the latest items, following. */
  readonly follow: () => void
  /** Closes it: partial messages are no longer folded for this view. */
  readonly close: () => void
}

/**
 * Where worker views read their transcripts (§ 3.5: the worker view subscribes to its own worker's
 * stream from Transcripts). Like the RunView bridge, it runs its Effects itself, so React only
 * opens and closes it, as it subscribes to a store.
 */
export interface TranscriptFeed {
  /** Opens the transcript of the ticket's worker, its view's open flag set until it is closed. */
  readonly open: (ticket: string) => OpenTranscript
}

/** The state before a transcript's view has its first items. */
export const emptyTranscript: TranscriptState = {
  window: windowOf([]),
  live: [],
  loading: false,
}

/** The live messages once `update` changed the one for its parent. */
const liveWith = (
  live: ReadonlyArray<Live>,
  parent: string | null,
  next: Live | undefined,
): ReadonlyArray<Live> => {
  const others = live.filter((each) => each.parent !== parent)
  return next === undefined ? others : [...others, next]
}

/** A TranscriptFeed over `transcripts`, its views' fibers in the scope. */
export const transcriptFeed = (
  transcripts: Transcripts["Service"],
): Effect.Effect<TranscriptFeed, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const fork = <A>(effect: Effect.Effect<A>) => Effect.runSync(Effect.forkIn(effect, scope))
    return {
      open: (ticket) => {
        const store = external<TranscriptState>(emptyTranscript)
        const update = (change: (state: TranscriptState) => TranscriptState) =>
          store.set(change(store.get()))
        let opened = false
        const viewing = fork(
          Effect.scoped(
            Effect.gen(function* () {
              const view = yield* transcripts.view(ticket)
              opened = true
              store.set({ window: windowOf(view.items), live: view.live, loading: false })
              yield* Stream.runForEach(view.updates, (change) =>
                Effect.sync(() =>
                  update((state) =>
                    change._tag === "Appended"
                      ? { ...state, window: appended(state.window, change.item) }
                      : { ...state, live: liveWith(state.live, change.parent, change.live) },
                  ),
                ),
              )
            }),
          ),
        )
        return {
          state: store,
          older: () => {
            const state = store.get()
            if (!opened || state.loading || state.window.start) return
            const first = state.window.items[0]?.seq
            update((now) => ({ ...now, loading: true }))
            fork(
              Effect.flatMap(transcripts.page(ticket, first), (items) =>
                Effect.sync(() =>
                  update((now) => ({
                    ...now,
                    loading: false,
                    window:
                      now.window.items[0]?.seq === first
                        ? prepended(now.window, items)
                        : now.window,
                  })),
                ),
              ),
            )
          },
          scrolledBack: () => update((state) => ({ ...state, window: scrolledBack(state.window) })),
          follow: () => update((state) => ({ ...state, window: followed(state.window) })),
          close: () => {
            fork(Fiber.interrupt(viewing))
          },
        }
      },
    }
  })

/**
 * `entries` cut to at most `limit` mounted with `expanded` open (`mounted`): the oldest let go at
 * the bottom, the newest when scrolled back. The window holds the bound already, since each entry
 * is a content block of an item of its own; this keeps it when a message holds several.
 */
export const bounded = (
  entries: ReadonlyArray<Entry>,
  expanded: ReadonlySet<string>,
  following: boolean,
  limit: number = mountLimit,
): ReadonlyArray<Entry> => {
  const sizes = entries.map((entry) => mountedCount(entry, expanded))
  let total = sizes.reduce((sum, size) => sum + size, 0)
  let from = 0
  let to = entries.length
  while (to > from && total > limit) {
    total -= (following ? sizes[from++] : sizes[--to]) ?? 0
  }
  return from === 0 && to === entries.length ? entries : entries.slice(from, to)
}
