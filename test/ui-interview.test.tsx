// The Interview view (§ 4.10, § 7.1): the chat with a feature's breakdown, built from the worker
// view's components; leaving it, which asks first unless the session filed something; and the
// interview's side of the run: its commands reaching the session, the tree checked once the epic is
// filed, the run started on it with nothing asked, and what an interview that runs nothing says.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createTestRenderer } from "@opentui/core/testing"
import { Deferred, Effect, Fiber, Layer, Option, Queue, Stream, SubscriptionRef } from "effect"
import fc from "fast-check"
import { act } from "react"
import type { MessageUuid } from "../src/agent/AgentHost.ts"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { Answer, type BreakdownState, type BreakdownTools } from "../src/agent/breakdownTools.ts"
import { interviewWorker } from "../src/agent/inView.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { exitCodes } from "../src/run/holds.ts"
import {
  filedLine,
  type InterviewInputs,
  InterviewOutcome,
  type InterviewScreen,
  interview,
  interviewCard,
  interviewEnding,
  interviewView,
  leftMessage,
  quitMessage,
  startingLine,
} from "../src/run/interview.ts"
import type { RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { TreeFilingStopped } from "../src/run/specTree.ts"
import type { TicketId } from "../src/services/Beads.ts"
import {
  assistantText,
  canUseTool,
  failStart,
  init,
  Recording,
  result,
  run,
  type Script,
  layer as scriptedHost,
  sessionState,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Backlog, layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { interviewScreen, Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { InterviewContext, leaveAbout, leaveQuestion } from "../src/ui/InterviewView.tsx"
import { rendererConfig, type Shell } from "../src/ui/renderer.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  followed,
  type OpenTranscript,
  scrolledBack,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { type External, external, type Settable, type ShellValue } from "../src/ui/useRunView.ts"
import { drawnFrame, type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const description = "Add a --json flag to list.\nIt prints the list as JSON."

// SDK messages with only the fields tutti reads.
const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage
const said = (words: string) =>
  sdk({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  })

const itemsOf = (messages: ReadonlyArray<SDKMessage>): ReadonlyArray<Item> =>
  messages.map((message, i) => ({
    v: transcriptVersion,
    seq: i + 1,
    session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
    time: "2026-10-20T13:00:00.000Z",
    message,
  }))

/** A feed with the interview's transcript fixed at `items`. */
const fixedFeed = (items: ReadonlyArray<Item>): TranscriptFeed => ({
  open: (ticket): OpenTranscript => {
    const state = external<TranscriptState>({
      ...emptyTranscript,
      window: windowOf(ticket === interviewWorker ? items : []),
    })
    return {
      state,
      older: () => {},
      scrolledBack: () => state.set({ ...state.get(), window: scrolledBack(state.get().window) }),
      follow: () => state.set({ ...state.get(), window: followed(state.get().window) }),
      close: () => {},
    }
  },
})

/** The shell's clock, which the tests move past the panel's guard. */
const clock = (() => {
  const start = began + 67_000
  let at = start
  return { now: () => at, pass: (millis: number) => (at += millis), reset: () => (at = start) }
})()

/** A question AskUserQuestion asked the interview. */
const question: AttentionRequest = {
  id: "q1",
  ticket: interviewWorker,
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "Should --json print one object or one per line?",
        options: [{ label: "One object", description: "Recommended" }, { label: "One per line" }],
        multiSelect: false,
      },
    ],
    input: {},
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: true,
  createdAt: began,
}

const viewOf = (requests: ReadonlyArray<AttentionRequest> = []): RunView =>
  interviewView(interviewCard(description, began, WS.Idle({ at: began }), requests))

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

const shownOf = (frame: Frame): string =>
  `\n${linesOf(frame)
    .filter((line) => line !== "")
    .join("\n")}\n`

const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      switch (key) {
        case "enter":
          setup.mockInput.pressEnter()
          break
        case "escape":
          await pressEscape(setup)
          break
        default:
          await setup.mockInput.typeText(key)
      }
    }
  })

