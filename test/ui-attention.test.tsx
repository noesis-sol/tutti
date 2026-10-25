// Attention cards (§ 4.5, § 7.2, § 7.3, § 7.11): a card whose worker waits for you grows to show
// its oldest request and its buttons, in the form roles; the keys and clicks that answer it, each
// answer naming the request drawn when the key was pressed; the 500 ms guard; `defaultToNo`, which
// opens on Deny with no one-key allow; several requests in order; a stale answer's toast; the
// Answer box of a compact card and Shift+D's reason box.

import { describe, expect, test } from "bun:test"
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import type { Answer, AttentionRequest, Question } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { attentionLines } from "../src/ui/AttentionCard.tsx"
import {
  buttonsOf,
  defaultFocus,
  keyAnswer,
  requestText,
  settle,
  stepFocus,
} from "../src/ui/attentionKeys.ts"
import { layoutOf } from "../src/ui/Card.tsx"
import type { Look, Segments } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const working = TicketPhase.Working()

const entryOf = (ticket: TicketId, worker: number, row: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: working,
  since: began,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView for workers 1 to `workers` on tickets t-1, t-2, …, with `requests` open. */
const viewOf = (requests: ReadonlyArray<AttentionRequest>, workers = 2): RunView =>
  project({
    ledger: {
      tickets: new Map(
        Array.from({ length: workers }, (_, i) => [
          `t-${i + 1}` as TicketId,
          entryOf(`t-${i + 1}` as TicketId, i + 1, i),
        ]),
      ),
      rows: workers,
      windDown: null,
      bugs: [],
    },
    // Every worker's turn has ended: no spinner turns on the shell's clock.
    workers: new Map(
      Array.from({ length: workers }, (_, i) => [`t-${i + 1}`, WS.Idle({ at: began })]),
    ),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: workers },
    actions: new Map(),
  })

const runRule: PermissionUpdate = {
  type: "addRules",
  behavior: "allow",
  rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }],
  destination: "localSettings",
}

const permission = (
  id: string,
  ticket: TicketId,
  over: Partial<AttentionRequest> & { readonly suggestions?: ReadonlyArray<PermissionUpdate> } = {},
): AttentionRequest => {
  const { suggestions, ...rest } = over
  return {
    id,
    ticket,
    kind: {
      _tag: "Permission",
      tool: "Bash",
      input: { command: "rm -rf build" },
      suggestions: suggestions ?? [],
      summary: "rm -rf build",
    },
    displayName: "Bash",
    description: "Remove the build cache",
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    createdAt: began,
    ...rest,
  }
}

const asked = (
  id: string,
  ticket: TicketId,
  questions: ReadonlyArray<Question> = [
    {
      question: "Which migration?",
      options: [{ label: "Keep the old" }, { label: "Write a new" }],
      multiSelect: false,
    },
  ],
): AttentionRequest => ({
  id,
  ticket,
  kind: { _tag: "Question", questions, input: { questions } },
  displayName: "AskUserQuestion",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const elicitation = (
  id: string,
  ticket: TicketId,
  over: { readonly mode: "form" | "url"; readonly requestedSchema?: Record<string, unknown> },
): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Elicitation",
    server: "docs",
    message: "Log in to the docs server",
    mode: over.mode,
    ...(over.mode === "url" ? { url: "https://docs.example/login" } : {}),
    ...(over.requestedSchema === undefined ? {} : { requestedSchema: over.requestedSchema }),
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

/** A clock the test moves. */
const clockAt = (start: number) => {
  let at = start
  return { now: () => at, pass: (millis: number) => (at += millis) }
}

const shellOf = (view: Settable<RunView>, commands: Commands, now: () => number): ShellValue => ({
  view,
  screen: external<Screen>(Screen.Dashboard()),
  commands,
  appearance: external<Appearance>("dark"),
  themeOf,
  now,
})

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** The lines of the Current section, from its label to the hint. */
const currentOf = (frame: Frame): string => {
  const lines = linesOf(frame)
  const from = lines.findIndex((line) => line.trim() === "Current")
  const to = lines.findLastIndex((line) => line.includes("? keys"))
  const shown = lines.slice(from, to + 1).filter((line) => line !== "")
  return `\n${shown.join("\n")}\n`
}

/** The commands sent since the last call, without waiting for one. */
const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const answerOf = (requestId: string, answer: Answer) => UiCommand.Answer({ requestId, answer })

/**
 * Renders the dashboard over `requests` at `size`, its clock at `began`, and runs `body` with the
 * view's store, the commands sent, the clock and the rendered tree.
 */
const scene = async (
  requests: ReadonlyArray<AttentionRequest>,
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly clock: ReturnType<typeof clockAt>
    readonly rendered: Rendered
  }) => Promise<void>,
  options: { readonly size?: { width: number; height: number }; readonly workers?: number } = {},
) => {
  const view = external(viewOf(requests, options.workers))
  const commands = Effect.runSync(makeCommands)
  const clock = clockAt(began)
  await withRender(
    <Root value={shellOf(view, commands, clock.now)} />,
    options.size ?? { width: 80, height: 40 },
    (rendered) => body({ view, commands, clock, rendered }),
  )
}

