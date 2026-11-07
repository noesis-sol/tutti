// A row's box (§ 7.2, tutti-149z.9): Enter on a row with no worker view opens the whole ticket and
// its stats over the dashboard, its scorecard or what the run knows so far, read again with bd show,
// and it scrolls with ↑↓, PgUp/PgDn and the wheel, the lines below counted, and Esc closes it.
import { describe, expect, test } from "bun:test"
import { Effect, Queue, Stream } from "effect"
import fc from "fast-check"
import { type Commands, makeCommands } from "../src/run/commands.ts"
import { EventStream } from "../src/run/eventstream.ts"
import { type Entry, emptyTallies, newAccount } from "../src/run/ledger.ts"
import { clock } from "../src/run/localTime.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { noScoring, type Score, type Scoring, scoreStep, sizeWords } from "../src/run/scorecard.ts"
import { Screen } from "../src/run/screen.ts"
import { nothingSpent, type Spent, type Sums } from "../src/run/spending.ts"
import { peerMedian, peersOf, statsOf } from "../src/run/ticketStats.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import * as TestStream from "../src/testing/EventStream.ts"
import { Root } from "../src/ui/App.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { statsLines } from "../src/ui/RowBox.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const took = began - 30 * 60_000

const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "0c1a9e7ffff" }) })

const issueOf = (description: string, more: Partial<Issue> = {}): Issue => ({
  id: "d-1" as TicketId,
  title: "Title of d-1",
  description,
  design: "",
  acceptance: "",
  notes: "",
  status: "closed",
  priority: 2,
  type: "feature",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "",
  closeReason: "",
  ...more,
})

const entryOf = (ticket: string, row: number, phase: Entry["phase"], more: Partial<Entry> = {}) =>
  ({
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
    account: { ...newAccount(), took },
    ...more,
  }) satisfies Entry

const scoreOf = (ticket: string, more: Partial<Score> = {}): Score => ({
  kind: "score",
  ticket,
  outcome: "merged",
  phase: "Done",
  verifier: { rounds: 2, passed: 1, failed: 1, last: "pass", last_fix_verified: true },
  hand_backs: { resolve: 1, fix: 2 },
  resolving: 125,
  fixing: 61,
  working: 754,
  seconds: 1800,
  checks: { failed: 3, timed_out: 4 },
  flaky: 5,
  denied: 6,
  asked: 7,
  cost_usd: 1.5,
  size: 3,
  follow_ups: ["f-1"],
  reverts: ["abc1234"],
  ...more,
})

const scoringOf = (...scores: ReadonlyArray<Score>): Scoring => ({
  tallies: new Map(),
  scores: new Map(scores.map((each) => [each.ticket, each])),
})

const sumsOf = (spent: Record<string, Partial<Spent>>): Sums => ({
  tickets: new Map(Object.entries(spent).map(([key, each]) => [key, { ...nothingSpent, ...each }])),
  total: nothingSpent,
})

const projected = (tickets: ReadonlyArray<Entry>, status: Partial<Status> = {}): RunView =>
  project({
    ledger: {
      tickets: new Map(tickets.map((each) => [each.ticket, each])),
      rows: tickets.length,
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
      concurrency: 4,
      ...status,
    },
    actions: new Map(),
  })

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands)).map((each) => each._tag)

const has = (frame: Frame, text: string) => frame.chars.includes(text)

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "escape") await pressEscape(setup)
      else if (key === "up" || key === "down") setup.mockInput.pressArrow(key)
      else if (key === "pagedown" || key === "pageup") {
        setup.mockInput.pressKey(key === "pagedown" ? "\x1b[6~" : "\x1b[5~")
        // The parser's wait for what may follow an escape sequence's start.
        await Bun.sleep(30)
      }
    }
  })

const scene = async (
  start: RunView,
  size: { readonly width: number; readonly height: number },
  body: (at: { readonly commands: Commands; readonly rendered: Rendered }) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  const value = {
    view: external(start),
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 3_600_000,
  }
  await withRender(<Root value={value} />, size, (rendered) => body({ commands, rendered }))
}

const wide = { width: 155, height: 50 }
const least = { width: 60, height: 16 }

const longTicket = issueOf(Array.from({ length: 80 }, (_, i) => `paragraph line ${i}`).join("\n\n"))

/** What is drawn of the box's frame's lines, the frame left out, to look for a figure in. */
const unframed = (frame: Frame) => frame.chars.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ")

