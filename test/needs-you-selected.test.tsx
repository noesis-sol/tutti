// Needs you as the tickets table's selected row (§ 7.2, tutti-149z.3): with nothing chosen the first
// row that wants you, by itself; a row you choose stays chosen by its ticket as rows re-sort, until
// you Esc out of the table or it stops needing you; with neither, Up next under `Nothing needs you`.
// Each kind of row says its own detail, in the panel or, in a pane with none, in a box.

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Queue } from "effect"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { putAside } from "../src/run/aside.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies, Ledger } from "../src/run/ledger.ts"
import { clock } from "../src/run/localTime.ts"
import { Finished, Move, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { setupFailedOnBranch } from "../src/run/start.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { init, result, sessionState } from "../src/testing/AgentHost.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { selectedTicket } from "../src/ui/SidePanel.tsx"
import { rowsBesideCurrent } from "../src/ui/TicketsTable.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { backlog, scenario } from "./harness.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "0c1a9e7ffff" }) })
const conflict = TicketPhase.Blocked({ why: "MERGE_CONFLICT" })
const dirty = TicketPhase.Blocked({ why: "DIRTY_TREE" })
const asked = TicketPhase.Asked({ question: "q-1" })

const entryOf = (
  ticket: string,
  row: number,
  phase: Entry["phase"],
  more: Partial<Entry> = {},
): Entry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since: began + row * 60_000,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
  ...more,
})

const q1 = {
  id: "q-1" as TicketId,
  title: "Which flag name?",
  description: "",
  options: [
    { label: "Use --flag", description: "" },
    { label: "Use --other", description: "" },
  ],
  maintainerOnly: false,
  waiting: ["a-1" as TicketId],
}

const projected = (tickets: ReadonlyArray<Entry>, status: Partial<Status> = {}): RunView =>
  project({
    ledger: {
      tickets: new Map(tickets.map((each) => [each.ticket, each])),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(
      tickets.flatMap((each) =>
        each.worker === null ? [] : [[each.ticket, WS.Idle({ at: began })] as const],
      ),
    ),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch",
      began,
      concurrency: 4,
      questions: new Map([["q-1", q1]]),
      ...status,
    },
    actions: new Map(),
  })

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key === "tab") setup.mockInput.pressTab()
      else if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "escape") await pressEscape(setup)
      else if (key === "up" || key === "down" || key === "left") setup.mockInput.pressArrow(key)
      else await setup.mockInput.typeText(key)
    }
  })

