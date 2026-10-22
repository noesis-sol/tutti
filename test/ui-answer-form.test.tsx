// The answer form (§ 4.5, § 7.3): Answer in view in the worker view's panel opens it for what a card
// can't hold. A question request's questions, each picked one or several, or your own text; an
// elicitation's fields from its requestedSchema; the Choose or Accept they send, the field still
// missing a value, and the keys and clicks that drive it.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import fc from "fast-check"
import { type AttentionRequest, fits, type Question } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import {
  answerOf,
  type Form,
  formOf,
  initialValues,
  pick,
  rowsOf,
  typeIn,
  type Value,
} from "../src/ui/answerForm.ts"
import { settle } from "../src/ui/attentionKeys.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type TranscriptFeed,
  type TranscriptState,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const questions: ReadonlyArray<Question> = [
  {
    question: "Which storage?",
    header: "Storage",
    options: [
      { label: "SQLite", description: "one file" },
      { label: "Postgres" },
      { label: "Dolt" },
    ],
    multiSelect: false,
  },
  {
    question: "Which checks?",
    options: [{ label: "tsc" }, { label: "biome" }, { label: "tests" }],
    multiSelect: true,
  },
]

const asked = (qs: ReadonlyArray<Question> = questions): AttentionRequest => ({
  id: "q1",
  ticket: "t-1",
  kind: { _tag: "Question", questions: qs, input: { questions: qs } },
  displayName: "AskUserQuestion",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const elicited = (requestedSchema: Readonly<Record<string, unknown>>): AttentionRequest => ({
  id: "e1",
  ticket: "t-1",
  kind: {
    _tag: "Elicitation",
    server: "tracker",
    message: "Sign in",
    mode: "form",
    requestedSchema,
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const schema = {
  type: "object",
  properties: {
    user: { type: "string", title: "User name", minLength: 2 },
    port: { type: "integer", minimum: 1, maximum: 65535, default: 443 },
    remember: { type: "boolean", title: "Remember me" },
    region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "America"] },
    scopes: {
      type: "array",
      items: {
        anyOf: [
          { const: "read", title: "Read" },
          { const: "write", title: "Write" },
        ],
      },
    },
  },
  required: ["user", "region"],
}

const formFor = (request: AttentionRequest): Form => {
  const form = formOf(request)
  if (form === undefined) throw new Error("no form")
  return form
}

/** `values` with `change` made to field `field`'s. */
const at = (
  values: ReadonlyArray<Value>,
  field: number,
  change: (value: Value) => Value,
): ReadonlyArray<Value> => values.map((value, i) => (i === field ? change(value) : value))

describe("the form's model", () => {
  test("a question's fields: its options and Other, one or several picked", () => {
    const form = formFor(asked())
    expect(
      form.fields.map((field) => field._tag === "Choice" && [field.multi, field.other]),
    ).toEqual([
      [false, true],
      [true, true],
    ])
    expect(rowsOf(form)).toHaveLength(8)
  })

  test("a question's answers: a label, your own text, several joined by commas", () => {
    const form = formFor(asked())
    const [one, two] = form.fields
    if (one === undefined || two === undefined) throw new Error("two fields")
    let values = initialValues(asked(), form)
    expect(answerOf(form, values)).toEqual({
      _tag: "Missing",
      field: 0,
      message: "Choose an answer to Which storage?",
    })
    values = at(values, 0, (v) => pick(one, pick(one, v, 0), 1))
    values = at(values, 1, (v) => pick(two, pick(two, pick(two, v, 2), 0), 2))
    values = at(values, 1, (v) => typeIn(two, v, "lint"))
    expect(answerOf(form, values)).toEqual({
      _tag: "Answer",
      answer: { _tag: "Choose", answers: ["Postgres", "tsc, lint"] },
    })
    values = at(values, 0, (v) => typeIn(one, v, "Redis"))
    expect(answerOf(form, values)).toMatchObject({ answer: { answers: ["Redis", "tsc, lint"] } })
    // Emptying your own text unpicks Other.
    values = at(values, 0, (v) => typeIn(one, v, " "))
    expect(answerOf(form, values)).toMatchObject({ _tag: "Missing", field: 0 })
  })

  test("an elicitation's fields from its schema, with their defaults", () => {
    const request = elicited(schema)
    const form = formFor(request)
    expect(
      form.fields.map((field) => [
        field._tag,
        field.title,
        field._tag === "Choice" ? field.options.map((o) => o.label) : null,
      ]),
    ).toEqual([
      ["Text", "User name", null],
      ["Text", "port", null],
      ["Toggle", "Remember me", null],
      ["Choice", "region", ["Europe", "America"]],
      ["Choice", "scopes", ["Read", "Write"]],
    ])
    expect(initialValues(request, form)[1]?.text).toBe("443")
  })

  test("an elicitation's content: the fields given, numbers as numbers, the schema's values", () => {
    const request = elicited(schema)
    const form = formFor(request)
    const [user, port, remember, region, scopes] = form.fields
    if (!user || !port || !remember || !region || !scopes) throw new Error("five fields")
    let values = initialValues(request, form)
    expect(answerOf(form, values)).toEqual({
      _tag: "Missing",
      field: 0,
      message: "Fill in User name",
    })
    values = at(values, 0, (v) => typeIn(user, v, "m"))
    expect(answerOf(form, values)).toMatchObject({
      message: "User name needs a length of at least 2",
    })
    values = at(values, 0, (v) => typeIn(user, v, "michael"))
    expect(answerOf(form, values)).toMatchObject({ message: "Choose an answer to region" })
    values = at(values, 3, (v) => pick(region, v, 1))
    values = at(values, 1, (v) => typeIn(port, v, "80.5"))
    expect(answerOf(form, values)).toMatchObject({ message: "port needs a whole number" })
    values = at(values, 1, (v) => typeIn(port, v, "70000"))
    expect(answerOf(form, values)).toMatchObject({
      message: "port needs a number from 1 to 65535",
    })
    values = at(values, 1, (v) => typeIn(port, v, "8080"))
    values = at(values, 2, (v) => pick(remember, v, 0))
    values = at(values, 4, (v) => pick(scopes, pick(scopes, v, 1), 0))
    expect(answerOf(form, values)).toEqual({
      _tag: "Answer",
      answer: {
        _tag: "Accept",
        content: {
          user: "michael",
          port: 8080,
          remember: true,
          region: "us",
          scopes: ["read", "write"],
        },
      },
    })
  })

  test("any schema makes a form whose answer fits the request, its text sanitised", () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.array(fc.nat(6)),
        fc.string(),
        (requestedSchema, properties, picks, typed) => {
          const request = elicited({
            ...(typeof requestedSchema === "object" && requestedSchema !== null
              ? (requestedSchema as Record<string, unknown>)
              : {}),
            properties,
            required: Object.keys(properties),
          })
          const form = formFor(request)
          let values = initialValues(request, form)
          for (const [i, field] of form.fields.entries()) {
            values = at(values, i, (v) =>
              typeIn(
                field,
                picks.reduce((w, p) => pick(field, w, p), v),
                typed,
              ),
            )
          }
          for (const field of form.fields) {
            const shown = [
              field.title,
              ...(field._tag === "Choice" ? field.options.map((o) => o.label) : []),
            ]
            for (const text of shown) expect(sanitizeLine(text)).toBe(text)
          }
          const outcome = answerOf(form, values)
          if (outcome._tag === "Answer") expect(fits(request, outcome.answer)).toBe(true)
        },
      ),
    )
  })

  test("any picks on any questions answer each question once, or name one missing", () => {
    const arbitraryQuestion = fc.record({
      question: fc.string(),
      options: fc.array(fc.record({ label: fc.string() }), { minLength: 1, maxLength: 4 }),
      multiSelect: fc.boolean(),
    })
    fc.assert(
      fc.property(
        fc.array(arbitraryQuestion, { minLength: 1, maxLength: 4 }),
        fc.array(fc.nat(5)),
        fc.string(),
        (qs, picks, typed) => {
          const request = asked(qs)
          const form = formFor(request)
          let values = initialValues(request, form)
          for (const [i, field] of form.fields.entries()) {
            values = at(values, i, (v) =>
              typeIn(
                field,
                picks.reduce((w, p) => pick(field, w, p), v),
                typed,
              ),
            )
          }
          const outcome = answerOf(form, values)
          if (outcome._tag === "Answer") expect(fits(request, outcome.answer)).toBe(true)
          else expect(outcome.field).toBeLessThan(qs.length)
        },
      ),
    )
  })
})

