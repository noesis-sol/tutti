// A spec breakdown's own tools (§ 4.14), on an in-process MCP server named `tutti`, the one MCP server
// the breakdown's session is given, as the feature interview's (interviewTools.ts):
//
// - tickets_list and ticket_show read the project's tickets, as the interview's do;
// - file_root files the root epic and, where the spec needs one, the environment ticket under it,
//   P0 and solo, each with the spec's metadata: once they are filed the run can start on that ticket
//   while the session works out the rest (orchestra-qd9e.1). A root epic filed already, by an
//   earlier breakdown, refuses it;
// - file_breakdown takes the rest of the tree in one call (src/run/specTree.ts), checks it against
//   bd's issues and the repository's files, refusing it with every reason and filing nothing, or
//   files it and answers with each issue's ID; an update's changes to the open tickets go in the
//   same call. A tree filed, or one whose filing stopped part way, refuses another call.
//
// What the tools filed is kept in `state`, which the breakdown (breakdown.ts) watches: the root epic,
// the environment ticket, the counts, and the answer.
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk"
import { Data, Effect, Result, SubscriptionRef } from "effect"
import { z } from "zod"
import { checkFiles, priorities } from "../project/planFile.ts"
import { soloLabel } from "../run/holds.ts"
import { type Spec, SpecMetadata, specIssues } from "../run/spec.ts"
import {
  type CheckedTree,
  checkTree,
  type FiledTree,
  fileTree,
  type KnownIssue,
  type TreeFilingStopped,
  treeTypes,
} from "../run/specTree.ts"
import { Beads, beadsWhy, type Issue, MetadataKey, type TicketId } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { type SessionFibers, toolAnswer, toolHandler, toolRefusal } from "./callbacks.ts"
import { readTools, serverName } from "./interviewTools.ts"

/** The names of a breakdown's own tools. */
export const breakdownToolNames = [
  "tickets_list",
  "ticket_show",
  "file_root",
  "file_breakdown",
] as const

/** A breakdown's own tools as Claude Code names them. */
export const qualifiedBreakdownTools: ReadonlyArray<string> = breakdownToolNames.map(
  (name) => `mcp__${serverName}__${name}`,
)

/** What file_breakdown has made of the answer. */
export type Answer = Data.TaggedEnum<{
  None: Record<never, never>
  /** A call is filing: another is refused. */
  Filing: Record<never, never>
  /** The tree is filed. */
  Filed: { readonly tree: CheckedTree; readonly filed: FiledTree }
  /** bd failed part way: nothing more is filed. */
  Stopped: { readonly stopped: TreeFilingStopped }
  /** There is no tree to file, and why. */
  Problem: { readonly why: string }
}>

export const Answer = Data.taggedEnum<Answer>()

/** What the breakdown's tools have filed. */
export interface BreakdownState {
  /** The root epic: filed by file_root, or by an earlier breakdown. */
  readonly root: TicketId | null
  /** The environment ticket file_root filed; null for none. */
  readonly environment: TicketId | null
  /** The epics, the root epic among them, and the tickets this session has filed. */
  readonly epics: number
  readonly tickets: number
  readonly answer: Answer
}

/** A breakdown's tools, the server over them, and what they have filed. */
export interface BreakdownTools {
  // biome-ignore lint/suspicious/noExplicitAny: createSdkMcpServer's own type, for tools of any shape
  readonly tools: ReadonlyArray<SdkMcpToolDefinition<any>>
  /** The in-process MCP server the breakdown's session is given, named serverName. */
  readonly server: McpSdkServerConfigWithInstance
  readonly state: SubscriptionRef.SubscriptionRef<BreakdownState>
}

/** Whether the tools have filed something: leaving a refinement then asks nothing. */
export const filedAny = (state: BreakdownState): boolean => state.epics + state.tickets > 0

const priority = z
  .number()
  .int()
  .min(priorities[0])
  .max(priorities[priorities.length - 1] ?? 4)
  .describe("0 (critical) to 4 (backlog)")

