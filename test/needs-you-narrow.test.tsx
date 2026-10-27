// What needs you on a pane too narrow for the panel beside the tickets table (§ 7.2, tutti-fdv1):
// an Asked row says its question's title, and Enter on it, or a click, opens the questions box at
// its question; the worker view of an Asked ticket has an Answer button doing the same; Enter on
// the totals' Needs you, or a click on it, opens a list of what needs you, then, faint, the open
// questions no ticket in the run waits on, each opened from it, coming back to it with the next one
// chosen; an empty list closes with a toast.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { answerButton } from "../src/ui/Composer.tsx"
import { dashboardLayout } from "../src/ui/Dashboard.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { listReadingText, nothingNeedsYou } from "../src/ui/NeedsList.tsx"
import { noneOpenText } from "../src/ui/QuestionsBox.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 27, 13, 0, 0).getTime()

const entry = (ticket: string, title: string, phase: TicketPhase, row: number): LedgerEntry => ({
  ticket: ticket as TicketId,
  title,
  phase,
  since: began,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const flag: OpenQuestion = {
  id: "q-1" as TicketId,
  title: "Which flag name?",
  description: "The flag needs a name.",
  options: [
    { label: "--long-flag", description: "says what it does" },
    { label: "--flag", description: "short to type" },
  ],
  maintainerOnly: false,
  waiting: ["t-1" as TicketId],
}

/** An open question in the run's scope that no ticket in the run waits on. */
const licence: OpenQuestion = {
  id: "q-3" as TicketId,
  title: "Which licence?",
  description: "",
  options: [{ label: "MIT", description: "the usual" }],
  maintainerOnly: false,
  waiting: [],
}

const asked = entry("t-1", "Add the flag", TicketPhase.Asked({ question: "q-1" }), 0)
const blocked = entry("t-2", "Merge the parser", TicketPhase.Blocked({ why: "MERGE_CONFLICT" }), 1)

/** RunView with `entries`, the look having read q-1 where `read`. */
const viewOf = (entries: ReadonlyArray<LedgerEntry>, read = true): RunView =>
  project({
    ledger: {
      tickets: new Map(entries.map((each) => [each.ticket, each])),
      rows: entries.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch",
      began,
      concurrency: 1,
      questions: new Map(read ? [["q-1", flag]] : []),
    },
    actions: new Map(),
  })

/** The commands sent since the last call. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** Captures frames until `ready` holds of one. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

/** The first ReadQuestions' uuid among `commands`, waiting for the box to offer one. */
const readUuid = async (rendered: Rendered, commands: Commands): Promise<string> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const read = taken(commands).find((command) => command._tag === "ReadQuestions")
    if (read?._tag === "ReadQuestions") return read.uuid
    if (Date.now() > deadline) return ""
    await rendered.capture()
    await Bun.sleep(20)
  }
}

/** The line and column of `text` in `frame`, to click on it. */
const placeOf = (frame: Frame, text: string): { readonly x: number; readonly y: number } => {
  const lines = frame.chars.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  return { x: lines[y]?.indexOf(text) ?? -1, y }
}

const scene = async (
  view: RunView,
  screen: Screen,
  body: (at: {
    readonly view: Settable<RunView>
    readonly news: Settable<ReadonlyArray<QuestionNews>>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
  width = 100,
) => {
  const views = external(view)
  const news = external<ReadonlyArray<QuestionNews>>([])
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: views,
        screen: external<Screen>(screen),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
        questions: news,
      }}
    />,
    { width, height: 30 },
    (rendered) => body({ view: views, news, commands, rendered }),
  )
}

const press = (rendered: Rendered, ...keys: ReadonlyArray<"tab" | "enter" | "escape" | "down">) =>
  rendered.input((setup) => {
    for (const key of keys) {
      if (key === "tab") setup.mockInput.pressTab()
      else if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "escape") pressEscape(setup)
      else setup.mockInput.pressArrow("down")
    }
  })