const scene = async (
  start: RunView,
  size: { readonly width: number; readonly height: number },
  body: (at: {
    readonly view: Settable<RunView>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const view = external(start)
  const commands = Effect.runSync(makeCommands)
  const value = {
    view,
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began,
  }
  await withRender(<Root value={value} />, size, (rendered) => body({ view, commands, rendered }))
}

const wide = { width: 155, height: 40 }
const narrow = { width: 100, height: 40 }

/** The panel's text on `frame`, unwrapped: what is right of the table, on one line. */
const panelOf = (frame: Frame): string =>
  frame.chars
    .split("\n")
    .map((line) =>
      line
        .slice(155 - 61)
        .replace(/[│┃]/g, "")
        .trim(),
    )
    .join(" ")
    .replace(/ +/g, " ")

const merge = (rendered: Rendered, view: Settable<RunView>, next: RunView) =>
  rendered.input(() => view.set(next))

describe("with nothing chosen", () => {
  test("the first row that wants you is selected by itself, and the panel shows it", async () => {
    const tickets = [entryOf("d-1", 0, merged), entryOf("a-1", 1, asked), entryOf("b-1", 2, dirty)]
    await scene(projected(tickets), wide, async ({ rendered }) => {
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("Needs you · 2")
      expect(panel).toContain("b-1 blocked: DIRTY_TREE")
      expect(panel).not.toContain("Which flag name?")
    })
  })

  test("a more urgent ticket takes the panel, with nothing chosen", async () => {
    const start = [entryOf("a-1", 0, asked)]
    await scene(projected(start), wide, async ({ view, rendered }) => {
      expect(panelOf(await rendered.capture())).toContain("Which flag name?")
      await merge(rendered, view, projected([...start, entryOf("b-1", 1, dirty)]))
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("b-1 blocked: DIRTY_TREE")
      expect(panel).toContain("Needs you · 2")
    })
  })

  test("a set-aside row is selected only with nothing asking more of you", () => {
    const view = projected([
      entryOf("s-1", 0, TicketPhase.Deferred({ why: "by the worker" })),
      entryOf("d-1", 1, merged),
    ])
    expect(selectedTicket(view.rows, null, view.needs, view.needs)).toBe("s-1" as TicketId)
    const both = projected([
      entryOf("s-1", 0, TicketPhase.Deferred({ why: "by the worker" })),
      entryOf("a-1", 1, asked),
    ])
    const rows = [...both.rows].reverse()
    expect(selectedTicket(rows, null, both.needs, both.needs)).toBe("a-1" as TicketId)
  })

  test("a need with no row, its card in Current, is selected before a row only set aside", () => {
    const view = projected([
      entryOf("s-1", 0, TicketPhase.Deferred({ why: "by the worker" })),
      entryOf("h-1", 1, conflict, { worker: 1, handBack: true }),
    ])
    const rows = rowsBesideCurrent(view.rows, view.cards)
    expect(rows.map((row) => row.ticket)).toEqual(["s-1"] as Array<TicketId>)
    expect(selectedTicket(rows, null, view.needs, view.needs)).toBe("h-1" as TicketId)
  })
})

describe("a row you choose", () => {
  const two = [entryOf("b-1", 0, dirty), entryOf("a-1", 1, asked)]

  test("stays by its ID as rows re-sort: a more urgent ticket bumps the count only", async () => {
    await scene(projected(two), wide, async ({ view, rendered }) => {
      await press(rendered, "enter", "down")
      expect(panelOf(await rendered.capture())).toContain("Which flag name?")
      await merge(
        rendered,
        view,
        projected([entryOf("b-0", 2, conflict, { since: began - 60_000 }), ...two]),
      )
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("Which flag name?")
      expect(panel).toContain("Needs you · 3")
    })
  })

  test("stays as the focus moves on to the panel, and goes back to automatic on Esc out of the table", async () => {
    await scene(projected(two), wide, async ({ rendered }) => {
      await press(rendered, "enter", "down", "tab")
      expect(panelOf(await rendered.capture())).toContain("Which flag name?")
    })
    await scene(projected(two), wide, async ({ rendered }) => {
      await press(rendered, "enter", "down", "escape")
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
    })
  })

  test("Esc from the table's top level lets go of it too", async () => {
    await scene(projected(two), wide, async ({ rendered }) => {
      // Enter, ↓ on the Asked row, Tab round to the panel, out, and across to Tickets' top level.
      await press(rendered, "enter", "down", "tab", "escape")
      await press(rendered, "left")
      expect(panelOf(await rendered.capture())).toContain("Which flag name?")
      await press(rendered, "escape")
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
    })
  })

  describe("pushed past the rows the table has room for", () => {
    const asks = Array.from({ length: 10 }, (_, i) =>
      entryOf(`a-${i}`, i, TicketPhase.Asked({ question: `q-${i}` })),
    )
    const question = (i: number) => ({
      ...q1,
      id: `q-${i}` as TicketId,
      title: `Question q-${i}`,
      waiting: [`a-${i}` as TicketId],
    })
    const questions = new Map(asks.map((_, i) => [`q-${i}`, question(i)]))
    const urgent = entryOf("b-0", 10, dirty)
    // The last of 10 Asked rows chosen, then a Blocked ticket on top: it has no room left.
    const pushed = async (
      body: (at: {
        readonly view: Settable<RunView>
        readonly commands: Commands
        readonly rendered: Rendered
      }) => Promise<void>,
    ) =>
      scene(projected(asks, { questions }), wide, async ({ view, commands, rendered }) => {
        await press(rendered, "enter", "up")
        expect(panelOf(await rendered.capture())).toContain("Question q-9")
        await merge(rendered, view, projected([...asks, urgent], { questions }))
        await body({ view, commands, rendered })
      })

    test("stays, bumping the count only, until Esc", async () => {
      await pushed(async ({ rendered }) => {
        const panel = panelOf(await rendered.capture())
        expect(panel).toContain("Question q-9")
        expect(panel).toContain("Needs you · 11")
        await press(rendered, "escape")
        expect(panelOf(await rendered.capture())).toContain("b-0 blocked: DIRTY_TREE")
      })
    })

    test("a digit answers the question on screen, not what wants you first", async () => {
      await pushed(async ({ commands, rendered }) => {
        await Bun.sleep(settle + 50)
        await press(rendered, "1")
        expect(taken(commands)).toMatchObject([{ question: "q-9", answer: "Use --flag" }])
      })
    })

    test("goes back to automatic once answered", async () => {
      await pushed(async ({ view, rendered }) => {
        const answered = new Set(["q-9"])
        await merge(rendered, view, projected([...asks, urgent], { questions, answered }))
        expect(panelOf(await rendered.capture())).toContain("b-0 blocked: DIRTY_TREE")
      })
    })

    test("goes back to automatic once merged", async () => {
      await pushed(async ({ view, rendered }) => {
        const rest = asks.filter((each) => each.ticket !== "a-9")
        const done = entryOf("a-9", 9, merged)
        await merge(rendered, view, projected([...rest, done, urgent], { questions }))
        expect(panelOf(await rendered.capture())).toContain("b-0 blocked: DIRTY_TREE")
      })
    })

    test("going back into Tickets keeps it", async () => {
      await pushed(async ({ rendered }) => {
        // No longer drawn, it is no stop of Tab's: on to the panel, out, across and back in.
        await press(rendered, "tab", "escape")
        await press(rendered, "left", "enter")
        expect(panelOf(await rendered.capture())).toContain("Question q-9")
      })
    })
  })

  test("that was set aside stays as newer ones push it past the rows with room", async () => {
    const set = (ticket: string, row: number) =>
      entryOf(ticket, row, TicketPhase.Deferred({ why: "by the worker" }))
    const start = Array.from({ length: 10 }, (_, i) => set(`s-${i}`, i))
    await scene(projected(start), wide, async ({ view, rendered }) => {
      // Newest first: ↑ from the first goes round to the oldest, s-0.
      await press(rendered, "enter", "up")
      expect(panelOf(await rendered.capture())).toContain("s-0 deferred")
      await merge(rendered, view, projected([...start, set("s-new", 10)]))
      expect(panelOf(await rendered.capture())).toContain("s-0 deferred")
    })
  })

  test("goes back to automatic once merged, gone from the table or no longer blocked", async () => {
    const start = [entryOf("b-1", 0, dirty), entryOf("b-2", 1, conflict)]
    await scene(projected(start), wide, async ({ view, rendered }) => {
      await press(rendered, "enter", "down", "tab")
      expect(panelOf(await rendered.capture())).toContain("b-2 blocked: MERGE_CONFLICT")
      await merge(rendered, view, projected([entryOf("b-1", 0, dirty), entryOf("b-2", 1, merged)]))
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
    })
  })

  test("goes back to automatic once taken back, into the merge queue", async () => {
    const start = [entryOf("b-1", 0, dirty), entryOf("b-2", 1, conflict)]
    const back = TicketPhase.ToMerge({ place: 1 })
    await scene(projected(start), wide, async ({ view, rendered }) => {
      await press(rendered, "enter", "down", "tab")
      await merge(
        rendered,
        view,
        projected([entryOf("b-1", 0, dirty), entryOf("b-2", 1, back, { worker: 1 })]),
      )
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("b-1 blocked: DIRTY_TREE")
      expect(panel).toContain("Needs you · 1")
    })
  })

  test("goes back to automatic once answered, by the look or on the panel", async () => {
    await scene(projected(two), wide, async ({ view, rendered }) => {
      await press(rendered, "enter", "down", "tab")
      await merge(rendered, view, projected(two, { answered: new Set(["q-1"]) }))
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
    })
    await scene(projected(two), wide, async ({ commands, rendered }) => {
      await press(rendered, "enter", "down", "tab")
      await Bun.sleep(settle + 50)
      await press(rendered, "1")
      expect(taken(commands)).toMatchObject([{ question: "q-1", answer: "Use --flag" }])
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("b-1 blocked: DIRTY_TREE")
      expect(panel).toContain("Needs you · 1")
    })
  })

  test("inside Tickets, its letting go leaves the keys on the row it goes back to", async () => {
    const start = [entryOf("b-1", 0, dirty), entryOf("b-2", 1, conflict)]
    await scene(projected(start), wide, async ({ view, commands, rendered }) => {
      await press(rendered, "enter", "down")
      await merge(rendered, view, projected([entryOf("b-1", 0, dirty), entryOf("b-2", 1, merged)]))
      await rendered.capture()
      taken(commands)
      await press(rendered, "enter")
      expect(has(await rendered.capture(), "Leave the main checkout clean")).toBe(true)
    })
  })

  test("that never wanted you stays chosen, as rows come in above it", async () => {
    const start = [entryOf("d-1", 0, merged), entryOf("d-2", 1, merged)]
    await scene(projected(start), wide, async ({ view, rendered }) => {
      await press(rendered, "enter", "down")
      const first = panelOf(await rendered.capture())
      const name = first.includes("d-1 done") ? "d-1 done" : "d-2 done"
      expect(first).toContain(name)
      await merge(rendered, view, projected([...start, entryOf("b-1", 2, dirty)]))
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain(name)
      expect(panel).toContain("Needs you · 1")
    })
  })

  test("`[` and `]` do nothing", async () => {
    await scene(projected(two), wide, async ({ rendered }) => {
      await press(rendered, "]")
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
      await press(rendered, "[")
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
    })
  })
})

const has = (frame: Frame, text: string) => frame.chars.includes(text)

describe("with no row that wants you", () => {
  const done = [entryOf("d-1", 0, merged)]

  test("nothing is selected: the panel says Nothing needs you, until you pick a row", async () => {
    await scene(projected(done), wide, async ({ rendered }) => {
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("Up next")
      expect(panel).toContain("Nothing needs you")
      await press(rendered, "enter")
      const picked = panelOf(await rendered.capture())
      expect(picked).toContain("Needs you · 0")
      expect(picked).toContain("d-1 done")
      expect(picked).not.toContain("Nothing needs you")
      await press(rendered, "escape")
      expect(panelOf(await rendered.capture())).toContain("Nothing needs you")
    })
  })

  test("Needs you isn't among the panels until there is a row to show", async () => {
    await scene(projected(done), wide, async ({ rendered }) => {
      await press(rendered, "tab")
      // Tab has nowhere to go: the panel's frame is no heavier for it.
      const frame = await rendered.capture()
      const under = frame.chars.split("\n").findIndex((line) => line.includes("Up next")) + 1
      expect(frame.chars.split("\n")[under]).not.toContain("┏")
      expect(frame.chars.split("\n")[under]).toContain("╭")
    })
  })

  test("a card's request isn't said to be nothing", async () => {
    const working = entryOf("w-1", 0, TicketPhase.Working(), { worker: 1 })
    const view = project({
      ledger: { tickets: new Map([[working.ticket, working]]), rows: 1, windDown: null, bugs: [] },
      workers: new Map([[working.ticket, WS.Idle({ at: began })]]),
      requests: [
        {
          id: "r1",
          ticket: "w-1" as TicketId,
          kind: { _tag: "Permission", tool: "Bash", input: {}, suggestions: [], summary: "ls" },
          displayName: "Bash",
          defaultToNo: false,
          suppressAlwaysAllowRule: false,
          createdAt: began,
        },
      ],
      status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 4 },
      actions: new Map(),
    })
    await scene(view, wide, async ({ rendered }) => {
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("Up next")
      expect(panel).not.toContain("Nothing needs you")
    })
  })
})

describe("each kind of row's detail", () => {
  const picked = async (entry: Entry, status: Partial<Status> = {}) => {
    let panel = ""
    await scene(projected([entry], status), wide, async ({ rendered }) => {
      await press(rendered, "enter")
      panel = panelOf(await rendered.capture())
    })
    return panel
  }

  test("a Blocked row: files, worktree, why it was set aside, what to run, what comes next", async () => {
    const panel = await picked(
      entryOf("b-1", 0, conflict, {
        about: {
          worktree: "/w/b-1",
          files: ["loop.ts"],
          reason: "2 hand-backs used",
        },
      }),
    )
    expect(panel).toContain("b-1 blocked: MERGE_CONFLICT")
    expect(panel).toContain("git rebase batch in /w/b-1")
    expect(panel).toContain("loop.ts")
    expect(panel).toContain("Set aside: 2 hand-backs used")
    expect(panel).toContain("Press h to hand it back")
    expect(panel).toContain("The run takes it back")
    // A short panel cuts the rest, and says how to read it all.
    expect(panel).toContain("reads it all")
  })

  test("an Asked row: its question and options", async () => {
    const panel = await picked(entryOf("a-1", 0, asked))
    expect(panel).toContain("Which flag name?")
    expect(panel).toContain("q-1 · a-1 waits on it")
    expect(panel).toContain("1 Use --flag")
    expect(panel).toContain("2 Use --other")
  })

  test("an answered row: it resumes at the next free slot", async () => {
    const panel = await picked(entryOf("a-1", 0, asked), { answered: new Set(["q-1"]) })
    expect(panel).toContain("a-1 answered")
    expect(panel).toContain("it resumes at the next free slot")
  })

  test("a deferred row: triage's verdict and bd undefer", async () => {
    const panel = await picked(entryOf("s-1", 0, TicketPhase.Deferred({ why: "by the worker" })), {
      verdicts: new Map([["s-1", "environment · high · retry it"]]),
    })
    expect(panel).toContain("s-1 deferred: by the worker")
    expect(panel).toContain("◆ environment · high · retry it")
    expect(panel).toContain("Run bd undefer s-1 to bring it back.")
  })

  test("a deferred row whose setup failed: that log's path too", async () => {
    const why = "its setup failed on its branch"
    const panel = await picked(
      entryOf("s-1", 0, TicketPhase.Deferred({ why }), {
        checkLog: "/repo/.tutti/run/workers/s-1/checks/setup-1.log",
      }),
    )
    expect(panel).toContain("Check log: /repo/.tutti/run/workers/s-1/checks/setup-1.log")
    expect(panel).toContain("Run bd undefer s-1 to bring it back.")
  })

  test("a row left for review: its check log's path, and no bd undefer", async () => {
    const review = TicketPhase.Review({ why: "CHECKS_FAILED" })
    const panel = await picked(
      entryOf("r-1", 0, review, { checkLog: "/repo/.tutti/run/workers/r-1/checks/fast-1.log" }),
    )
    expect(panel).toContain("r-1 review: CHECKS_FAILED")
    expect(panel).toContain("Check log: /repo/.tutti/run/workers/r-1/checks/fast-1.log")
    expect(panel).not.toContain("bd undefer")
  })

  test("a done row: its merge commit and time", async () => {
    const panel = await picked(entryOf("d-1", 0, merged))
    expect(panel).toContain("d-1 done")
    expect(panel).toContain(`Merged as 0c1a9e7 into batch at ${clock(began)}.`)
  })

  test("a row closed with no change: when", async () => {
    const none = TicketPhase.Done({ outcome: Finished.NoChange() })
    expect(await picked(entryOf("d-1", 0, none))).toContain(
      `No change to merge; closed at ${clock(began)}.`,
    )
  })

  test("a stopped row: what comes of it", async () => {
    const panel = await picked(entryOf("t-1", 0, TicketPhase.Stopped({ why: "PAUSED" })))
    expect(panel).toContain("t-1 stopped: PAUSED")
    expect(panel).toContain("The next run resumes it.")
  })
})

describe("a pane too narrow for the panel", () => {
  test("Enter on a row opens the same detail in a box, Esc closing it", async () => {
    const view = projected([entryOf("d-1", 0, merged)])
    await scene(view, narrow, async ({ commands, rendered }) => {
      await press(rendered, "enter", "enter")
      const box = await rendered.capture()
      expect(has(box, "d-1 done")).toBe(true)
      expect(has(box, `Merged as 0c1a9e7 into batch at ${clock(began)}.`)).toBe(true)
      expect(has(box, "Esc close")).toBe(true)
      expect(has(box, "open its worker view")).toBe(false)
      // With no worker, Enter does nothing.
      await press(rendered, "enter")
      expect(taken(commands)).toEqual([])
      await press(rendered, "escape")
      expect(has(await rendered.capture(), "Merged as 0c1a9e7")).toBe(false)
    })
  })

  test("a row with a worker's box opens its worker view on Enter", async () => {
    const stopped = TicketPhase.Stopped({ why: "PAUSED" })
    await scene(
      projected([entryOf("t-1", 0, stopped, { worker: 1 })]),
      narrow,
      async ({ commands, rendered }) => {
        await press(rendered, "enter", "enter")
        const box = await rendered.capture()
        expect(has(box, "The next run resumes it.")).toBe(true)
        expect(has(box, "open its worker view")).toBe(true)
        await press(rendered, "enter")
        expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: "t-1" as TicketId })])
      },
    )
  })

  test("Blocked and Asked rows keep their own boxes", async () => {
    await scene(projected([entryOf("b-1", 0, dirty)]), narrow, async ({ rendered }) => {
      await press(rendered, "enter", "enter")
      expect(has(await rendered.capture(), "Leave the main checkout clean")).toBe(true)
    })
  })
})

