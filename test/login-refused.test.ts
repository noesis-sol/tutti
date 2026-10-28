// Claude's login refused in a worker's turn (§ 4.13, login.ts): the turn's assistant message says
// `authentication_failed` and its result is_error, as on 2026-10-28 when an OAuth session expired
// mid-run. The worker is LoginRefused, not Failed; the run quits as a quit does, ending LOGIN with
// exit 2: its ticket neither deferred nor triaged, its session kept with what the refused turn was
// to tell it, which the next run sends again as it resumes it, and no organ called.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { read } from "../src/agent/reading.ts"
import { initial, settled, step, WorkerEvent, WorkerState } from "../src/agent/WorkerState.ts"
import { Organs } from "../src/organs/Organs.ts"
import { line } from "../src/run/log.ts"
import { retellHead, retellKey, retellText, toldOf } from "../src/run/login.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { type State, Store } from "../src/services/Store.ts"
import {
  awaitInterrupt,
  bash,
  emit,
  interruptedResult,
  type SessionScript,
  run as stepOf,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { backlog, type Ran, scenario } from "./harness.ts"

// A whole run takes up to a second on an idle machine: bun's 5 s default fails it when other
// checks run beside this one.
setDefaultTimeout(30_000)

const refusal = "Failed to authenticate: OAuth session expired and could not be refreshed"

// The turn's last two messages, as .tutti/run/workers/tutti-djtt/messages.jsonl had them.
const refusedAssistant = { type: "assistant", error: "authentication_failed" }
const refusedResult = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: refusal,
  api_error_status: null,
  terminal_reason: "api_error",
  num_turns: 1,
}

const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ session: "s", reading: read(message as unknown as SDKMessage) })
const init = sdk({ type: "system", subtype: "init", session_id: "s" })
const idle = sdk({ type: "system", subtype: "session_state_changed", state: "idle" })
const assistant = (fields: object) =>
  sdk({ type: "assistant", message: { role: "assistant", content: [] }, ...fields })

const fold = (events: ReadonlyArray<WorkerEvent>) =>
  events.reduce((worker, event, i) => step(worker, event, i), initial())

describe("reading a turn refused for the login", () => {
  test("an assistant message with authentication_failed reads as the login refused", () => {
    const reading = read({
      ...refusedAssistant,
      message: { role: "assistant", content: [] },
    } as unknown as SDKMessage)
    expect(reading).toEqual(expect.objectContaining({ _tag: "Assistant", loginRefused: true }))
    expect(read({ type: "assistant", error: "rate_limit" } as unknown as SDKMessage)).toEqual(
      expect.objectContaining({ loginRefused: false, rateLimited: true }),
    )
  })

  test("its worker is LoginRefused, with the result's text and what its sends said, and never settles", () => {
    const worker = fold([
      WorkerEvent.Sent({ session: "s", uuid: "u-1", text: "your question is answered" }),
      init,
      assistant({ error: "authentication_failed" }),
      sdk({ ...refusedResult, user_message_uuids: ["u-1"] }),
      idle,
    ])
    expect(worker.state).toEqual(
      WorkerState.LoginRefused({ error: refusal, told: ["your question is answered"] }),
    )
    expect(settled(worker.state)).toBe(false)
    // Its sends are answered, their texts let go of.
    expect(worker.outstanding).toEqual([])
    expect(worker.texts.size).toBe(0)
  })

  test("a result listing no sends was to tell all those outstanding", () => {
    const worker = fold([
      WorkerEvent.Sent({ session: "s", uuid: "u-1", text: "first" }),
      WorkerEvent.Sent({ session: "s", uuid: "u-2", text: "second" }),
      init,
      assistant({ error: "authentication_failed" }),
      sdk(refusedResult),
    ])
    expect(worker.state).toEqual(
      WorkerState.LoginRefused({ error: refusal, told: ["first", "second"] }),
    )
  })

  test("a turn failing without authentication_failed is Failed, and a new turn ends the refusal", () => {
    const failed = fold([init, assistant({}), sdk(refusedResult), idle])
    expect(failed.state._tag).toBe("Failed")
    const refused = fold([init, assistant({ error: "authentication_failed" }), sdk(refusedResult)])
    const again = step(refused, init, 10)
    expect(again.state._tag).toBe("Working")
    expect(again.loginRefused).toBe(false)
  })
})