/** Renders the Interview view over `items` and runs `body`. */
const scene = async (
  items: ReadonlyArray<Item>,
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly filed: Settable<boolean>
    readonly rendered: Rendered
  }) => Promise<void>,
  options: { readonly requests?: ReadonlyArray<AttentionRequest>; readonly filed?: boolean } = {},
) => {
  clock.reset()
  const view = external(viewOf(options.requests))
  const commands = Effect.runSync(makeCommands)
  const filed = external(options.filed ?? false)
  const value: ShellValue = {
    view,
    screen: external<Screen>(Screen.Interview()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: clock.now,
    transcripts: fixedFeed(items),
  }
  await withRender(
    <InterviewContext.Provider value={{ description, filed: filed as External<boolean> }}>
      <Root value={value} />
    </InterviewContext.Provider>,
    { width: 80, height: 24 },
    (rendered) => body({ view, commands, filed, rendered }),
  )
}

const chat = itemsOf([
  said("1. Should `--json` replace the table, or sit beside it? I'd keep the table as default."),
])

describe("the Interview view", () => {
  test("its chrome, the chat, and the composer for your answers", async () => {
    await scene(chat, async ({ rendered }) => {
      const frame = await until(rendered, has("Should `--json` replace"))
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Back   •  Interview  your turn  1m07s   Add a --json flag to list.
        ────────────────────────────────────────────────────────────────────────────────
          1. Should \`--json\` replace the table, or sit beside it? I'd keep the table as
          default.
        ────────────────────────────────────────────────────────────────────────────────
         > i to answer
          Esc back · i answer · ↑↓ select · Enter expand · PgUp/PgDn scroll · ? keys
        "
      `)
    })
  })

  test("an answer typed in the composer is sent to the session", async () => {
    await scene(chat, async ({ commands, rendered }) => {
      await until(rendered, has("Should `--json` replace"))
      await press(rendered, "i", "Beside it.", "enter")
      expect(taken(commands)).toEqual([
        UiCommand.SendMessage({
          ticket: interviewWorker,
          text: "Beside it.",
          uuid: expect.any(String) as unknown as MessageUuid,
        }),
      ])
    })
  })

  test("AskUserQuestion shows in the panel, and its option answers it", async () => {
    await scene(
      chat,
      async ({ commands, rendered }) => {
        const frame = await until(rendered, has("One per line"))
        expect(frame.chars).toContain("Should --json print one object or one per line?")
        expect(frame.chars).toContain("1 One object")
        clock.pass(settle)
        await press(rendered, "2", "enter")
        expect(taken(commands)).toEqual([
          UiCommand.Answer({
            requestId: "q1",
            answer: { _tag: "Choose", answers: ["One per line"] },
          }),
        ])
      },
      { requests: [question] },
    )
  })

  test("leaving with nothing filed asks first: n stays, y ends the interview", async () => {
    await scene(chat, async ({ commands, rendered }) => {
      await until(rendered, has("Should `--json` replace"))
      await press(rendered, "escape")
      const asked = await until(rendered, has(leaveQuestion))
      expect(asked.chars).toContain(leaveAbout)
      await press(rendered, "n")
      expect((await rendered.capture()).chars).not.toContain(leaveQuestion)
      expect(taken(commands)).toEqual([])
      await press(rendered, "escape")
      await until(rendered, has(leaveQuestion))
      await press(rendered, "y")
      expect(taken(commands)).toEqual([UiCommand.CloseWorker()])
    })
  })

  test("Esc in the composer leaves the composer, not the interview", async () => {
    await scene(chat, async ({ commands, rendered }) => {
      await until(rendered, has("Should `--json` replace"))
      await press(rendered, "i", "escape")
      expect((await rendered.capture()).chars).not.toContain(leaveQuestion)
      expect(taken(commands)).toEqual([])
    })
  })

  test("a click on ← Back asks too", async () => {
    await scene(chat, async ({ rendered }) => {
      await until(rendered, has("Should `--json` replace"))
      await rendered.input((setup) => setup.mockMouse.click(2, 1))
      expect((await until(rendered, has(leaveQuestion))).chars).toContain(leaveAbout)
    })
  })

  test("once the session filed something, leaving asks nothing", async () => {
    await scene(chat, async ({ commands, filed, rendered }) => {
      await until(rendered, has("Should `--json` replace"))
      filed.set(true)
      await press(rendered, "escape")
      expect((await rendered.capture()).chars).not.toContain(leaveQuestion)
      expect(taken(commands)).toEqual([UiCommand.CloseWorker()])
    })
  })
})

// The interview's side of the run, with the scripted host.