// The worker view, as ui-worker-view.test.tsx draws it, with one request open.

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const ledgerEntry = (ticket: string, worker: number): LedgerEntry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: TicketPhase.Working({ activity: "working" }),
  since: began,
  worker,
  row: worker - 1,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const viewOf = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  project({
    ledger: {
      tickets: new Map([["t-1", ledgerEntry("t-1", 1)]]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map([["t-1", WS.Idle({ at: began })]]),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

const feed: TranscriptFeed = {
  open: () => {
    const state = external<TranscriptState>(emptyTranscript)
    return { state, older: () => {}, scrolledBack: () => {}, follow: () => {}, close: () => {} }
  },
}

const clock = (() => {
  let now = began + 67_000
  return { now: () => now, pass: (millis: number) => (now += millis) }
})()

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      switch (key) {
        case "tab":
          setup.mockInput.pressTab()
          break
        case "enter":
          setup.mockInput.pressEnter()
          break
        case "escape":
          await pressEscape(setup)
          break
        case "up":
        case "down":
          setup.mockInput.pressArrow(key)
          break
        case "space":
          setup.mockInput.pressKey(" ")
          break
        default:
          await setup.mockInput.typeText(key)
      }
    }
  })

/** Captures frames until `ready` holds of one: what an input typed is drawn a frame later. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** Draws worker 1's view with `request` open, past the guard, and runs `body`. */
const scene = async (
  request: AttentionRequest,
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(viewOf([request]))
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view,
        screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: clock.now,
        transcripts: feed,
      }}
    />,
    { width: 80, height: 40 },
    async (rendered) => {
      clock.pass(settle)
      await body({ view, commands, rendered })
    },
  )
}

