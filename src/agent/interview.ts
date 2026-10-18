// The feature interview, the session side (§ 4.10): New feature at the start question talks the
// feature through with Claude in an SDK session in the main checkout, which AgentHost knows as
// interviewWorker, as it knows the probe's. The session's instructions are orchestra v0.7.7's
// interview instructions, adapted (templates/interview-prompt.md, with the MIT notice of the
// grilling skill they adapt, also in THIRD_PARTY_NOTICES.md), appended to the claude_code preset;
// its tools are enforced (options.ts's interviewOptions) and its one MCP server is tutti's own
// (interviewTools.ts).
//
// The description typed at the start question is saved to .tutti/run/feature-request.md and sent
// as the first message, between pasted_content tags carrying a fresh ID, as orchestra sends it. tutti
// composed that message, so it goes client_composed (§ 4.1), as written, an `@path` in the
// description not expanded; what you type in the composer after it goes as yours. The tags:
// the description is often pasted from an issue or a web page, and the instructions say text in the
// tags may carry instructions the user didn't write. The ID is drawn again while the description
// holds it, so no text in it can close the block early.
//
// Once file_feature has filed the epic and the session's turns are over, tutti closes the session
// and offers the epic and its tickets with `Start the run on <epic> (N tickets)? [y/N]`; the
// Interview view (src/ui/InterviewView.tsx) shows the chat and the question.
import { randomUUID } from "node:crypto"
import { Data, Effect, Option, Ref, Result, Stream, SubscriptionRef } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { evidenceId } from "../organs/evidence.ts"
import { type FeaturePlan, type FiledPlan, maxPlanned } from "../project/planFile.ts"
import template from "../project/templates/interview-prompt.md" with { type: "text" }
import { shownPlan } from "../run/feature.ts"
import type { Beads } from "../services/Beads.ts"
import type { Git } from "../services/Git.ts"
import { runFolder, writeRunFile } from "../services/Worktrees.ts"
import { type Plan, startOnQuestion } from "../ui/questions.ts"
import { type AgentGone, AgentHost, AgentStartFailed } from "./AgentHost.ts"
import {
  type Filing,
  filedSomething,
  type InterviewTools,
  makeInterviewTools,
} from "./interviewTools.ts"

/** The name AgentHost knows the interview's session by, as a ticket's worker is known by its ID. */
export const interviewWorker = "tutti-interview"

/** The interview's description, under the main checkout's .tutti/run/. */
export const featureRequestName = "feature-request.md"

/** Where the description is saved, relative to the main checkout. */
export const featureRequestFile = `${runFolder}/${featureRequestName}`

/** The interview's instructions, appended to the claude_code preset. */
export const interviewPrompt: string = template.replaceAll("{{maxPlanned}}", String(maxPlanned))

/** What opens the first message, before the description. */
export const featureLead = "Here is the feature I'd like to talk through:"

/** `description` between pasted_content tags carrying `id`, each tag on its own line. */
export const pasted = (description: string, id: string): string =>
  `<pasted_content id="${id}">\n${description.replace(/^\n+|\n+$/g, "")}\n</pasted_content id="${id}">`

/** The interview's first message: featureLead, then `description` pasted under a fresh ID. */
export const firstMessage = (description: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    let id = yield* evidenceId
    while (description.includes(id)) id = yield* evidenceId
    return `${featureLead}\n\n${pasted(description, id)}`
  })

/** The filed feature, as the confirmation offers it: by the bd IDs of the epic and its tickets. */
export const filedPlan = (plan: FeaturePlan, filed: FiledPlan): Plan => {
  const shown = shownPlan(plan)
  const id = (key: string) => filed.tickets.get(key) ?? key
  return {
    epic: { title: `${filed.epic} ${shown.epic.title}`, description: shown.epic.description },
    tickets: shown.tickets.map((t) => ({ ...t, key: id(t.key), after: t.after.map(id) })),
    notes: shown.notes,
  }
}

/** Why an interview ended when it was left. */
export const leftWhy = "the interview was left"

/** How an interview ended. */
export type InterviewEnd = Data.TaggedEnum<{
  /**
   * file_feature filed the epic and the session's turns are over: the session is closed, and the
   * epic and its tickets are offered with `question`.
   */
  Filed: {
    readonly epic: string
    readonly tickets: number
    readonly plan: Plan
    readonly question: string
  }
  /**
   * The session ended, or went, without filing the feature: `filing` says whether file_feature
   * filed anything all the same, partway.
   */
  Ended: { readonly why: string; readonly filing: Filing }
}>

