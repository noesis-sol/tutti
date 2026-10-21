// A feature's plan (§ 4.10, § 6): an epic and its child tickets, each with its title, description,
// acceptance criteria, type, priority, files, the tickets it waits for and whether it is solo. The
// plan organ answers with one for --feature (organs/plan.ts), and the interview's file_feature tool
// takes one; both are checked and filed here.
//
// validatePlan checks a plan as orchestra v0.7.7 checks its plan organ's: unique keys, blocked_by
// naming tickets of the plan and no cycles, 1 to maxPlanned tickets (or none, with the questions
// the plan needs answered first), known types and priorities. It takes any value at all, since a
// model wrote it, and never throws: what is wrong comes back as reasons, every one it finds. Files
// that aren't the repository's, nor new files in its directories, are dropped with a note.
//
// filePlan files a checked plan with bd: the epic, its tickets as the epic's children (their files
// in the `files` metadata, the solo ones labelled solo), then the blocks links, and gives back the
// epic's ID. A step that fails stops it, with what was filed before it, so that what to remove, or
// how to carry on, can be said (filingFailedLines).
import { posix } from "node:path"
import { Effect, Result, Schema } from "effect"
import { soloLabel } from "../run/holds.ts"
import { Beads, type BeadsError, beadsWhy, MetadataKey } from "../services/Beads.ts"

/** The types a planned ticket can have. */
export const ticketTypes = ["task", "feature", "bug", "chore"] as const
export type TicketType = (typeof ticketTypes)[number]

/** The priorities a planned ticket can have: 0 (critical) to 4 (backlog). */
export const priorities = [0, 1, 2, 3, 4] as const

/** The most tickets a plan can have. */
export const maxPlanned = 12

/** A ticket of a checked plan. */
export interface PlannedTicket {
  /** Its name within the plan, which blockedBy refers to. */
  readonly key: string
  readonly title: string
  readonly type: TicketType
  readonly priority: number
  readonly description: string
  readonly acceptance: string
  /** The repository's files, or new files in its directories, without repeats. */
  readonly files: ReadonlyArray<string>
  /** The keys of the tickets it waits for, without repeats. */
  readonly blockedBy: ReadonlyArray<string>
  /** It runs with no other ticket beside it. */
  readonly solo: boolean
}

/** A checked plan: the epic and its tickets, or, with no tickets, the questions to answer first. */
export interface FeaturePlan {
  readonly epic: { readonly title: string; readonly description: string }
  readonly tickets: ReadonlyArray<PlannedTicket>
  readonly questions: ReadonlyArray<string>
  /** What checking the plan changed, such as a file dropped. */
  readonly notes: ReadonlyArray<string>
}

/** Whether the plan has no tickets: it couldn't be made without answers to its questions. */
export const needsAnswers = (plan: FeaturePlan): boolean => plan.tickets.length === 0

// ---------------------------------------------------------------------------------------------
// Checking

type Fields = Readonly<Record<string, unknown>>

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The value of `key`, its own, or undefined. */
const field = (fields: Fields, key: string): unknown =>
  Object.hasOwn(fields, key) ? fields[key] : undefined

/** `value` quoted, for a reason: a string as JSON, anything else by its type. */
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

/** The text at `key`, trimmed: "" when it is missing (or null), or a reason when it isn't text. */
const textOf = (fields: Fields, key: string, what: string, reasons: Array<string>): string => {
  const value = field(fields, key)
  if (typeof value === "string") return value.trim()
  if (value !== undefined && value !== null)
    reasons.push(`${what}'s ${key} is ${shown(value)}, not text`)
  return ""
}

/** The text at `key`, trimmed, which mustn't be blank: `missing` is the reason when it is. */
const requiredText = (
  fields: Fields,
  key: string,
  what: string,
  reasons: Array<string>,
  missing: string,
): string => {
  const value = field(fields, key)
  const text = textOf(fields, key, what, reasons)
  if (text === "" && (typeof value === "string" || value === undefined || value === null)) {
    reasons.push(missing)
  }
  return text
}

/** The texts listed at `key`, trimmed, blanks dropped: none when it is missing, or a reason. */
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
    if (typeof item !== "string") {
      reasons.push(`${what}'s ${key} has ${shown(item)} at ${i + 1}, not text`)
    } else if (item.trim() !== "") {
      texts.push(item.trim())
    }
  })
  return texts
}