/** Whether the segment holding `text` among `lines` is drawn in the focus's look. */
const focused = (lines: ReadonlyArray<Segments>, text: string): boolean =>
  lines.flat().some((each) => each.text.includes(text) && each.look === theme.form.focusedButton)

describe("an Asked row", () => {
  test("says its question's title once the look has read it, its ticket's until then", () => {
    const row = (view: RunView) => view.rows.find((each) => each.ticket === "t-1")
    expect(row(viewOf([asked]))?.note).toBe("Which flag name?")
    expect(row(viewOf([asked]))?.title).toBe("Add the flag")
    expect(row(viewOf([asked], false))?.note).toBe("Add the flag")
  })

  test("is drawn in the focus's look while the highlight is on it, as Needs you is", () => {
    const view = viewOf([asked, blocked])
    const side = { needs: view.needs, at: { index: 0, focused: false, choice: 0 } }
    const onRow = dashboardLayout(view, theme, 100, 30, null, side, { row: "t-1" as TicketId })
    expect(focused(onRow.tickets, "Which flag name?")).toBe(true)
    expect(focused(onRow.totals, "Needs you")).toBe(false)
    const onNeeds = dashboardLayout(view, theme, 100, 30, null, side, "needs")
    expect(focused(onNeeds.totals, "Needs you")).toBe(true)
    expect(focused(onNeeds.tickets, "Which flag name?")).toBe(false)
  })

  test("Enter on it opens the questions box at its question", async () => {
    await scene(
      viewOf([asked, blocked]),
      Screen.Dashboard(),
      async ({ news, commands, rendered }) => {
        const table = await until(rendered, has("Which flag name?"))
        expect(table.chars).toContain("? for you")
        // Tab reaches Needs you first, then the Asked row.
        await press(rendered, "tab", "tab", "enter")
        const uuid = await readUuid(rendered, commands)
        await rendered.input(() =>
          news.set([QuestionNews.Read({ uuid, questions: [licence, flag] })]),
        )
        const box = await until(rendered, has("Open question 2 of 2 · q-1"))
        expect(box.chars).toContain("Open question 2 of 2 · q-1")
      },
    )
  })

  test("a click on it opens the questions box at its question", async () => {
    await scene(
      viewOf([asked, blocked]),
      Screen.Dashboard(),
      async ({ news, commands, rendered }) => {
        const table = await until(rendered, has("Which flag name?"))
        const { x, y } = placeOf(table, "Which flag name?")
        await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
        const uuid = await readUuid(rendered, commands)
        expect(uuid).not.toBe("")
        await rendered.input(() =>
          news.set([QuestionNews.Read({ uuid, questions: [licence, flag] })]),
        )
        const box = await until(rendered, has("Open question 2 of 2 · q-1"))
        expect(box.chars).toContain("Open question 2 of 2 · q-1")
      },
    )
  })
})

describe("the worker view of an Asked ticket", () => {
  const working = entry("t-1", "Add the flag", TicketPhase.Working(), 0)
  const atWork = (): RunView =>
    project({
      ledger: {
        tickets: new Map([["t-1" as TicketId, { ...working, worker: 1 }]]),
        rows: 1,
        windDown: null,
        bugs: [],
      },
      workers: new Map([["t-1", WS.Working({ doing: "working" })]]),
      requests: [],
      status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
      actions: new Map(),
    })

  test("has an Answer button, and A, opening the questions box at its question", async () => {
    await scene(
      atWork(),
      Screen.Worker({ ticket: "t-1" as TicketId }),
      async ({ view, news, commands, rendered }) => {
        const before = await until(rendered, has("t-1"))
        expect(before.chars).not.toContain(answerButton)
        // Its worker files a question and ends: the ticket waits on it.
        await rendered.input(() => view.set(viewOf([asked])))
        const after = await until(rendered, has(answerButton))
        const { x, y } = placeOf(after, answerButton)
        await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
        const uuid = await readUuid(rendered, commands)
        await rendered.input(() =>
          news.set([QuestionNews.Read({ uuid, questions: [licence, flag] })]),
        )
        const box = await until(rendered, has("Open question 2 of 2 · q-1"))
        expect(box.chars).toContain("Open question 2 of 2 · q-1")

        // Esc closes it; A opens it again.
        await press(rendered, "escape")
        await until(rendered, (frame) => !frame.chars.includes("Open question"))
        await rendered.input((setup) => setup.mockInput.pressKey("A", { shift: true }))
        const again = await readUuid(rendered, commands)
        expect(again).not.toBe("")
      },
    )
  })
})

