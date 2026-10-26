// A spec's tree (§ 4.14): what the breakdown's session hands tutti to file, checked and filed here.
// The session files the root epic and the environment ticket itself (file_root), so that the run can
// start on that ticket early; the rest of the tree comes in one answer (file_breakdown), which tutti
// files with bd, saving the session a turn for each issue (orchestra-aehg: 46 of 56 turns).
//
// checkTree reads the answer as a model wrote it, any value at all, and never throws: each issue
// has a key of its own, a parent (the key of an epic in the answer, the ID of an epic of the spec's
// tree, or none for the root epic), a type, a priority, a title, a description, acceptance criteria,
// labels, files and the issues it waits for, each by its key or the ID of an issue bd has. An
// update of the tree (the spec changed) also gives the open tickets it changes, defers, and the
// blocks links it adds and removes. What is wrong comes back as reasons, every one found: a key
// used twice, a key or ID naming no issue, a cycle among the parents and the blocks links together
// (an epic waiting for a ticket under it), a closed or in-progress ticket changed.
//
// fileTree files a checked tree: each issue after its parent and the issues it waits for, with the
// spec's metadata and its blocks links in the one bd create, so that bd failing part way leaves
// every issue filed with all its links; then the links, the changes and the deferrals; then the
// assumptions and the change's note in the root epic's notes. A step that fails stops it, saying
// how far it got.
import { Effect, Predicate, Result, Schema } from "effect"
import { checkFiles, priorities, ticketTypes } from "../project/planFile.ts"
import {
  Beads,
  type BeadsError,
  beadsWhy,
  HumanLabel,
  MetadataKey,
  type Status,
  type TicketId,
} from "../services/Beads.ts"
import { specKey } from "./start.ts"

/** The types an issue of the tree can have: an epic, or a ticket's. */
export const treeTypes = ["epic", ...ticketTypes] as const
export type TreeType = (typeof treeTypes)[number]

/** An issue named in the answer: one of the answer's own, by its key, or one bd has, by its ID. */
export type TreeRef =
  | { readonly _tag: "Key"; readonly key: string }
  | { readonly _tag: "Id"; readonly id: TicketId }

/** An issue of a checked tree, to file. */
export interface TreeIssue {
  readonly key: string
  /** Its epic: the root epic when none. */
  readonly parent: TreeRef | null
  readonly type: TreeType
  readonly priority: number
  readonly title: string
  readonly description: string
  /** None for an epic. */
  readonly acceptance: string
  readonly labels: ReadonlyArray<string>
  /** None for an epic. */
  readonly files: ReadonlyArray<string>
  readonly waitsFor: ReadonlyArray<TreeRef>
}

/** An open ticket of the tree the change alters. */
export interface TreeUpdate {
  readonly id: TicketId
  readonly description?: string
  readonly acceptance?: string
  readonly priority?: number
  readonly files?: ReadonlyArray<string>
  /** Appended to its notes, naming the change. */
  readonly note: string
}

/** An open ticket of the tree the change makes obsolete. */
export interface TreeDeferral {
  readonly id: TicketId
  readonly reason: string
}

/** A blocks link: `waits` waits for `on`. */
export interface TreeLink {
  readonly waits: TreeRef
  readonly on: TreeRef
}

/** A blocks link between two issues bd has, to remove. */
export interface TreeUnlink {
  readonly waits: TicketId
  readonly on: TicketId
}

/** A checked tree: its issues in the order they are filed, and an update's changes. */
export interface CheckedTree {
  readonly issues: ReadonlyArray<TreeIssue>
  readonly updates: ReadonlyArray<TreeUpdate>
  readonly deferrals: ReadonlyArray<TreeDeferral>
  readonly links: ReadonlyArray<TreeLink>
  readonly unlinks: ReadonlyArray<TreeUnlink>
  /** The choices the spec left open, each naming the tickets resting on it. */
  readonly assumptions: ReadonlyArray<string>
  /** What the change was and what the update did, for the root epic's notes; "" for none. */
  readonly note: string
  /** What checking the tree changed, such as a file dropped. */
  readonly notes: ReadonlyArray<string>
}

/** An issue bd has that the answer may name. */
export interface KnownIssue {
  readonly type: string
  readonly status: Status
  readonly parent?: TicketId
  /** It is the spec's: the root epic or under it. */
  readonly inTree: boolean
}

