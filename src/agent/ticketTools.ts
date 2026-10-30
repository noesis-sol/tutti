// tutti's own MCP server for the sessions shown in the Interview view (§ 4.10, § 4.11, § 4.14): its
// name, and the two tools every one of them has, tickets_list and ticket_show, which read the
// project's tickets through the Beads service, so that a session with no Bash can look for tickets
// it would repeat. A spec's or a feature's breakdown (breakdownTools.ts) and a question's talk
// (answerTalk.ts) add their own tools beside them; a worker's server takes the same name
// (requiresTools.ts).
import { tool } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { z } from "zod"
import { type Beads, beadsWhy, type Issue, type TicketId } from "../services/Beads.ts"
import { type ToolAnswer, toolAnswer, toolRefusal } from "./callbacks.ts"

/** tutti's own MCP server's name: its tools are `mcp__tutti__<name>` to Claude Code. */
export const serverName = "tutti"

/** The most tickets tickets_list lists; the rest are counted. */
export const maxListedTickets = 500

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

/**
 * tickets_list and ticket_show, reading the project's tickets through `beads`, their handlers run
 * with `run` (toolHandler): the breakdown's and a question's talk's.
 */
export const readTools = (
  beads: Beads["Service"],
  run: (effect: Effect.Effect<ToolAnswer, unknown>, extra: unknown) => Promise<ToolAnswer>,
) => {
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
    (args, extra) =>
      run(
        // The model names the epic by its ID, as bd gave it: bd looks it up.
        beads
          .list({
            ...(args.status === undefined ? {} : { status: args.status }),
            ...(args.parent === undefined ? {} : { parent: args.parent as TicketId }),
            ...(args.all === true ? { all: true } : {}),
          })
          .pipe(
            Effect.map((issues) =>
              toolAnswer(
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
              Effect.succeed(toolRefusal(`bd couldn't list the tickets: ${beadsWhy(error)}`)),
            ),
          ),
        extra,
      ),
    { annotations: { readOnlyHint: true } },
  )

  const ticketShow = tool(
    "ticket_show",
    "Shows one Beads ticket: its fields, description, design, acceptance criteria and notes.",
    { id: z.string().describe("The ticket's ID") },
    (args, extra) =>
      run(
        // The model names the ticket by its ID, as bd gave it: bd looks it up.
        beads.show(args.id as TicketId).pipe(
          Effect.map((issue) => toolAnswer(ticketText(issue))),
          Effect.catch((error) =>
            Effect.succeed(toolRefusal(`bd couldn't show ${args.id}: ${beadsWhy(error)}`)),
          ),
        ),
        extra,
      ),
    { annotations: { readOnlyHint: true } },
  )
  return [ticketsList, ticketShow] as const
}
