// The Interview view (§ 4.10, § 7.1): the chat with the interview's session, built from the worker
// view's components; leaving it, which asks first unless file_feature filed something; and the
// interview's side of the run: its commands reaching the session, the plan confirmation once the
// epic is filed, the run on y, and what an interview that runs nothing says.

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
import { interviewWorker } from "../src/agent/interview.ts"
import { Filing } from "../src/agent/interviewTools.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import type { FeaturePlan, FiledPlan } from "../src/project/planFile.ts"
import { FilingFailed } from "../src/project/planFile.ts"
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
} from "../src/run/interview.ts"
import type { RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
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
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { interviewScreen, Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { InterviewContext, leaveAbout, leaveQuestion } from "../src/ui/InterviewView.tsx"
import { askPlan } from "../src/ui/PlanConfirmation.tsx"
import { FormCancelled, type Plan } from "../src/ui/questions.ts"
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
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

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
    readonly filing: Settable<Filing>
    readonly rendered: Rendered
  }) => Promise<void>,
  options: { readonly requests?: ReadonlyArray<AttentionRequest>; readonly filing?: Filing } = {},
) => {
  clock.reset()
  const view = external(viewOf(options.requests))
  const commands = Effect.runSync(makeCommands)
  const filing = external<Filing>(options.filing ?? Filing.None())
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
    <InterviewContext.Provider value={{ description, filing: filing as External<Filing> }}>
      <Root value={value} />
    </InterviewContext.Provider>,
    { width: 80, height: 24 },
    (rendered) => body({ view, commands, filing, rendered }),
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

  test("once file_feature filed something, leaving asks nothing", async () => {
    await scene(chat, async ({ commands, filing, rendered }) => {
      await until(rendered, has("Should `--json` replace"))
      filing.set(Filing.Filed({ plan, filed }))
      await press(rendered, "escape")
      expect((await rendered.capture()).chars).not.toContain(leaveQuestion)
      expect(taken(commands)).toEqual([UiCommand.CloseWorker()])
    })
  })
})

// The interview's side of the run, with the scripted host.

/** The plan file_feature filed: an epic and two tickets. */
const plan: FeaturePlan = {
  epic: { title: "A --json flag for list", description: "list prints JSON with --json." },
  tickets: [
    {
      key: "t1",
      title: "JSON output for list",
      type: "feature",
      priority: 2,
      description: "Why and what.",
      acceptance: "The tests pass.",
      files: ["src/list.ts"],
      blockedBy: [],
      solo: false,
    },
    {
      key: "t2",
      title: "Document --json",
      type: "task",
      priority: 1,
      description: "Why and what.",
      acceptance: "The tests pass.",
      files: [],
      blockedBy: ["t1"],
      solo: true,
    },
  ],
  questions: [],
  notes: [],
}

const filed: FiledPlan = {
  epic: "bd-7" as TicketId,
  tickets: new Map([
    ["t1", "bd-7.1" as TicketId],
    ["t2", "bd-7.2" as TicketId],
  ]),
}

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
 * view's place once it is shown, and `answer` answers the confirmation.
 */