/** What the answer is checked against. */
export interface TreeContext {
  readonly root: TicketId
  /** The spec's issues and the open tickets, by ID, the root epic among them. */
  readonly known: ReadonlyMap<string, KnownIssue>
  /** The repository's files, as git ls-files lists them. */
  readonly tracked: ReadonlyArray<string>
  /** The answer updates a tree filed for an earlier version of the spec. */
  readonly update: boolean
}

// ---------------------------------------------------------------------------------------------
// Reading

type Fields = Readonly<Record<string, unknown>>

const field = (fields: Fields, key: string): unknown =>
  Object.hasOwn(fields, key) ? fields[key] : undefined

const shown = (value: unknown): string =>
  typeof value === "string"
    ? JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value)
    : typeof value === "number"
      ? String(value)
      : value === null
        ? "null"
        : Array.isArray(value)
          ? "a list"
          : `a ${typeof value}`

/** The text at `key`, trimmed: "" when missing, or a reason when it isn't text. */
const textOf = (fields: Fields, key: string, what: string, reasons: Array<string>): string => {
  const value = field(fields, key)
  if (typeof value === "string") return value.trim()
  if (value !== undefined && value !== null)
    reasons.push(`${what}'s ${key} is ${shown(value)}, not text`)
  return ""
}

/** The texts listed at `key`, trimmed, blanks dropped, or a reason. */
const textsOf = (
  fields: Fields,
  key: string,
  what: string,
  reasons: Array<string>,
): ReadonlyArray<string> => {
  const value = field(fields, key)
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    reasons.push(`${what}'s ${key} is ${shown(value)}, not a list`)
    return []
  }
  const texts: Array<string> = []
  value.forEach((item: unknown, i) => {
    if (typeof item !== "string")
      reasons.push(`${what}'s ${key} has ${shown(item)} at ${i + 1}, not text`)
    else if (item.trim() !== "" && !texts.includes(item.trim())) texts.push(item.trim())
  })
  return texts
}

/** The objects listed at `key`, or a reason. */
const objectsOf = (
  fields: Fields,
  key: string,
  reasons: Array<string>,
): ReadonlyArray<Fields | null> => {
  const value = field(fields, key)
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    reasons.push(`the answer's ${key} is ${shown(value)}, not a list`)
    return []
  }
  return value.map((item: unknown, i) => {
    if (Predicate.isObject(item)) return item
    reasons.push(`${key} ${i + 1} of the answer is ${shown(item)}, not an object`)
    return null
  })
}

/** The priority at `key`, 0 to 4, or a reason; `required` says whether none is one. */
const priorityOf = (
  fields: Fields,
  what: string,
  reasons: Array<string>,
  required: boolean,
): number | undefined => {
  const value = field(fields, "priority")
  if (value === undefined || value === null) {
    if (required) reasons.push(`${what} has no priority`)
    return undefined
  }
  if (!priorities.some((known) => known === value)) {
    reasons.push(`${what} has the priority ${shown(value)}, not 0 to 4`)
    return undefined
  }
  return value as number
}

