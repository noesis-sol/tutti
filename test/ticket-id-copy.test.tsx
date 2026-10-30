// A click on a ticket's ID in the tickets table copies it (§ 7.2, § 7.3, tutti-vkuj): on every row,
// through the shell's Clipboard, the cell saying `✓ copied` for 1.5 s, `✓` alone where the column
// is narrower, and a click again starting the 1.5 s over; a failed copy toasts `couldn't copy` and
// keeps the ID. A drag across the ID still selects and copies the text, and a click on a `? for
// you` row outside its ID still opens the questions box.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { type Clipboard, copiedLife, copiedToast, copyFailedToast } from "../src/ui/clipboard.ts"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { copiedCell, ticketsLines } from "../src/ui/TicketsTable.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Interval } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 30, 13, 0, 0).getTime()

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
  options: [{ label: "--flag", description: "short to type" }],
  maintainerOnly: false,
  waiting: ["t-1" as TicketId],
}

const done = entry(
  "tutti-done1",
  "Add the parser",
  TicketPhase.Done({ outcome: { _tag: "Merged", commit: "abc1234" } }),
  0,
)
const asked = entry("t-1", "Add the flag", TicketPhase.Asked({ question: "q-1" }), 1)

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

/** A Clipboard that answers `answer`, and what it was asked to copy. */
const fakeClipboard = (answer: boolean | "throw" = true) => {
  const copied: Array<string> = []
  const clipboard: Clipboard = {
    copy: (text) => {
      copied.push(text)
      return answer === "throw" ? Promise.reject(new Error("broken")) : Promise.resolve(answer)
    },
  }
  return { clipboard, copied }
}

/** The shell's intervals, which the test fires by hand: none fires by itself. */
const handIntervals = () => {
  const running = new Set<{ readonly run: () => void; readonly ms: number }>()
  const interval: Interval = (run, ms) => {
    const timer = { run, ms }
    running.add(timer)
    return () => {
      running.delete(timer)
    }
  }
  return {
    interval,
    /** How many intervals of `ms` are running. */
    count: (ms: number) => [...running].filter((timer) => timer.ms === ms).length,
    /** Fires every interval of `ms`. */
    fire: (ms: number) => {
      for (const timer of [...running]) if (timer.ms === ms) timer.run()
    },
  }
}

/** The commands sent since the last call. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

/** Captures frames until `ready` holds of one. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** Whether `frame` toasts `text`: a line outside the frames, the toasts' above the hint, says it. */
const toasted = (frame: Frame, text: string): boolean =>
  frame.chars.split("\n").some((line) => !line.includes("│") && line.includes(` ${text} `))

/** The frame's line `y`. */
const lineAt = (frame: Frame, y: number): string => frame.chars.split("\n")[y] ?? ""

/** The line and column of `text` in the table (past the totals' line), to click on it. */
const placeOf = (frame: Frame, text: string): { readonly x: number; readonly y: number } => {
  const lines = frame.chars.split("\n")
  const y = lines.findIndex((line) => line.includes(text) && line.includes("│"))
  return { x: lines[y]?.indexOf(text) ?? -1, y }
}

const scene = async (
  clipboard: Clipboard,
  body: (at: {
    readonly commands: Commands
    readonly rendered: Rendered
    readonly intervals: ReturnType<typeof handIntervals>
  }) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  const intervals = handIntervals()
  await withRender(
    <Root
      value={{
        view: external(viewOf([done, asked])),
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
        interval: intervals.interval,
        clipboard,
      }}
    />,
    { width: 100, height: 30 },
    (rendered) => body({ commands, rendered, intervals }),
  )
}

