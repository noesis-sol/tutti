// A worker's own tools on the project's requires list (§ 4.11, § 8.4), on an in-process MCP server
// (createSdkMcpServer) named `tutti`, which each worker's session gets beside workers.mcp_servers:
//
// - requires_check checks the list in the worker's worktree, as `tutti requires` does: each entry's
//   check, and for one that fails, its install, then the check again (checkRequires), each entry's
//   state a line of its answer. Only some entries are checked when named; no_install only checks;
// - requires_readme writes README.md's section on what to install from the worktree's list
//   (writeReadmeRequires), as `tutti requires --readme` does, for the worker to commit with it.
//
// Both read the worktree's .tutti/settings.json, so a worker that adds an entry checks that entry,
// and writes that README, on its branch, without tutti on its PATH. tutti runs only the entries the
// main checkout's list has as they are there, and runs them in the main checkout, as a run's start
// does: neither the commands nor the files they run are the branch's. An entry the branch adds or
// changes is the worker's to write, so its commands are given back for the worker to run with Bash,
// where the permission mode sees them (the classifier, a person, Bash's rules and the sandbox), in
// the workers' environment; tutti running them, the permission request would show only the tool's
// input, the entries' names. Each session gets a server of its own (an SDK server serves one
// session), made for its worktree; the handlers run with the services the maker was given, and stop
// with the call (its abort signal). A list the settings refuse, a name not in it, or a README whose
// markers don't pair is a tool error saying why.
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Effect, type FileSystem, Predicate } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { z } from "zod"
import {
  appliesOn,
  readmeName,
  requiresEnd,
  requiresStart,
  writeReadmeRequires,
} from "../project/requires.ts"
import { type Requirement, readSettings, settingsFile } from "../project/settings.ts"
import {
  checkRequires,
  missingOf,
  type RequireResult,
  sameRequires,
  says,
} from "../run/requires.ts"
import { serverName } from "./interviewTools.ts"

/** The worker's server's name, the interview's: its tools are `mcp__tutti__<name>` to Claude Code. */
export const requiresServerName = serverName

/** The names of a worker's requires tools. */
export const requiresToolNames = ["requires_check", "requires_readme"] as const

/** A worker's requires tool `name` as Claude Code names it. */
export const qualifiedRequiresTool = (name: (typeof requiresToolNames)[number]): string =>
  `mcp__${requiresServerName}__${name}`

/** The services a worker's requires tools run with: the commands', and the files'. */
export type RequiresToolsServices = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

/** A worker's requires tools, and the server over them. */
export interface RequiresTools {
  // biome-ignore lint/suspicious/noExplicitAny: createSdkMcpServer's own type, for tools of any shape
  readonly tools: ReadonlyArray<SdkMcpToolDefinition<any>>
  /** The in-process MCP server the worker's session is given, named requiresServerName. */
  readonly server: McpSdkServerConfigWithInstance
}

type Answer = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>

const answer = (text: string): Answer => ({ content: [{ type: "text", text }] })

const refusal = (text: string): Answer => ({ content: [{ type: "text", text }], isError: true })

/** The abort signal an MCP call's `extra` carries, if it carries one. */
const signalOf = (extra: unknown): AbortSignal | undefined => {
  const signal = Predicate.hasProperty(extra, "signal") ? extra.signal : undefined
  return signal instanceof AbortSignal ? signal : undefined
}

/** The worktree's settings, or the refusal saying what is wrong with them, as `tutti requires` says it. */
const settingsIn = (worktree: string) =>
  Effect.map(Effect.result(readSettings(worktree)), (read) =>
    read._tag === "Success"
      ? read
      : {
          _tag: "Failure" as const,
          failure: refusal(
            read.failure.problems
              .map(
                (problem) =>
                  `${settingsFile}: ${problem.path === "" ? "" : `${problem.path}: `}${problem.message}`,
              )
              .join("\n"),
          ),
        },
  )

/** requires_check's input. */
const checkShape = {
  names: z
    .array(z.string())
    .optional()
    .describe("Only these entries of the list, by name; every entry when left out"),
  no_install: z
    .boolean()
    .optional()
    .describe("Only check: run no install for an entry whose check fails"),
}

/**
 * What the worker is to run with Bash for the entry `r` its branch adds or changes: its check, and
 * where that fails, its install and the check again, or its manual step; only the check with
 * `noInstall`.
 */
export const yoursToRun = (
  r: Requirement,
  change: "new" | "changed",
  noInstall: boolean,
): string => {
  const check = `${change} on your branch, so tutti doesn't run it: run its check with Bash, '${r.check}'`
  if (noInstall) return check
  if (r.install !== undefined && r.install !== "") {
    return `${check}; where it fails, its install, '${r.install}', then the check again`
  }
  return `${check}; where it fails, ask the maintainer for its manual step: ${r.manual ?? ""}`
}

/**
 * requires_check for the worker in `worktree`, the main checkout at `repo`, for `args`: each entry's
 * state a line, then what is missing; an entry the main checkout's list lacks, or has otherwise, is
 * given back to run with Bash (see the module's comment).
 */