const plural = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`)

/**
 * The tree `input` holds, checked against `context`, or every reason it can't be filed. Its fields
 * as the file_breakdown tool names them: `issues` (each `key`, `parent`, `type`, `priority`,
 * `title`, `description`, `acceptance`, `labels`, `files`, `waits_for`), `updates` (`id`,
 * `description`, `acceptance`, `priority`, `files`, `note`), `deferrals` (`id`, `reason`), `links`
 * and `unlinks` (`waits`, `on`), `assumptions` and `note`. Never throws, whatever `input` is.
 */
export const checkTree = (
  input: unknown,
  context: TreeContext,
): Result.Result<CheckedTree, ReadonlyArray<string>> => {
  if (!Predicate.isObject(input))
    return Result.fail([`the answer is ${shown(input)}, not an object`])
  const reasons: Array<string> = []
  const notes: Array<string> = []
  const { known, root } = context

  // The keys first, so that a reference can be read as a key or an ID.
  const raws = objectsOf(input, "issues", reasons)
  const keys = new Map<string, number>()
  raws.forEach((raw, i) => {
    if (raw === null) return
    const key = textOf(raw, "key", `issue ${i + 1} of the answer`, reasons)
    if (key === "") reasons.push(`issue ${i + 1} of the answer has no key`)
    else if (keys.has(key)) reasons.push(`the answer has two issues keyed ${JSON.stringify(key)}`)
    else if (known.has(key) || key === root) {
      reasons.push(
        `issue ${i + 1}'s key ${JSON.stringify(key)} is the ID of an issue bd has: give it a key of its own`,
      )
    } else keys.set(key, i)
  })

  /** The issue `text` names: a key of the answer's, else an ID bd has; a reason when neither. */
  const refOf = (text: string, what: string): TreeRef | undefined => {
    if (keys.has(text)) return { _tag: "Key", key: text }
    if (known.has(text)) return { _tag: "Id", id: text as TicketId }
    reasons.push(
      `${what} names ${JSON.stringify(text)}, which is neither a key of the answer nor an issue bd has`,
    )
    return undefined
  }

  const drafts: Array<TreeIssue> = []
  raws.forEach((raw, i) => {
    if (raw === null) return
    const key = textOf(raw, "key", `issue ${i + 1} of the answer`, [])
    if (keys.get(key) !== i) return
    const what = `issue ${key}`
    const title = textOf(raw, "title", what, reasons)
    if (title === "") reasons.push(`${what} has no title`)
    const type = field(raw, "type")
    if (!treeTypes.some((t) => t === type)) {
      reasons.push(
        type === undefined || type === null
          ? `${what} has no type`
          : `${what} has the unknown type ${shown(type)}, not ${treeTypes.join(", ")}`,
      )
    }
    const epic = type === "epic"
    const priority = priorityOf(raw, what, reasons, true) ?? 2
    const parentText = textOf(raw, "parent", what, reasons)
    let parent: TreeRef | null = null
    if (parentText !== "" && parentText !== root) {
      const ref = refOf(parentText, `${what}'s parent`)
      if (ref?._tag === "Key" && field(raws[keys.get(ref.key) ?? -1] ?? {}, "type") !== "epic") {
        reasons.push(`${what}'s parent ${ref.key} isn't an epic`)
      } else if (ref?._tag === "Id") {
        const issue = known.get(ref.id)
        if (issue !== undefined && !issue.inTree) {
          reasons.push(`${what}'s parent ${ref.id} isn't in the spec's tree`)
        } else if (issue !== undefined && issue.type !== "epic") {
          reasons.push(`${what}'s parent ${ref.id} isn't an epic`)
        }
      }
      parent = ref ?? null
    }
    const waitsFor: Array<TreeRef> = []
    for (const text of textsOf(raw, "waits_for", what, reasons)) {
      if (text === key) {
        reasons.push(`${what} waits for itself`)
        continue
      }
      const ref = refOf(text, `${what}'s waits_for`)
      if (ref !== undefined) waitsFor.push(ref)
    }
    const labels = textsOf(raw, "labels", what, reasons).filter((label) => {
      if (label !== HumanLabel) return true
      notes.push(
        `dropped the label ${HumanLabel} from ${key}: nobody answers a spec run's questions`,
      )
      return false
    })
    const description = textOf(raw, "description", what, reasons)
    const acceptance = textOf(raw, "acceptance", what, reasons)
    const files = textsOf(raw, "files", what, reasons)
    drafts.push({
      key,
      parent,
      type: type as TreeType,
      priority,
      title,
      description,
      acceptance: epic ? "" : acceptance,
      labels,
      files: epic ? [] : files,
      waitsFor,
    })
  })

  // The changes of an update, to open tickets of the tree alone.
  const changeable = (id: string, what: string): id is TicketId => {
    const issue = known.get(id)
    if (issue === undefined || !issue.inTree) {
      reasons.push(`${what} names ${JSON.stringify(id)}, which isn't an issue of the spec's tree`)
      return false
    }
    if (id === root) {
      reasons.push(`${what} names the root epic ${root}, which the update leaves as it is`)
      return false
    }
    if (issue.status === "closed") {
      reasons.push(
        `${what} names ${id}, which is closed: file a new ticket that changes its work instead`,
      )
      return false
    }
    if (issue.status === "in_progress") {
      reasons.push(`${what} names ${id}, which a worker has: file a ticket blocked by it instead`)
      return false
    }
    return true
  }
  const updates: Array<TreeUpdate> = []
  const deferrals: Array<TreeDeferral> = []
  const links: Array<TreeLink> = []
  const unlinks: Array<TreeUnlink> = []
  const updateRaws = objectsOf(input, "updates", reasons)
  const deferralRaws = objectsOf(input, "deferrals", reasons)
  const linkRaws = objectsOf(input, "links", reasons)
  const unlinkRaws = objectsOf(input, "unlinks", reasons)
  if (
    !context.update &&
    updateRaws.length + deferralRaws.length + linkRaws.length + unlinkRaws.length > 0
  ) {
    reasons.push(
      "updates, deferrals, links and unlinks are for an update of a tree filed already: give each issue's waits_for instead",
    )
  } else {
    updateRaws.forEach((raw, i) => {
      if (raw === null) return
      const what = `update ${i + 1}`
      const id = textOf(raw, "id", what, reasons)
      const note = textOf(raw, "note", what, reasons)
      const description = textOf(raw, "description", what, reasons)
      const acceptance = textOf(raw, "acceptance", what, reasons)
      const priority = priorityOf(raw, what, reasons, false)
      const files =
        field(raw, "files") === undefined ? undefined : textsOf(raw, "files", what, reasons)
      if (note === "") reasons.push(`${what} has no note naming the change`)
      if (!changeable(id, what)) return
      updates.push({
        id,
        note,
        ...(description === "" ? {} : { description }),
        ...(acceptance === "" ? {} : { acceptance }),
        ...(priority === undefined ? {} : { priority }),
        ...(files === undefined ? {} : { files }),
      })
    })
    deferralRaws.forEach((raw, i) => {
      if (raw === null) return
      const what = `deferral ${i + 1}`
      const id = textOf(raw, "id", what, reasons)
      const reason = textOf(raw, "reason", what, reasons)
      if (reason === "") reasons.push(`${what} has no reason naming the change`)
      if (changeable(id, what)) deferrals.push({ id, reason })
    })
    linkRaws.forEach((raw, i) => {
      if (raw === null) return
      const what = `link ${i + 1}`
      const waits = refOf(textOf(raw, "waits", what, reasons), `${what}'s waits`)
      const on = refOf(textOf(raw, "on", what, reasons), `${what}'s on`)
      if (waits === undefined || on === undefined) return
      if (waits._tag === "Id" && known.get(waits.id)?.status === "closed") {
        reasons.push(`${what}: ${waits.id} is closed, and waits for nothing more`)
        return
      }
      links.push({ waits, on })
    })
    unlinkRaws.forEach((raw, i) => {
      if (raw === null) return
      const what = `unlink ${i + 1}`
      const waits = textOf(raw, "waits", what, reasons)
      const on = textOf(raw, "on", what, reasons)
      for (const id of [waits, on]) {
        if (!known.has(id))
          reasons.push(`${what} names ${JSON.stringify(id)}, which bd doesn't have`)
      }
      if (known.has(waits) && known.has(on))
        unlinks.push({ waits: waits as TicketId, on: on as TicketId })
    })
  }
  const assumptions = textsOf(input, "assumptions", "the answer", reasons)
  const note = textOf(input, "note", "the answer", reasons)
  if (reasons.length > 0) return Result.fail(reasons)

  const cycle = treeCycle(drafts, links, context)
  if (cycle !== undefined) {
    return Result.fail([`the tree's parents and blocks links make a cycle: ${cycle.join(" → ")}`])
  }
  const tickets = drafts.filter((issue) => issue.type !== "epic")
  const checked = checkFiles(tickets, context.tracked, { newFolders: true })
  const filesOf = new Map(tickets.map((t, i) => [t.key, checked.files[i] ?? []]))
  const updated = checkFiles(
    updates.map((u) => ({ key: u.id, files: u.files ?? [] })),
    context.tracked,
    { newFolders: true },
  )
  return Result.succeed({
    issues: inFilingOrder(drafts).map((issue) => ({
      ...issue,
      files: filesOf.get(issue.key) ?? [],
    })),
    updates: updates.map((u, i) =>
      u.files === undefined ? u : { ...u, files: updated.files[i] ?? [] },
    ),
    deferrals,
    links,
    unlinks,
    assumptions,
    note,
    notes: [...notes, ...checked.notes, ...updated.notes],
  })
}