/** The breakdown's own tools, on the session the interview started. */
const toolsOfSession = Effect.gen(function* () {
  const recording = yield* Recording
  for (;;) {
    const started = (yield* recording.sentTo(interviewWorker)).find((s) => s._tag === "Started")
    const kind = started?._tag === "Started" ? started.session.kind : undefined
    if (kind?._tag === "Interview") return kind
    yield* Effect.sleep("5 millis")
  }
})

/** Calls the breakdown's tool `name` with `input`, as the session would. */
const call = (
  tools: Pick<BreakdownTools, "tools">,
  name: string,
  input: Record<string, unknown>,
) => {
  const found = tools.tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return Effect.promise(() => found.handler(input as never, {}))
}

const ticket = (fields: Record<string, unknown>) => ({
  parent: "",
  type: "task",
  priority: 2,
  description: "Why and what.",
  acceptance: "The tests pass.",
  labels: [],
  files: ["README.md"],
  waits_for: [],
  ...fields,
})

/** Files the feature's epic and two tickets side by side with the tools, as the session would. */
const fileFeature = (
  tools: Pick<BreakdownTools, "tools">,
  issues: ReadonlyArray<Record<string, unknown>> = [
    ticket({ key: "json", title: "JSON output for list" }),
    ticket({ key: "docs", title: "Document --json" }),
  ],
) =>
  Effect.gen(function* () {
    const root = yield* call(tools, "file_root", {
      title: "A --json flag for list",
      description: "list prints JSON with --json.",
      priority: 1,
    })
    const epic = /Filed the root epic (\S+)\./.exec(
      root.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )?.[1]
    yield* call(tools, "file_breakdown", { root: epic ?? "", issues })
  })

/** The uuid the composer drew for your answer. */
const sentUuid = "5d1f6a3e-2222-4c8e-9a51-6f0d1f0b2a02" as MessageUuid

/** The interview's session's system/init. */
const interviewInit = init({ mcp_servers: [{ name: "tutti", status: "connected", source: "sdk" }] })

/** The services the interview runs with: the scripted host playing `script`, in `repo`. */
const layersFor = (repo: string, script: Script) =>
  scriptedHost({ [interviewWorker]: script }).pipe(
    Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
    Layer.provideMerge(
      Layer.mergeAll(
        logLayer(),
        eventsLayer(),
        configLayer(appConfig({}, repo)),
        beadsLayer(),
        memoryGit({ dir: repo, files: { "README.md": "# demo\n" } }),
      ),
    ),
  )

/** A new main checkout. */
const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-ui-interview-")))

/**
 * Runs the interview of `description` with the scripted host playing `script`; `drive` acts in the
 * view's place once it is shown. What it said, line by line.
 */
const scenario = <A,>(
  script: Script,
  drive: (inputs: InterviewInputs) => Effect.Effect<A, never, Recording>,
) => {
  const said: Array<string> = []
  const errors: Array<string> = []
  return Effect.runPromise(
    Effect.gen(function* () {
      const shown = yield* Deferred.make<InterviewInputs>()
      const screen: InterviewScreen = (inputs) => Effect.asVoid(Deferred.succeed(shown, inputs))
      const fiber = yield* Effect.forkChild(
        interview(description, {
          screen,
          say: (text) => Effect.sync(() => void said.push(text)),
          error: (text) => Effect.sync(() => void errors.push(text)),
        }),
      )
      const drove = yield* Effect.flatMap(Deferred.await(shown), drive)
      const outcome = yield* Fiber.join(fiber)
      const recording = yield* Recording
      const sent = yield* recording.sentTo(interviewWorker)
      const issues = yield* (yield* Backlog).issues
      return { outcome, said, errors, sent, drove, issues }
    }).pipe(Effect.provide(layersFor(folder(), script))),
  )
}

/** The first view `inputs` shows that `ready` holds of. */
const viewWhere = (inputs: InterviewInputs, ready: (view: RunView) => boolean) =>
  SubscriptionRef.changes(inputs.view).pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

const idle = (view: RunView) => view.cards[0]?.state?._tag === "Idle"

/** A session whose first turn asks in text, and whose second files the feature with `filing`. */
const filingSession = (filing: Effect.Effect<void>): Script => [
  [
    wait,
    interviewInit,
    sessionState("running"),
    assistantText("1. Beside the table, or instead of it? I'd keep the table."),
    result("asked"),
    sessionState("idle"),
    wait,
    sessionState("running"),
    run(filing),
    result("Filed."),
    sessionState("idle"),
  ],
]

