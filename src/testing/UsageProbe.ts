// UsageProbe's test layer: the live probe (probeWith), its session playing scripted answers, in
// order, in place of Claude Code, and Probed, to read back the limits each probe was asked about.
// Everything else is the live code's: the answer read from the turn's messages (answerOf), its
// cost in OrganCost (the context's, which the organs' share as in a run, or one of its own), a
// session's failure and probeTimeout as Unanswered. Once the script runs out, the account is under
// the limit (Allowed), as the hold's lifts on the clock assumed before the probe.
//
// A scripted answer is played as the turn that gives it (turnOf): Allowed as a clean result,
// Refused as a rejected rate_limit_event and a 429, Unanswered as a session failing for its
// reason. It may be the turn's SDK messages themselves, or an Effect giving either, as a probe
// that takes time.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Effect, Layer, Ref, Stream } from "effect"
import { ProbeAnswer, type ProbeSession, probeWith, UsageProbe } from "../agent/UsageProbe.ts"
import type { OrganCost } from "../organs/OrganCost.ts"
import type { Log } from "../run/log.ts"
import { shared } from "./OrganCost.ts"

/** The probes asked of the test layer, for a test to look at. */
export class Probed extends Context.Service<
  Probed,
  {
    /** The held limit each probe was asked about, in order. */
    readonly limits: Effect.Effect<ReadonlyArray<string | null>>
  }
>()("tutti/testing/UsageProbe/Probed") {}

/** A probe's turn as its SDK messages. */
export type Turn = ReadonlyArray<SDKMessage>

/** A probe's answer in a script: the answer, its turn, or an Effect giving either. */
export type Scripted = ProbeAnswer | Turn | Effect.Effect<ProbeAnswer | Turn>

/** The probe's result: a clean one, `fields` laid over it. */
const result = (fields: object = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 0,
    stop_reason: "end_turn",
    session_id: "usage-probe",
    ...fields,
  }) as unknown as SDKMessage

/**
 * The turn that answers `answer`, or the reason its session fails with, for Unanswered. A reset is
 * given in seconds, as the API's header has it.
 */
export const turnOf = (answer: ProbeAnswer): Turn | string =>
  ProbeAnswer.$match(answer, {
    Allowed: () => [result()],
    Refused: ({ limit, resetsAt }) => [
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          ...(limit === null ? {} : { rateLimitType: limit }),
          ...(resetsAt === null ? {} : { resetsAt: resetsAt / 1000 }),
        },
      } as unknown as SDKMessage,
      result({ is_error: true, api_error_status: 429, result: "API Error: 429" }),
    ],
    Unanswered: ({ reason }) => reason,
  })

/**
 * A UsageProbe answering `answers` in order, then Allowed, with the OrganCost its costs go to (the
 * context's, or one logged to the Log), and Probed, to read what it was asked.
 */
export const layer = (
  answers: ReadonlyArray<Scripted> = [],
): Layer.Layer<UsageProbe | Probed | OrganCost, never, Log> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<string | null>>([])
      const left = yield* Ref.make<ReadonlyArray<Scripted>>(answers)
      const session: ProbeSession = ({ limit }) =>
        Effect.gen(function* () {
          yield* Ref.update(asked, (all) => [...all, limit])
          const next = yield* Ref.modify(left, (all) => [all[0], all.slice(1)] as const)
          const played = next === undefined ? ProbeAnswer.Allowed() : yield* play(next)
          const turn = Array.isArray(played) ? played : turnOf(played as ProbeAnswer)
          if (typeof turn === "string") return yield* Effect.fail(turn)
          return Stream.fromIterable(turn)
        })
      const probe = yield* probeWith(session)
      return Context.make(UsageProbe, probe).pipe(
        Context.add(Probed, Probed.of({ limits: Ref.get(asked) })),
      )
    }),
  ).pipe(Layer.provideMerge(shared))

const play = (scripted: Scripted): Effect.Effect<ProbeAnswer | Turn> =>
  Effect.isEffect(scripted)
    ? (scripted as Effect.Effect<ProbeAnswer | Turn>)
    : Effect.succeed(scripted as ProbeAnswer | Turn)