describe("the Needs you list, without the panel", () => {
  test("lists the questions, the Blocked tickets, then faint the questions none waits on", async () => {
    await scene(
      viewOf([asked, blocked]),
      Screen.Dashboard(),
      async ({ news, commands, rendered }) => {
        await until(rendered, has("Which flag name?"))
        await press(rendered, "tab", "enter")
        const reading = await until(rendered, has(listReadingText))
        expect(reading.chars).toContain("? q-1 Which flag name?")
        const uuid = await readUuid(rendered, commands)
        await rendered.input(() =>
          news.set([QuestionNews.Read({ uuid, questions: [flag, licence] })]),
        )
        const list = await until(rendered, has("? q-3 Which licence?"))
        const at = (text: string) => list.chars.indexOf(text)
        expect(at("> ? q-1 Which flag name?")).toBeGreaterThan(-1)
        expect(at("■ t-2 blocked: MERGE_CONFLICT")).toBeGreaterThan(at("? q-1 Which flag name?"))
        expect(at("? q-3 Which licence?")).toBeGreaterThan(at("■ t-2 blocked: MERGE_CONFLICT"))
        // q-1 is listed once, as t-1's.
        expect(list.chars.split("Which flag name?").length).toBe(3)
        expect(list.chars).not.toContain(listReadingText)
      },
    )
  })

  test("a click on Needs you opens it; an answer comes back to it, the next chosen", async () => {
    await scene(
      viewOf([asked, blocked]),
      Screen.Dashboard(),
      async ({ news, commands, rendered }) => {
        const dashboard = await until(rendered, has("Needs you"))
        const { x, y } = placeOf(dashboard, "Needs you")
        await rendered.input((setup) => setup.mockMouse.click(x + 1, y))
        const listUuid = await readUuid(rendered, commands)
        await rendered.input(() =>
          news.set([QuestionNews.Read({ uuid: listUuid, questions: [flag, licence] })]),
        )
        await until(rendered, has("? q-3 Which licence?"))

        // Enter on q-1: the questions box at it alone; Enter answers with the recommended option.
        await press(rendered, "enter")
        const boxUuid = await readUuid(rendered, commands)
        await rendered.input(() =>
          news.set([
            ...news.get(),
            QuestionNews.Read({ uuid: boxUuid, questions: [flag, licence] }),
          ]),
        )
        const box = await until(rendered, has("Open question 1 of 1 · q-1"))
        expect(box.chars).toContain("Open question 1 of 1 · q-1")
        await press(rendered, "enter")
        // The answer, and the list opened again, reading the questions.
        const sent = taken(commands)
        const answers = sent.filter((command) => command._tag === "AnswerQuestion")
        expect(answers).toMatchObject([{ question: "q-1", answer: "--long-flag" }])
        const reread = sent.find((command) => command._tag === "ReadQuestions")
        const back = reread?._tag === "ReadQuestions" ? reread.uuid : ""
        expect(back).not.toBe("")

        // Back in the list, q-1 gone and the Blocked ticket chosen.
        await rendered.input(() =>
          news.set([...news.get(), QuestionNews.Read({ uuid: back, questions: [flag, licence] })]),
        )
        const list = await until(rendered, has("> ■ t-2 blocked: MERGE_CONFLICT"))
        expect(list.chars).toContain("> ■ t-2 blocked: MERGE_CONFLICT")
        expect(list.chars).not.toContain("? q-1")

        // Enter on it: what clears it; Esc back to the list, the next one chosen.
        await press(rendered, "enter")
        const clears = await until(rendered, has("Its rebase onto main conflicts"))
        expect(clears.chars).toContain("Merge the parser")
        await press(rendered, "escape")
        const next = await until(rendered, has("> ? q-3 Which licence?"))
        expect(next.chars).toContain("> ? q-3 Which licence?")

        await press(rendered, "escape")
        const closed = await until(rendered, (frame) => !frame.chars.includes("q-3"))
        expect(closed.chars).not.toContain("q-3")
      },
    )
  })

  test("with nothing in it, it closes with a toast", async () => {
    await scene(viewOf([]), Screen.Dashboard(), async ({ news, commands, rendered }) => {
      await until(rendered, has("Needs you"))
      await press(rendered, "tab", "enter")
      const uuid = await readUuid(rendered, commands)
      await rendered.input(() => news.set([QuestionNews.Read({ uuid, questions: [] })]))
      const toast = await until(rendered, has(nothingNeedsYou))
      expect(toast.chars).toContain(nothingNeedsYou)
      expect(toast.chars).not.toContain(noneOpenText)
      expect(toast.chars).not.toContain(listReadingText)
    })
  })

  test("a click on an item not chosen, then Esc, comes back at the one after it", async () => {
    const lexer = entry("t-3", "Fix the lexer", TicketPhase.Blocked({ why: "DIRTY_TREE" }), 2)
    await scene(
      viewOf([asked, blocked, lexer]),
      Screen.Dashboard(),
      async ({ news, commands, rendered }) => {
        await until(rendered, has("Which flag name?"))
        await press(rendered, "tab", "enter")
        const uuid = await readUuid(rendered, commands)
        await rendered.input(() =>
          news.set([QuestionNews.Read({ uuid, questions: [flag, licence] })]),
        )
        const list = await until(rendered, has("? q-3 Which licence?"))
        expect(list.chars).toContain("> ? q-1 Which flag name?")

        // A click on t-3, below the one chosen: what clears it; Esc, the one after it.
        const { x, y } = placeOf(list, "t-3 blocked: DIRTY_TREE")
        await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
        await until(rendered, has("main's checkout has changes"))
        await press(rendered, "escape")
        const next = await until(rendered, has("> ? q-3 Which licence?"))
        expect(next.chars).toContain("> ? q-3 Which licence?")

        // Esc from a question opened from the list comes back at the one after it too.
        await press(rendered, "down")
        const first = await until(rendered, has("> ? q-1 Which flag name?"))
        expect(first.chars).toContain("> ? q-1 Which flag name?")
        await press(rendered, "enter")
        const boxUuid = await readUuid(rendered, commands)
        await rendered.input(() =>
          news.set([
            ...news.get(),
            QuestionNews.Read({ uuid: boxUuid, questions: [flag, licence] }),
          ]),
        )
        await until(rendered, has("Open question 1 of 1 · q-1"))
        await press(rendered, "escape")
        const backUuid = await readUuid(rendered, commands)
        await rendered.input(() =>
          news.set([
            ...news.get(),
            QuestionNews.Read({ uuid: backUuid, questions: [flag, licence] }),
          ]),
        )
        const after = await until(rendered, has("> ■ t-2 blocked: MERGE_CONFLICT"))
        expect(after.chars).toContain("> ■ t-2 blocked: MERGE_CONFLICT")
        expect(after.chars).toContain("? q-1 Which flag name?")
        expect(taken(commands).some((command) => command._tag === "AnswerQuestion")).toBe(false)
      },
    )
  })

  test("isn't reached where the panel shows what needs you", async () => {
    await scene(
      viewOf([asked, blocked]),
      Screen.Dashboard(),
      async ({ commands, rendered }) => {
        await until(rendered, has("Needs you · 1 of 2"))
        const frame = await rendered.capture()
        const { x, y } = placeOf(frame, "2 Needs you")
        await rendered.input((setup) => setup.mockMouse.click(x + 1, y))
        await rendered.capture()
        expect(taken(commands).some((command) => command._tag === "ReadQuestions")).toBe(false)
      },
      155,
    )
  })
})