/**
 * A session whose second turn files the feature with `issues` through its own tools, once `find`
 * has found them on the started session: the view's driver runs it.
 */
const filingWith = (issues?: ReadonlyArray<Record<string, unknown>>) => {
  const found: { tools?: Pick<BreakdownTools, "tools"> } = {}
  return {
    script: filingSession(
      Effect.suspend(() =>
        found.tools === undefined ? Effect.void : fileFeature(found.tools, issues),
      ),
    ),
    find: Effect.map(toolsOfSession, (tools) => {
      found.tools = tools
    }),
  }
}

/** Your answer, sent from the composer once it is your turn. */
const answered = (inputs: InterviewInputs) =>
  Effect.gen(function* () {
    yield* viewWhere(inputs, idle)
    yield* Queue.offer(
      inputs.commands,
      UiCommand.SendMessage({ ticket: interviewWorker, text: "Beside it.", uuid: sentUuid }),
    )
  })

describe("the interview's side of the run", () => {
  test("the view is shown the interview's card and transcript, at the Interview screen", async () => {
    const { outcome, drove } = await scenario(filingSession(Effect.void), (inputs) =>
      Effect.gen(function* () {
        const view = yield* viewWhere(inputs, idle)
        const screen = yield* SubscriptionRef.get(inputs.screen)
        yield* Queue.offer(inputs.commands, UiCommand.CloseWorker())
        return { view, screen, description: inputs.description }
      }),
    )
    expect(drove.screen._tag).toBe("Interview")
    expect(drove.description).toBe(description)
    expect(drove.view.cards.map((card) => [card.ticket, card.title, card.status])).toEqual([
      [interviewWorker, "Add a --json flag to list.", "your turn"],
    ])
    expect(outcome._tag).toBe("Left")
    if (outcome._tag !== "Left") return
    expect(outcome.quit).toBe(false)
    expect(outcome.state.root).toBeNull()
    expect(interviewEnding(outcome)).toEqual({ out: [], error: [leftMessage], exitCode: 0 })
  })

  test("your answer reaches the session; once the epic is filed, the run starts with nothing asked", async () => {
    const filing = filingWith()
    const { outcome, said, errors, sent, issues } = await scenario(filing.script, (inputs) =>
      Effect.andThen(filing.find, answered(inputs)),
    )
    const messages = sent.flatMap((each) => (each._tag === "Message" ? [each.message] : []))
    expect(messages.at(-1)?.message.content).toBe("Beside it.")
    expect(messages.at(-1)?.uuid).toBe(sentUuid)
    expect(sent.some((each) => each._tag === "Ended" || each._tag === "Closed")).toBe(true)
    const epic = issues[0]?.id ?? ("?" as TicketId)
    expect(issues.map((issue) => [issue.type, issue.parent])).toEqual([
      ["epic", undefined],
      ["task", epic],
      ["task", epic],
    ])
    expect(outcome).toEqual(InterviewOutcome.Run({ epic, tickets: 2 }))
    expect(said).toEqual([startingLine(epic, 2)])
    expect(said[0]).toBe(`filed ${epic}: 2 tickets, starting the run`)
    expect(errors).toEqual([])
  })

  test("the tree is checked once filed: open tickets without files are a warning", async () => {
    const filing = filingWith([
      ticket({ key: "json", title: "JSON output for list", files: [] }),
      ticket({ key: "docs", title: "Document --json" }),
    ])
    const { outcome, said, errors, issues } = await scenario(filing.script, (inputs) =>
      Effect.andThen(filing.find, answered(inputs)),
    )
    const epic = issues[0]?.id ?? ("?" as TicketId)
    expect(outcome).toEqual(InterviewOutcome.Run({ epic, tickets: 2 }))
    expect(errors).toEqual([
      `warning: 1 open ticket under ${epic} has no files metadata, so tutti guesses its files: ${issues[1]?.id}`,
    ])
    expect(said).toEqual([startingLine(epic, 2)])
  })
  test("an AskUserQuestion answered in the view goes to Attention, and the session goes on", async () => {
    const input = {
      questions: [
        {
          question: "One object or one per line?",
          header: "Shape",
          options: [{ label: "One object" }, { label: "One per line" }],
          multiSelect: false,
        },
      ],
    }
    const { outcome, sent } = await scenario(
      [
        [
          wait,
          interviewInit,
          sessionState("running"),
          canUseTool("AskUserQuestion", input),
          result("asked"),
          sessionState("idle"),
        ],
      ],
      (inputs) =>
        Effect.gen(function* () {
          const view = yield* viewWhere(inputs, (each) => each.requests.length > 0)
          const request = view.requests[0]
          if (request === undefined) return
          yield* Queue.offer(
            inputs.commands,
            UiCommand.Answer({
              requestId: request.id,
              answer: { _tag: "Choose", answers: ["One per line"] },
            }),
          )
          yield* viewWhere(inputs, idle)
          yield* Queue.offer(inputs.commands, UiCommand.Quit({ now: true }))
        }),
    )
    const answered = sent.flatMap((each) => (each._tag === "Answered" ? [each] : []))
    expect(answered.map((each) => each.result?.behavior)).toEqual(["allow"])
    expect(outcome._tag === "Left" && outcome.quit).toBe(true)
  })

  test("a session that can't start runs nothing, and says why", async () => {
    let shown = false
    const ended = await Effect.runPromise(
      interview(description, {
        screen: () =>
          Effect.sync(() => {
            shown = true
          }),
        say: () => Effect.void,
        error: () => Effect.void,
      }).pipe(Effect.provide(layersFor(folder(), [[failStart("no login")]]))),
    )
    expect(shown).toBe(false)
    expect(ended._tag).toBe("NotStarted")
    if (ended._tag !== "NotStarted") return
    expect(ended.why).toContain("no login")
    expect(interviewEnding(ended)).toEqual({
      out: [],
      error: [`tutti: the interview couldn't start: ${ended.why}; nothing was filed.`],
      exitCode: exitCodes.tool,
    })
  })
})

