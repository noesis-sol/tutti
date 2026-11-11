// A question answered outside the dashboard (tutti answer, bd by hand) before the run's look has
// taken its ticket back (tutti-fnvd.9, § 7.2): the Needs you list, which reads the open questions
// as it opens, leaves it out once the read doesn't have it, though the run still has its ticket
// asking it; the questions box opened on it from a list read earlier says it is already answered,
// and the list opens again without it. A need come in since the list opened stays, the read before
// it saying nothing of it.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { orchestra } from "../src/project/scheme.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, Need, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { closedSince, listReadingText } from "../src/ui/NeedsList.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 8, 8, 0, 0).getTime()

const question = (id: string, title: string, waiting: string): OpenQuestion => ({
  id: id as TicketId,
  title,
  description: "",
  options: [{ label: "Yes", description: "" }],
  maintainerOnly: false,
  waiting: [waiting as TicketId],
})

const flag = question("q-1", "Which flag name?", "a-1")
const licence = question("q-2", "Which licence?", "a-2")
const colour = question("q-3", "Which colour?", "a-3")

const asked = (ticket: string, title: string, on: string, row: number): Entry => ({
  ticket: ticket as TicketId,
  title,
  phase: TicketPhase.Asked({ question: on }),
  since: began,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const viewOf = (entries: ReadonlyArray<Entry>, questions: ReadonlyArray<OpenQuestion>): RunView =>
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
      questions: new Map(questions.map((each) => [each.id, each])),
    },
    actions: new Map(),
  })

const two = [asked("a-1", "Add the flag", "q-1", 0), asked("a-2", "Add a licence", "q-2", 1)]
const view = viewOf(two, [flag, licence])

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

interface At {
  readonly view: Settable<RunView>
  readonly news: Settable<ReadonlyArray<QuestionNews>>
  readonly commands: Commands
  readonly rendered: Rendered
}

/** Waits for the box or the list to offer ReadQuestions, and has the run read `questions` open. */
const reads = async (at: At, questions: ReadonlyArray<OpenQuestion>): Promise<void> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(at.commands))
    const read = offered.find((each) => each._tag === "ReadQuestions")
    if (read?._tag === "ReadQuestions") {
      await at.rendered.input(() =>
        at.news.set([...at.news.get(), QuestionNews.Read({ uuid: read.uuid, questions })]),
      )
      return
    }
    if (Date.now() > deadline) throw new Error("nothing read the questions")
    await at.rendered.capture()
    await Bun.sleep(20)
  }
}

const enter = (rendered: Rendered) => rendered.input((setup) => setup.mockInput.pressEnter())

/** Opens the list, on a dashboard too narrow for the panel, and has the run read `questions`. */
const openList = async (at: At, questions: ReadonlyArray<OpenQuestion>): Promise<Frame> => {
  await until(at.rendered, has("Which flag name?"))
  await at.rendered.input((setup) => setup.mockInput.pressTab())
  await enter(at.rendered)
  await reads(at, questions)
  return until(at.rendered, (frame) => !frame.chars.includes(listReadingText))
}

const scene = async (body: (at: At) => Promise<void>) => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const shown = external(view)
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: shown,
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 60_000,
        questions: news,
      }}
    />,
    { width: 100, height: 30 },
    (rendered) => body({ view: shown, news, commands, rendered }),
  )
}

describe("a question answered outside the dashboard, its ticket still asking it", () => {
  test("is left out of the Needs you list whose read doesn't have it open", async () => {
    await scene(async (at) => {
      const list = await openList(at, [licence])
      expect(list.chars).not.toContain("? q-1")
      expect(list.chars).toContain("> ? q-2 Which licence?")
    })
  })

  test("opened from a list read earlier, the box says it is already answered", async () => {
    await scene(async (at) => {
      const list = await openList(at, [flag, licence])
      expect(list.chars).toContain("> ? q-1")
      await enter(at.rendered)
      await reads(at, [licence])
      // Back at the list, which reads it gone too.
      await reads(at, [licence])
      const back = await until(at.rendered, has("q-1 is already answered"))
      expect(back.chars).toContain("q-1 is already answered")
      const listed = await until(at.rendered, has("? q-2 Which licence?"))
      expect(listed.chars).not.toContain("? q-1")
    })
  })

  test("a need come in since the list opened stays, the read not having it", async () => {
    await scene(async (at) => {
      await until(at.rendered, has("Which flag name?"))
      await at.rendered.input((setup) => setup.mockInput.pressTab())
      await enter(at.rendered)
      // The run takes on another question before the read it offered comes back.
      await at.rendered.input(() =>
        at.view.set(viewOf([...two, asked("a-3", "Paint it", "q-3", 2)], [flag, licence, colour])),
      )
      await reads(at, [licence])
      const list = await until(at.rendered, has("? q-3"))
      expect(list.chars).toContain("? q-3 Which colour?")
      expect(list.chars).toContain("? q-2 Which licence?")
      expect(list.chars).not.toContain("? q-1")
    })
  })
})

describe("closedSince", () => {
  const needOf = (ticket: string, on: OpenQuestion | null, id: string) =>
    Need.Question({ ticket: ticket as TicketId, label: ticket, title: "", id, question: on })

  test("is the asked questions the read doesn't have open", () => {
    const needs = [needOf("a-1", flag, "q-1"), needOf("a-2", null, "q-2")]
    expect(closedSince(needs, [licence])).toEqual(["q-1"])
    expect(closedSince(needs, [])).toEqual(["q-1", "q-2"])
    expect(closedSince(needs, [flag, licence])).toEqual([])
  })

  test("is none until the questions are read, and none for a Blocked ticket", () => {
    expect(closedSince([needOf("a-1", flag, "q-1")], undefined)).toEqual([])
    const blocked = Need.Blocked({
      ticket: "b-1" as TicketId,
      label: "b-1",
      title: "",
      why: "MERGE_CONFLICT",
      base: "batch",
      handBack: false,
      about: null,
      run: "on",
      mergesOver: false,
    })
    expect(closedSince([blocked], [])).toEqual([])
  })
})