export const InterviewEnd = Data.taggedEnum<InterviewEnd>()

/** An interview under way. */
export interface Interview {
  /** The session's ID. */
  readonly sessionId: string
  /** The interview's own tools, on the server its session was given. */
  readonly tools: InterviewTools
  /** What file_feature has filed, now and on each change. */
  readonly filing: SubscriptionRef.SubscriptionRef<Filing>
  /** Sends what you typed in the composer: its uuid. */
  send(text: string): Effect.Effect<string, AgentGone>
  /**
   * Waits for the interview's end: once file_feature has filed the epic and the session's turns
   * are over, closes the session and gives the epic to offer; or the session's end without it.
   */
  readonly ended: Effect.Effect<InterviewEnd>
  /** Leaves the interview: closes its session, filed or not. */
  readonly leave: Effect.Effect<void>
  /** Whether leaving now would leave something filed (§ 4.10: then nothing is asked). */
  readonly filedSomething: Effect.Effect<boolean>
}

/**
 * Starts the interview on `description`, as typed at the start question: saves it to
 * .tutti/run/feature-request.md, starts the session in the main checkout and sends it the first
 * message. A description that can't be saved fails the start, as a session that doesn't start does.
 */
export const startInterview = (
  description: string,
): Effect.Effect<Interview, AgentStartFailed, AgentHost | AppConfig | Beads | Git> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const host = yield* AgentHost
    const saved = yield* Effect.result(
      writeRunFile(config.repo, featureRequestName, `${description.replace(/\n+$/, "")}\n`),
    )
    if (Result.isFailure(saved)) {
      return yield* new AgentStartFailed({
        ticket: interviewWorker,
        reason: `${featureRequestFile} could not be written: ${saved.failure.message}`,
      })
    }
    const tools = yield* makeInterviewTools(config.repo)
    const sessionId = randomUUID()
    yield* host.start(interviewWorker, {
      sessionId,
      cwd: config.repo,
      interview: { prompt: interviewPrompt, server: tools.server },
    })
    const first = yield* firstMessage(description)
    yield* host
      .send(interviewWorker, first, "clientComposed")
      .pipe(
        Effect.mapError(
          (gone) => new AgentStartFailed({ ticket: interviewWorker, reason: gone.why }),
        ),
      )

    // Whether the interview was left: its session's end, or its worker forgotten, is no news.
    const left = yield* Ref.make(false)
    const endedWithout = (why: string) =>
      Effect.gen(function* () {
        const filing = yield* SubscriptionRef.get(tools.filing)
        return InterviewEnd.Ended({ why: (yield* Ref.get(left)) ? leftWhy : why, filing })
      })

    const ended = host.state(interviewWorker).pipe(
      Stream.mapEffect((state) =>
        Effect.map(SubscriptionRef.get(tools.filing), (filing) => ({ state, filing })),
      ),
      Stream.filter(
        ({ state, filing }) =>
          state._tag === "Gone" ||
          state._tag === "Closed" ||
          (filing._tag === "Filed" && (state._tag === "Idle" || state._tag === "Failed")),
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => endedWithout(leftWhy),
          onSome: ({ state, filing }) =>
            Effect.gen(function* () {
              if (filing._tag === "Filed" && state._tag !== "Gone" && state._tag !== "Closed") {
                yield* host.end(interviewWorker)
                const plan = filedPlan(filing.plan, filing.filed)
                return InterviewEnd.Filed({
                  epic: filing.filed.epic,
                  tickets: plan.tickets.length,
                  plan,
                  question: startOnQuestion(filing.filed.epic, plan.tickets.length),
                })
              }
              return yield* endedWithout(state._tag === "Gone" ? state.why : leftWhy)
            }),
        }),
      ),
      Effect.catchTag("AgentGone", (gone) => endedWithout(gone.why)),
    )

    return {
      sessionId,
      tools,
      filing: tools.filing,
      send: (text) => host.send(interviewWorker, text, "human"),
      ended,
      leave: Effect.andThen(Ref.set(left, true), host.end(interviewWorker)),
      filedSomething: Effect.map(SubscriptionRef.get(tools.filing), filedSomething),
    } satisfies Interview
  })