/** Where `text` is in the frame: its column and line. */
const where = (frame: Frame, text: string): { readonly x: number; readonly y: number } => {
  const lines = linesOf(frame)
  const y = lines.findIndex((line) => line.includes(text))
  if (y === -1) throw new Error(`no line holds ${text}`)
  return { x: (lines[y] ?? "").indexOf(text), y }
}

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      switch (key) {
        case "tab":
          setup.mockInput.pressTab()
          break
        case "shift+tab":
          setup.mockInput.pressTab({ shift: true })
          break
        case "enter":
          setup.mockInput.pressEnter()
          break
        case "escape":
          await pressEscape(setup)
          break
        case "right":
        case "left":
        case "up":
        case "down":
          setup.mockInput.pressArrow(key)
          break
        default:
          await setup.mockInput.typeText(key)
      }
    }
  })

/** The look of the segment whose text is `text`. */
const lookOf = (lines: ReadonlyArray<Segments>, text: string): Look => {
  const found = lines.flat().find((s) => s.text === text)
  if (found?.look === undefined || found.look === null) throw new Error(`no look for ${text}`)
  return found.look
}

const sameLook = (a: Look, b: Look) => {
  expect(a.attributes).toBe(b.attributes)
  expect(a.fg?.toInts()).toEqual(b.fg?.toInts())
  expect(a.bg?.toInts()).toEqual(b.bg?.toInts())
}

