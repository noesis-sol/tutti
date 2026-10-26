// The forms' click targets (D9, § 7.3): in init's form, the start question, the plan confirmation and
// the answer form, a click on a button, an option or a line to type in does what its key does; with
// the mouse left to the terminal (--no-mouse), the forms take keys only.

import { describe, expect, test } from "bun:test"
import type { InputRenderable } from "@opentui/core"
import { Effect, Option, Queue } from "effect"
import type { ReactNode } from "react"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { initMouse, readInitFlags } from "../src/cli/commands.ts"
import { makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { type Asking, emptyScreen, InitView } from "../src/ui/InitForm.tsx"
import { escapeHold, InputGuards } from "../src/ui/keys.ts"
import { PlanConfirmation } from "../src/ui/PlanConfirmation.tsx"
import { type Plan, TicketCount, Work } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { emptyTranscript, type TranscriptState } from "../src/ui/transcriptItems.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, leap, parserWait, type Rendered, withRender } from "./render.ts"
import { noSpecAsk } from "./specAsk.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const dark = themeOf("dark")

const size = { width: 90, height: 30 }

/** Where `text` starts in `frame`: its column and line. */
const spot = (frame: Frame, text: string): { readonly x: number; readonly y: number } => {
  const lines = frame.chars.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y < 0) throw new Error(`no ${JSON.stringify(text)} in:\n${frame.chars}`)
  return { x: (lines[y] ?? "").indexOf(text), y }
}

/** Clicks the left button on `text`'s first column, or `offset` columns into it. */
const click = async (rendered: Rendered, text: string, offset = 0) => {
  const { x, y } = spot(await rendered.capture(), text)
  await rendered.input((setup) => setup.mockMouse.click(x + offset, y))
}

/** What a field said, in order. */
const said = () => {
  const all: Array<unknown> = []
  return { all, say: (value: unknown) => all.push(value) }
}

/** init's form asking `asking`, its clock stopped. */
const initForm = (asking: Asking): ReactNode => (
  <InitView
    theme={dark}
    repo="/work/shop"
    screen={{ ...emptyScreen, steps: ["Workers", "Checks"], at: 0, asking }}
    now={0}
  />
)

const never = () => {
  throw new Error("cancelled")
}

describe("init's form takes clicks", () => {
  test("Yes and No answer a confirm", async () => {
    const { all, say } = said()
    const asking: Asking = {
      _tag: "Confirm",
      id: 1,
      field: { question: "Import orchestra's settings and worker prompt?", initial: true },
      answer: say,
      cancel: never,
    }
    await withRender(initForm(asking), size, async (rendered) => {
      await click(rendered, "  No  ", 2)
      await click(rendered, "  Yes  ", 2)
    })
    expect(all).toEqual([false, true])
  })

  test("a select's option is chosen and confirmed", async () => {
    const { all, say } = said()
    const asking: Asking = {
      _tag: "Select",
      id: 1,
      field: { title: "Billing", options: ["subscription", "api"] },
      answer: say,
      cancel: never,
    }
    await withRender(initForm(asking), size, async (rendered) => {
      await click(rendered, "api")
    })
    expect(all).toEqual([1])
  })

  test("a checklist's option is ticked or unticked; Enter confirms", async () => {
    const { all, say } = said()
    const asking: Asking = {
      _tag: "Checklist",
      id: 1,
      field: {
        title: "MCP servers workers get",
        description: "Each worker gets the ones ticked.",
        options: ["github", "linear"],
        ticked: [0],
      },
      answer: say,
      cancel: never,
    }
    await withRender(initForm(asking), size, async (rendered) => {
      await click(rendered, "linear")
      expect((await rendered.capture()).chars).toContain("> ✓ linear")
      await click(rendered, "github")
      const frame = await rendered.capture()
      expect(frame.chars).toContain("> • github")
      expect(frame.chars).toContain("  ✓ linear")
      expect(all).toEqual([])
      await rendered.input((setup) => setup.mockInput.pressEnter())
    })
    expect(all).toEqual([[1]])
  })

  test("a click on the line to type in focuses it", async () => {
    const { all, say } = said()
    const asking: Asking = {
      _tag: "Text",
      id: 1,
      field: { title: "Tickets to run at the same time" },
      answer: say,
      cancel: never,
    }
    await withRender(initForm(asking), size, async (rendered) => {
      const input = rendered.setup.renderer.currentFocusedRenderable as InputRenderable
      await rendered.input(() => input.blur())
      expect(input.focused).toBe(false)
      const { x, y } = spot(await rendered.capture(), "Tickets to run at the same time")
      await rendered.input((setup) => setup.mockMouse.click(x, y + 1))
      expect(input.focused).toBe(true)
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("3")
        setup.mockInput.pressEnter()
      })
    })
    expect(all).toEqual(["3"])
  })

  test("the scout's Esc line skips it", async () => {
    let skipped = 0
    const asking: Asking = {
      _tag: "Scout",
      id: 1,
      since: 0,
      skip: () => {
        skipped++
      },
      cancel: never,
    }
    await withRender(initForm(asking), size, async (rendered) => {
      await click(rendered, "skip and type a check yourself")
    })
    expect(skipped).toBe(1)
  })
})