/** The name of the issue `ref` names, as a cycle shows it. */
const nameOf = (ref: TreeRef): string => (ref._tag === "Key" ? ref.key : ref.id)

/**
 * A cycle among the tree's parents and blocks links together, as the names in it, or none. Each
 * issue starts and finishes: it finishes after it starts; an epic finishes after each issue under
 * it, which starts only once the epic may (bd holds a blocked epic's subtickets back); an issue
 * waiting for another starts after that one finishes. So an epic waiting for a ticket under it,
 * or a ticket for its own epic, waits for ever, as two tickets waiting for each other do. The
 * blocks links bd has already are not read: the answer's issues are new, so none of them waits
 * for one of these.
 */
export const treeCycle = (
  issues: ReadonlyArray<Pick<TreeIssue, "key" | "parent" | "waitsFor">>,
  links: ReadonlyArray<TreeLink>,
  context: Pick<TreeContext, "known" | "root">,
): ReadonlyArray<string> | undefined => {
  // An edge from a step to one it comes after.
  const edges = new Map<string, Array<string>>()
  const add = (from: string, to: string) => {
    const list = edges.get(from) ?? []
    list.push(to)
    edges.set(from, list)
  }
  const issue = (name: string) => add(`F\0${name}`, `S\0${name}`)
  const under = (parent: string, child: string) => {
    add(`F\0${parent}`, `F\0${child}`)
    add(`S\0${child}`, `S\0${parent}`)
  }
  const waits = (waiter: string, on: string) => add(`S\0${waiter}`, `F\0${on}`)
  for (const [id, known] of context.known) {
    issue(id)
    if (known.parent !== undefined) under(known.parent, id)
  }
  for (const i of issues) {
    issue(i.key)
    under(i.parent === null ? context.root : nameOf(i.parent), i.key)
    for (const ref of i.waitsFor) waits(i.key, nameOf(ref))
  }
  for (const link of links) waits(nameOf(link.waits), nameOf(link.on))
  const state = new Map<string, "visiting" | "done">()
  const stack: Array<string> = []
  const visit = (n: string): ReadonlyArray<string> | undefined => {
    state.set(n, "visiting")
    stack.push(n)
    for (const next of edges.get(n) ?? []) {
      const seen = state.get(next)
      if (seen === "visiting") return [...stack.slice(stack.indexOf(next)), next]
      if (seen === undefined) {
        const cycle = visit(next)
        if (cycle !== undefined) return cycle
      }
    }
    stack.pop()
    state.set(n, "done")
    return undefined
  }
  for (const n of [...edges.keys()].sort()) {
    if (state.get(n) !== undefined) continue
    const cycle = visit(n)
    if (cycle === undefined) continue
    // Each issue once where its start and finish follow each other, the cycle closed on its first.
    const names: Array<string> = []
    for (const step of cycle) {
      const name = step.slice(2)
      if (names.at(-1) !== name) names.push(name)
    }
    if (names.length > 1 && names[0] === names.at(-1)) names.pop()
    return [...names, names[0] ?? ""]
  }
  return undefined
}

