// Attention's refusal at the run's end (tutti-t7z7): once the end has stopped a ticket's fiber, every
// answer to its sessions' requests, open or opened later, fails NotOpen saying why, from the screen,
// `tutti answer` or the test policy, while its requests stay open for the end to read and an abort
// still withdraws them. Other tickets' requests, and a session made afterwards (the next run's), are
// answered as before.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, Layer, Stream } from "effect"
import {
  Attention,
  type AttentionRequest,
  NotOpen,
  type Policy,
  runEnding,
} from "../src/agent/Attention.ts"
import {
  answerFile,
  attentionFolder,
  encodeFile,
  refusedFile,
  serve,
  writeExclusive,
} from "../src/agent/attentionFiles.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { allowAll, layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { openFibers } from "./fibers.ts"

type Env = Attention | Log | EventStream

const run = <A, E>(
  effect: Effect.Effect<A, E, Env>,
  options: { readonly policy?: Policy; readonly repo?: string } = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        if (options.repo !== undefined) yield* serve({ repo: options.repo, poll: "50 millis" })
        return yield* effect
      }),
    ).pipe(
      Effect.provide(
        attentionLayer(options.policy).pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer(), BunFileSystem.layer)),
        ),
      ),
    ),
  )

const sdkOptions = (): Parameters<CanUseTool>[2] & { readonly controller: AbortController } => {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
    requestId: "req",
    controller,
  }
}

const rm = { command: "rm -rf build" }

/**
 * Asks to remove the build through `callback`, by default a new session's canUseTool for `ticket`,
 * and waits until the request is open.
 */
const ask = (
  ticket: TicketId,
  options: Parameters<CanUseTool>[2] = sdkOptions(),
  callback?: CanUseTool,
) =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const before = (yield* attention.current).length
    const result = (callback ?? (yield* attention.request(ticket, openFibers())))(
      "Bash",
      rm,
      options,
    )
    const open = yield* attention.open.pipe(
      Stream.filter((all) => all.length > before),
      Stream.runHead,
    )
    const all = open._tag === "Some" ? open.value : []
    return { result, request: all[all.length - 1] as AttentionRequest }
  })

const allow = (request: AttentionRequest) =>
  Effect.exit(
    Effect.flatMap(Attention, (attention) =>
      attention.answer(request.id, { _tag: "Allow" }, "answer_command"),
    ),
  )

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

/** Waits up to 5 seconds for `check` to hold, looking every 10 ms. */
const until = (what: string, check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      if (check()) return
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`))
  })

describe("Attention: answers refused once the run's end stops a ticket", () => {
  test("an open request of a refused ticket stays open, and its answer fails NotOpen", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const a = yield* ask("a" as TicketId)
        const b = yield* ask("b" as TicketId)
        yield* attention.refuse("a" as TicketId)
        const refused = yield* allow(a.request)
        const open = (yield* attention.current).map((request) => request.ticket)
        const other = yield* allow(b.request)
        return {
          refused,
          open,
          other,
          b: yield* Effect.promise(() => b.result),
          log: yield* texts,
          tally: yield* attention.tally("a" as TicketId),
        }
      }),
    )
    const error = failure(seen.refused)
    expect(error).toBeInstanceOf(NotOpen)
    expect(error.message).toBe(`request r1 is no longer open: ${runEnding}`)
    expect(seen.open).toEqual(["a" as TicketId, "b" as TicketId])
    expect(Exit.isSuccess(seen.other)).toBe(true)
    expect(seen.b?.behavior).toBe("allow")
    expect(seen.log.filter((text) => text.includes("a's worker") && /allowed/.test(text))).toEqual(
      [],
    )
    expect(seen.tally.allowed).toBe(0)
  })

  test("a session's request opened after the refusal isn't answered, by the policy either", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const session = yield* attention.request("a" as TicketId, openFibers())
        yield* attention.refuse("a" as TicketId)
        const { request } = yield* ask("a" as TicketId, sdkOptions(), session)
        return { refused: yield* allow(request), open: (yield* attention.current).length }
      }),
      { policy: allowAll },
    )
    expect(failure(seen.refused)).toBeInstanceOf(NotOpen)
    expect(seen.open).toBe(1)
  })

  test("a session made after the refusal, the next run's, is answered as before", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        yield* ask("a" as TicketId)
        yield* attention.refuse("a" as TicketId)
        const next = yield* ask("a" as TicketId)
        return {
          answered: yield* allow(next.request),
          result: yield* Effect.promise(() => next.result),
        }
      }),
    )
    expect(Exit.isSuccess(seen.answered)).toBe(true)
    expect(seen.result?.behavior).toBe("allow")
  })

  test("an abort still withdraws a refused ticket's request", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const options = sdkOptions()
        const { result } = yield* ask("a" as TicketId, options)
        yield* attention.refuse("a" as TicketId)
        options.controller.abort()
        const outcome = yield* Effect.promise(() => result)
        return { outcome, open: (yield* attention.current).length }
      }),
    )
    expect(seen.outcome?.behavior).toBe("deny")
    expect(seen.open).toBe(0)
  })

  test("tutti answer is told the run refused it, and why", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-attention-refuse-")))
    const seen = await run(
      Effect.gen(function* () {
        const attention = yield* Attention
        const { request } = yield* ask("a" as TicketId)
        yield* until("the request's file", () => existsSync(join(repo, attentionFolder)))
        yield* attention.refuse("a" as TicketId)
        yield* Effect.orDie(
          writeExclusive(
            repo,
            answerFile(request.id),
            encodeFile({ v: 1, request: request.id, answer: "allow" }),
          ),
        )
        yield* until("the refusal", () => existsSync(join(repo, refusedFile(request.id))))
        const refusal = JSON.parse(readFileSync(join(repo, refusedFile(request.id)), "utf8"))
        return { reason: refusal.reason as string, open: (yield* attention.current).length }
      }),
      { repo },
    )
    expect(seen.reason).toBe(`request r1 is no longer open: ${runEnding}`)
    expect(seen.open).toBe(1)
  })
})