describe("the start question takes clicks", () => {
  test("Current tickets answers; New feature asks for its description, focused", async () => {
    const { all, say } = said()
    const node = (
      <StartQuestion
        spec={noSpecAsk}
        theme={dark}
        count={TicketCount.Ready({ n: 3 })}
        answer={say}
        cancel={never}
      />
    )
    await withRender(node, size, async (rendered) => {
      await click(rendered, "New feature")
      const frame = await rendered.capture()
      expect(frame.chars).toContain("> New feature")
      expect(frame.chars).toContain("What should it do, and why?")
      const focused = rendered.setup.renderer.currentFocusedRenderable
      await rendered.input(() => focused?.blur())
      await click(rendered, "What should it do, and why?")
      expect(focused?.focused).toBe(true)
      expect(all).toEqual([])
      await click(rendered, "Current tickets")
    })
    expect(all).toEqual([Work.Tickets()])
  })
})

const plan: Plan = {
  epic: { title: "Checkout", description: "Pay for the basket." },
  tickets: [],
  notes: [],
}

describe("the plan confirmation takes clicks", () => {
  test("y in [y/N] says yes, N no", async () => {
    const { all, say } = said()
    const node = (
      <PlanConfirmation theme={dark} plan={plan} question="Run it?" answer={say} cancel={never} />
    )
    await withRender(node, size, async (rendered) => {
      expect((await rendered.capture()).chars).toContain("Run it? [y/N]")
      await click(rendered, "[y/N]", 3)
      await click(rendered, "[y/N]", 1)
    })
    expect(all).toEqual([false, true])
  })
})

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const asked: AttentionRequest = {
  id: "q1",
  ticket: "t-1" as TicketId,
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "Which storage?",
        options: [{ label: "SQLite" }, { label: "Postgres" }],
        multiSelect: false,
      },
      {
        question: "Which checks?",
        options: [{ label: "tsc" }, { label: "biome" }],
        multiSelect: true,
      },
    ],
    input: {},
  },
  displayName: "AskUserQuestion",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
}