/** A cycle of blocked-by links among the tickets, starting and ending with one key, or none. */
export const planCycle = (
  tickets: ReadonlyArray<Pick<PlannedTicket, "key" | "blockedBy">>,
): ReadonlyArray<string> | undefined => {
  const blockers = new Map(tickets.map((t) => [t.key, t.blockedBy]))
  const state = new Map<string, "visiting" | "done">()
  const stack: Array<string> = []
  const visit = (key: string): ReadonlyArray<string> | undefined => {
    state.set(key, "visiting")
    stack.push(key)
    for (const blocker of blockers.get(key) ?? []) {
      const seen = state.get(blocker)
      if (seen === "visiting") return [...stack.slice(stack.indexOf(blocker)), blocker]
      if (seen === undefined) {
        const cycle = visit(blocker)
        if (cycle !== undefined) return cycle
      }
    }
    stack.pop()
    state.set(key, "done")
    return undefined
  }
  for (const t of tickets) {
    if (state.get(t.key) === undefined) {
      const cycle = visit(t.key)
      if (cycle !== undefined) return cycle
    }
  }
  return undefined
}

/**
 * Each ticket's files that are the repository's (`tracked`, as git ls-files lists them), or new
 * files in a directory holding some (or at the top), cleaned and without repeats; a note for each
 * one dropped.
 */
export const checkFiles = (
  tickets: ReadonlyArray<{ readonly key: string; readonly files: ReadonlyArray<string> }>,
  tracked: ReadonlyArray<string>,
): {
  readonly files: ReadonlyArray<ReadonlyArray<string>>
  readonly notes: ReadonlyArray<string>
} => {
  const known = new Set(tracked)
  const dirs = new Set(["."])
  for (const f of tracked) {
    for (let d = posix.dirname(f); !dirs.has(d); d = posix.dirname(d)) dirs.add(d)
  }
  const notes: Array<string> = []
  const files = tickets.map((t) => {
    const kept: Array<string> = []
    for (const raw of t.files) {
      const f = raw.trim()
      if (f === "") continue
      const clean = posix.normalize(f.startsWith("./") ? f.slice(2) : f).replace(/\/+$/, "")
      const why =
        clean === "" ||
        clean === "." ||
        clean === ".." ||
        clean.startsWith("../") ||
        posix.isAbsolute(clean) ||
        clean.includes("\\") ||
        clean.includes("\0")
          ? "not a path inside the repository"
          : clean !== clean.trim()
            ? "it starts or ends with a space"
            : known.has(clean)
              ? undefined
              : dirs.has(clean)
                ? "a directory, not a file"
                : !dirs.has(posix.dirname(clean))
                  ? `not in the repository, and its directory ${posix.dirname(clean)}/ doesn't exist`
                  : undefined
      if (why !== undefined)
        notes.push(`dropped ${JSON.stringify(f)} from ${t.key}'s files: ${why}`)
      else if (!kept.includes(clean)) kept.push(clean)
    }
    return kept
  })
  return { files, notes }
}

/**
 * The plan `input` holds, checked against the repository's files (`tracked`): its fields as
 * planSchema names them (`epic_title`, `epic_description`, `tickets`, `questions`, and each
 * ticket's `key`, `title`, `type`, `priority`, `description`, `acceptance`, `files`, `blocked_by`
 * and `solo`), or every reason it can't be filed. Never throws, whatever `input` is.
 */