describe("the card", () => {
  test("grows to show its oldest request: its line, the summary and reason faint, the buttons", async () => {
    const requests = [
      permission("r1", "t-2" as TicketId, {
        decisionReason: "Path is outside allowed working directories",
        suggestions: [runRule],
      }),
      permission("r2", "t-2" as TicketId),
      permission("r3", "t-2" as TicketId),
    ]
    await scene(requests, async ({ rendered }) => {
      expect(currentOf(await rendered.capture())).toMatchInlineSnapshot(`
        "
          Current
        ╭──────────────────────────────────────────────────────────────────────────────╮
        │ • t-1  done  0s                                                              │
        │   Title of t-1                                                               │
        ╰──────────────────────────────────────────────────────────────────────────────╯
        ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        ┃ • t-2  permission — waiting for you (3)  0s                                  ┃
        ┃   Title of t-2                                                               ┃
        ┃   Bash: Remove the build cache                                               ┃
        ┃   rm -rf build                                                               ┃
        ┃   Path is outside allowed working directories                                ┃
        ┃   [ Deny ]  [ Allow ]  [ Allow for this run ]  +2 more                       ┃
        ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
          Tab select · Enter open · d deny · a allow · s stop after current · ? keys
        "
      `)
    })
  })

  test("framed needsYou, the line in the text's colour, the rest faint, the buttons in the form roles", () => {
    const card = viewOf([permission("r1", "t-1" as TicketId, { decisionReason: "held" })]).cards[0]
    if (card === undefined) throw new Error("no card")
    const lines = attentionLines(card, theme, [], { width: 60, highlighted: false, focus: 0 })
    const frame = lines[0]?.[0]?.look
    if (frame === undefined || frame === null) throw new Error("no frame")
    expect(frame.fg?.toInts()).toEqual(theme.rgba("needsYou").toInts())
    expect(lines.flat().find((s) => s.text === "Bash: Remove the build cache")?.look).toBeNull()
    sameLook(lookOf(lines, "rm -rf build"), theme.styles.dim)
    sameLook(lookOf(lines, "held"), theme.styles.dim)
    sameLook(lookOf(lines, "[ Deny ]"), theme.form.focusedButton)
    sameLook(lookOf(lines, "[ Allow ]"), theme.form.button)
  })

  test("a title stands for the line; the tool's name and the input's summary for what's missing", () => {
    const titled = permission("r", "t" as TicketId, { title: "Claude wants to run: rm -rf build" })
    expect(requestText(titled)).toEqual({ line: "Claude wants to run: rm -rf build", faint: [] })
    const bare = permission("r", "t" as TicketId)
    const { displayName: _, description: __, ...plain } = bare
    expect(requestText(plain)).toEqual({ line: "Bash: rm -rf build", faint: [] })
    expect(
      requestText(permission("r", "t" as TicketId, { title: "Claude wants to clean up" })),
    ).toEqual({
      line: "Claude wants to clean up",
      faint: ["rm -rf build"],
    })
  })

  test("the buttons of each kind; Allow for this run only with rules to keep, not suppressed", () => {
    const labels = (request: AttentionRequest) => buttonsOf(request).map((b) => b.label)
    expect(labels(permission("r", "t" as TicketId))).toEqual(["Deny", "Allow"])
    expect(labels(permission("r", "t" as TicketId, { suggestions: [runRule] }))).toEqual([
      "Deny",
      "Allow",
      "Allow for this run",
    ])
    expect(
      labels(
        permission("r", "t" as TicketId, { suggestions: [runRule], suppressAlwaysAllowRule: true }),
      ),
    ).toEqual(["Deny", "Allow"])
    expect(labels(asked("q", "t" as TicketId))).toEqual(["1 Keep the old", "2 Write a new"])
    const two: Question = { question: "And?", options: [{ label: "x" }], multiSelect: false }
    const first = asked("q", "t" as TicketId).kind
    if (first._tag !== "Question") throw new Error("not a question")
    expect(labels(asked("q", "t" as TicketId, [...first.questions, two]))).toEqual([
      "Answer in view",
    ])
    expect(labels(asked("q", "t" as TicketId, [{ ...two, multiSelect: true }]))).toEqual([
      "Answer in view",
    ])
    expect(labels(elicitation("e", "t" as TicketId, { mode: "url" }))).toEqual([
      "Decline",
      "Open URL",
    ])
    expect(
      labels(
        elicitation("e", "t" as TicketId, {
          mode: "form",
          requestedSchema: { type: "object", properties: { token: { type: "string" } } },
        }),
      ),
    ).toEqual(["Decline", "Answer in view"])
    expect(labels(elicitation("e", "t" as TicketId, { mode: "form" }))).toEqual([
      "Decline",
      "Accept",
    ])
  })

  test("a question's options one a line; an elicitation's URL faint", async () => {
    await scene(
      [asked("q1", "t-1" as TicketId), elicitation("e1", "t-2" as TicketId, { mode: "url" })],
      async ({ rendered }) => {
        expect(currentOf(await rendered.capture())).toMatchInlineSnapshot(`
          "
            Current
          ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
          ┃ • t-1  question — waiting for you  0s                                        ┃
          ┃   Title of t-1                                                               ┃
          ┃   Which migration?                                                           ┃
          ┃   [ 1 Keep the old ]                                                         ┃
          ┃   [ 2 Write a new ]                                                          ┃
          ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
          ╭──────────────────────────────────────────────────────────────────────────────╮
          │ • t-2  input — waiting for you  0s                                           │
          │   Title of t-2                                                               │
          │   docs: Log in to the docs server                                            │
          │   https://docs.example/login                                                 │
          │   [ Decline ]  [ Open URL ]                                                  │
          ╰──────────────────────────────────────────────────────────────────────────────╯
            Tab select · Enter open · d deny · s stop after current · ? keys
          "
        `)
      },
    )
  })

  test("cards keep their order; an attention card is taller, not moved", async () => {
    await scene(
      [permission("r1", "t-1" as TicketId)],
      async ({ rendered }) => {
        const lines = linesOf(await rendered.capture())
        const heads = lines.flatMap((line) =>
          [...line.matchAll(/[│┃] [•⣾] (t-\d)/g)].map((m) => m[1]),
        )
        expect(heads).toEqual(["t-1", "t-2", "t-3", "t-4"])
      },
      { size: { width: 120, height: 40 }, workers: 4 },
    )
    const view = viewOf([permission("r1", "t-1" as TicketId)], 4)
    const layout = layoutOf(view.cards, 120, 30)
    if (layout._tag !== "Cards") throw new Error("not cards")
    // The first row holds the attention card, as tall as its request; the second, two cards.
    expect(layout.rows).toEqual([7, 4])
  })

  test("in the compact layout, ■ allow?, and Enter opens its request in the Answer box", async () => {
    await scene(
      [permission("r1", "t-3" as TicketId)],
      async ({ rendered, commands, clock }) => {
        const frame = await rendered.capture()
        expect(linesOf(frame).some((line) => line.includes("• t-3  ■ allow?"))).toBe(true)
        expect(linesOf(frame).some((line) => line.includes("[ Deny ]"))).toBe(false)
        await press(rendered, "enter")
        expect(linesOf(await rendered.capture()).some((line) => line.includes("[ Deny ]"))).toBe(
          true,
        )
        clock.pass(settle)
        await press(rendered, "tab", "enter")
        expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Allow" })])
        expect(linesOf(await rendered.capture()).some((line) => line.includes("[ Deny ]"))).toBe(
          false,
        )
      },
      { size: { width: 80, height: 24 }, workers: 4 },
    )
  })
})