const viewOf = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  project({
    ledger: {
      tickets: new Map([
        [
          "t-1" as TicketId,
          {
            ticket: "t-1" as TicketId,
            title: "Title of t-1",
            phase: TicketPhase.Working(),
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
    workers: new Map([["t-1", WS.Idle({ at: began })]]),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

describe("the answer form takes clicks", () => {
  test("an option is picked, Other's line focused, and Answer pressed", async () => {
    let now = began
    const commands = Effect.runSync(makeCommands)
    const root = (
      <Root
        value={{
          view: external(viewOf([asked])),
          screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
          commands,
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => now,
          transcripts: {
            open: () => ({
              state: external<TranscriptState>(emptyTranscript),
              older: () => {},
              scrolledBack: () => {},
              follow: () => {},
              close: () => {},
            }),
          },
        }}
      />
    )
    await withRender(root, { width: 80, height: 40 }, async (rendered) => {
      now += settle
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect((await rendered.capture()).chars).toContain("t-1 asks")
      await click(rendered, "( ) Postgres")
      expect((await rendered.capture()).chars).toContain("(•) Postgres")
      await click(rendered, "[ ] biome")
      expect((await rendered.capture()).chars).toContain("[x] biome")
      // The second question's Other: its line focused, and typed in.
      const lines = (await rendered.capture()).chars.split("\n")
      const y = lines.findLastIndex((line) => line.includes("Other:"))
      const x = (lines[y] ?? "").indexOf("Other:")
      await rendered.input((setup) => setup.mockMouse.click(x + 12, y))
      await rendered.input((setup) => setup.mockInput.typeText("lint"))
      expect((await rendered.capture()).chars).toContain("[x] Other: lint")
      await click(rendered, "[ Answer ]", 2)
    })
    expect(Effect.runSync(Queue.clear(commands))).toEqual([
      UiCommand.Answer({
        requestId: "q1",
        answer: { _tag: "Choose", answers: ["Postgres", "biome, lint"] },
      }),
    ])
  })
})

describe("init's form taking the mouse", () => {
  /**
   * Sends `start`, then `rest` a read later, as a terminal can split a mouse report (#1661): the
   * read after the stdin parser's wait and within the Esc hold, then the hold out. Both are timers
   * on the renderer's clock, which this leaps, so a loaded machine can't stretch the gap past them.
   */
  const split = (rendered: Rendered, start: string, rest: string) =>
    rendered.input((setup) => {
      setup.renderer.stdin.emit("data", Buffer.from(start))
      leap(setup, parserWait)
      setup.renderer.stdin.emit("data", Buffer.from(rest))
      leap(setup, escapeHold)
    })

  test("a mouse report split after its Esc doesn't cancel a confirm", async () => {
    const { all, say } = said()
    let cancelled = 0
    const asking: Asking = {
      _tag: "Confirm",
      id: 1,
      field: { question: "Import orchestra's settings and worker prompt?", initial: true },
      answer: say,
      cancel: () => {
        cancelled++
      },
    }
    const node = (
      <>
        <InputGuards />
        {initForm(asking)}
      </>
    )
    await withRender(node, size, async (rendered) => {
      await split(rendered, "\x1b", "[<35;10;5M")
      expect(cancelled).toBe(0)
      await rendered.input((setup) => setup.mockInput.pressKey("y"))
    })
    expect(all).toEqual([true])
  })

  test("a mouse report split after its ESC [ types nothing into a line", async () => {
    const { all, say } = said()
    const asking: Asking = {
      _tag: "Text",
      id: 1,
      field: { title: "Tickets to run at the same time" },
      answer: say,
      cancel: never,
    }
    const node = (
      <>
        <InputGuards />
        {initForm(asking)}
      </>
    )
    await withRender(node, size, async (rendered) => {
      await split(rendered, "\x1b[", "<64;87;26M")
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("2")
        setup.mockInput.pressEnter()
      })
    })
    expect(all).toEqual(["2"])
  })
})

describe("--no-mouse", () => {
  test("leaves the forms keys only", async () => {
    const { all, say } = said()
    const asking: Asking = {
      _tag: "Confirm",
      id: 1,
      field: { question: "Merge CHANGELOG.md by union?", initial: true },
      answer: say,
      cancel: never,
    }
    await withRender(initForm(asking), size, async (rendered) => {
      rendered.setup.renderer.useMouse = false
      await click(rendered, "  No  ", 2)
      expect(all).toEqual([])
      await rendered.input((setup) => setup.mockInput.pressKey("n"))
    })
    expect(all).toEqual([false])
  })

  test("init's form takes the mouse unless --no-mouse or the user config says not", () => {
    const read = (text: string) => {
      const flags = readInitFlags({
        checkFast: Option.none(),
        checkFull: Option.none(),
        checkFastTimeout: Option.none(),
        checkFullTimeout: Option.none(),
        setup: Option.none(),
        concurrent: Option.none(),
        mcp: Option.none(),
        changelogUnion: Option.none(),
        installBeads: Option.none(),
        verifier: Option.none(),
        prefix: Option.none(),
        noMouse: text === "" ? Option.none() : Option.some(text),
        force: false,
      })
      if (flags._tag === "Failure") throw new Error(flags.failure.join("\n"))
      return flags.success
    }
    expect(read("").noMouse).toBeUndefined()
    expect(read("true").noMouse).toBe(true)
    expect(initMouse(read(""), Option.none())).toBe(true)
    expect(initMouse(read(""), Option.some(false))).toBe(false)
    expect(initMouse(read("true"), Option.some(true))).toBe(false)
    expect(initMouse(read("false"), Option.some(false))).toBe(true)
  })
})
