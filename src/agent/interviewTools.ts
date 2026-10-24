// The feature interview's own tools (§ 4.10), on an in-process MCP server (createSdkMcpServer)
// named `tutti`, the one MCP server the interview's session is given:
//
// - tickets_list and ticket_show read the project's tickets through the Beads service, so the
//   interview, which has no Bash, can look for tickets the feature would repeat;
// - file_feature takes the epic and its tickets, checks them with validatePlan against the main
//   checkout's files, as the plan organ's answer is checked, files them with filePlan, as --feature
//   does, and answers with the epic's ID. There is no feature.json: what was filed is kept in
//   `filing`, which the interview watches.
//
// Each handler runs an Effect with the services it was made with and answers in text; a call tutti
// refuses, or one bd fails, is a tool error saying why. file_feature files once: a call while
// another files, or after one filed something, is refused, so a feature is never filed twice.
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk"
import { Data, Effect, Predicate, Result, SubscriptionRef } from "effect"
import { z } from "zod"
import {
  type FeaturePlan,
  type FiledPlan,
  type FilingFailed,
  filePlan,
  filingFailedLines,
  maxPlanned,
  priorities,
  ticketTypes,
  validatePlan,
} from "../project/planFile.ts"
import { Beads, beadsWhy, type Issue } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"

/** The interview's MCP server's name: its tools are `mcp__tutti__<name>` to Claude Code. */
export const serverName = "tutti"

/** The names of the interview's own tools. */
export const toolNames = ["tickets_list", "ticket_show", "file_feature"] as const

/** The interview's own tools as Claude Code names them. */
export const qualifiedToolNames: ReadonlyArray<string> = toolNames.map(
  (name) => `mcp__${serverName}__${name}`,
)

/** The most tickets tickets_list lists; the rest are counted. */
export const maxListedTickets = 500

/** How far file_feature has got: nothing filed, filing, filed, or stopped partway. */
export type Filing = Data.TaggedEnum<{
  None: Record<never, never>
  /** A call is filing: another is refused. */
  Filing: Record<never, never>
  /** The feature is filed: the plan, and the epic's and its tickets' IDs. */
  Filed: { readonly plan: FeaturePlan; readonly filed: FiledPlan }
  /** bd failed partway, or may have filed a step all the same: nothing more is filed. */
  Stopped: { readonly failed: FilingFailed }
}>

export const Filing = Data.taggedEnum<Filing>()

/** Whether file_feature has filed something, or may have: leaving the interview then asks nothing. */
export const filedSomething = (filing: Filing): boolean =>
  filing._tag === "Filed" || filing._tag === "Stopped"

/** The interview's tools, its server over them, and what file_feature has filed. */
export interface InterviewTools {
  // biome-ignore lint/suspicious/noExplicitAny: createSdkMcpServer's own type, for tools of any shape
  readonly tools: ReadonlyArray<SdkMcpToolDefinition<any>>
  /** The in-process MCP server the interview's session is given, named serverName. */
  readonly server: McpSdkServerConfigWithInstance
  readonly filing: SubscriptionRef.SubscriptionRef<Filing>
}

type Answer = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>

const answer = (text: string): Answer => ({ content: [{ type: "text", text }] })

const refusal = (text: string): Answer => ({ content: [{ type: "text", text }], isError: true })

/** One line of tickets_list: ID, status, priority, type, title, and the epic it is under. */
export const ticketLine = (issue: Issue): string =>
  [
    issue.id,
    issue.status,
    issue.priority === undefined ? "P?" : `P${issue.priority}`,
    issue.type,
    issue.title,
    ...(issue.parent === undefined ? [] : [`(under ${issue.parent})`]),
  ].join("  ")