describe("answering by key", () => {
  test("d denies, a allows, r allows for this run: the oldest request is the target", async () => {
    const requests = [
      permission("r1", "t-2" as TicketId, { suggestions: [runRule] }),
      permission("r2", "t-1" as TicketId, { suggestions: [runRule] }),
    ]
    await scene(requests, async ({ view, commands, clock, rendered }) => {
      clock.pass(settle)
      await press(rendered, "d")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Deny" })])
      await press(rendered, "a")
      await press(rendered, "r")
      expect(taken(commands)).toEqual([
        answerOf("r1", { _tag: "Allow" }),
        answerOf("r1", { _tag: "AllowForRun" }),
      ])
      // Answered, it goes; the next oldest is the target.
      await rendered.input(() => view.set(viewOf([requests[1] as AttentionRequest])))
      clock.pass(settle)
      await press(rendered, "d")
      expect(taken(commands)).toEqual([answerOf("r2", { _tag: "Deny" })])
    })
  })

  test("Enter presses the focused button, Deny at first; Tab and → move to Allow", async () => {
    await scene([permission("r1", "t-1" as TicketId)], async ({ commands, clock, rendered }) => {
      clock.pass(settle)
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Deny" })])
      await press(rendered, "right", "enter")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Allow" })])
      // Past the last button, Tab goes on to the next card, whose Enter opens it.
      await press(rendered, "tab", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "t-2" as TicketId })])
    })
  })

  test("r answers nothing without rules to keep; a highlighted card that waits on nothing has no target", async () => {
    await scene([permission("r1", "t-1" as TicketId)], async ({ commands, clock, rendered }) => {
      clock.pass(settle)
      await press(rendered, "r")
      expect(taken(commands)).toEqual([])
      await press(rendered, "down", "d", "a")
      expect(taken(commands)).toEqual([])
    })
  })

  test("Shift+D denies with the reason typed in a small field; Esc closes it", async () => {
    await scene([permission("r1", "t-1" as TicketId)], async ({ commands, clock, rendered }) => {
      clock.pass(settle)
      await press(rendered, "D")
      const frame = await rendered.capture()
      expect(linesOf(frame).some((line) => line.includes("Deny t-1's request, saying why:"))).toBe(
        true,
      )
      // The field takes printable keys: `a` is typed, not an allow.
      await press(rendered, "a stray build", "enter")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Deny", reason: "a stray build" })])
      await press(rendered, "D", "escape")
      expect(taken(commands)).toEqual([])
      expect(linesOf(await rendered.capture()).some((line) => line.includes("saying why"))).toBe(
        false,
      )
    })
  })

  test("1–4 pick a question's option and Enter confirms; before a pick, Enter opens the card", async () => {
    await scene(
      [asked("q1", "t-1" as TicketId)],
      async ({ commands, clock, rendered }) => {
        clock.pass(settle)
        await press(rendered, "enter")
        expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "t-1" as TicketId })])
        await press(rendered, "2", "enter")
        expect(taken(commands)).toEqual([
          answerOf("q1", { _tag: "Choose", answers: ["Write a new"] }),
        ])
        // 3 is no option of the question's, and no number opens a worker: it does nothing.
        await press(rendered, "3")
        expect(taken(commands)).toEqual([])
      },
      { workers: 3 },
    )
  })

  test("an elicitation: d declines; Open URL accepts", async () => {
    await scene(
      [elicitation("e1", "t-1" as TicketId, { mode: "url" })],
      async ({ commands, clock, rendered }) => {
        clock.pass(settle)
        await press(rendered, "d", "tab", "enter")
        expect(taken(commands)).toEqual([
          answerOf("e1", { _tag: "Decline" }),
          answerOf("e1", { _tag: "Accept" }),
        ])
      },
    )
  })
})

