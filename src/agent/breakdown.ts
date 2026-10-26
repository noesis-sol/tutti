// A spec's breakdown (§ 4.14), the session side: an SDK session in the main checkout, which AgentHost
// knows as breakdownWorker (headless) or interviewWorker (--refine, in the Interview view), with the
// breakdown's instructions (templates/spec-prompt.md, orchestra's adapted) appended to the
// claude_code preset, its tools enforced (Read, Grep, Glob and Agent, with AskUserQuestion when the
// user is there; `dontAsk` when nobody is) and tutti's own server (breakdownTools.ts) its one MCP
// server, as the feature interview's session has.
//
// Its first message names the spec, its SHA-256 and commit, and for a headless one its time limit;
// a breakdown carried on lists what the earlier one filed, and an update names the root epic and the
// version of the spec its tree was filed for, the change being in .tutti/run/spec-update.md.
//
// It ends once file_breakdown has filed the tree (or said there is none) and the session's turn is
// over: tutti closes the session. A headless session whose turn ends without that is told once to
// hand the tree over, then given up on; one past its time limit is closed. With --refine the turn
// ending is the user's turn, and leaving the view ends it.
import { randomUUID } from "node:crypto"
import {
  Data,
  type Duration,
  Effect,
  Option,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import template from "../project/templates/spec-prompt.md" with { type: "text" }
import { issueLine, type Spec, short, specUpdateFile } from "../run/spec.ts"
import type { CheckedTree, FiledTree } from "../run/specTree.ts"
import type { Beads, Issue, TicketId } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import { type AgentGone, AgentHost, AgentStartFailed, type MessageUuid } from "./AgentHost.ts"
import {
  type BreakdownState,
  type BreakdownTools,
  makeBreakdownTools,
  qualifiedBreakdownTools,
} from "./breakdownTools.ts"
import { sessionFibers } from "./callbacks.ts"
import { interviewWorker } from "./interview.ts"
import { SessionKind } from "./sessionKind.ts"
import type { WorkerState } from "./WorkerState.ts"

/** The name AgentHost knows a headless breakdown's session by. */
export const breakdownWorker = "tutti-breakdown" as TicketId

/** The built-in tools of a breakdown's session: AskUserQuestion too with the user there. */
export const breakdownBuiltins = (refine: boolean): ReadonlyArray<string> => [
  "Read",
  "Grep",
  "Glob",
  "Agent",
  ...(refine ? ["AskUserQuestion"] : []),
]

/**
 * `text` with its sections kept or dropped by `flags`: `{{#if name}}`, `{{#if not name}}`,
 * `{{else}}` and `{{/if}}`, nested, each on a line of its own (which goes with it) or inline. Its
 * leading HTML comment, a note for whoever edits it, goes too.
 */
export const renderPrompt = (text: string, flags: Readonly<Record<string, boolean>>): string => {
  const body = text.replace(/^<!--[\s\S]*?-->\n/, "")
  const token = /\{\{(?:#if (not )?(\w+)|(else)|(\/if))\}\}/g
  // A token alone on its line takes the line with it.
  const lines = body.replace(/^[ \t]*(\{\{(?:#if (?:not )?\w+|else|\/if)\}\})[ \t]*\n/gm, "$1")
  const kept: Array<boolean> = []
  let out = ""
  let at = 0
  const keeping = () => kept.every(Boolean)
  for (const match of lines.matchAll(token)) {
    if (keeping()) out += lines.slice(at, match.index)
    at = match.index + match[0].length
    if (match[2] !== undefined) {
      const on = flags[match[2]] === true
      kept.push(match[1] === undefined ? on : !on)
    } else if (match[3] !== undefined) {
      kept.push(!(kept.pop() ?? true))
    } else {
      kept.pop()
    }
  }
  if (keeping()) out += lines.slice(at)
  return out
}

/** A breakdown's instructions: refined with the user or headless, an update or not. */
export const breakdownPrompt = (mode: { readonly refine: boolean; readonly update: boolean }) =>
  renderPrompt(template, mode)

/** What a breakdown starts from: a new tree, one an earlier breakdown didn't finish, or an update. */
export type BreakdownMode = Data.TaggedEnum<{
  New: Record<never, never>
  /** The breakdown that filed `root` didn't finish; `filed` is what is under it. */
  Carry: { readonly root: Issue; readonly filed: ReadonlyArray<Issue> }
  /** The spec changed since `root`'s tree was filed for it, at `filedFor`. */
  Update: { readonly root: Issue; readonly filedFor: string | null }
}>

export const BreakdownMode = Data.taggedEnum<BreakdownMode>()

/** What a breakdown is started with. */
export interface BreakdownStart {
  readonly spec: Spec
  /** The commit that has the spec as it is. */
  readonly commit: string
  readonly mode: BreakdownMode
  /** With the user, in the Interview view. */
  readonly refine: boolean
  /** How long a headless one may take. */
  readonly timeLimit: Duration.Duration
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max" | null
}

/** The most issues the first message of a breakdown carried on lists. */
export const listedFiled = 200

/** The breakdown's first message. */
export const breakdownMessage = (start: Omit<BreakdownStart, "effort">): string => {
  const { spec } = start
  const version = `sha256 ${spec.sha256}, commit ${start.commit}`
  const lead = start.refine
    ? `Break the spec at ${spec.path} down into Beads tickets with me (${version}).`
    : `Break the spec at ${spec.path} down into Beads tickets (${version}). You have ${formatDuration(start.timeLimit)}.`
  switch (start.mode._tag) {
    case "New":
      return lead
    case "Carry": {
      const { root, filed } = start.mode
      return [
        lead,
        "",
        `An earlier breakdown of this spec filed the root epic ${root.id} and stopped part way. It is yours: don't call file_root, and hand file_breakdown only what is missing under ${root.id}, naming what is filed by its ID. Filed so far:`,
        "",
        ...[root, ...filed].slice(0, listedFiled).map((issue) => `- ${issueLine(issue)}`),
        ...(filed.length + 1 > listedFiled
          ? [`- … and ${filed.length + 1 - listedFiled} more: tickets_list them`]
          : []),
      ].join("\n")
    }
    case "Update": {
      const { root, filedFor } = start.mode
      return [
        start.refine
          ? `Update the tree of the spec at ${spec.path} for its change with me (${version}).`
          : `Update the tree of the spec at ${spec.path} for its change (${version}). You have ${formatDuration(start.timeLimit)}.`,
        "",
        `Its root epic is ${root.id}, whose tree was filed for ${filedFor === null ? "an earlier version of the spec" : `the spec at commit ${short(filedFor)}`}. ${specUpdateFile} holds the change and the tree.`,
      ].join("\n")
    }
  }
}

/** How a breakdown ended. */
export type BreakdownEnd = Data.TaggedEnum<{
  /** The tree is filed under `root`, and the session closed. */
  Filed: {
    readonly root: TicketId
    readonly tree: CheckedTree
    readonly filed: FiledTree
    readonly state: BreakdownState
  }
  /** It said there is nothing to file, and why. */
  NoTree: { readonly why: string; readonly state: BreakdownState }
  /** It ended without the tree: why, and what it had filed. */
  Failed: { readonly why: string; readonly state: BreakdownState }
  /** The user left the view (--refine). */
  Left: { readonly state: BreakdownState }
}>

export const BreakdownEnd = Data.taggedEnum<BreakdownEnd>()

/** What a headless session whose turn ended without the tree is told, once. */
export const handOverNudge =
  "Your turn ended, but the tree isn't filed: nobody is here to answer. Hand the tree to file_breakdown now (or, if there is nothing to build, call it with only a problem), then end your turn."

/** A breakdown under way. */
export interface Breakdown {
  /** The name AgentHost knows its session by. */
  readonly worker: TicketId
  readonly sessionId: string
  readonly tools: BreakdownTools
  readonly state: SubscriptionRef.SubscriptionRef<BreakdownState>
  /** Sends what you typed in the composer (--refine). */
  send(text: string, uuid?: MessageUuid): Effect.Effect<MessageUuid, AgentGone>
  /** Waits for the breakdown's end, and closes its session. */
  readonly ended: Effect.Effect<BreakdownEnd>
  /** Leaves the breakdown: closes its session. */
  readonly leave: Effect.Effect<void>
}

/**
 * Starts the breakdown of `start.spec`, committed in the main checkout: its session, its tools, and
 * the first message. Its tools' calls are fibers of the caller's scope, which outlasts the session.
 */
export const startBreakdown = (
  start: BreakdownStart,
): Effect.Effect<Breakdown, AgentStartFailed, AgentHost | AppConfig | Beads | Git | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const host = yield* AgentHost
    const worker = start.refine ? interviewWorker : breakdownWorker
    const update = start.mode._tag === "Update"
    const tools = yield* makeBreakdownTools({
      repo: config.repo,
      spec: start.spec,
      root: start.mode._tag === "New" ? null : start.mode.root.id,
      update,
      fibers: yield* sessionFibers,
    })
    const sessionId = randomUUID()
    yield* host.start(worker, {
      sessionId,
      cwd: config.repo,
      kind: SessionKind.Interview({
        prompt: breakdownPrompt({ refine: start.refine, update }),
        server: tools.server,
        breakdown: {
          builtins: breakdownBuiltins(start.refine),
          allowed: qualifiedBreakdownTools,
          headless: !start.refine,
          effort: start.effort,
          tools: tools.tools,
        },
      }),
    })
    const send = (text: string) =>
      host
        .send(worker, { text, from: "clientComposed" })
        .pipe(Effect.mapError((gone) => new AgentStartFailed({ ticket: worker, reason: gone.why })))
    yield* send(breakdownMessage(start))

    const left = yield* Ref.make(false)
    const nudged = yield* Ref.make(false)
    /** The end the session's `state` makes with what the tools filed, if it is one. */
    const endOf = (state: WorkerState): Effect.Effect<Option.Option<BreakdownEnd>> =>
      Effect.gen(function* () {
        const filed = yield* SubscriptionRef.get(tools.state)
        const over = state._tag === "Gone" || state._tag === "Closed"
        if (over) {
          if (yield* Ref.get(left)) return Option.some(BreakdownEnd.Left({ state: filed }))
          if (filed.answer._tag === "Filed" && filed.root !== null) {
            return Option.some(
              BreakdownEnd.Filed({
                root: filed.root,
                tree: filed.answer.tree,
                filed: filed.answer.filed,
                state: filed,
              }),
            )
          }
          const why = state._tag === "Gone" ? state.why : "its session was closed"
          return Option.some(BreakdownEnd.Failed({ why, state: filed }))
        }
        const turnOver = state._tag === "Idle" || state._tag === "Failed"
        if (state._tag === "UsageLimited") {
          yield* host.end(worker)
          return Option.some(
            BreakdownEnd.Failed({ why: "it stopped at the account's usage limit", state: filed }),
          )
        }
        if (!turnOver) return Option.none()
        switch (filed.answer._tag) {
          case "Filed":
            yield* host.end(worker)
            return filed.root === null
              ? Option.none()
              : Option.some(
                  BreakdownEnd.Filed({
                    root: filed.root,
                    tree: filed.answer.tree,
                    filed: filed.answer.filed,
                    state: filed,
                  }),
                )
          case "Problem":
            yield* host.end(worker)
            return Option.some(BreakdownEnd.NoTree({ why: filed.answer.why, state: filed }))
          case "Stopped":
            yield* host.end(worker)
            return Option.some(
              BreakdownEnd.Failed({ why: filed.answer.stopped.message, state: filed }),
            )
          case "Filing":
            return Option.none()
          case "None":
            // With the user there, it is their turn.
            if (start.refine) return Option.none()
            if (!(yield* Ref.get(nudged)) && state._tag === "Idle") {
              yield* Ref.set(nudged, true)
              const sent = yield* Effect.result(send(handOverNudge))
              if (sent._tag === "Success") return Option.none()
            }
            yield* host.end(worker)
            return Option.some(
              BreakdownEnd.Failed({
                why:
                  state._tag === "Failed"
                    ? `its turn ended on an error: ${state.error}`
                    : "its turn ended without handing the tree to file_breakdown",
                state: filed,
              }),
            )
        }
      })

    const watched = host.state(worker).pipe(
      Stream.mapEffect(endOf),
      Stream.filter(Option.isSome),
      Stream.map((end) => end.value),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.map(SubscriptionRef.get(tools.state), (state) =>
              BreakdownEnd.Failed({ why: "its session went", state }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.catchTag("AgentGone", (gone) =>
        Effect.map(SubscriptionRef.get(tools.state), (state) =>
          BreakdownEnd.Failed({ why: gone.why, state }),
        ),
      ),
    )
    const ended = start.refine
      ? watched
      : watched.pipe(
          Effect.timeoutOrElse({
            duration: start.timeLimit,
            orElse: () =>
              Effect.gen(function* () {
                yield* host.end(worker)
                const state = yield* SubscriptionRef.get(tools.state)
                return BreakdownEnd.Failed({
                  why: `it ran past its time limit of ${formatDuration(start.timeLimit)}`,
                  state,
                })
              }),
          }),
        )

    return {
      worker,
      sessionId,
      tools,
      state: tools.state,
      send: (text, uuid) => host.send(worker, { text, from: "human", uuid }),
      ended,
      leave: Effect.andThen(Ref.set(left, true), host.end(worker)),
    } satisfies Breakdown
  })
