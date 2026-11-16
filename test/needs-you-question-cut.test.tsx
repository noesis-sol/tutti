// A Needs you panel too short to show a question's options (§ 7.2, tutti-1zov): it shows none, a
// digit answers nothing, and Enter in the panel, or a click on its foot, opens the questions box at
// the question, where they all are; with room for them, digits and Enter answer as ever.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type Commands, makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { readingText } from "../src/ui/QuestionsBox.tsx"
import { needsLines, panelTargets, questionCut } from "../src/ui/SidePanel.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")
const began = new Date(2026, 10, 16, 9, 0, 0).getTime()

const question = {
  id: "q-1" as TicketId,
  title: "Which name should the flag that turns the side panel's question options off take?",
  description: "",
  options: [
    { label: "Use --flag", description: "" },
    { label: "Use --other", description: "" },
    { label: "Use --third", description: "" },
  ],
  maintainerOnly: false,
  waiting: ["a-1" as TicketId],
}

const asked: Entry = {
  ticket: "a-1" as TicketId,
  title: "Add the flag",
  phase: TicketPhase.Asked({ question: "q-1" }),
  since: began,
  worker: null,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
}

const view: RunView = project({
  ledger: { tickets: new Map([[asked.ticket, asked]]), rows: 1, windDown: null, bugs: [] },
  workers: new Map(),
  requests: [],
  status: {
    ...emptyStatus,
    version: "0.8.9",
    branch: "main",
    began,
    concurrency: 3,
    questions: new Map([["q-1", question]]),
  },
  actions: new Map(),
})

const need = () => {
  const first = view.needs[0]
  if (first?._tag !== "Question") throw new Error("no Question need")
  return first
}

const texts = (lines: ReadonlyArray<ReadonlyArray<{ readonly text: string }>>) =>
  lines.map((line) => line.map((segment) => segment.text).join("")).join("\n")

describe("the panel's lines", () => {
  const at = { focused: true, inside: true, choice: 0 }

  test("too short for the options: none of them, and the foot, to click, says Enter shows them", () => {
    // Three lines in its frame: the title's two and who waits on it leave none.
    expect(questionCut(need(), 55, 6)).toBe(true)
    const lines = needsLines(need(), 1, at, theme, 55, 6)
    const said = texts(lines)
    expect(said).not.toContain("Use --flag")
    expect(said).toContain("a-1 waits on it")
    expect(said).toContain("… no room for its options · Enter shows them")
    const foot = lines.flat().find((segment) => segment.text.includes("no room"))
    expect(foot?.target).toBe(panelTargets.read)
  })

  test("its foot by where the focus is", () => {
    const foot = (focused: boolean, inside: boolean) =>
      texts(needsLines(need(), 1, { focused, inside, choice: 0 }, theme, 55, 6))
    expect(foot(true, false)).toContain("no room for its options · Enter goes in")
    expect(foot(false, false)).toContain("no room for its options · click shows them")
  })

  test("with room for every option: they all show, to answer, as ever", () => {
    expect(questionCut(need(), 55, 20)).toBe(false)
    const said = texts(needsLines(need(), 1, at, theme, 55, 20))
    expect(said).toContain("3 Use --third")
    expect(said).toContain("Other…")
    expect(said).not.toContain("no room")
  })

  test("at every height, the options show whole or not at all", () => {
    for (let height = 4; height <= 20; height++) {
      const said = texts(needsLines(need(), 1, at, theme, 55, height))
      const cut = questionCut(need(), 55, height)
      expect(said.includes("Use --third")).toBe(!cut)
      expect(said.includes("Use --flag")).toBe(!cut)
    }
  })
})

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "right") setup.mockInput.pressArrow(key)
      else await setup.mockInput.typeText(key)
    }
  })

/** Draws the run's dashboard in a pane `height` lines tall, 140 wide. */
const dashboard = async (
  height: number,
  body: (rendered: Rendered, commands: Commands) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: external(view),
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 60_000,
      }}
    />,
    { width: 140, height },
    async (rendered) => {
      await rendered.capture()
      await Bun.sleep(settle + 50)
      await body(rendered, commands)
    },
  )
}

const answers = (commands: Commands) =>
  taken(commands).filter((each) => each._tag === "AnswerQuestion")

describe("the dashboard", () => {
  test("too short for the options: 1 answers nothing, and Enter in the panel opens the questions box", async () => {
    await dashboard(24, async (rendered, commands) => {
      const frame = await rendered.capture()
      expect(frame.chars).toContain("no room for its options")
      expect(frame.chars).not.toContain("Use --flag")
      await press(rendered, "1")
      expect(answers(commands)).toEqual([])
      await press(rendered, "right", "enter", "enter")
      expect(answers(commands)).toEqual([])
      expect((await rendered.capture()).chars).toContain(readingText)
    })
  })

  test("with room for the options: 1 answers, and so does Enter in the panel", async () => {
    await dashboard(40, async (rendered, commands) => {
      expect((await rendered.capture()).chars).toContain("Use --third")
      await press(rendered, "1")
      expect(answers(commands)).toMatchObject([{ question: "q-1", answer: "Use --flag" }])
    })
    await dashboard(40, async (rendered, commands) => {
      await press(rendered, "right", "enter", "enter")
      expect(answers(commands)).toMatchObject([{ question: "q-1", answer: "Use --flag" }])
      expect((await rendered.capture()).chars).not.toContain(readingText)
    })
  })
})