describe("the check log's path on the ledger", () => {
  test("is kept while the ticket is in Review, and goes as it leaves", async () => {
    const a = "a" as TicketId
    const idle = [init(), sessionState("running"), result(), sessionState("idle")]
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, scripts: () => ({ a: [idle] }) },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition(a, Move.Ready(), { title: "Ticket a" })
        yield* ledger.transition(a, Move.Dispatched())
        yield* ledger.transition(a, Move.Aside({ why: "CHECKS_FAILED" }), {
          checkLog: "/repo/fast-1.log",
        })
        const inReview = (yield* ledger.current).tickets.get(a)
        yield* ledger.transition(a, Move.Recheck({ place: 1 }))
        return { inReview, after: (yield* ledger.current).tickets.get(a) }
      }).pipe(Effect.provide(Ledger.layer)),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    expect(ran.exit.value.inReview?.phase._tag).toBe("Review")
    expect(ran.exit.value.inReview?.checkLog).toBe("/repo/fast-1.log")
    expect(ran.exit.value.after?.phase._tag).toBe("ToMerge")
    expect(ran.exit.value.after?.checkLog).toBeUndefined()
  })

  // Its Deferred row names the log, whether bd deferred it or, as for a ticket it can't find, not.
  test.each([
    ["a", true],
    ["ghost", false],
  ] as const)(
    "is kept as %s is set aside, deferred: %s, and goes as it comes back",
    async (id, deferred) => {
      const ticket = id as TicketId
      const idle = [init(), sessionState("running"), result(), sessionState("idle")]
      const ran = await scenario(
        { backlog: backlog().ticket("a").seeds, scripts: () => ({ a: [idle] }) },
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.transition(ticket, Move.Ready(), { title: "A ticket" })
          yield* ledger.transition(ticket, Move.Dispatched())
          const said = yield* putAside(
            { id: ticket, title: "A ticket" },
            setupFailedOnBranch({
              id: ticket,
              worktree: "/w/a",
              command: "bun install",
              how: "fails",
              output: "/repo/setup-1.log",
              commits: 2,
            }),
          )
          const aside = (yield* ledger.current).tickets.get(ticket)
          yield* ledger.transition(ticket, Move.Undeferred())
          return { said, aside, after: (yield* ledger.current).tickets.get(ticket) }
        }).pipe(Effect.provide(Ledger.layer)),
      )
      if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
      expect(ran.exit.value.said).toBe(deferred)
      expect(ran.exit.value.aside?.phase._tag).toBe("Deferred")
      expect(ran.exit.value.aside?.checkLog).toBe("/repo/setup-1.log")
      expect(ran.exit.value.after?.phase._tag).toBe("Queued")
      expect(ran.exit.value.after?.checkLog).toBeUndefined()
    },
  )

  test("a setup that failed on a ticket's branch names its log for the row", () => {
    const output = "/repo/.tutti/run/workers/s-1/checks/setup-1.log"
    const aside = setupFailedOnBranch({
      id: "s-1" as TicketId,
      worktree: "/w/s-1",
      command: "bun install",
      how: "fails",
      output,
      commits: 2,
    })
    expect(aside.checkLog).toBe(output)
  })
})
