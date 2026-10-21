// Messages sent to a worker are in its transcript (§ 4.4, § 7.5): the host records each one as it
// pushes it into the session's inbox, the scripted layer as the live one, and the worker view draws
// it as a Prompt where it was sent, once the composer no longer shows it queued, and not at all
// once the CLI cancelled it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Fiber, Layer, Option, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { AgentHost, userMessage } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Recording, Sent, layer as scriptedLayer, turn } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  appended,
  emptyTranscript,
  entriesOf,
  followed,
  type OpenTranscript,
  scrolledBack,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { testEnv } from "./env.ts"
import { type Rendered, withRender } from "./render.ts"

const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

let seq = 0
/** `messages` as transcript items, numbered on from the last. */
const itemsOf = (messages: ReadonlyArray<SDKMessage>): ReadonlyArray<Item> =>
  messages.map((message) => ({
    v: transcriptVersion,
    seq: ++seq,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message,
  }))

/** A message sent to the worker, as the host records it. */
const sent = (text: string, uuid: string) =>
  userMessage({ text, from: "human" }, uuid, session) as unknown as SDKMessage

const said = (words: string) =>
  sdk({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  })

const lifecycle = (uuid: string, state: string) =>
  sdk({ type: "command_lifecycle", command_uuid: uuid, state })

/** The texts of the Prompt entries drawn. */
const prompts = (items: ReadonlyArray<Item>, queued: ReadonlySet<string> = new Set()) =>
  entriesOf(items, [], queued).flatMap((entry) => (entry._tag === "Prompt" ? [entry.text] : []))

describe("the scripted host records what it sends", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, AgentHost | Recording | Files>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          scriptedLayer({ "t-1": [turn([])] }).pipe(
            Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
            Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )

  test("a send is in the transcript as the SDK gets it, before its queued lifecycle", async () => {
    const done = await run(
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", { sessionId: "s-1", cwd: "/work/t-1" })
        const settled = yield* host.state("t-1").pipe(
          Stream.filter((state) => state._tag === "Idle"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        )
        const uuid = yield* host.send("t-1", "Please add tests too.", "human", "u-1")
        yield* Fiber.join(settled)
        return {
          uuid,
          transcript: yield* (yield* Files).messages("t-1"),
          sent: yield* (yield* Recording).sentTo("t-1"),
        }
      }),
    )
    expect(done.uuid).toBe("u-1")
    const [first, second] = done.transcript
    expect(first?.message).toEqual(
      userMessage({ text: "Please add tests too.", from: "human" }, "u-1", "s-1"),
    )
    expect(first?.session).toBe("s-1")
    expect(second?.message).toMatchObject({ type: "command_lifecycle", state: "queued" })
    // The very message the session was sent.
    expect(done.sent.filter((each) => each._tag === "Message")).toEqual([
      Sent.Message({ ticket: "t-1", message: first?.message as never }),
    ])
    expect(done.transcript.filter((item) => item.message.type === "user")).toHaveLength(1)
  })
})

describe("the live host records what it sends", () => {
  test("tutti's message and yours are in the transcript, each once, as they were sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-sent-"))
    const config = appConfig(
      {
        claude: resolve(import.meta.dir, "fixtures/fake-claude/claude.ts"),
        settings: defaultSettings,
      },
      dir,
    )
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: { servers: [], note: noServersNote },
      account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
      env: {
        ...testEnv,
        FAKE_CLAUDE_SCENARIO: JSON.stringify({ log: join(dir, "fake.jsonl") }),
      },
    })
    const sessionId = "11111111-1111-4111-8111-111111111111"
    const idle = Effect.gen(function* () {
      const found = yield* (yield* AgentHost).state("t-1").pipe(
        Stream.filter((state) => state._tag === "Idle"),
        Stream.runHead,
        Effect.timeout(Duration.seconds(10)),
      )
      return Option.getOrThrow(found)
    })
    const done = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* AgentHost
        yield* agents.start("t-1", { sessionId, cwd: dir })
        const first = yield* agents.send("t-1", "Work on t-1.", "clientComposed")
        yield* idle
        const second = yield* agents.send("t-1", "And the docs.", "human", "u-2")
        yield* idle
        return { first, second, items: yield* (yield* Files).messages("t-1") }
      }).pipe(
        Effect.provide(
          host.pipe(
            Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
            Layer.provideMerge(
              Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
            ),
          ),
        ),
      ),
    )
    const users = done.items.filter(
      (item) => item.message.type === "user" && !("isReplay" in item.message),
    )
    expect(users.map((item) => item.message)).toEqual([
      userMessage({ text: "Work on t-1.", from: "clientComposed" }, done.first, sessionId),
      userMessage({ text: "And the docs.", from: "human" }, "u-2", sessionId),
    ])
    expect(users.every((item) => item.session === sessionId)).toBe(true)
    // Each before the result of the turn it started.
    const at = (uuid: string) => done.items.findIndex((item) => item.message.uuid === uuid)
    const results = done.items.flatMap((item, i) => (item.message.type === "result" ? [i] : []))
    expect(at(done.first)).toBeLessThan(results[0] ?? -1)
    expect(at("u-2")).toBeGreaterThan(results[0] ?? Number.POSITIVE_INFINITY)
    expect(at("u-2")).toBeLessThan(results[1] ?? -1)
  })
})