describe("the message told again", () => {
  test("is the refused turn's texts after its head, and a message told again stays as it is", () => {
    const once = retellText(["your question is answered"], ["fact"])
    expect(once).toBe(`${retellHead}\n\nyour question is answered\n\nfact`)
    expect(retellText([once], ["fact"])).toBe(once)
  })

  test("reads the texts saved under its key, and nothing else", () => {
    expect(toldOf({ [retellKey]: ["a", 1, "b"] })).toEqual(["a", "b"])
    expect(toldOf({ [retellKey]: "a" })).toEqual([])
    expect(toldOf({})).toEqual([])
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-login-refused-${name}-`)))

/** A turn refused for the login, once `before` has run. */
const refused = (before: Effect.Effect<void> = Effect.void): SessionScript =>
  turn([stepOf(before), emit(refusedAssistant)], emit(refusedResult))

/** The texts sent to `id`'s worker, in order. */
const toldTo = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id ? [String(sent.message.message.content)] : [],
  )

// The predictor guesses the tickets' files as they are dispatched, before any stop: left off, every
// organ call the organs record is one after the stop.
const noFootprint = { ...appConfig().settings.queue, footprint: false }

/**
 * A whole run of t-1 and t-2, two at a time, from `state`, with organs that record every call:
 * t-1's turn is refused for the login once t-2's worker has claimed its ticket; t-2's worker works
 * on until interrupted. Its outcome's report is asked for as main asks for it. What state.json
 * says once it has ended.
 */
const runRefused = async (
  scripts: Readonly<Record<string, ReadonlyArray<SessionScript>>>,
  dirs: { readonly repo: string; readonly root: string },
  state?: State,
): Promise<{
  readonly ran: Ran<Outcome>
  readonly saved: State
  readonly calls: ReadonlyArray<OrganCallRecord>
}> => {
  const calls: Array<OrganCallRecord> = []
  let saved: State | undefined
  const ran = await scenario(
    {
      config: {
        repo: dirs.repo,
        settings: { ...appConfig().settings, concurrent: 2, queue: noFootprint },
      },
      backlog: backlog().ticket("t-1").ticket("t-2").seeds,
      git: { dir: dirs.repo },
      worktrees: { root: dirs.root },
      scripts,
      ...(state === undefined ? {} : { state }),
    },
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti`] }),
      )
      const outcome = yield* Fiber.join(fiber)
      yield* outcome.report(Effect.die(new Error("the report printed")))
      saved = yield* (yield* Store).state
      return outcome
    }).pipe(Effect.provide(Organs.layer.pipe(Layer.provide(cannedLayer({}, calls))))),
  )
  if (saved === undefined) throw new Error(`the run failed: ${ran.exit}`)
  return { ran, saved, calls }
}

const exitCode = (ran: Ran<Outcome>) =>
  ran.exit._tag === "Success" ? ran.exit.value.exitCode : undefined

const loginLine =
  "LOGIN: Claude's login was refused (Failed to authenticate: OAuth session expired and could not be refreshed): run claude /login, or tutti login, then start tutti again"

describe("a run whose worker's turn is refused for the login", () => {
  test("ends LOGIN with exit 2, its ticket kept for the next run, which tells it again", async () => {
    const dirs = { repo: folder("repo"), root: folder("worktrees") }
    const claimed = Effect.runSync(Deferred.make<void>())
    const first = await runRefused(
      {
        "t-1": [refused(Deferred.await(claimed))],
        "t-2": [
          turn(
            [
              ...bash("bd update t-2 --claim"),
              stepOf(Effect.asVoid(Deferred.succeed(claimed, undefined))),
              awaitInterrupt,
            ],
            interruptedResult,
          ),
        ],
      },
      dirs,
    )
    const { ran, saved, calls } = first
    expect(exitCode(ran)).toBe(2)
    expect(ran.log).toContain(
      "t-1's turn was refused for Claude's login (Failed to authenticate: OAuth session expired and could not be refreshed): the run stops, its workers stopped and their sessions kept for the next run",
    )
    expect(ran.log.at(-1)).toBe(`${loginLine}; the sessions of t-1, t-2 are saved for the next run`)
    // Neither ticket deferred, noted or triaged; t-2's worker interrupted as a quit interrupts it.
    expect(ran.log.some((text) => text.includes("deferred"))).toBe(false)
    for (const issue of ran.issues) {
      expect(issue.status).not.toBe("deferred")
      expect(issue.notes ?? "").not.toContain("finished without closing")
    }
    expect(ran.sent).toContainEqual(expect.objectContaining({ _tag: "Interrupted", ticket: "t-2" }))
    // No organ was called: not triage, nor the reviewer the report would have asked.
    expect(calls).toEqual([])
    const stop = ran.events.find((record) => record.kind === "stop")
    expect(stop).toEqual(expect.objectContaining({ detail: "LOGIN", ticket: "t-1" }))
    // Both sessions are kept; t-1's with what its refused turn was to tell it.
    const told = toldTo(ran, "t-1")
    expect(told).toHaveLength(1)
    expect(saved.tickets["t-1"]).toEqual(
      expect.objectContaining({
        suspended: "LOGIN",
        phase: "Stopped",
        metadata: { [retellKey]: told },
      }),
    )
    expect(saved.tickets["t-1"]?.session).toBeDefined()
    expect(saved.tickets["t-2"]).toEqual(
      expect.objectContaining({ suspended: "LOGIN", phase: "Stopped" }),
    )

    // The next run resumes t-1's session, telling it again what the refused turn was to tell it;
    // refused once more, it keeps that message as it is.
    const second = await runRefused(
      { "t-1": [refused()], "t-2": [turn([awaitInterrupt], interruptedResult)] },
      dirs,
      saved,
    )
    expect(exitCode(second.ran)).toBe(2)
    expect(second.ran.sent).toContainEqual(
      expect.objectContaining({ _tag: "Resumed", ticket: "t-1" }),
    )
    // Its message starts with the standing rules' notes a resume tells (resumedNotes), then what
    // it was to be told again.
    const sent = toldTo(second.ran, "t-1")
    expect(sent).toHaveLength(1)
    const retold = sent[0]?.slice(sent[0].indexOf(retellHead)) ?? ""
    expect(retold).toStartWith(`${retellHead}\n\n${told[0]}`)
    expect(second.saved.tickets["t-1"]?.metadata).toEqual({ [retellKey]: [retold] })
    expect(second.calls).toEqual([])
  })
})
