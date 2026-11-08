// A Blocked ticket's box opened from the Needs you list (§ 7.2, tutti-fnvd.18) draws the ticket as
// the run has it now: its leaving Blocked, handed back or merged meanwhile, takes the box back to the
// list at the next one, with no `h` to send a stale hand-back; its need changing redraws the box.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 8, 9, 0, 0).getTime()

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
  description: "",
  options: [{ label: "--flag", description: "short to type" }],
  maintainerOnly: false,
  waiting: ["t-1" as TicketId],
}

const asked = entry("t-1", "Add the flag", TicketPhase.Asked({ question: "q-1" }), 0)
const parser = (phase: TicketPhase) => entry("t-2", "Merge the parser", phase, 1)
const conflict = parser(TicketPhase.Blocked({ why: "MERGE_CONFLICT" }))
const lexer = entry("t-3", "Fix the lexer", TicketPhase.Blocked({ why: "DIRTY_TREE" }), 2)

const viewOf = (entries: ReadonlyArray<LedgerEntry>): RunView =>
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
      questions: new Map([["q-1", flag]]),
    },
    actions: new Map(),
  })

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

/** Has the run read the questions for the list once it offers ReadQuestions. */
const reads = async (
  rendered: Rendered,
  commands: Commands,
  news: Settable<ReadonlyArray<QuestionNews>>,
) => {
  const deadline = Date.now() + 5000
  for (;;) {
    const read = taken(commands).find((each) => each._tag === "ReadQuestions")
    if (read?._tag === "ReadQuestions") {
      await rendered.input(() => news.set([QuestionNews.Read({ uuid: read.uuid, questions: [] })]))
      return
    }
    if (Date.now() > deadline) throw new Error("nothing read the questions")
    await rendered.capture()
    await Bun.sleep(20)
  }
}

/** On a dashboard too narrow for the panel, the list open with t-2's box over it. */
const scene = async (
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(viewOf([asked, conflict, lexer]))
  const news = external<ReadonlyArray<QuestionNews>>([])
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view,
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 60_000,
        questions: news,
      }}
    />,
    { width: 100, height: 30 },
    async (rendered) => {
      await until(rendered, has("Which flag name?"))
      await rendered.input((setup) => setup.mockInput.pressTab())
      await rendered.input((setup) => setup.mockInput.pressEnter())
      await reads(rendered, commands, news)
      await until(rendered, has("> ? q-1 Which flag name?"))
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      await until(rendered, has("> ■ t-2 blocked: MERGE_CONFLICT"))
      await rendered.input((setup) => setup.mockInput.pressEnter())
      const box = await until(rendered, has("Merge the parser"))
      expect(box.chars).toContain("h hand it back")
      expect(box.chars).not.toContain("? q-1 Which flag name?")
      taken(commands)
      await body({ view, commands, rendered })
    },
  )
}

const press = (rendered: Rendered, key: string) =>
  rendered.input((setup) => setup.mockInput.pressKey(key))

describe("a Blocked ticket's box opened from the Needs you list", () => {
  test("goes back to the list at the next one when the ticket is handed back", async () => {
    await scene(async ({ view, commands, rendered }) => {
      await rendered.input(() =>
        view.set(
          viewOf([
            asked,
            parser(TicketPhase.Fixing({ attempt: 1, afterResolution: false })),
            lexer,
          ]),
        ),
      )
      const list = await until(rendered, has("> ■ t-3 blocked: DIRTY_TREE"))
      expect(list.chars).toContain("? q-1 Which flag name?")
      expect(list.chars).not.toContain("t-2")
      expect(list.chars).not.toContain("hand it back")
      await press(rendered, "h")
      await rendered.capture()
      expect(taken(commands).some((each) => each._tag === "HandBackNow")).toBe(false)
    })
  })

  test("goes back to the list when the ticket merges, and stays there if it blocks again", async () => {
    await scene(async ({ view, rendered }) => {
      const merged = parser(TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc123" }) }))
      await rendered.input(() => view.set(viewOf([asked, merged, lexer])))
      const list = await until(rendered, has("> ■ t-3 blocked: DIRTY_TREE"))
      expect(list.chars).toContain("> ■ t-3 blocked: DIRTY_TREE")
      await rendered.input(() => view.set(viewOf([asked, conflict, lexer])))
      const again = await until(rendered, has("■ t-2 blocked: MERGE_CONFLICT"))
      expect(again.chars).toContain("■ t-3 blocked: DIRTY_TREE")
      expect(again.chars).toContain("Enter open · Esc close")
      expect(again.chars).not.toContain("h hand it back")
    })
  })

  test("says what clears the ticket as the run has it now", async () => {
    await scene(async ({ view, commands, rendered }) => {
      await rendered.input(() =>
        view.set(viewOf([asked, parser(TicketPhase.Blocked({ why: "DIRTY_TREE" })), lexer])),
      )
      const box = await until(rendered, has("t-2 blocked: DIRTY_TREE"))
      expect(box.chars).toContain("Merge the parser")
      expect(box.chars).toContain("Leave the main checkout clean")
      expect(box.chars).not.toContain("hand it back")
      await press(rendered, "h")
      await rendered.capture()
      expect(taken(commands).some((each) => each._tag === "HandBackNow")).toBe(false)
    })
  })
})