export const checkIn = (
  repo: string,
  worktree: string,
  args: {
    readonly names?: ReadonlyArray<string> | undefined
    readonly no_install?: boolean | undefined
  },
) =>
  Effect.gen(function* () {
    const settings = yield* settingsIn(worktree)
    if (settings._tag === "Failure") return settings.failure
    const list = settings.success.requires
    const names = args.names ?? []
    const unknown = names.filter((name) => !list.some((r) => r.name === name))
    if (unknown.length > 0) {
      const has =
        list.length === 0 ? "it has no entries" : `it has ${list.map((r) => r.name).join(", ")}`
      return refusal(
        `Not in the requires list in ${settingsFile}: ${unknown.join(", ")}; ${has}. Add an entry for it there first.`,
      )
    }
    const due = names.length === 0 ? list : list.filter((r) => names.includes(r.name))
    if (due.length === 0) return answer(`No requirements: ${settingsFile} has no 'requires' list.`)
    // The main checkout's list; none where it can't be read, so that tutti runs nothing then.
    const read = yield* Effect.result(readSettings(repo))
    const base = read._tag === "Success" ? read.success.requires : []
    const isBase = (r: Requirement) => base.some((b) => sameRequires([b], [r]))
    const noInstall = args.no_install === true
    const report = yield* checkRequires(due.filter(isBase), {
      repo,
      installLimit: settings.success.checks.fast.timeout,
      noInstall,
    })
    const found = new Map<Requirement, RequireResult>(report.map((res) => [res.requirement, res]))
    const lines = due.map((r) => {
      const res = found.get(r)
      if (res !== undefined) return `${r.name}: ${says(res)}`
      if (!appliesOn(r, process.platform)) {
        return `${r.name}: ${says({ requirement: r, state: "otherOS", ran: false })}`
      }
      const change = base.some((b) => b.name === r.name) ? "changed" : "new"
      return `${r.name}: ${yoursToRun(r, change, noInstall)}`
    })
    const yours = due.some((r) => !found.has(r) && appliesOn(r, process.platform))
    const missing = missingOf(report).map((res) => res.requirement.name)
    return answer(
      [
        ...lines,
        ...(missing.length === 0
          ? []
          : [
              `Still missing: ${missing.join(", ")}. Fix its entry in ${settingsFile} and call requires_check again, or ask the maintainer for a manual step.`,
            ]),
        ...(yours
          ? [
              "tutti runs only the entries the main checkout's list has; run those your branch adds or changes with Bash, so that the permission mode sees what runs.",
            ]
          : []),
      ].join("\n"),
    )
  })

/** requires_readme in `worktree`: README.md's section written from the list, or already it. */
export const readmeIn = (worktree: string) =>
  Effect.gen(function* () {
    const settings = yield* settingsIn(worktree)
    if (settings._tag === "Failure") return settings.failure
    const written = yield* Effect.result(writeReadmeRequires(worktree, settings.success.requires))
    if (written._tag === "Failure") return refusal(written.failure)
    return answer(
      written.success
        ? `Wrote the requires list into ${readmeName}, between ${requiresStart} and ${requiresEnd}: commit it with the list.`
        : `${readmeName}'s section is the requires list's already.`,
    )
  })

/**
 * The requires tools of the worker in `worktree`, the main checkout at `repo`, and the server over
 * them. Their handlers run with the services they were made with.
 */
export const makeRequiresTools = (
  repo: string,
  worktree: string,
): Effect.Effect<RequiresTools, never, RequiresToolsServices> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<RequiresToolsServices>()
    const run = (effect: Effect.Effect<Answer, never, RequiresToolsServices>, extra: unknown) => {
      const signal = signalOf(extra)
      return Effect.runPromiseWith(context)(
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.succeed(refusal(`tutti couldn't do it: ${Cause.pretty(cause)}`)),
          ),
        ),
        signal === undefined ? undefined : { signal },
      )
    }

    const check = tool(
      "requires_check",
      `Checks the project's requires list ("requires" in ${settingsFile}) in your worktree, as a run's start does: each entry's check, and for one that fails, its install, then the check again. Answers with each entry's state: met, installed, or missing and what to do. An entry your branch adds or changes it doesn't run: it gives you its commands, to run with Bash. Use it to install what the list says, never by hand outside the list.`,
      checkShape,
      (args, extra) => run(checkIn(repo, worktree, args), extra),
    )

    const readme = tool(
      "requires_readme",
      `Writes ${readmeName}'s section on what to install, between ${requiresStart} and ${requiresEnd}, from the requires list in ${settingsFile} in your worktree. Call it after changing the list, and commit ${readmeName} with it.`,
      {},
      (_args, extra) => run(readmeIn(worktree), extra),
    )

    const tools = [check, readme]
    return {
      tools,
      server: createSdkMcpServer({
        name: requiresServerName,
        version: "1.0.0",
        tools,
        alwaysLoad: true,
      }),
    }
  })

/**
 * The maker of a worker's server for the live AgentHost's ownServer, the main checkout at `repo`:
 * for each worktree, its requires tools' server, run with the services this was given.
 */
export const requiresServerFor = (repo: string) =>
  Effect.map(
    Effect.context<RequiresToolsServices>(),
    (context) =>
      (worktree: string): Effect.Effect<McpSdkServerConfigWithInstance> =>
        makeRequiresTools(repo, worktree).pipe(
          Effect.map((tools) => tools.server),
          Effect.provideContext(context),
        ),
  )