describe("the answer form in the worker view", () => {
  test("Answer in view opens it; the options picked and Answer send Choose", async () => {
    await scene(asked(), async ({ rendered, commands }) => {
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([])
      const frame = await rendered.capture()
      expect(frame.chars).toContain("t-1 asks")
      expect(frame.chars).toContain("Storage  Which storage?")
      expect(frame.chars).toContain("> ( ) SQLite — one file")
      expect(frame.chars).toContain("  [ ] tests")
      expect(frame.chars).toContain("[ Answer ]  [ Deny ]")
      // 2 picks Postgres; ↓ to the second question's options, Space, ↓↓ and Space.
      await press(rendered, "2", "down", "down", "down", "space", "down", "down", "space")
      const picked = await rendered.capture()
      expect(picked.chars).toContain("(•) Postgres")
      expect(picked.chars).toContain("[x] tsc")
      expect(picked.chars).toContain("[x] tests")
      await press(rendered, "tab", "tab", "enter")
      expect(taken(commands)).toEqual([
        UiCommand.Answer({
          requestId: "q1",
          answer: { _tag: "Choose", answers: ["Postgres", "tsc, tests"] },
        }),
      ])
      expect((await rendered.capture()).chars).not.toContain("t-1 asks")
    })
  })

  test("Other takes your own text; a question left unanswered is named, and nothing is sent", async () => {
    await scene(asked(), async ({ rendered, commands }) => {
      await press(rendered, "enter")
      // ↓↓↓ to the first question's Other, and type.
      await press(rendered, "down", "down", "down", "Redis")
      expect((await until(rendered, has("Other: Redis"))).chars).toContain("(•) Other: Redis")
      // Enter in the line goes on to the next row; Tab on to Answer.
      await press(rendered, "enter")
      for (let i = 0; i < 4; i++) await press(rendered, "tab")
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([])
      const missing = await rendered.capture()
      expect(missing.chars).toContain("Choose an answer to Which checks?")
      expect(missing.chars).toContain("> [ ] tsc")
      await press(rendered, "1", "tab", "tab", "tab", "tab", "enter")
      expect(taken(commands)).toEqual([
        UiCommand.Answer({
          requestId: "q1",
          answer: { _tag: "Choose", answers: ["Redis", "tsc"] },
        }),
      ])
    })
  })

  test("an elicitation's fields: typed, toggled and picked, then Accept with content", async () => {
    await scene(elicited(schema), async ({ rendered, commands }) => {
      // The panel's buttons are Decline and Answer in view: Tab to it.
      await press(rendered, "tab", "enter")
      const frame = await rendered.capture()
      expect(frame.chars).toContain("User name *")
      expect(frame.chars).toContain("[ ] Remember me")
      expect(frame.chars).toContain("[ Accept ]  [ Decline ]")
      expect(frame.chars).toContain("443")
      await press(rendered, "michael")
      await until(rendered, has("michael"))
      await press(rendered, "down", "down", "space", "down", "down", "space")
      await press(rendered, "tab", "tab", "tab", "enter")
      expect(taken(commands)).toEqual([
        UiCommand.Answer({
          requestId: "e1",
          answer: {
            _tag: "Accept",
            content: { user: "michael", port: 443, remember: true, region: "us" },
          },
        }),
      ])
    })
  })

  test("Decline declines; Esc closes the form without an answer", async () => {
    await scene(elicited(schema), async ({ rendered, commands }) => {
      await press(rendered, "tab", "enter")
      await press(rendered, "escape")
      expect((await rendered.capture()).chars).not.toContain("[ Accept ]")
      expect(taken(commands)).toEqual([])
      // Answer in view keeps the panel's focus.
      await press(rendered, "enter")
      const frame = await rendered.capture()
      const y = linesOf(frame).findIndex((line) => line.includes("[ Decline ]"))
      const x = (linesOf(frame)[y] ?? "").indexOf("[ Decline ]")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      expect(taken(commands)).toEqual([
        UiCommand.Answer({ requestId: "e1", answer: { _tag: "Decline" } }),
      ])
    })
  })

  test("a request withdrawn while its form is open closes it with a toast", async () => {
    await scene(asked(), async ({ rendered, view }) => {
      await press(rendered, "enter")
      expect((await rendered.capture()).chars).toContain("t-1 asks")
      await rendered.input(() => view.set(viewOf([])))
      // The toast is drawn over the foot of the view, a rule's `─` showing through its spaces there.
      const frame = await until(rendered, (shown) =>
        shown.chars.replaceAll("─", " ").includes("t-1's request is no longer open"),
      )
      expect(frame.chars).not.toContain("t-1 asks")
      expect(frame.chars.replaceAll("─", " ")).toContain("t-1's request is no longer open")
    })
  })
})