/** ticket_show's answer: the ticket's fields, then its texts, each under a heading. */
export const ticketText = (issue: Issue): string => {
  const waitsFor = issue.dependencies.filter((d) => d.type === "blocks").map((d) => d.id)
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["status", issue.status],
    ["type", issue.type],
    ["priority", issue.priority === undefined ? "" : String(issue.priority)],
    ["parent", issue.parent ?? ""],
    ["labels", issue.labels.join(", ")],
    ["files", issue.files.join(", ")],
    ["waits for", waitsFor.join(", ")],
  ]
  const texts: ReadonlyArray<readonly [string, string]> = [
    ["Description", issue.description],
    ["Design", issue.design],
    ["Acceptance criteria", issue.acceptance],
    ["Notes", issue.notes],
  ]
  return [
    `${issue.id}: ${issue.title}`,
    ...fields.filter(([, value]) => value !== "").map(([name, value]) => `${name}: ${value}`),
    ...texts
      .filter(([, value]) => value.trim() !== "")
      .map(([name, value]) => `\n## ${name}\n\n${value.trim()}`),
  ].join("\n")
}

/** file_feature's input, as the model gives it. */
const featureShape = {
  epic: z
    .object({
      title: z.string().describe("The epic's title: the feature, at most 60 characters"),
      description: z.string().describe("The feature, and the decisions settled in the interview"),
    })
    .describe("The epic the tickets are filed under"),
  tickets: z
    .array(
      z.object({
        key: z.string().describe("The ticket's name within this call: t1, t2, …"),
        title: z.string().describe("A plain summary of the change, at most 60 characters"),
        description: z
          .string()
          .describe(
            "The context and the decisions it depends on, the files and functions it changes",
          ),
        acceptance: z.string().describe("What must be true when it is done, the tests included"),
        type: z.enum(ticketTypes),
        priority: z
          .number()
          .int()
          .min(priorities[0])
          .max(priorities[priorities.length - 1] ?? 4)
          .describe("0 (critical) to 4 (backlog)"),
        files: z.array(z.string()).describe("The repository paths it changes, new ones included"),
        blocked_by: z
          .array(z.string())
          .describe("The keys of the tickets in this call it waits for"),
        solo: z.boolean().describe("It restructures code most tickets touch, and runs alone"),
      }),
    )
    .describe(`The epic's tickets, 1 to ${maxPlanned}, each one worker's session of work`),
}

/** file_feature's input as validatePlan reads a plan: the plan organ's field names, no questions. */
export const planOf = (input: {
  readonly epic?: unknown
  readonly tickets?: unknown
}): Record<string, unknown> => {
  const epic = Predicate.isObject(input.epic) ? input.epic : {}
  return {
    epic_title: epic.title,
    epic_description: epic.description,
    tickets: input.tickets,
    questions: [],
  }
}