export const validatePlan = (
  input: unknown,
  tracked: ReadonlyArray<string>,
): Result.Result<FeaturePlan, ReadonlyArray<string>> => {
  if (!isFields(input)) return Result.fail([`the plan is ${shown(input)}, not an object`])
  const reasons: Array<string> = []
  const questions = textsOf(input, "questions", "the plan", reasons)
  const rawTickets = field(input, "tickets")
  const listed: ReadonlyArray<unknown> = Array.isArray(rawTickets) ? rawTickets : []
  if (rawTickets !== undefined && rawTickets !== null && !Array.isArray(rawTickets)) {
    reasons.push(`the plan's tickets are ${shown(rawTickets)}, not a list`)
  }
  if (listed.length === 0) {
    if (reasons.length === 0 && questions.length === 0) {
      reasons.push("the plan has no tickets and no questions")
    }
    return reasons.length > 0
      ? Result.fail(reasons)
      : Result.succeed({ epic: { title: "", description: "" }, tickets: [], questions, notes: [] })
  }
  if (listed.length > maxPlanned) {
    reasons.push(`the plan has ${listed.length} tickets, more than ${maxPlanned}`)
  }
  const epic = {
    title: requiredText(input, "epic_title", "the plan", reasons, "the plan's epic has no title"),
    description: textOf(input, "epic_description", "the plan", reasons),
  }

  const keys = new Set<string>()
  const drafts: Array<
    Omit<PlannedTicket, "blockedBy" | "files"> & { files: ReadonlyArray<string> }
  > = []
  const blockedBy: Array<ReadonlyArray<string>> = []
  listed.forEach((raw, i) => {
    if (!isFields(raw)) {
      reasons.push(`ticket ${i + 1} of the plan is ${shown(raw)}, not an object`)
      return
    }
    const key = requiredText(
      raw,
      "key",
      `ticket ${i + 1} of the plan`,
      reasons,
      `ticket ${i + 1} of the plan has no key`,
    )
    if (keys.has(key)) reasons.push(`the plan has two tickets keyed ${JSON.stringify(key)}`)
    else if (key !== "") keys.add(key)
    const what = key === "" ? `ticket ${i + 1} of the plan` : `ticket ${key} of the plan`
    const title = requiredText(raw, "title", what, reasons, `${what} has no title`)
    const type = field(raw, "type")
    if (!ticketTypes.some((known) => known === type)) {
      reasons.push(
        type === undefined || type === null
          ? `${what} has no type`
          : `${what} has the unknown type ${shown(type)}, not ${ticketTypes.join(", ")}`,
      )
    }
    const priority = field(raw, "priority")
    if (priority === undefined || priority === null) {
      reasons.push(`${what} has no priority`)
    } else if (!priorities.some((known) => known === priority)) {
      reasons.push(`${what} has the priority ${shown(priority)}, not 0 to 4`)
    }
    const solo = field(raw, "solo")
    if (solo !== undefined && solo !== null && typeof solo !== "boolean") {
      reasons.push(`${what}'s solo is ${shown(solo)}, not true or false`)
    }
    drafts.push({
      key,
      title,
      type: type as TicketType,
      priority: priority as number,
      description: textOf(raw, "description", what, reasons),
      acceptance: textOf(raw, "acceptance", what, reasons),
      files: textsOf(raw, "files", what, reasons),
      solo: solo === true,
    })
    blockedBy.push(textsOf(raw, "blocked_by", what, reasons))
  })

  const linked = drafts.map((t, i) => {
    const blockers: Array<string> = []
    for (const b of blockedBy[i] ?? []) {
      if (b === t.key) reasons.push(`ticket ${t.key} of the plan is blocked by itself`)
      else if (!keys.has(b)) {
        reasons.push(
          `ticket ${t.key || "?"} of the plan is blocked by ${JSON.stringify(b)}, which isn't in the plan`,
        )
      } else if (!blockers.includes(b)) blockers.push(b)
    }
    return { ...t, blockedBy: blockers }
  })
  if (reasons.length > 0) return Result.fail(reasons)
  const cycle = planCycle(linked)
  if (cycle !== undefined) {
    return Result.fail([`the plan's tickets block each other in a cycle: ${cycle.join(" → ")}`])
  }
  const checked = checkFiles(linked, tracked)
  return Result.succeed({
    epic,
    tickets: linked.map((t, i) => ({ ...t, files: checked.files[i] ?? [] })),
    questions,
    notes: checked.notes,
  })
}

// ---------------------------------------------------------------------------------------------
// Filing

/** A blocks link of a filed plan: ticket `blocked` waits for `blocker`, by bd ID and plan key. */
export const PlanLink = Schema.Struct({
  blocked: Schema.String,
  blocker: Schema.String,
  blockedKey: Schema.String,
  blockerKey: Schema.String,
})
export type PlanLink = typeof PlanLink.Type

/** What was filed: its bd ID, its key in the plan (none for the epic) and its title. */
export const FiledIssue = Schema.Struct({
  id: Schema.String,
  key: Schema.NullOr(Schema.String),
  title: Schema.String,
})
export type FiledIssue = typeof FiledIssue.Type

/** Filing the plan stopped at a step bd failed. */
export class FilingFailed extends Schema.TaggedError<FilingFailed>()("FilingFailed", {
  /** The step: `the epic`, `ticket t2`, `the link test-1.2 (t2) after test-1.1 (t1)`. */
  what: Schema.String,
  /** bd's error, on one line. */
  reason: Schema.String,
  /** bd may have done the step all the same: it timed out, or its output couldn't be read. */
  mayHaveFiled: Schema.Boolean,
  /** The epic's ID, once filed. */
  epic: Schema.NullOr(Schema.String),
  /** What was filed before the step, the epic first. */
  filed: Schema.Array(FiledIssue),
  /** The links not added, this step's first, when a link failed. */
  unlinked: Schema.NullOr(Schema.Array(PlanLink)),
}) {}

/** A filed plan: the epic's ID, and each ticket's by its key. */
export interface FiledPlan {
  readonly epic: string
  readonly tickets: ReadonlyMap<string, string>
}