const scenario = <A,>(
  script: Script,
  drive: (inputs: InterviewInputs) => Effect.Effect<A>,
  answer: Effect.Effect<boolean, FormCancelled> = Effect.succeed(true),
) => {
  const asked: Array<{ plan: Plan; question: string }> = []
  return Effect.runPromise(
    Effect.gen(function* () {
      const shown = yield* Deferred.make<InterviewInputs>()
      const screen: InterviewScreen = (inputs) => Effect.asVoid(Deferred.succeed(shown, inputs))
      const fiber = yield* Effect.forkChild(
        interview(description, {
          screen,
          confirm: (shownPlan, question) =>
            Effect.suspend(() => {
              asked.push({ plan: shownPlan, question })
              return answer
            }),
        }),
      )
      const drove = yield* Effect.flatMap(Deferred.await(shown), drive)
      const outcome = yield* Fiber.join(fiber)
      const recording = yield* Recording
      const sent = yield* recording.sentTo(interviewWorker)
      return { outcome, asked, sent, drove }
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
    expect(outcome).toEqual(InterviewOutcome.Left({ filing: Filing.None(), quit: false }))
  })

  test("your answer reaches the session; once the epic is filed, the confirmation, and y runs it", async () => {
    let inputsSeen: InterviewInputs | undefined
    const { outcome, asked, sent } = await scenario(
      filingSession(
        Effect.suspend(() =>
          inputsSeen === undefined
            ? Effect.void
            : SubscriptionRef.set(inputsSeen.filing, Filing.Filed({ plan, filed })),
        ),
      ),
      (inputs) =>
        Effect.gen(function* () {
          inputsSeen = inputs
          yield* viewWhere(inputs, idle)
          yield* Queue.offer(
            inputs.commands,
            UiCommand.SendMessage({ ticket: interviewWorker, text: "Beside it.", uuid: sentUuid }),
          )
        }),
    )
    const messages = sent.flatMap((each) => (each._tag === "Message" ? [each.message] : []))
    expect(messages.at(-1)?.message.content).toBe("Beside it.")
    expect(messages.at(-1)?.uuid).toBe(sentUuid)
    expect(asked.map((each) => each.question)).toEqual(["Start the run on bd-7 (2 tickets)?"])
    expect(asked[0]?.plan.tickets.map((ticket) => [ticket.key, ticket.after])).toEqual([
      ["bd-7.1", []],
      ["bd-7.2", ["bd-7.1"]],
    ])
    expect(sent.some((each) => each._tag === "Ended" || each._tag === "Closed")).toBe(true)
    expect(outcome).toEqual(InterviewOutcome.Run({ epic: "bd-7" as TicketId, tickets: 2 }))
  })

  test("n at the confirmation, or Esc, leaves the epic filed and runs nothing", async () => {
    for (const answer of [Effect.succeed(false), Effect.fail(new FormCancelled())]) {
      let inputsSeen: InterviewInputs | undefined
      const { outcome } = await scenario(
        filingSession(
          Effect.suspend(() =>
            inputsSeen === undefined
              ? Effect.void
              : SubscriptionRef.set(inputsSeen.filing, Filing.Filed({ plan, filed })),
          ),
        ),
        (inputs) =>
          Effect.gen(function* () {
            inputsSeen = inputs
            yield* viewWhere(inputs, idle)
            yield* Queue.offer(
              inputs.commands,
              UiCommand.SendMessage({
                ticket: interviewWorker,
                text: "Beside it.",
                uuid: sentUuid,
              }),
            )
          }),
        answer,
      )
      expect(outcome).toEqual(InterviewOutcome.Declined({ epic: "bd-7" as TicketId, tickets: 2 }))
    }
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
    expect(outcome).toEqual(InterviewOutcome.Left({ filing: Filing.None(), quit: true }))
  })

  test("a session that can't start runs nothing, and says why", async () => {
    let shown = false
    const ended = await Effect.runPromise(
      interview(description, {
        screen: () =>
          Effect.sync(() => {
            shown = true
          }),
        confirm: () => Effect.succeed(true),
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
  const failed = new FilingFailed({
    what: "ticket t2",
    reason: "bd create failed",
    mayHaveFiled: false,
    epic: "bd-7",
    filed: [{ id: "bd-7" as TicketId, key: null, title: "A --json flag for list" }],
    unlinked: null,
  })

  test("what each end says, and its exit code", () => {
    expect(
      interviewEnding(InterviewOutcome.Declined({ epic: "bd-7" as TicketId, tickets: 2 })),
    ).toEqual({
      out: ["Filed epic bd-7 with 2 tickets; nothing was run. Run it with: tutti --ticket bd-7"],
      error: [],
      exitCode: exitCodes.ok,
    })
    expect(interviewEnding(InterviewOutcome.Left({ filing: Filing.None(), quit: false }))).toEqual({
      out: [],
      error: [leftMessage],
      exitCode: exitCodes.ok,
    })
    expect(interviewEnding(InterviewOutcome.Left({ filing: Filing.None(), quit: true }))).toEqual({
      out: [],
      error: [quitMessage],
      exitCode: exitCodes.interrupted,
    })
    expect(
      interviewEnding(
        InterviewOutcome.Left({ filing: Filing.Filed({ plan, filed }), quit: false }),
      ),
    ).toEqual({ out: [filedLine("bd-7" as TicketId, 2)], error: [], exitCode: exitCodes.ok })
    expect(
      interviewEnding(InterviewOutcome.Ended({ why: "it crashed", filing: Filing.None() })),
    ).toEqual({
      out: [],
      error: ["tutti: the interview's session ended: it crashed; nothing was filed."],
      exitCode: exitCodes.tool,
    })
    const stopped = interviewEnding(
      InterviewOutcome.Left({ filing: Filing.Stopped({ failed }), quit: false }),
    )
    expect(stopped.exitCode).toBe(exitCodes.tool)
    expect(stopped.error[0]).toBe("tutti couldn't file ticket t2: bd create failed")
  })

  test("what it says of the session's words and the epic's ID stays on its line, printable", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }).map((epic) => epic as TicketId),
        (why, epic) => {
          const lines = [
            ...interviewEnding(InterviewOutcome.Ended({ why, filing: Filing.None() })).error,
            ...interviewEnding(InterviewOutcome.NotStarted({ why })).error,
            ...interviewEnding(InterviewOutcome.Declined({ epic, tickets: 1 })).out,
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

  test("the chat, your answer, the filing, then the confirmation: y runs the epic", async () => {
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
        await act(async () => {
          await setup.renderOnce()
        })
        // A frame the renderer scheduled itself may be drawing still: its buffer can't be read
        // (OutputBusy) until that frame ends.
        const frame = setup.renderer.getSchedulerState().isRendering ? "" : setup.captureCharFrame()
        if (frame.includes(text) || Date.now() > deadline) return frame
        await act(async () => {
          await Bun.sleep(20)
        })
      }
    }
    try {
      let inputsSeen: InterviewInputs | undefined
      const shown = interviewScreen(shell, themeOf)
      let fiber: Fiber.Fiber<InterviewOutcome> | undefined
      await act(async () => {
        fiber = Effect.runFork(
          interview(description, {
            screen: (inputs) => {
              inputsSeen = inputs
              return shown(inputs)
            },
            confirm: (filedPlan, question) => askPlan(shell, themeOf, filedPlan, question),
          }).pipe(
            Effect.provide(
              layersFor(
                folder(),
                filingSession(
                  Effect.suspend(() =>
                    inputsSeen === undefined
                      ? Effect.void
                      : SubscriptionRef.set(inputsSeen.filing, Filing.Filed({ plan, filed })),
                  ),
                ),
              ),
            ),
          ),
        )
      })
      expect(await showing("Beside the table, or instead of it?")).toContain("your turn")
      await act(async () => {
        await setup.mockInput.typeText("i")
        await setup.mockInput.typeText("Beside it.")
        setup.mockInput.pressEnter()
      })
      const confirmation = await showing("Start the run on bd-7 (2 tickets)?")
      expect(confirmation).toContain("Epic: bd-7 A --json flag for list")
      expect(confirmation).not.toContain("← Back")
      await act(async () => {
        await setup.mockInput.typeText("y")
      })
      const outcome = await Effect.runPromise(Fiber.join(fiber as Fiber.Fiber<InterviewOutcome>))
      expect(outcome).toEqual(InterviewOutcome.Run({ epic: "bd-7" as TicketId, tickets: 2 }))
    } finally {
      setup.renderer.destroy()
    }
  })
})