/** file_root's input, as the model gives it. */
const rootShape = {
  title: z.string().describe("The root epic's title: what the spec builds, at most 60 characters"),
  description: z.string().describe("The spec summed up: what it builds, its parts, its epics"),
  priority: priority.describe("Its most urgent ticket's priority, 0 (critical) to 4 (backlog)"),
  environment: z
    .object({
      title: z.string().describe("A plain summary, at most 60 characters"),
      description: z.string().describe("What its worker sets up, as The environment first says"),
      acceptance: z.string().describe("What must be true when it is done"),
      files: z.array(z.string()).describe("The repository paths it changes, new ones included"),
    })
    .optional()
    .describe("The environment setup ticket, where the spec needs one: filed P0 and solo"),
}

const issueShape = z.object({
  key: z.string().describe("A name of your own for it, used once: listing, sort-by-name, …"),
  parent: z
    .string()
    .describe("The key of its epic in this call, or the ID of an epic filed; empty: the root epic"),
  type: z.enum(treeTypes),
  priority,
  title: z.string().describe("A plain summary, at most 60 characters"),
  description: z.string().describe("The context, citing the spec's sections by heading"),
  acceptance: z.string().describe("What must be true when it is done; empty for an epic"),
  labels: z.array(z.string()).describe("solo, spike, …"),
  files: z.array(z.string()).describe("The repository paths it changes; none for an epic"),
  waits_for: z
    .array(z.string())
    .describe("The tickets it waits for: keys in this call, or IDs of issues filed"),
})

/** file_breakdown's input, as the model gives it. */
const breakdownShape = {
  root: z.string().describe("The root epic's ID"),
  issues: z.array(issueShape).describe("Every other issue of the tree: child epics and tickets"),
  updates: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().optional(),
        acceptance: z.string().optional(),
        priority: priority.optional(),
        files: z.array(z.string()).optional(),
        note: z.string().describe("The change it is updated for"),
      }),
    )
    .optional()
    .describe("An update only: the open tickets of the tree the change alters"),
  deferrals: z
    .array(z.object({ id: z.string(), reason: z.string() }))
    .optional()
    .describe("An update only: the open tickets the change makes obsolete"),
  links: z
    .array(z.object({ waits: z.string(), on: z.string() }))
    .optional()
    .describe("An update only: blocks links to add, each a key or ID"),
  unlinks: z
    .array(z.object({ waits: z.string(), on: z.string() }))
    .optional()
    .describe("An update only: blocks links between filed issues to remove"),
  assumptions: z
    .array(z.string())
    .optional()
    .describe("Each assumption, a sentence naming the tickets resting on it"),
  note: z.string().optional().describe("An update only: what changed, and what was done for it"),
  problem: z
    .string()
    .optional()
    .describe("Empty, unless there is no tree to file: then why not, and no issues"),
}