/** Whether bd, failing with `error`, may have done what it was asked: not when it said it failed. */
const mayHaveDone = (error: BeadsError): boolean => error._tag !== "BeadsFailed"

/**
 * Files `plan` with bd: the epic, at the highest of its tickets' priorities; its tickets as its
 * children, their files in the `files` metadata and the solo ones labelled solo; then the blocks
 * links. A plan with no tickets files nothing and fails.
 */
export const filePlan = (plan: FeaturePlan): Effect.Effect<FiledPlan, FilingFailed, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const filed: Array<FiledIssue> = []
    const stop = (
      what: string,
      error: BeadsError | string,
      epic: string | null,
      unlinked: ReadonlyArray<PlanLink> | null = null,
    ) =>
      new FilingFailed({
        what,
        reason: typeof error === "string" ? error : beadsWhy(error),
        mayHaveFiled: typeof error !== "string" && mayHaveDone(error),
        epic,
        filed: [...filed],
        unlinked,
      })
    if (plan.tickets.length === 0) {
      return yield* stop("the plan", "it has no tickets, only questions", null)
    }
    const priority = Math.min(...plan.tickets.map((t) => t.priority))
    const epic = yield* beads
      .create({
        title: plan.epic.title,
        description: plan.epic.description,
        type: "epic",
        priority,
      })
      .pipe(Effect.mapError((error) => stop("the epic", error, null)))
    filed.push({ id: epic.id, key: null, title: plan.epic.title })
    const ids = new Map<string, string>()
    for (const t of plan.tickets) {
      const issue = yield* beads
        .create({
          title: t.title,
          description: t.description,
          acceptance: t.acceptance,
          type: t.type,
          priority: t.priority,
          parent: epic.id,
          // bd just gave the epic's ID, and the links' below.
          checked: true,
          ...(t.files.length === 0 ? {} : { metadata: { [MetadataKey.files]: t.files } }),
          ...(t.solo ? { labels: [soloLabel] } : {}),
        })
        .pipe(Effect.mapError((error) => stop(`ticket ${t.key}`, error, epic.id)))
      ids.set(t.key, issue.id)
      filed.push({ id: issue.id, key: t.key, title: t.title })
    }
    const links: Array<PlanLink> = plan.tickets.flatMap((t) =>
      t.blockedBy.map((b) => ({
        blocked: ids.get(t.key) ?? t.key,
        blocker: ids.get(b) ?? b,
        blockedKey: t.key,
        blockerKey: b,
      })),
    )
    for (const [i, l] of links.entries()) {
      yield* beads
        .addDependency(l.blocked, l.blocker, "blocks", { checked: true })
        .pipe(
          Effect.mapError((error) =>
            stop(
              `the link ${l.blocked} (${l.blockedKey}) after ${l.blocker} (${l.blockerKey})`,
              error,
              epic.id,
              links.slice(i),
            ),
          ),
        )
    }
    return { epic: epic.id, tickets: ids }
  })

/**
 * What to say when filing stopped: why, what was filed before it with the commands to remove it,
 * and how to carry on with it.
 */
export const filingFailedLines = (failed: FilingFailed): ReadonlyArray<string> => {
  const lines = [`tutti couldn't file ${failed.what}: ${failed.reason}`]
  if (failed.epic === null) {
    lines.push(
      failed.filed.length === 0 && !failed.mayHaveFiled
        ? "Nothing was filed."
        : "bd may have filed the epic all the same: check with: bd list --type epic",
    )
    return lines
  }
  lines.push("Filed before it:")
  for (const issue of failed.filed) {
    lines.push(`  ${issue.id} (${issue.key ?? "epic"}) ${issue.title}`)
  }
  if (failed.unlinked === null && failed.mayHaveFiled) {
    lines.push(
      `bd may have filed ${failed.what} all the same: check with: bd list --parent ${failed.epic}`,
    )
  }
  // Children before their epic.
  const ids = failed.filed.map((issue) => issue.id).reverse()
  lines.push(`Remove them with: bd delete ${ids.join(" ")} --force`)
  if (failed.unlinked === null) {
    lines.push(`Or file the rest with bd and carry on with: tutti --ticket ${failed.epic}`)
  } else {
    // Without its links the epic's tickets would run side by side, in no particular order.
    lines.push("Or add the links that are missing and carry on:")
    for (const l of failed.unlinked) lines.push(`  bd dep add ${l.blocked} ${l.blocker}`)
    lines.push(`  tutti --ticket ${failed.epic}`)
  }
  return lines
}