describe("defaultToNo", () => {
  const held = permission("r1", "t-1" as TicketId, {
    defaultToNo: true,
    suppressAlwaysAllowRule: true,
    decisionReason: "held by the safety check",
    suggestions: [runRule],
  })

  test("opens with Deny focused, no a in the hint, no Allow for this run", async () => {
    await scene([held], async ({ rendered }) => {
      const frame = await rendered.capture()
      const lines = linesOf(frame)
      expect(lines.some((line) => line.includes("[ Deny ]  [ Allow ]"))).toBe(true)
      expect(lines.some((line) => line.includes("Allow for this run"))).toBe(false)
      const hint = lines.find((line) => line.includes("? keys")) ?? ""
      expect(hint).toContain("d deny")
      expect(hint).not.toContain("a allow")
      const deny = where(frame, "[ Deny ]")
      const span = frame.spans.lines[deny.y]?.spans.find((s) => s.text.includes("[ Deny ]"))
      expect(span?.bg.toInts()).toEqual(theme.form.focusedButton.bg?.toInts())
    })
    expect(defaultFocus(held)).toBe(0)
    expect(keyAnswer(held, "a")).toBeNull()
  })

  test("has no one-key allow: a does nothing; → then Enter, or a click, allows", async () => {
    await scene([held], async ({ commands, clock, rendered }) => {
      clock.pass(settle)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([])
      await press(rendered, "right", "enter")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Allow" })])
      const allow = where(await rendered.capture(), "[ Allow ]")
      await rendered.input((setup) => setup.mockMouse.click(allow.x + 2, allow.y))
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Allow" })])
    })
  })

  test("r doesn't allow it for this run either, though it offers the button", async () => {
    const asked = permission("r1", "t-1" as TicketId, { defaultToNo: true, suggestions: [runRule] })
    expect(keyAnswer(asked, "r")).toBeNull()
    expect(buttonsOf(asked).map((b) => b.label)).toEqual(["Deny", "Allow", "Allow for this run"])
    await scene([asked], async ({ commands, clock, rendered }) => {
      clock.pass(settle)
      await press(rendered, "r", "a")
      expect(taken(commands)).toEqual([])
      await press(rendered, "right", "right", "enter")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "AllowForRun" })])
    })
  })

  test("Allow is never the focused default, whatever the request", () => {
    for (const request of [
      permission("r", "t" as TicketId),
      held,
      permission("r", "t" as TicketId, { suggestions: [runRule] }),
      asked("q", "t" as TicketId),
      elicitation("e", "t" as TicketId, { mode: "url" }),
    ]) {
      const focus = defaultFocus(request)
      const label = focus === null ? null : (buttonsOf(request)[focus]?.label ?? null)
      expect(label === null || ["Deny", "Decline", "Answer in view"].includes(label)).toBe(true)
    }
  })
})

describe("the 500 ms guard", () => {
  test("input to a card is ignored for 500 ms after its request appears", async () => {
    await scene([permission("r1", "t-1" as TicketId)], async ({ commands, clock, rendered }) => {
      await press(rendered, "a", "d", "enter", "D")
      clock.pass(settle - 1)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([])
      expect(linesOf(await rendered.capture()).some((line) => line.includes("saying why"))).toBe(
        false,
      )
      clock.pass(1)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Allow" })])
    })
  })

  test("and again after it changes: the next request is guarded anew", async () => {
    const first = permission("r1", "t-1" as TicketId)
    const next = permission("r2", "t-1" as TicketId)
    await scene([first, next], async ({ view, commands, clock, rendered }) => {
      clock.pass(settle)
      await press(rendered, "a")
      await rendered.input(() => view.set(viewOf([next])))
      await press(rendered, "a")
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Allow" })])
      clock.pass(settle)
      await press(rendered, "a")
      expect(taken(commands)).toEqual([answerOf("r2", { _tag: "Allow" })])
    })
  })

  test("a click on a button too", async () => {
    await scene([permission("r1", "t-1" as TicketId)], async ({ commands, clock, rendered }) => {
      const deny = where(await rendered.capture(), "[ Deny ]")
      await rendered.input((setup) => setup.mockMouse.click(deny.x + 2, deny.y))
      expect(taken(commands)).toEqual([])
      clock.pass(settle)
      await rendered.input((setup) => setup.mockMouse.click(deny.x + 2, deny.y))
      expect(taken(commands)).toEqual([answerOf("r1", { _tag: "Deny" })])
    })
  })
})