/** Whether `code` is a control character: C0, DEL or C1. */
const controls = (code: number): boolean => code < 0x20 || (code >= 0x7f && code < 0xa0)

describe("interviewEnding", () => {
  /** What the breakdown had filed: `fields` over nothing. */
  const state = (fields: Partial<BreakdownState> = {}): BreakdownState => ({
    root: null,
    environment: null,
    epics: 0,
    tickets: 0,
    answer: Answer.None(),
    ...fields,
  })
  const filedTree = state({
    root: "bd-7" as TicketId,
    epics: 1,
    tickets: 2,
    answer: Answer.Filed({
      tree: {
        issues: [],
        updates: [],
        deferrals: [],
        links: [],
        unlinks: [],
        assumptions: [],
        note: "",
        notes: [],
      },
      filed: { ids: new Map(), epics: 0, tickets: 2 },
    }),
  })

  test("what each end says, and its exit code", () => {
    expect(interviewEnding(InterviewOutcome.Left({ state: state(), quit: false }))).toEqual({
      out: [],
      error: [leftMessage],
      exitCode: exitCodes.ok,
    })
    expect(interviewEnding(InterviewOutcome.Left({ state: state(), quit: true }))).toEqual({
      out: [],
      error: [quitMessage],
      exitCode: exitCodes.interrupted,
    })
    expect(interviewEnding(InterviewOutcome.Left({ state: filedTree, quit: false }))).toEqual({
      out: [filedLine("bd-7" as TicketId, 2)],
      error: [],
      exitCode: exitCodes.ok,
    })
    expect(filedLine("bd-7" as TicketId, 2)).toBe(
      "Filed epic bd-7 with 2 tickets; nothing was run. Run it with: tutti --ticket bd-7",
    )
    expect(
      interviewEnding(
        InterviewOutcome.Left({
          state: state({ root: "bd-7" as TicketId, epics: 1 }),
          quit: false,
        }),
      ),
    ).toEqual({
      out: [],
      error: [
        "tutti: the interview ended with the epic bd-7 filed, but not its tickets; nothing was run. Close it with: bd close bd-7",
      ],
      exitCode: exitCodes.ok,
    })
    expect(interviewEnding(InterviewOutcome.Ended({ why: "it crashed", state: state() }))).toEqual({
      out: [],
      error: ["tutti: the interview's session ended: it crashed; nothing was filed."],
      exitCode: exitCodes.tool,
    })
    const stopped = interviewEnding(
      InterviewOutcome.Left({
        state: state({
          root: "bd-7" as TicketId,
          epics: 1,
          tickets: 1,
          answer: Answer.Stopped({
            stopped: new TreeFilingStopped({
              what: "issue docs (Document --json)",
              reason: "bd create failed",
              filed: 1,
              total: 2,
            }),
          }),
        }),
        quit: false,
      }),
    )
    expect(stopped).toEqual({
      out: [],
      error: [
        "tutti filed 1 of its answer's 2 issues, then couldn't file issue docs (Document --json): bd create failed",
        "tutti: nothing was run under bd-7.",
      ],
      exitCode: exitCodes.tool,
    })
    expect(
      interviewEnding(
        InterviewOutcome.Refused({
          epic: "bd-7" as TicketId,
          why: "bd-7 is a task, not an epic",
          exitCode: exitCodes.setup,
        }),
      ),
    ).toEqual({
      out: [],
      error: ["tutti won't run what the interview filed under bd-7: bd-7 is a task, not an epic"],
      exitCode: exitCodes.setup,
    })
  })

  test("what it says of the session's words and the epic's ID stays on its line, printable", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }).map((epic) => epic as TicketId),
        (why, epic) => {
          const lines = [
            ...interviewEnding(InterviewOutcome.Ended({ why, state: state() })).error,
            ...interviewEnding(InterviewOutcome.NotStarted({ why })).error,
            ...interviewEnding(InterviewOutcome.Refused({ epic, why, exitCode: 2 })).error,
            ...interviewEnding(
              InterviewOutcome.Left({ state: state({ root: epic, epics: 1 }), quit: false }),
            ).error,
            ...interviewEnding(
              InterviewOutcome.Left({ state: { ...filedTree, root: epic }, quit: false }),
            ).out,
            startingLine(epic, 1),
          ]
          for (const line of lines) {
            expect([...line].some((ch) => controls(ch.codePointAt(0) ?? 0))).toBe(false)
          }
        },
      ),
    )
  })

  test("the card's title is the description's first line that says something", () => {
    expect(interviewCard("\n  \nAdd a flag.\nWhy.", began, null, []).title).toBe("Add a flag.")
    fc.assert(
      fc.property(fc.string(), (text) => {
        const lines = text.split("\n")
        const title = interviewCard(`\n  \n${text}`, began, null, []).title
        expect(title).toBe(lines.find((line) => line.trim() !== "") ?? "")
      }),
    )
  })
})