describe("the view draws a sent message", () => {
  test("as a Prompt where it was sent", () => {
    const items = itemsOf([said("Working on it."), sent("Please add tests too.", "u-1")])
    expect(entriesOf(items).at(-1)).toMatchObject({ _tag: "Prompt", text: "Please add tests too." })
  })

  test("not while the composer shows it queued, nor once the CLI cancelled it", () => {
    const items = itemsOf([
      sent("first", "u-1"),
      sent("second", "u-2"),
      sent("third", "u-3"),
      lifecycle("u-3", "cancelled"),
    ])
    expect(prompts(items)).toEqual(["first", "second"])
    expect(prompts(items, new Set(["u-2"]))).toEqual(["first"])
  })

  test("any sends, queued and cancelled: exactly those neither are drawn, in order", () => {
    const send = fc.record({
      text: fc.stringMatching(/^[a-z]{1,8}( [a-z]{1,8}){0,3}$/),
      fate: fc.constantFrom("drawn", "queued", "cancelled"),
    })
    fc.assert(
      fc.property(fc.array(send, { maxLength: 12 }), (sends) => {
        const uuid = (i: number) => `u-${i}`
        const items = itemsOf([
          ...sends.map((each, i) => sent(each.text, uuid(i))),
          ...sends.flatMap((each, i) =>
            each.fate === "cancelled" ? [lifecycle(uuid(i), "cancelled")] : [],
          ),
        ])
        const queued = new Set(
          sends.flatMap((each, i) => (each.fate === "queued" ? [uuid(i)] : [])),
        )
        expect(prompts(items, queued)).toEqual(
          sends.filter((each) => each.fate === "drawn").map((each) => each.text),
        )
      }),
    )
  })
})

describe("the worker view", () => {
  const themeOf = (appearance: Appearance) =>
    makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
  const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

  const viewOf = (state: WorkerState): RunView =>
    project({
      ledger: {
        tickets: new Map([
          [
            "t-1",
            {
              ticket: "t-1",
              title: "Title of t-1",
              phase: TicketPhase.Working({ activity: "working" }),
              since: began,
              worker: 1,
              row: 0,
              rechecking: false,
              steered: false,
              lastMessage: null,
              tallies: emptyTallies,
            },
          ],
        ]),
        rows: 1,
        windDown: null,
        bugs: [],
      },
      workers: new Map([["t-1", state]]),
      requests: [],
      status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
      actions: new Map(),
    })

  /** A feed of t-1's transcript, which the test appends to as the host would. */
  const liveFeed = () => {
    const state = external<TranscriptState>({ ...emptyTranscript, window: windowOf([]) })
    const feed: TranscriptFeed = {
      open: (): OpenTranscript => ({
        state,
        older: () => {},
        scrolledBack: () => state.set({ ...state.get(), window: scrolledBack(state.get().window) }),
        follow: () => state.set({ ...state.get(), window: followed(state.get().window) }),
        close: () => {},
      }),
    }
    const append = (messages: ReadonlyArray<SDKMessage>) => {
      let window = state.get().window
      for (const item of itemsOf(messages)) window = appended(window, item)
      state.set({ ...state.get(), window })
    }
    return { feed, append }
  }

  const sendIn = (commands: Commands): string => {
    const taken: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(commands))
    const send = taken.find((command) => command._tag === "SendMessage")
    if (send?._tag !== "SendMessage") throw new Error("no SendMessage")
    return send.uuid
  }

  /** How many times the frame shows `text`, once the renderer is idle. */
  const times = async (rendered: Rendered, text: string) =>
    (await rendered.capture()).chars.split(text).length - 1

  test("your message is drawn once: queued below, then in the transcript", async () => {
    const view = external(viewOf(WS.Working({ doing: "working" })))
    const commands = Effect.runSync(makeCommands)
    const { feed, append } = liveFeed()
    append([said("Working on it.")])
    const shell: ShellValue = {
      view,
      screen: external<Screen>(Screen.Worker({ worker: 1 })),
      commands,
      appearance: external<Appearance>("dark"),
      themeOf,
      now: () => began + 67_000,
      transcripts: feed,
    }
    await withRender(<Root value={shell} />, { width: 80, height: 16 }, async (rendered) => {
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("i")
        await setup.mockInput.typeText("Please add tests")
        setup.mockInput.pressEnter()
      })
      const uuid = sendIn(commands)
      // The host records it as it pushes it, with its queued lifecycle.
      await rendered.input(() =>
        append([sent("Please add tests", uuid), lifecycle(uuid, "queued")]),
      )
      let frame = await rendered.capture()
      expect(frame.chars).toContain("queued")
      expect(await times(rendered, "› Please add tests")).toBe(1)
      await rendered.input(() => append([lifecycle(uuid, "started"), said("Adding them.")]))
      frame = await rendered.capture()
      expect(frame.chars).not.toContain("queued")
      expect(await times(rendered, "› Please add tests")).toBe(1)
      // In place: after what came before it was sent, before the turn that took it.
      const lines = frame.chars.split("\n")
      const row = (text: string) => lines.findIndex((line) => line.includes(text))
      expect(row("Working on it.")).toBeLessThan(row("› Please add tests"))
      expect(row("› Please add tests")).toBeLessThan(row("Adding them."))
    })
  })
})