/**
 * The issues each after its parent and the issues it waits for, of those in the answer, and
 * otherwise in the answer's order. They make no cycle (treeCycle).
 */
export const inFilingOrder = (issues: ReadonlyArray<TreeIssue>): ReadonlyArray<TreeIssue> => {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]))
  const placed = new Set<string>()
  const ordered: Array<TreeIssue> = []
  const place = (issue: TreeIssue) => {
    if (placed.has(issue.key)) return
    placed.add(issue.key)
    for (const ref of [...(issue.parent === null ? [] : [issue.parent]), ...issue.waitsFor]) {
      const before = ref._tag === "Key" ? byKey.get(ref.key) : undefined
      if (before !== undefined) place(before)
    }
    ordered.push(issue)
  }
  for (const issue of issues) place(issue)
  return ordered
}

// ---------------------------------------------------------------------------------------------
// Filing

/** Filing the tree stopped at a step bd failed. */
export class TreeFilingStopped extends Schema.TaggedError<TreeFilingStopped>()(
  "TreeFilingStopped",
  {
    /** The step: `issue listing (List the shop's items)`, `the link a.2 after a.1`. */
    what: Schema.String,
    reason: Schema.String,
    /** How many of the answer's issues were filed before it, of how many. */
    filed: Schema.Number,
    total: Schema.Number,
  },
) {
  override get message(): string {
    return `tutti filed ${this.filed} of its answer's ${plural(this.total, "issue")}, then couldn't file ${this.what}: ${this.reason}`
  }
}