describe("a click on a ticket's ID", () => {
  test("copies it, the cell saying ✓ copied for 1.5 s, then the ID, with no toast", async () => {
    const { clipboard, copied } = fakeClipboard()
    await scene(clipboard, async ({ rendered, intervals }) => {
      const table = await until(rendered, has("tutti-done1"))
      const { x, y } = placeOf(table, "tutti-done1")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      const marked = await until(rendered, has(copiedCell(11)))
      expect(copied).toEqual(["tutti-done1"])
      expect(lineAt(marked, y)).toContain("✓ copied")
      expect(lineAt(marked, y)).not.toContain("tutti-done1")
      expect(toasted(marked, copiedToast)).toBe(false)
      expect(intervals.count(copiedLife)).toBe(1)
      await rendered.input(() => intervals.fire(copiedLife))
      const back = await until(rendered, (frame) => !frame.chars.includes("✓ copied"))
      expect(lineAt(back, y)).toContain("tutti-done1")
      expect(intervals.count(copiedLife)).toBe(0)
    })
  })

  test("a click again in that time copies again and starts the 1.5 s over", async () => {
    const { clipboard, copied } = fakeClipboard()
    await scene(clipboard, async ({ rendered, intervals }) => {
      const table = await until(rendered, has("tutti-done1"))
      const { x, y } = placeOf(table, "tutti-done1")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      await until(rendered, has("✓ copied"))
      // The second click, quick enough to be OpenTUI's double click, selects no word to copy.
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      const deadline = Date.now() + 5000
      while (copied.length < 2 && Date.now() < deadline) await Bun.sleep(20)
      await Bun.sleep(20)
      expect(copied).toEqual(["tutti-done1", "tutti-done1"])
      expect(intervals.count(copiedLife)).toBe(1)
      const frame = await rendered.capture()
      expect(lineAt(frame, y)).toContain("✓ copied")
      expect(toasted(frame, copiedToast)).toBe(false)
      await rendered.input(() => intervals.fire(copiedLife))
      const back = await until(rendered, (each) => !each.chars.includes("✓ copied"))
      expect(lineAt(back, y)).toContain("tutti-done1")
    })
  })

  test("that fails toasts couldn't copy and keeps the ID", async () => {
    for (const answer of [false, "throw"] as const) {
      const { clipboard, copied } = fakeClipboard(answer)
      await scene(clipboard, async ({ rendered, intervals }) => {
        const table = await until(rendered, has("tutti-done1"))
        const { x, y } = placeOf(table, "tutti-done1")
        await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
        const frame = await until(rendered, has(copyFailedToast))
        expect(copied).toEqual(["tutti-done1"])
        expect(toasted(frame, copyFailedToast)).toBe(true)
        expect(frame.chars).not.toContain("✓ copied")
        expect(lineAt(frame, y)).toContain("tutti-done1")
        expect(intervals.count(copiedLife)).toBe(0)
      })
    }
  })

  test("on a ? for you row copies the ID and opens no questions box", async () => {
    const { clipboard, copied } = fakeClipboard()
    await scene(clipboard, async ({ commands, rendered }) => {
      const table = await until(rendered, has("Which flag name?"))
      const { x, y } = placeOf(table, "t-1 ")
      await rendered.input((setup) => setup.mockMouse.click(x + 1, y))
      const frame = await until(rendered, has("✓ copied"))
      expect(copied).toEqual(["t-1"])
      expect(lineAt(frame, y)).toContain("✓ copied")
      expect(taken(commands).some((command) => command._tag === "ReadQuestions")).toBe(false)
    })
  })
})

describe("on a ? for you row", () => {
  test("a click outside its ID still opens the questions box, copying nothing", async () => {
    const { clipboard, copied } = fakeClipboard()
    await scene(clipboard, async ({ commands, rendered }) => {
      const table = await until(rendered, has("Which flag name?"))
      const { x, y } = placeOf(table, "Which flag name?")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      const deadline = Date.now() + 5000
      let read = false
      while (!read && Date.now() < deadline) {
        read = taken(commands).some((command) => command._tag === "ReadQuestions")
        if (!read) {
          await rendered.capture()
          await Bun.sleep(20)
        }
      }
      expect(read).toBe(true)
      expect(copied).toEqual([])
    })
  })
})

describe("a drag across a ticket's ID", () => {
  test("copies what it selects, with a toast, the cell keeping its ID", async () => {
    const { clipboard, copied } = fakeClipboard()
    await scene(clipboard, async ({ rendered, intervals }) => {
      const table = await until(rendered, has("tutti-done1"))
      const { x, y } = placeOf(table, "tutti-done1")
      await rendered.input((setup) => setup.mockMouse.drag(x, y, x + 10, y))
      const frame = await until(rendered, (each) => toasted(each, copiedToast))
      expect(copied).toEqual(["tutti-done1"])
      expect(frame.chars).not.toContain("✓ copied")
      expect(lineAt(frame, y)).toContain("tutti-done1")
      expect(intervals.count(copiedLife)).toBe(0)
    })
  })
})

describe("the copied cell", () => {
  test("says ✓ copied where the column has room, ✓ alone where it is narrower", () => {
    expect(copiedCell(8)).toBe("✓ copied")
    expect(copiedCell(11)).toBe("✓ copied")
    expect(copiedCell(7)).toBe("✓")
    expect(copiedCell(1)).toBe("✓")
  })

  test("is drawn in the closed style in the table, in place of the ID", () => {
    const text = (view: RunView, copied: string) =>
      ticketsLines(
        view.rows,
        theme,
        80,
        { lines: 6 },
        { highlighted: null, target: () => undefined, idTarget: () => 2000, copied },
      )
        .flat()
        .filter((each) => each.text.includes("✓"))
    // Only short IDs: the column is 7 wide, too narrow for ✓ copied.
    const narrow = text(viewOf([asked]), "t-1")
    expect(narrow.map((each) => each.text.trim())).toContain("✓")
    expect(narrow.some((each) => each.text.includes("copied"))).toBe(false)
    const wide = text(viewOf([done]), "tutti-done1")
    const cell = wide.find((each) => each.text.includes("✓ copied"))
    expect(cell?.look).toEqual(theme.styles.closed)
  })
})