describe("Enter on a done row", () => {
  const view = projected(
    [
      entryOf("d-1", 0, merged, {
        issue: issueOf("What is *wanted* of it.", {
          design: "How it goes.",
          acceptance: "- It works",
          notes: "Noted during the run.",
          labels: ["ui"],
          parent: "p-1" as TicketId,
        }),
      }),
    ],
    {
      scoring: scoringOf(scoreOf("d-1"), scoreOf("o-1", { working: 100, cost_usd: 0.5 })),
      spending: sumsOf({
        "d-1": {
          turns: 32,
          tokens: { m: { input: 1000, output: 0, cache_write: 0, cache_read: 0 } },
        },
        "o-1": {
          turns: 10,
          tokens: { m: { input: 500, output: 0, cache_write: 0, cache_read: 0 } },
        },
      }),
    },
  )

  test("shows the panel's words, the whole ticket and its scorecard's fields", async () => {
    await scene(view, wide, async ({ commands, rendered }) => {
      await press(rendered, "enter", "enter")
      const box = await rendered.capture()
      expect(taken(commands)).toEqual(["ReadTicket"])
      const text = unframed(box)
      for (const said of [
        "d-1 done",
        "Title of d-1",
        `Merged as 0c1a9e7 into batch at ${clock(began)}.`,
        "feature · P2",
        "What is *wanted* of it.",
        "Design",
        "How it goes.",
        "It works",
        "Noted during the run.",
        "parent p-1",
        "ui",
        "Stats",
        "Outcome merged",
        `Dispatched ${clock(took)}`,
        `Merged ${clock(began)} as 0c1a9e7 into batch`,
        "Verifier 2 rounds: 1 passed, 1 failed; last PASS",
        "Hand-backs 1 to resolve (2m05s), 2 to fix (1m01s)",
        "Merge checks 3 failed, 4 timed out",
        "FLAKY tests 5",
        "Denied calls 6",
        "Questions 7",
        `Size ${sizeWords(3)}; median of 1 other of the size in the run`,
        "Working 12m34s (median 1m40s)",
        "Turns 32 (median 10)",
        "Tokens 1k (median 500)",
        "Cost $1.50 (median $0.50)",
        "Follow-ups f-1",
        "Reverts abc1234",
      ]) {
        expect(text).toContain(said)
      }
      await press(rendered, "escape")
      expect(has(await rendered.capture(), "Stats")).toBe(false)
    })
  })

  test("a set-aside row says when and why", async () => {
    const aside = projected(
      [
        entryOf("s-1", 0, TicketPhase.Deferred({ why: "no way forward" }), {
          issue: issueOf("Its description."),
        }),
      ],
      {
        scoring: scoringOf(
          scoreOf("s-1", { outcome: "set_aside", phase: "Deferred", why: "no way forward" }),
        ),
      },
    )
    await scene(aside, wide, async ({ rendered }) => {
      await press(rendered, "enter", "enter")
      const text = unframed(await rendered.capture())
      expect(text).toContain("Outcome set aside: no way forward")
      expect(text).toContain(`Set aside ${clock(began)}: no way forward`)
      expect(text).toContain("Its description.")
    })
  })

  test("what RunView has shows until bd answers, and what it brings then", async () => {
    const start = entryOf("d-1", 0, merged)
    const value = external(projected([start]))
    const commands = Effect.runSync(makeCommands)
    await withRender(
      <Root
        value={{
          view: value,
          screen: external<Screen>(Screen.Dashboard()),
          commands,
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => began,
        }}
      />,
      wide,
      async (rendered) => {
        await press(rendered, "enter", "enter")
        expect(has(await rendered.capture(), "Reading the ticket…")).toBe(true)
        expect(taken(commands)).toEqual(["ReadTicket"])
        await rendered.input(() =>
          value.set(projected([{ ...start, issue: issueOf("Read.", { notes: "Added since." }) }])),
        )
        const read = await rendered.capture()
        expect(has(read, "Reading the ticket…")).toBe(false)
        expect(has(read, "Added since.")).toBe(true)
      },
    )
  })
})