/** A filed tree: each of the answer's issues' IDs, by its key. */
export interface FiledTree {
  readonly ids: ReadonlyMap<string, TicketId>
  readonly epics: number
  readonly tickets: number
}

/** The root epic's note for the tree filed: the change's note, then the assumptions; "" for none. */
export const rootNote = (tree: Pick<CheckedTree, "note" | "assumptions">): string => {
  const parts: Array<string> = []
  if (tree.note !== "") parts.push(tree.note)
  if (tree.assumptions.length > 0) {
    parts.push(["Assumptions", "", ...tree.assumptions.map((a) => `- ${a}`)].join("\n"))
  }
  return parts.join("\n\n")
}

/**
 * Files `tree` under `root` with bd, every issue with the metadata `spec` (`path`): the issues in
 * their order, each with its links, then the links, the deferred links removed, the updates and
 * the deferrals, then the root epic's note. `filed` hears of each issue filed.
 */
export const fileTree = (
  tree: CheckedTree,
  options: {
    readonly root: TicketId
    readonly path: string
    readonly filed?: (issue: TreeIssue, id: TicketId) => Effect.Effect<void>
  },
): Effect.Effect<FiledTree, TreeFilingStopped, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ids = new Map<string, TicketId>()
    const total = tree.issues.length
    const stop = (what: string) => (error: BeadsError) =>
      new TreeFilingStopped({ what, reason: beadsWhy(error), filed: ids.size, total })
    // Every key is filed before what names it (inFilingOrder), and every ID is bd's (checkTree).
    const idOf = (ref: TreeRef): TicketId =>
      ref._tag === "Id" ? ref.id : (ids.get(ref.key) ?? (ref.key as TicketId))
    for (const issue of tree.issues) {
      const created = yield* beads
        .create({
          title: issue.title,
          description: issue.description,
          ...(issue.type === "epic" ? {} : { acceptance: issue.acceptance }),
          type: issue.type,
          priority: issue.priority,
          parent: issue.parent === null ? options.root : idOf(issue.parent),
          blockedBy: issue.waitsFor.map(idOf),
          ...(issue.labels.length === 0 ? {} : { labels: issue.labels }),
          metadata: {
            [specKey]: options.path,
            ...(issue.files.length === 0 ? {} : { [MetadataKey.files]: issue.files }),
          },
          checked: true,
        })
        .pipe(Effect.mapError(stop(`issue ${issue.key} (${issue.title})`)))
      ids.set(issue.key, created.id)
      if (options.filed !== undefined) yield* options.filed(issue, created.id)
    }
    for (const link of tree.links) {
      const waits = idOf(link.waits)
      const on = idOf(link.on)
      yield* beads
        .addDependency(waits, on, "blocks", { checked: true })
        .pipe(Effect.mapError(stop(`the link ${waits} after ${on}`)))
    }
    for (const unlink of tree.unlinks) {
      yield* beads
        .removeDependency(unlink.waits, unlink.on)
        .pipe(Effect.mapError(stop(`the removal of the link ${unlink.waits} after ${unlink.on}`)))
    }
    for (const u of tree.updates) {
      yield* beads
        .update(u.id, {
          appendNotes: u.note,
          ...(u.description === undefined ? {} : { description: u.description }),
          ...(u.acceptance === undefined ? {} : { acceptance: u.acceptance }),
          ...(u.priority === undefined ? {} : { priority: u.priority }),
          ...(u.files === undefined ? {} : { metadata: { [MetadataKey.files]: u.files } }),
        })
        .pipe(Effect.mapError(stop(`the update of ${u.id}`)))
    }
    for (const d of tree.deferrals) {
      yield* beads
        .defer(d.id, { reason: d.reason })
        .pipe(Effect.mapError(stop(`the deferral of ${d.id}`)))
    }
    const note = rootNote(tree)
    if (note !== "") {
      yield* beads
        .update(options.root, { appendNotes: note })
        .pipe(Effect.mapError(stop(`the note on ${options.root}`)))
    }
    const epics = tree.issues.filter((issue) => issue.type === "epic").length
    return { ids, epics, tickets: total - epics }
  })
