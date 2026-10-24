// The dashboard's title line, totals strip and tickets table (§ 5.1, § 7.2, § 7.11): frames at a
// narrow, a 120-column and the minimum size, a row for each phase and activity in its style, the
// banners, the table's place and height, and the 3-second tick of the run's time.
import { describe, expect, spyOn, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { Effect } from "effect"
import fc from "fast-check"
import { act } from "react"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { type Activity, Outcome, TicketPhase, WaitFor } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { dashboardLayout, warningLines } from "../src/ui/Dashboard.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { fewestTableLines, ticketsLines } from "../src/ui/TicketsTable.tsx"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { totalsLines } from "../src/ui/Totals.tsx"
import { type Appearance, makeTheme, orchestra, type StyleName } from "../src/ui/theme.ts"
import { external, type Settable, type ShellValue, tick } from "../src/ui/useRunView.ts"
import { type Frame, renderFrame, type Size, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

// Local times, as the banners' clock shows them.
const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + (18 * 60 + 40) * 1000
const resets = new Date(2026, 9, 20, 14, 5).getTime()

const entry = (ticket: string, title: string, phase: TicketPhase, row: number | null): Entry => ({
  ticket,
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

/** RunView for `entries`, taken up in that order, the run on batch/2026-10-20 with 3 workers. */
const viewOf = (entries: ReadonlyArray<Entry>, status: Partial<Status> = {}): RunView =>
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
      branch: "batch/2026-10-20",
      began,
      concurrency: 3,
      ...status,
    },
  })

const value = (view: RunView | Settable<RunView>, clock: () => number = () => now): ShellValue => ({
  view: "get" in view ? view : external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: clock,
})

/** The frame's lines, their trailing spaces left out. */
const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((_, i, all) => i < all.length - 1 || all[i] !== "")

const draw = async (view: RunView, size: Size) => {
  const frame = await renderFrame(<Root value={value(view)} />, size)
  return { frame, text: `\n${linesOf(frame).join("\n")}\n` }
}

/** The first span holding `text`: its colour and its attributes. */
const spanOf = (frame: Frame, text: string) => {
  const span = frame.spans.lines.flatMap((line) => line.spans).find((s) => s.text.includes(text))
  if (span === undefined) throw new Error(`no span holds ${text}`)
  return { fg: span.fg.toInts().slice(0, 3), attributes: span.attributes }
}

/** What a span drawn in `style` holds: the style's colour, or the default's, and its attributes. */
const looksLike = (frame: Frame, text: string, style: StyleName) => {
  const span = spanOf(frame, text)
  const drawn = theme.styles[style]
  expect(span.attributes & (TextAttributes.BOLD | TextAttributes.DIM)).toBe(drawn.attributes)
  if (drawn.fg !== undefined) expect(span.fg).toEqual(drawn.fg.toInts().slice(0, 3))
}

const merged = (commit: string) => TicketPhase.Done({ outcome: Outcome.Merged({ commit }) })

/** The run as § 7.2's illustration shows it. */
const illustrated = viewOf(
  [
    entry("tut-dwv", "Lay out the property panel", merged("ffd6ce4a1b2c3"), 0),
    entry(
      "tut-kco",
      "Open the property model: Interpolatable protocol and custom key-path properties",
      TicketPhase.Merging({ step: "check" }),
      1,
    ),
    entry(
      "tut-zq4",
      "Add an undo stack for property edits",
      TicketPhase.Working({ activity: "testing" }),
      2,
    ),
    entry("tut-9a1", "Remove the build cache", TicketPhase.Working({ activity: "allow" }), 3),
    entry("tut-vzg", "Animate the timeline", TicketPhase.Deferred({ why: "BAD_TICKET_ID" }), 4),
    entry("tut-q1", "A ticket in the queue", TicketPhase.Queued(), null),
    entry("tut-q2", "A ticket held back", TicketPhase.HeldBack({ why: "overlap" }), null),
  ],
  {
    scope: "tut-8f2",
    usage: { utilization: 0.85, resetsAt: resets },
    unclosed: 16,
    verdicts: new Map([["tut-vzg", "environment · high · prompt never submitted"]]),
  },
)

describe("frames", () => {
  test("80 columns", async () => {
    const { text } = await draw(illustrated, { width: 80, height: 24 })
    expect(text).toMatchInlineSnapshot(`
      "

       Tutti  0.1.0   batch/2026-10-20 · 18m40s · ticket tu…  usage 85% · resets 14:05

       ▶ 2 of 3 workers
      ╭───────────────┬───────────────┬─────────────┬────────────────────────────────╮
      │ ✓ 1 Completed │ ↷ 1 Set aside │ 1 Needs you │ 1 of 16 In queue · 1 held back │
      ╰───────────────┴───────────────┴─────────────┴────────────────────────────────╯
        Tickets
      ╭─────────────┬─────────┬──────────────────────────────────────────────────────╮
      │             │ +3      │ earlier tickets, see the log                         │
      │ ■ allow?    │ tut-9a1 │ Remove the build cache                               │
      │ ↷ deferred  │ tut-vzg │ ◆ environment · high · prompt never submitted        │
      ╰─────────────┴─────────┴──────────────────────────────────────────────────────╯
        Current
      ╭──────────────────────────────────────────────────────────────────────────────╮
      │ ⣾ picking the next ticket…                                                   │
      ╰──────────────────────────────────────────────────────────────────────────────╯






        s stop after current · ? keys
      "
    `)
  })

  test("120 columns", async () => {
    const { text } = await draw(illustrated, { width: 120, height: 30 })
    expect(text).toMatchInlineSnapshot(`
      "

       Tutti  0.1.0   batch/2026-10-20 · 18m40s · ticket tut-8f2                                      usage 85% · resets 14:05

       ▶ 2 of 3 workers
      ╭───────────────────────┬─────────────────────────────┬───────────────────────┬────────────────────────────────────────╮
      │ ✓ 1 Completed         │ ↷ 1 Set aside · ◆ 1 triaged │ 1 Needs you           │ 1 of 16 In queue · 1 held back         │
      ╰───────────────────────┴─────────────────────────────┴───────────────────────┴────────────────────────────────────────╯
        Tickets
      ╭─────────────┬─────────┬──────────────────────────────────────────────────────────────────────────────────────────────╮
      │ ✓ done      │ tut-dwv │ ffd6ce4 merged into batch/2026-10-20                                                         │
      │ ◆ merging   │ tut-kco │ Open the property model: Interpolatable protocol and custom key-path properties              │
      │ ▶ testing   │ tut-zq4 │ Add an undo stack for property edits                                                         │
      │ ■ allow?    │ tut-9a1 │ Remove the build cache                                                                       │
      │ ↷ deferred  │ tut-vzg │ ◆ environment · high · prompt never submitted                                                │
      │             │         │                                                                                              │
      │             │         │                                                                                              │
      ╰─────────────┴─────────┴──────────────────────────────────────────────────────────────────────────────────────────────╯
        Current
      ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
      │ ⣾ picking the next ticket…                                                                                           │
      ╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯








        s stop after current · ? keys
      "
    `)
  })

  test("the minimum size, 60×16, which has no room for the table", async () => {
    const { text } = await draw(illustrated, { width: 60, height: 16 })
    expect(text).toMatchInlineSnapshot(`
      "

       Tutti  0.1.0   batch/2026-10-20 …  usage 85% · resets 14:05

       ▶ 2 of 3 workers
       ✓ 1 · ↷ 1 ◆ 1 · ? 1 · queue 1 of 16 · 1 held back
        Current
      ╭──────────────────────────────────────────────────────────╮
      │ ⣾ picking the next ticket…                               │
      ╰──────────────────────────────────────────────────────────╯






        s stop after current · ? keys
      "
    `)
  })

  test("below the minimum size, only the totals on one line and the hint", async () => {
    for (const size of [
      { width: 59, height: 24 },
      { width: 80, height: 15 },
    ]) {
      const { text } = await draw(illustrated, size)
      const lines = text.trim().split("\n")
      expect(lines[0]).toBe("✓ 1 · ↷ 1 ◆ 1 · ? 1 · ▶ 2/3 · queue 1 of 16 · 1 held back")
      expect(lines.at(-1)).toBe("  s stop after current · ? keys")
      expect(lines.filter((line) => line !== "")).toHaveLength(2)
    }
  })

  test("a run's warnings, each once, on the warning line above the hint", async () => {
    const warning =
      "colour scheme 'dusk' isn't used: 'colours.frame': 'ansi:300' is not a palette slot (0–255)"
    const view = viewOf([], { warnings: [warning, warning] })
    const { frame, text } = await draw(view, { width: 120, height: 24 })
    const lines = text.trim().split("\n")
    expect(lines.at(-2)).toBe(` ! ${warning}`)
    expect(lines.filter((line) => line.includes("!"))).toHaveLength(1)
    looksLike(frame, "colour scheme", "deferred")
  })
})

describe("the title line", () => {
  const title = async (status: Partial<Status>, width = 100) => {
    const { frame, text } = await draw(viewOf([], status), { width, height: 24 })
    return { frame, line: text.split("\n")[2] ?? "" }
  }

  test("the pill, the version faint, the branch, the run's time and the scope faint", async () => {
    const { frame, line } = await title({ scope: "tut-8f2" })
    expect(line).toBe(" Tutti  0.1.0   batch/2026-10-20 · 18m40s · ticket tut-8f2")
    looksLike(frame, " Tutti ", "title")
    looksLike(frame, "0.1.0", "dim")
    looksLike(frame, "18m40s", "dim")
  })

  test("· stopping, and the solo ticket next or running", async () => {
    const stopping = await title({ stopping: true })
    expect(stopping.line).toStartWith(" Tutti  0.1.0  · stopping   batch/2026-10-20")
    looksLike(stopping.frame, "· stopping", "stop")
    const next = await title({ solo: { ticket: "tut-s1", running: false } })
    expect(next.line).toStartWith(" Tutti  0.1.0  · solo tut-s1 next   batch")
    looksLike(next.frame, "· solo tut-s1 next", "deferred")
    const running = await title({ solo: { ticket: "tut-s1", running: true } })
    expect(running.line).toStartWith(" Tutti  0.1.0  · solo tut-s1 running   batch")
    looksLike(running.frame, "· solo tut-s1 running", "picked")
  })

  test("the usage banner on the right, notice, and bold once the limit is reached", async () => {
    const below = await title({ usage: { utilization: 0.85, resetsAt: resets } })
    expect(below.line).toEndWith(`18m40s${" ".repeat(35)}usage 85% · resets 14:05`)
    expect(below.line).toHaveLength(100)
    looksLike(below.frame, "usage 85%", "deferred")
    const reached = await title({ usage: { utilization: 1, resetsAt: null } })
    expect(reached.line).toEndWith("usage 100%")
    looksLike(reached.frame, "usage 100%", "testing")
  })

  test("the holds' banners: BLOCKED needsYou bold, the usage limit's notice bold", async () => {
    const { frame, line } = await title({
      holds: [
        { word: "BLOCKED", resetsAt: null },
        { word: "USAGE_LIMIT", resetsAt: resets },
      ],
    })
    expect(line).toEndWith("BLOCKED  USAGE_LIMIT · resets 14:05")
    looksLike(frame, "BLOCKED", "stop")
    looksLike(frame, "USAGE_LIMIT", "testing")
  })

  test("a narrow pane cuts the branch and the time, then drops them, keeping the banners", async () => {
    const holds = [{ word: "BLOCKED", resetsAt: null }]
    expect((await title({ holds }, 60)).line).toBe(
      ` Tutti  0.1.0   batch/2026-10-20 · 18m40s${" ".repeat(12)}BLOCKED`,
    )
    const cut = await title(
      { holds, stopping: true, solo: { ticket: "tut-s1", running: true } },
      60,
    )
    expect(cut.line).toBe(" Tutti  0.1.0  · stopping  · solo tut-s1 running     BLOCKED")
  })

  test("the run's time is drawn anew every 3 seconds", async () => {
    const intervals = spyOn(globalThis, "setInterval")
    let clock = now
    try {
      await withRender(
        <Root value={value(viewOf([]), () => clock)} />,
        { width: 80, height: 24 },
        async (rendered) => {
          expect((await rendered.capture()).chars).toContain("18m40s")
          const ticking = intervals.mock.calls.find(([, delay]) => delay === tick)?.[0]
          if (typeof ticking !== "function") throw new Error("nothing ticks every 3 seconds")
          clock += 3000
          await act(async () => ticking())
          expect((await rendered.capture()).chars).toContain("18m43s")
        },
      )
    } finally {
      intervals.mockRestore()
    }
    expect(tick).toBe(3000)
  })
})

describe("the totals strip", () => {
  test("zeros faint whole, the counts in their styles, their labels faint, ◆ triaged, held back and held", async () => {
    const { frame, text } = await draw(illustrated, { width: 120, height: 30 })
    looksLike(frame, " Completed", "dim")
    looksLike(frame, "✓ 1", "closed")
    looksLike(frame, "↷ 1", "deferred")
    looksLike(frame, " · ◆ 1 triaged", "organ")
    looksLike(frame, " Needs you", "dim")
    looksLike(frame, " of 3", "dim")
    looksLike(frame, " of 16", "dim")
    looksLike(frame, " In queue", "dim")
    looksLike(frame, " · 1 held back", "heldBack")
    expect(text).not.toContain("· held ")
    const empty = await draw(viewOf([], { holds: [{ word: "BLOCKED", resetsAt: null }] }), {
      width: 80,
      height: 24,
    })
    expect(empty.text).toContain("│ 0 Completed ")
    expect(empty.text).toContain("│ 0 In queue · held ")
    looksLike(empty.frame, "0 Completed", "dim")
    looksLike(empty.frame, "0 Needs you", "dim")
    looksLike(empty.frame, "0 of 3", "dim")
    looksLike(empty.frame, " · held", "windDown")
  })
})

describe("the tickets table", () => {
  const rowOf = async (phase: TicketPhase, status: Partial<Status> = {}) => {
    const view = viewOf([entry("tut-1", "The ticket's title", phase, 0)], status)
    const { frame, text } = await draw(view, { width: 80, height: 24 })
    const line = text.split("\n").find((each) => each.includes("tut-1")) ?? ""
    return { frame, line }
  }

  const working = (activity: Activity) => TicketPhase.Working({ activity })

  test.each<readonly [string, TicketPhase, string, StyleName]>([
    ["▶ working", working("working"), "The ticket's title", "picked"],
    ["▶ editing", working("editing"), "The ticket's title", "picked"],
    ["▶ reading", working("reading"), "The ticket's title", "picked"],
    ["▶ subagent", working("subagent"), "The ticket's title", "picked"],
    ["▶ starting", working("starting"), "The ticket's title", "picked"],
    ["▶ testing", working("testing"), "The ticket's title", "testing"],
    ["▶ retrying", working("retrying"), "The ticket's title", "deferred"],
    ["◷ limit", working("limit"), "The ticket's title", "deferred"],
    ["■ allow?", working("allow"), "The ticket's title", "stop"],
    ["■ answer?", working("answer"), "The ticket's title", "stop"],
    ["◼ to merge", TicketPhase.ToMerge({ place: 2 }), "The ticket's title", "toMerge"],
    ["◆ merging", TicketPhase.Merging({ step: "rebase" }), "The ticket's title", "merging"],
    ["⟳ resolving", TicketPhase.Resolving({ attempt: 1 }), "The ticket's title", "deferred"],
    [
      "⟳ fixing",
      TicketPhase.Fixing({ attempt: 1, afterResolution: false }),
      "The ticket's title",
      "deferred",
    ],
    ["✓ done", merged("abc1234def"), "abc1234 merged into batch/2026-10-20", "closed"],
    ["✓ done", TicketPhase.Done({ outcome: Outcome.NoChange() }), "no change to merge", "closed"],
    ["? for you", TicketPhase.Asked({ question: "q-1" }), "The ticket's title", "stop"],
    [
      "◷ waiting",
      TicketPhase.Waiting({ for: WaitFor.Blockers({ ids: ["tut-2"] }) }),
      "The ticket's title",
      "dim",
    ],
    [
      "↷ deferred",
      TicketPhase.Deferred({ why: "BAD_TICKET_ID" }),
      "The ticket's title",
      "deferred",
    ],
    ["! review", TicketPhase.Review({ why: "OFF_BRANCH" }), "The ticket's title", "deferred"],
    ["■ blocked", TicketPhase.Blocked({ why: "MERGE_CONFLICT" }), "The ticket's title", "stop"],
    ["■ stopped", TicketPhase.Stopped({ why: "PAUSED" }), "The ticket's title", "stop"],
  ])("%s", async (word, phase, note, style) => {
    const { frame, line } = await rowOf(phase)
    const literal = (text: string) => text.replace(/[?]/g, "\\?")
    expect(line).toMatch(new RegExp(`^│ ${literal(word)} +│ tut-1 +│ ${note} +│$`))
    looksLike(frame, word, style)
    looksLike(frame, "tut-1", style)
  })

  test("a finished ticket's note is faint, a live one's title is not", async () => {
    looksLike((await rowOf(merged("abc1234def"))).frame, "abc1234 merged", "dim")
    looksLike(
      (await rowOf(TicketPhase.Waiting({ for: WaitFor.Blockers({ ids: ["x"] }) }))).frame,
      "The ticket's",
      "dim",
    )
    const live = spanOf((await rowOf(working("editing"))).frame, "The ticket's")
    expect(live.attributes & TextAttributes.DIM).toBe(0)
  })

  test("triage's verdict replaces a set-aside ticket's note, organ bold", async () => {
    const verdicts = new Map([["tut-1", "environment · high"]])
    for (const phase of [
      TicketPhase.Deferred({ why: "BAD_TICKET_ID" }),
      TicketPhase.Review({ why: "OFF_BRANCH" }),
    ]) {
      const { frame, line } = await rowOf(phase, { verdicts })
      expect(line).toContain("│ ◆ environment · high")
      looksLike(frame, "◆ environment", "organ")
    }
    expect((await rowOf(working("editing"), { verdicts })).line).toContain("The ticket's title")
  })

  test("rows keep their place as phases change", async () => {
    const tickets = (phases: ReadonlyArray<TicketPhase>) =>
      viewOf(phases.map((phase, i) => entry(`tut-${i + 1}`, `Ticket ${i + 1}`, phase, i)))
    const view = external(tickets([working("starting"), working("starting"), working("starting")]))
    await withRender(<Root value={value(view)} />, { width: 80, height: 24 }, async (rendered) => {
      const rows = async () =>
        linesOf(await rendered.capture())
          .filter((line) => line.includes("tut-"))
          .map((line) => line.split("│")[2]?.trim())
      expect(await rows()).toEqual(["tut-1", "tut-2", "tut-3"])
      await rendered.input(() =>
        view.set(
          tickets([
            TicketPhase.Merging({ step: "check" }),
            merged("abc1234def"),
            TicketPhase.Waiting({ for: WaitFor.Blockers({ ids: ["tut-1"] }) }),
          ]),
        ),
      )
      const frame = linesOf(await rendered.capture())
      expect(await rows()).toEqual(["tut-1", "tut-2", "tut-3"])
      expect(
        frame.filter((line) => line.includes("tut-")).map((l) => l.slice(0, 13).trimEnd()),
      ).toEqual(["│ ◆ merging", "│ ✓ done", "│ ◷ waiting"])
    })
  })

  test("its height is what Current is kept leaves, and the oldest give way to +N earlier tickets", async () => {
    // At 80 columns, the title, the strip and the foot take 9 lines, and Current is kept 16 for 3
    // workers' cards; at 16 lines the table's fewest don't fit beside a line for each worker.
    const tables = [16, 24, 30, 35, 45, 60].map(
      (height) => dashboardLayout(viewOf([]), theme, 80, height).table,
    )
    expect(tables).toEqual([0, 6, 6, 10, 13, 13])
    const many = viewOf(
      Array.from({ length: 9 }, (_, i) =>
        entry(`tut-${i + 1}`, `Ticket ${i + 1}`, merged(`c0ffee${i}abcdef`), i),
      ),
    )
    const { text } = await draw(many, { width: 80, height: 35 })
    const lines = text.split("\n")
    const top = lines.findIndex((line) => line.startsWith("╭─────────────┬"))
    // 10 lines in all: the label, the frame, and 7 rows.
    expect(lines[top - 1]).toBe("  Tickets")
    expect(lines[top + 1]).toMatch(/^│ +│ \+3 +│ earlier tickets, see the log +│$/)
    expect(lines.slice(top + 2, top + 8).map((line) => line.split("│")[2]?.trim())).toEqual([
      "tut-4",
      "tut-5",
      "tut-6",
      "tut-7",
      "tut-8",
      "tut-9",
    ])
    expect(lines[top + 8]).toStartWith("╰")
    const few = await draw(viewOf([entry("tut-1", "One", working("editing"), 0)]), {
      width: 80,
      height: 35,
    })
    const blank = few.text.split("\n").filter((line) => /^│ +│ +│ +│$/.test(line))
    expect(blank).toHaveLength(6)
  })

  test("a pane too short for it and a line a worker leaves it out", async () => {
    const view = viewOf([entry("tut-1", "One", working("editing"), 0)])
    expect((await draw(view, { width: 80, height: 19 })).text).not.toContain("Tickets")
    expect((await draw(view, { width: 80, height: 20 })).text).toContain("Tickets")
    const more = viewOf([entry("tut-1", "One", working("editing"), 0)], { concurrency: 8 })
    expect((await draw(more, { width: 80, height: 24 })).text).not.toContain("Tickets")
  })

  test("Tickets is emphasis bold, the frames in the frame role", async () => {
    const { frame } = await draw(illustrated, { width: 80, height: 24 })
    looksLike(frame, "Tickets", "tickets")
    expect(spanOf(frame, "╭───").fg).toEqual(theme.rgba("frame").toInts().slice(0, 3))
  })
})

describe("untrusted text", () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is sought
  const control = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/

  test("titles, IDs, verdicts, scopes and warnings stay on their line, in its width", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary" }),
        fc.string({ unit: "binary", minLength: 1 }),
        fc.string({ unit: "binary" }),
        fc.string({ unit: "binary" }),
        fc.integer({ min: 60, max: 160 }),
        (text, id, verdict, scope, width) => {
          const view = viewOf(
            [
              entry(id, text, TicketPhase.Deferred({ why: "BAD_TICKET_ID" }), 0),
              entry(`${id}-2`, text, TicketPhase.Working({ activity: "editing" }), 1),
            ],
            {
              branch: text,
              scope,
              verdicts: new Map([[id, verdict]]),
              warnings: [text],
              holds: [{ word: text, resetsAt: null }],
            },
          )
          const lines = [
            titleSegments(view.title, view.banners, now, theme, width),
            ...totalsLines(view.totals, theme, width, false),
            ...ticketsLines(view.rows, theme, width, { lines: fewestTableLines }),
            ...warningLines(view.warnings, theme, width),
          ]
          for (const line of lines) {
            expect(widthOf(line)).toBeLessThanOrEqual(width)
            expect(line.some((each) => control.test(each.text))).toBe(false)
          }
        },
      ),
    )
  })
})