const plural = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`)

/** file_feature's answer once the feature is filed: the epic's ID, each ticket's, and the notes. */
export const filedText = (plan: FeaturePlan, filed: FiledPlan): string =>
  [
    `Filed epic ${filed.epic} with ${plural(plan.tickets.length, "ticket")}:`,
    ...plan.tickets.map((t) => `  ${filed.tickets.get(t.key) ?? "?"} (${t.key}) ${t.title}`),
    ...(plan.notes.length === 0
      ? []
      : ["Checking the proposal:", ...plan.notes.map((n) => `  ${n}`)]),
  ].join("\n")

/**
 * The interview's tools for the main checkout `repo`, and the server over them. Their handlers run
 * with the Beads and Git they were made with.
 */
export const makeInterviewTools = (
  repo: string,
): Effect.Effect<InterviewTools, never, Beads | Git> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Beads | Git>()
    const beads = yield* Beads
    const git = yield* Git
    const filing = yield* SubscriptionRef.make<Filing>(Filing.None())
    const run = (effect: Effect.Effect<Answer, never, Beads | Git>) =>
      Effect.runPromiseWith(context)(effect)

    const ticketsList = tool(
      "tickets_list",
      "Lists the project's Beads tickets, one a line: ID, status, priority, type, title and the epic it is under. Without arguments, every ticket not closed.",
      {
        status: z
          .string()
          .optional()
          .describe("Only tickets with this status: open, in_progress, blocked, deferred, closed"),
        parent: z.string().optional().describe("Only the subtickets of this epic"),
        all: z.boolean().optional().describe("Closed tickets too"),
      },
      (args) =>
        run(
          beads
            .list({
              ...(args.status === undefined ? {} : { status: args.status }),
              ...(args.parent === undefined ? {} : { parent: args.parent }),
              ...(args.all === true ? { all: true } : {}),
            })
            .pipe(
              Effect.map((issues) =>
                answer(
                  issues.length === 0
                    ? "No tickets."
                    : [
                        ...issues.slice(0, maxListedTickets).map(ticketLine),
                        ...(issues.length > maxListedTickets
                          ? [`(… and ${issues.length - maxListedTickets} more)`]
                          : []),
                      ].join("\n"),
                ),
              ),
              Effect.catch((error) =>
                Effect.succeed(refusal(`bd couldn't list the tickets: ${beadsWhy(error)}`)),
              ),
            ),
        ),
      { annotations: { readOnlyHint: true } },
    )

    const ticketShow = tool(
      "ticket_show",
      "Shows one Beads ticket: its fields, description, design, acceptance criteria and notes.",
      { id: z.string().describe("The ticket's ID") },
      (args) =>
        run(
          beads.show(args.id).pipe(
            Effect.map((issue) => answer(ticketText(issue))),
            Effect.catch((error) =>
              Effect.succeed(refusal(`bd couldn't show ${args.id}: ${beadsWhy(error)}`)),
            ),
          ),
        ),
      { annotations: { readOnlyHint: true } },
    )

    const fileFeature = tool(
      "file_feature",
      "Files the feature the user agreed to: the epic, its tickets as the epic's children, and the links between them. tutti checks the proposal first and files nothing if it refuses it. Answers with the epic's ID. Call it once.",
      featureShape,
      (args) => run(fileOnce(args)),
    )

    /** file_feature: checks the proposal, then files it, once. */
    const fileOnce = (input: { readonly epic?: unknown; readonly tickets?: unknown }) =>
      Effect.gen(function* () {
        const before = yield* SubscriptionRef.modify(filing, (now): readonly [Filing, Filing] =>
          now._tag === "None" ? [now, Filing.Filing()] : [now, now],
        )
        switch (before._tag) {
          case "Filing":
            return refusal("The feature is being filed by another call; nothing more was filed.")
          case "Filed":
            return refusal(
              `The feature is already filed as epic ${before.filed.epic}; nothing more was filed.`,
            )
          case "Stopped":
            return refusal(
              "Filing the feature already stopped partway; nothing more was filed. Tell the user what was filed.",
            )
        }
        const tracked = yield* git
          .trackedFiles(repo)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const checked = validatePlan(planOf(input), tracked)
        if (Result.isFailure(checked)) {
          yield* SubscriptionRef.set(filing, Filing.None())
          return refusal(
            [
              "tutti refused the proposal; nothing was filed. Fix these and call file_feature again:",
              ...checked.failure.map((reason) => `- ${reason}`),
            ].join("\n"),
          )
        }
        const plan = checked.success
        const filed = yield* filePlan(plan).pipe(Effect.result)
        if (Result.isFailure(filed)) {
          const failed = filed.failure
          const nothing = failed.filed.length === 0 && !failed.mayHaveFiled
          yield* SubscriptionRef.set(filing, nothing ? Filing.None() : Filing.Stopped({ failed }))
          return refusal(filingFailedLines(failed).join("\n"))
        }
        yield* SubscriptionRef.set(filing, Filing.Filed({ plan, filed: filed.success }))
        return answer(filedText(plan, filed.success))
      }).pipe(
        // Once started, filing runs to its end, so `filing` always says what was filed.
        Effect.uninterruptible,
      )

    const tools = [ticketsList, ticketShow, fileFeature]
    return {
      tools,
      server: createSdkMcpServer({ name: serverName, version: "1.0.0", tools, alwaysLoad: true }),
      filing,
    }
  })