describe("scrolling", () => {
  // One worker's room in Current: the table has its place at the minimum size too.
  const view = projected([entryOf("d-1", 0, merged, { issue: longTicket })], { concurrency: 1 })
  const moreOf = (frame: Frame) => Number(/↓ (\d+) more lines?/.exec(frame.chars)?.[1] ?? 0)

  test("the keys and the wheel move it, the lines below counted, and Esc closes it", async () => {
    await scene(view, wide, async ({ rendered }) => {
      await press(rendered, "enter", "enter")
      const opened = await rendered.capture()
      const at = moreOf(opened)
      expect(at).toBeGreaterThan(50)
      expect(has(opened, "paragraph line 0")).toBe(true)
      await press(rendered, "down")
      const down = moreOf(await rendered.capture())
      expect(down).toBe(at - 1)
      await press(rendered, "up")
      expect(moreOf(await rendered.capture())).toBe(at)
      await press(rendered, "pagedown")
      const paged = await rendered.capture()
      expect(moreOf(paged)).toBeLessThan(at - 10)
      expect(has(paged, "paragraph line 0\n")).toBe(false)
      await press(rendered, "pageup")
      expect(moreOf(await rendered.capture())).toBe(at)
      await rendered.input(async (setup) => {
        await setup.mockMouse.scroll(77, 25, "down")
        await Bun.sleep(30)
      })
      expect(moreOf(await rendered.capture())).toBeLessThan(at)
      // To the end: the stats are there, and no more lines below.
      for (let i = 0; i < 10; i++) await press(rendered, "pagedown")
      const end = await rendered.capture()
      expect(has(end, "more line")).toBe(false)
      expect(has(end, "Reverts")).toBe(true)
      await press(rendered, "escape")
      expect(has(await rendered.capture(), "Reverts")).toBe(false)
    })
  })

  // The table has no room at the minimum size, so the box comes to it from a pane that was larger.
  test("at the minimum size it keeps within the pane and scrolls", async () => {
    await scene(view, { width: 100, height: 40 }, async ({ rendered }) => {
      await press(rendered, "enter", "enter")
      await rendered.input((setup) => setup.resize(least.width, least.height))
      const opened = await rendered.capture()
      const lines = opened.chars.split("\n")
      expect(has(opened, "d-1 done")).toBe(true)
      expect(has(opened, "Esc close")).toBe(true)
      expect(lines.some((line) => line.includes("╭─ Ticket"))).toBe(true)
      expect(lines.some((line) => /more lines ─╯/.test(line))).toBe(true)
      const at = moreOf(opened)
      expect(at).toBeGreaterThan(0)
      await press(rendered, "pagedown")
      expect(moreOf(await rendered.capture())).toBeLessThan(at)
      await press(rendered, "escape")
      expect(has(await rendered.capture(), "Esc close")).toBe(false)
    })
  })

  test("a short ticket has no count", async () => {
    const short = projected([entryOf("d-1", 0, merged, { issue: issueOf("Short.") })])
    await scene(short, wide, async ({ rendered }) => {
      await press(rendered, "enter", "enter")
      const box = await rendered.capture()
      expect(has(box, "more line")).toBe(false)
      expect(has(box, "Short.")).toBe(true)
    })
  })

  // <markdown> lays a table out in more lines than it has as written.
  test("it takes the pane's whole height, whatever the ticket, a table's lines all reachable", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `| ${i} | value ${i} |`).join("\n")
    const table = `Before.\n\n| key | value |\n|---|---|\n${rows}\n\nAfter.`
    for (const issue of [issueOf("Short."), issueOf(table)]) {
      const tall = projected([entryOf("d-1", 0, merged, { issue })])
      await withRender(
        <Root
          value={{
            view: external(tall),
            screen: external<Screen>(Screen.Dashboard()),
            commands: Effect.runSync(makeCommands),
            appearance: external<Appearance>("dark"),
            themeOf,
            now: () => began,
          }}
        />,
        { width: 155, height: 60 },
        async (rendered) => {
          await press(rendered, "enter", "enter")
          const box = await rendered.capture()
          const lines = box.chars.trimEnd().split("\n")
          expect(lines[0]).toContain("╭─ Ticket")
          expect(lines[59]).toContain("╯")
          if (has(box, "Reverts")) return
          for (let i = 0; i < 5; i++) await press(rendered, "pagedown")
          expect(has(await rendered.capture(), "Reverts")).toBe(true)
        },
        { treeSitter: "real" },
      )
    }
  })
})