describe("the interview in the command's renderer", () => {
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

  test("the chat, your answer, the filing, then the view goes and the run starts", async () => {
    const setup = await createTestRenderer({
      ...rendererConfig,
      width: 80,
      height: 24,
      onDestroy: () => {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
      },
    })
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const shell: Shell = { renderer: setup.renderer, appearance: external<Appearance>("dark") }
    /** The frame once it shows `text`, drawn again until it does. */
    const showing = async (text: string): Promise<string> => {
      const deadline = Date.now() + 5000
      for (;;) {
        const frame = await drawnFrame(setup)
        if (frame.includes(text) || Date.now() > deadline) return frame
        await act(async () => {
          await Bun.sleep(20)
        })
      }
    }
    try {
      const filing = filingWith()
      const said: Array<string> = []
      const shown = interviewScreen(shell, themeOf)
      let fiber: Fiber.Fiber<InterviewOutcome> | undefined
      await act(async () => {
        fiber = Effect.runFork(
          Effect.gen(function* () {
            const running = yield* Effect.forkChild(
              interview(description, {
                screen: shown,
                say: (text) => Effect.sync(() => void said.push(text)),
                error: () => Effect.void,
              }),
            )
            yield* filing.find
            return yield* Fiber.join(running)
          }).pipe(Effect.provide(layersFor(folder(), filing.script))),
        )
      })
      expect(await showing("Beside the table, or instead of it?")).toContain("your turn")
      await act(async () => {
        await setup.mockInput.typeText("i")
        await setup.mockInput.typeText("Beside it.")
        setup.mockInput.pressEnter()
      })
      const outcome = await Effect.runPromise(Fiber.join(fiber as Fiber.Fiber<InterviewOutcome>))
      expect(outcome._tag).toBe("Run")
      if (outcome._tag !== "Run") return
      expect(outcome.tickets).toBe(2)
      expect(said).toEqual([startingLine(outcome.epic, 2)])
      const after = await drawnFrame(setup)
      expect(after).not.toContain("← Back")
      expect(after).not.toContain("Start the run on")
    } finally {
      setup.renderer.destroy()
    }
  })
})