describe("several requests", () => {
  test("in order, the oldest shown with +N more, each answered as it is shown", async () => {
    const requests = [
      permission("r1", "t-1" as TicketId),
      permission("r2", "t-1" as TicketId),
      permission("r3", "t-1" as TicketId),
    ]
    await scene(requests, async ({ view, commands, clock, rendered }) => {
      for (let i = 0; i < requests.length; i++) {
        const left = requests.slice(i)
        await rendered.input(() => view.set(viewOf(left)))
        const lines = linesOf(await rendered.capture())
        const more = left.length - 1
        expect(lines.some((line) => line.includes(`+${more} more`))).toBe(more > 0)
        clock.pass(settle)
        await press(rendered, "d")
      }
      expect(taken(commands)).toEqual(requests.map((r) => answerOf(r.id, { _tag: "Deny" })))
    })
  })

  test("Tab moves through every card's buttons, then on to the next card", async () => {
    const requests = [permission("r1", "t-1" as TicketId), permission("r2", "t-2" as TicketId)]
    await scene(requests, async ({ commands, clock, rendered }) => {
      clock.pass(settle)
      // Card 1's Deny (the target), its Allow, then card 2 on its Deny; Shift+Tab back to card 1,
      // which a card is entered on its Deny, and → to its Allow. Each card, as it becomes the
      // target, is guarded again (tutti-14o5).
      await press(rendered, "tab", "tab")
      clock.pass(settle)
      await press(rendered, "enter")
      await press(rendered, "shift+tab", "right")
      clock.pass(settle)
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([
        answerOf("r2", { _tag: "Deny" }),
        answerOf("r1", { _tag: "Allow" }),
      ])
    })
    expect(stepFocus(2, 0, 1, 0)).toBe(1)
    expect(stepFocus(2, 1, 1, 0)).toBe("leave")
    expect(stepFocus(2, 0, -1, 0)).toBe("leave")
    expect(stepFocus(2, null, 1, null)).toBe(0)
    expect(stepFocus(2, 0, -1, null)).toBeNull()
    expect(stepFocus(2, null, -1, null)).toBe("leave")
  })
})

describe("the answer names the request shown", () => {
  test("a key pressed as the request changes answers the one drawn, and a stale one toasts", async () => {
    const first = permission("r1", "t-1" as TicketId)
    const next = permission("r2", "t-1" as TicketId)
    await scene([first, next], async ({ view, commands, clock, rendered }) => {
      clock.pass(settle)
      // r1 is answered elsewhere and r2 shown in its place; the key, pressed before the screen
      // draws r2, names r1, which is no longer open: dropped, with a toast.
      await rendered.input(async (setup) => {
        view.set(viewOf([next]))
        await setup.mockInput.typeText("d")
      })
      expect(taken(commands)).toEqual([])
      const lines = linesOf(await rendered.capture())
      expect(lines.some((line) => line.includes("t-1's request is no longer open"))).toBe(true)
    })
  })

  test("a click names the request of the card clicked", async () => {
    const requests = [permission("r1", "t-1" as TicketId), permission("r2", "t-2" as TicketId)]
    await scene(requests, async ({ commands, clock, rendered }) => {
      clock.pass(settle)
      const frame = await rendered.capture()
      const lines = linesOf(frame)
      const second = lines.findIndex((line) => line.includes("• t-2"))
      const deny = lines.findIndex((line, i) => i > second && line.includes("[ Deny ]"))
      const x = (lines[deny] ?? "").indexOf("[ Allow ]")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, deny))
      expect(taken(commands)).toEqual([answerOf("r2", { _tag: "Allow" })])
      // A click elsewhere on the card opens its worker.
      await rendered.input((setup) => setup.mockMouse.click(40, second))
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "t-2" as TicketId })])
    })
  })
})