const plural = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`)

/** file_breakdown's answer once the tree is filed: each issue's ID by its key, and the notes. */
export const filedTreeText = (tree: CheckedTree, filed: FiledTree): string =>
  [
    `Filed ${plural(filed.epics, "epic")} and ${plural(filed.tickets, "ticket")}:`,
    ...tree.issues.map((i) => `  ${filed.ids.get(i.key) ?? "?"} (${i.key}) ${i.title}`),
    ...(tree.updates.length + tree.deferrals.length === 0
      ? []
      : [`Updated ${tree.updates.length}, deferred ${tree.deferrals.length}.`]),
    ...(tree.notes.length === 0
      ? []
      : ["Checking the answer:", ...tree.notes.map((n) => `  ${n}`)]),
  ].join("\n")

/**
 * The breakdown's tools for `spec`, committed in the main checkout `repo`: `root` is the root epic
 * an earlier breakdown filed, if any, and `update` says whether this one updates its tree. Their
 * handlers run in the breakdown's `fibers`, with the Beads and Git they were made with.
 */
export const makeBreakdownTools = (options: {
  readonly repo: string
  readonly spec: Pick<Spec, "path">
  readonly root: TicketId | null
  readonly update: boolean
  readonly fibers: SessionFibers
}): Effect.Effect<BreakdownTools, never, Beads | Git> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const git = yield* Git
    const state = yield* SubscriptionRef.make<BreakdownState>({
      root: options.root,
      environment: null,
      epics: 0,
      tickets: 0,
      answer: Answer.None(),
    })
    const run = yield* toolHandler<Beads | Git>(options.fibers)
    const path = options.spec.path
    const counted = (epics: number, tickets: number) =>
      SubscriptionRef.update(state, (s) => ({
        ...s,
        epics: s.epics + epics,
        tickets: s.tickets + tickets,
      }))
    const tracked = git
      .trackedFiles(options.repo)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

    const fileRoot = tool(
      "file_root",
      "Files the spec's root epic and, where the spec needs one, the environment setup ticket under it (P0, solo), each with the spec's metadata. Answers with their IDs. Call it once, before file_breakdown; not when the root epic is filed already.",
      rootShape,
      (args, extra) =>
        run(
          Effect.gen(function* () {
            const now = yield* SubscriptionRef.get(state)
            if (now.root !== null) {
              return toolRefusal(
                `The root epic is filed already: ${now.root}. Nothing was filed; hand the rest of the tree to file_breakdown.`,
              )
            }
            const title = args.title.trim()
            if (title === "") return toolRefusal("The root epic has no title; nothing was filed.")
            const env = args.environment
            if (env !== undefined && env.title.trim() === "") {
              return toolRefusal("The environment ticket has no title; nothing was filed.")
            }
            const root = yield* beads
              .create({
                title,
                description: args.description.trim(),
                type: "epic",
                priority: args.priority,
                metadata: { [SpecMetadata.spec]: path },
              })
              .pipe(Effect.result)
            if (Result.isFailure(root)) {
              return toolRefusal(`bd couldn't file the root epic: ${beadsWhy(root.failure)}`)
            }
            const rootId = root.success.id
            yield* SubscriptionRef.update(state, (s) => ({
              ...s,
              root: rootId,
              epics: s.epics + 1,
            }))
            if (env === undefined) return toolAnswer(`Filed the root epic ${rootId}.`)
            const files = checkFiles(
              [{ key: "the environment ticket", files: env.files }],
              yield* tracked,
            )
            const filed = yield* beads
              .create({
                title: env.title.trim(),
                description: env.description.trim(),
                acceptance: env.acceptance.trim(),
                type: "task",
                priority: 0,
                parent: rootId,
                labels: [soloLabel],
                metadata: {
                  [SpecMetadata.spec]: path,
                  ...((files.files[0] ?? []).length === 0
                    ? {}
                    : { [MetadataKey.files]: files.files[0] }),
                },
                checked: true,
              })
              .pipe(Effect.result)
            if (Result.isFailure(filed)) {
              return toolRefusal(
                `Filed the root epic ${rootId}, but bd couldn't file the environment ticket: ${beadsWhy(filed.failure)}. Give it to file_breakdown instead.`,
              )
            }
            const envId = filed.success.id
            yield* SubscriptionRef.update(state, (s) => ({
              ...s,
              environment: envId,
              tickets: s.tickets + 1,
            }))
            return toolAnswer(
              [
                `Filed the root epic ${rootId} and the environment ticket ${envId}: list ${envId} in the waits_for of every ticket you hand file_breakdown.`,
                ...files.notes.map((n) => `  ${n}`),
              ].join("\n"),
            )
          }).pipe(Effect.uninterruptible),
          extra,
        ),
    )

    /** The issues the answer may name: the spec's, and the open tickets, by ID. */
    const knownIssues = (root: TicketId) =>
      Effect.gen(function* () {
        const spec = yield* specIssues(path)
        const open = yield* beads.list()
        const ids = new Set<string>(spec.map((issue) => issue.id))
        const known = new Map<string, KnownIssue>()
        const add = (issue: Issue, inTree: boolean) =>
          known.set(issue.id, {
            type: issue.type,
            status: issue.status,
            ...(issue.parent === undefined ? {} : { parent: issue.parent }),
            inTree,
          })
        for (const issue of open) add(issue, ids.has(issue.id))
        for (const issue of spec) add(issue, true)
        if (!known.has(root)) {
          add(yield* beads.show(root), true)
        }
        return known
      })

    const fileBreakdown = tool(
      "file_breakdown",
      "Files the rest of the spec's tree under the root epic, in one call: its child epics and tickets, and for an update the changes to the open tickets. tutti checks it first, refusing it with every reason and filing nothing; then files it and answers with each issue's ID. Call it once, last.",
      breakdownShape,
      (args, extra) => run(fileOnce(args), extra),
    )

    const fileOnce = (input: Record<string, unknown>) =>
      Effect.gen(function* () {
        const before = yield* SubscriptionRef.modify(
          state,
          (now): readonly [BreakdownState, BreakdownState] =>
            now.answer._tag === "None" ? [now, { ...now, answer: Answer.Filing() }] : [now, now],
        )
        const back = SubscriptionRef.update(state, (s) => ({ ...s, answer: Answer.None() }))
        switch (before.answer._tag) {
          case "Filing":
            return toolRefusal("The tree is being filed by another call; nothing more was filed.")
          case "Filed":
            return toolRefusal("The tree is filed already; nothing more was filed.")
          case "Stopped":
            return toolRefusal(
              `Filing the tree stopped part way, and nothing more is filed: ${before.answer.stopped.message}`,
            )
          case "Problem":
            return toolRefusal("You said there is no tree to file; nothing was filed.")
        }
        const problem = typeof input.problem === "string" ? input.problem.trim() : ""
        const issues = Array.isArray(input.issues) ? input.issues : []
        if (problem !== "" && issues.length === 0) {
          yield* SubscriptionRef.update(state, (s) => ({
            ...s,
            answer: Answer.Problem({ why: problem }),
          }))
          return toolAnswer("Noted: there is no tree to file. End your turn.")
        }
        const root = before.root
        if (root === null) {
          yield* back
          return toolRefusal("No root epic is filed yet: file it with file_root first.")
        }
        const given = typeof input.root === "string" ? input.root.trim() : ""
        if (given !== root) {
          yield* back
          return toolRefusal(
            `The root epic is ${root}, not ${JSON.stringify(given)}; nothing was filed. Call file_breakdown again with root ${root}.`,
          )
        }
        const known = yield* knownIssues(root).pipe(Effect.result)
        if (Result.isFailure(known)) {
          yield* back
          return toolRefusal(
            `bd couldn't list the issues the tree may name: ${beadsWhy(known.failure)}. Nothing was filed; try again.`,
          )
        }
        const checked = checkTree(input, {
          root,
          known: known.success,
          tracked: yield* tracked,
          update: options.update,
        })
        if (Result.isFailure(checked)) {
          yield* back
          return toolRefusal(
            [
              "tutti refused the answer; nothing was filed. Fix these and call file_breakdown again:",
              ...checked.failure.map((reason) => `- ${reason}`),
            ].join("\n"),
          )
        }
        const tree = checked.success
        const filed = yield* fileTree(tree, {
          root,
          path,
          filed: (issue) => (issue.type === "epic" ? counted(1, 0) : counted(0, 1)),
        }).pipe(Effect.result)
        if (Result.isFailure(filed)) {
          yield* SubscriptionRef.update(state, (s) => ({
            ...s,
            answer: Answer.Stopped({ stopped: filed.failure }),
          }))
          return toolRefusal(filed.failure.message)
        }
        yield* SubscriptionRef.update(state, (s) => ({
          ...s,
          answer: Answer.Filed({ tree, filed: filed.success }),
        }))
        return toolAnswer(filedTreeText(tree, filed.success))
      }).pipe(
        // Once started, filing runs to its end, so `state` always says what was filed.
        Effect.uninterruptible,
      )

    const [ticketsList, ticketShow] = readTools(beads, run)
    const tools = [ticketsList, ticketShow, fileRoot, fileBreakdown]
    return {
      tools,
      server: createSdkMcpServer({ name: serverName, version: "1.0.0", tools, alwaysLoad: true }),
      state,
    }
  })