describe("a ticket still going", () => {
  const working = entryOf("w-1", 0, TicketPhase.Working(), {
    worker: 1,
    account: {
      ...newAccount(),
      took,
      spentIn: { working: 60_000, resolving: 30_000 },
      handBacks: { resolve: 1, fix: 0 },
    },
    issue: issueOf("Still going."),
  })
  const scoring = (["began", "ended"] as const).reduce(
    (now, detail) =>
      scoreStep(
        now,
        {
          kind: "verifier",
          ticket: "w-1",
          detail,
          ...(detail === "ended" ? { verdict: "fail" } : {}),
        },
        took,
      ),
    noScoring,
  )

  test("its figures are what the run knows so far, and its time goes on", () => {
    const [row] = projected([working], {
      scoring,
      spending: sumsOf({ "w-1": { turns: 3, costUsd: 0.25 } }),
    }).rows
    if (row === undefined) throw new Error("no row")
    expect(row.stats.outcome).toBeNull()
    expect(row.stats.verifier.failed).toBe(1)
    expect(row.stats.handBacks.resolve).toBe(1)
    const text = statsLines(row, [], theme, 68, row.since + 5_000)
      .map((line) => line.map((each) => each.text).join(""))
      .join(" ")
      .replace(/\s+/g, " ")
    expect(text).toContain("Outcome under way")
    expect(text).toContain("Verifier 1 round: 0 passed, 1 failed; last FAIL")
    expect(text).toContain("Hand-backs 1 to resolve (30s), 0 to fix (0s)")
    expect(text).toContain("Working 1m05s")
    expect(text).toContain("Turns 3")
    expect(text).toContain("Cost $0.25")
    expect(text).toContain("Size footprint unknown; no other ticket of the size scored yet")
  })

  test("a dollar on a subscription is an estimate", () => {
    const [row] = projected([working], {
      subscription: true,
      spending: sumsOf({ "w-1": { costUsd: 0.25 } }),
    }).rows
    if (row === undefined) throw new Error("no row")
    const text = statsLines(row, [], theme, 68, row.since)
      .map((line) => line.map((each) => each.text).join(""))
      .join("\n")
    expect(text).toContain("≈$0.25")
  })

  test("one ended with no score yet says how it ended, and its time has stopped", () => {
    const stats = statsOf(entryOf("d-1", 0, merged), noScoring, sumsOf({}), false)
    expect(stats.outcome).toBe("merged")
    expect(stats.counting).toBeNull()
  })

  test("the score of an earlier end isn't its figures once it has come back", () => {
    const stats = statsOf(working, scoringOf(scoreOf("w-1")), sumsOf({}), false)
    expect(stats.outcome).toBeNull()
    expect(stats.flaky).toBe(0)
  })

  test("in a pane with no panel, Enter on its box opens its worker view", async () => {
    const stopped = entryOf("w-1", 0, TicketPhase.Stopped({ why: "PAUSED" }), { worker: 1 })
    await scene(
      projected([stopped]),
      { width: 100, height: 40 },
      async ({ commands, rendered }) => {
        await press(rendered, "enter", "enter")
        expect(has(await rendered.capture(), "open its worker view")).toBe(true)
        expect(taken(commands)).toEqual(["ReadTicket"])
        await press(rendered, "enter")
        expect(taken(commands)).toEqual(["OpenWorker"])
      },
    )
  })
})

describe("the median", () => {
  const peers = peersOf(
    scoringOf(
      scoreOf("a", { size: 2, working: 10, cost_usd: 1 }),
      scoreOf("b", { size: 3, working: 30, cost_usd: 3 }),
      scoreOf("c", { size: 20, working: 500 }),
      scoreOf("d", { size: 3, working: 1000, cost_usd: 9 }),
    ),
    sumsOf({ a: { turns: 2 }, b: { turns: 4 } }),
  )

  test("is of the others of its size class, not of itself", () => {
    expect(peerMedian(peers, "d", 2)).toEqual({
      tickets: 2,
      working: 20,
      turns: 3,
      tokens: 0,
      costUsd: 2,
    })
  })

  test("is none with no other of its size", () => {
    expect(peerMedian(peers, "c", 20)).toBeNull()
    expect(peerMedian(peers, "a", null)).toBeNull()
  })
})

describe("what a worker wrote", () => {
  const text = fc.string({
    unit: fc.constantFrom("a", " ", "\x1b]0;x\x07", "\x9b", "\n", "é", "漢"),
  })

  test("is sanitised, one line a figure, and keeps within the box", () => {
    fc.assert(
      fc.property(
        text,
        text,
        text,
        fc.integer({ min: 8, max: 80 }),
        (why, follow, revert, width) => {
          const [row] = projected([entryOf("d-1", 0, merged)], {
            scoring: scoringOf(scoreOf("d-1", { why, follow_ups: [follow], reverts: [revert] })),
          }).rows
          if (row === undefined) throw new Error("no row")
          for (const line of statsLines(row, [], theme, width, began)) {
            expect(widthOf(line)).toBeLessThanOrEqual(width)
            // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is sought
            expect(line.map((each) => each.text).join("")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
          }
        },
      ),
    )
  })
})

describe("the EventStream", () => {
  test("publishes the run's scoring as it changes", async () => {
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventStream
          yield* events.emit({ kind: "score_update", ticket: "t-1", follow_up: "f-1" })
          return yield* events.scorings.pipe(Stream.take(1), Stream.runCollect)
        }).pipe(Effect.provide(TestStream.layer())),
      ),
    )
    expect([...seen][0]?.tallies.get("t-1")?.followUps).toEqual(["f-1"])
  })
})
