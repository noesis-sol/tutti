// A worker's waiting request is shown and one key away, and the focus never moves to it by itself
// (§ 4.5, § 7.3, tutti-149z.4): the oldest request's card stays heavy whichever panel has the focus,
// the hint names `g request on <id>`, and `g` goes there from any panel and level; where no buttons
// are drawn it opens the Answer box, as `Enter` on the line does.

import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type Commands, makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { sanitizeLine } from "../src/text/sanitize.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { compactShown } from "../src/ui/Card.tsx"
import { dashboardHint, dashboardLayout, targetOf } from "../src/ui/Dashboard.tsx"
import type { Panel } from "../src/ui/panelFocus.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { emptyTranscript, type TranscriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const entryOf = (
  ticket: string,
  row: number,
  phase: Entry["phase"],
  worker: number | null,
): Entry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "0c1a9e7" }) })

/** RunView over `tickets`, with `requests` open. */
const projected = (
  tickets: ReadonlyArray<Entry>,
  requests: ReadonlyArray<AttentionRequest>,
  status: Partial<Status> = {},
): RunView =>
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
    requests,
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

const workersOf = (workers: number, nameOf: (i: number) => string = (i) => `w-${i + 1}`) =>
  Array.from({ length: workers }, (_, i) => entryOf(nameOf(i), 3 + i, TicketPhase.Working(), i + 1))

/** Two done rows, a Blocked one, and `workers` cards, with `requests` open. */
const viewOf = (
  workers: number,
  requests: ReadonlyArray<AttentionRequest> = [],
  nameOf?: (i: number) => string,
): RunView =>
  projected(
    [
      entryOf("d-1", 0, merged, null),
      entryOf("d-2", 1, merged, null),
      entryOf("b-1", 2, TicketPhase.Blocked({ why: "DIRTY_TREE" }), null),
      ...workersOf(workers, nameOf),
    ],
    requests,
  )

/** q-1 is put to the maintainer in Needs you, a-1 waiting on it, beside `workers` cards. */
const askingView = (requests: ReadonlyArray<AttentionRequest>, workers = 2): RunView =>
  projected(
    [entryOf("a-1", 0, TicketPhase.Asked({ question: "q-1" }), null), ...workersOf(workers)],
    requests,
    {
      questions: new Map([
        [
          "q-1",
          {
            id: "q-1" as TicketId,
            title: "Which flag name?",
            description: "",
            options: [
              { label: "Use --flag", description: "" },
              { label: "Use --other", description: "" },
            ],
            maintainerOnly: false,
            waiting: ["a-1" as TicketId],
          },
        ],
      ]),
    },
  )

const permission = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket: ticket as TicketId,
  kind: { _tag: "Permission", tool: "Bash", input: {}, suggestions: [], summary: "ls" },
  displayName: "Bash",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const question = (id: string, ticket: string): AttentionRequest => ({
  ...permission(id, ticket),
  kind: {
    _tag: "Question",
    input: {},
    questions: [
      { question: "Which?", options: [{ label: "Keep" }, { label: "New" }], multiSelect: false },
    ],
  },
})

/** No transcript: no worker view is opened here. */
const feed: TranscriptFeed = {
  open: () => ({
    state: external(emptyTranscript),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
}

interface Scene {
  readonly view: Settable<RunView>
  readonly commands: Commands
  readonly rendered: Rendered
  /** The clock moves `millis` on, and every timer the view keeps fires. */
  readonly pass: (millis: number) => Promise<void>
}

const scene = async (
  start: RunView,
  size: { readonly width: number; readonly height: number },
  body: (at: Scene) => Promise<void>,
) => {
  const view = external(start)
  const commands = Effect.runSync(makeCommands)
  let at = began
  const timers = new Set<() => void>()
  const value = {
    view,
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => at,
    transcripts: feed,
    interval: (run: () => void) => {
      timers.add(run)
      return () => timers.delete(run)
    },
  }
  await withRender(<Root value={value} />, size, async (rendered) => {
    const pass = (millis: number) =>
      rendered.input(() => {
        at += millis
        for (const timer of timers) timer()
      })
    await body({ view, commands, rendered, pass })
  })
}

const wide = { width: 155, height: 40 }

const linesOf = (frame: Frame) => frame.chars.split("\n")

const has = (frame: Frame, text: string) => frame.chars.includes(text)

/** Whether a heavy frame, or a compact line's heavy bar, is drawn on the left of `ticket`. */
const heavyOn = (frame: Frame, ticket: string) =>
  linesOf(frame).some((line) => {
    const at = line.indexOf(`${ticket} `)
    return at !== -1 && line.slice(0, at).match(/[│┃]/g)?.at(-1) === "┃"
  })

/** The hint says the keys are inside a panel. */
const insideNow = (frame: Frame) => has(frame, "arrows select") && has(frame, "Esc back")

/** Whether a span of `text` on `frame` has the focus's fill. */
const lit = (frame: Frame, text: string): boolean =>
  frame.spans.lines.some((line) =>
    line.spans.some(
      (span) =>
        span.text.includes(text) &&
        Bun.deepEquals(span.bg.toInts(), theme.form.focusedButton.bg?.toInts()),
    ),
  )

/** The colour of the last heavy frame's corner drawn: w-2's, the last card. */
const heavyColour = (frame: Frame) =>
  frame.spans.lines
    .flatMap((line) => line.spans)
    .findLast((span) => span.text.includes("┏"))
    ?.fg.toInts()

/** The frame's text, the times the clock moves left out. */
const timeless = (frame: Frame) => frame.chars.replace(/\d+[hms]/g, "").replace(/ +/g, " ")

/** The line each section's label is on, and the hint's: none of them moves as the keys move. */
const linesAt = (frame: Frame) =>
  ["Tickets", "Current", "keys"].map((word) =>
    linesOf(frame).findIndex((line) => line.includes(word)),
  )

const answered = (commands: Commands) =>
  Effect.runSync(Queue.clear(commands)).flatMap((each) =>
    each._tag === "Answer" ? [[each.requestId, each.answer._tag]] : [],
  )

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "tab") setup.mockInput.pressTab()
      else if (key === "escape") await pressEscape(setup)
      else if (key === "left" || key === "right" || key === "up" || key === "down") {
        setup.mockInput.pressArrow(key)
      } else await setup.mockInput.typeText(key)
    }
  })

/** The keys from the start to each place g goes from, with Needs you's panel beside the table. */
const places: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["the top level of Tickets", []],
  ["inside Tickets", ["enter"]],
  ["the top level of Needs you", ["right"]],
  ["inside Needs you", ["right", "enter"]],
  ["the top level of Current", ["down"]],
  ["a card with no request, inside Current", ["tab"]],
]

const oneRequest = () => askingView([permission("r-1", "w-2")])

describe("the frame on a waiting request's card", () => {
  for (const [where, keys] of places) {
    test(`is heavy from ${where}`, async () => {
      await scene(oneRequest(), wide, async ({ rendered }) => {
        await press(rendered, ...keys)
        const frame = await rendered.capture()
        expect(heavyOn(frame, "w-2")).toBe(true)
        expect(heavyColour(frame)).toEqual(theme.look("needsYou").bold().fg?.toInts())
      })
    })
  }

  test("leaves a card with no request as it was, in the tickets table", async () => {
    await scene(oneRequest(), wide, async ({ rendered }) => {
      await press(rendered, "enter")
      expect(heavyOn(await rendered.capture(), "w-1")).toBe(false)
    })
  })

  test("goes with the request, and no card is heavy with none open", async () => {
    await scene(oneRequest(), wide, async ({ rendered, view }) => {
      await press(rendered, "enter")
      view.set(askingView([]))
      const frame = await rendered.capture()
      expect(heavyOn(frame, "w-2")).toBe(false)
      expect(heavyOn(frame, "w-1")).toBe(false)
    })
  })

  describe("with two waiting", () => {
    const two = () => askingView([permission("r-1", "w-2"), permission("r-2", "w-1")], 3)

    /** The title line of `ticket`'s card, as drawn. */
    const titleOf = (frame: Frame, ticket: string) =>
      linesOf(frame).find((line) => line.includes(`Title of ${ticket}`)) ?? ""
    const pointedAt = (frame: Frame, ticket: string) =>
      new RegExp(`▸  Title of ${ticket}`).test(titleOf(frame, ticket))

    test("is on both, from inside Tickets, where the answer keys reach neither", async () => {
      await scene(two(), wide, async ({ rendered }) => {
        await press(rendered, "enter")
        const frame = await rendered.capture()
        expect(heavyOn(frame, "w-2")).toBe(true)
        expect(heavyOn(frame, "w-1")).toBe(true)
        expect(heavyOn(frame, "w-3")).toBe(false)
        expect(pointedAt(frame, "w-1")).toBe(false)
        expect(pointedAt(frame, "w-2")).toBe(false)
      })
    })

    test("is on both, the oldest's pointed at from the top level, where d answers it", async () => {
      await scene(two(), wide, async ({ rendered, commands, pass }) => {
        const frame = await rendered.capture()
        expect(heavyOn(frame, "w-1")).toBe(true)
        expect(heavyOn(frame, "w-2")).toBe(true)
        expect(pointedAt(frame, "w-2")).toBe(true)
        expect(pointedAt(frame, "w-1")).toBe(false)
        await pass(settle)
        await press(rendered, "d")
        expect(answered(commands)).toEqual([["r-1", "Deny"]])
      })
    })

    test("is on both inside Current, the pointer on the card the keys answer", async () => {
      await scene(two(), wide, async ({ rendered, commands, pass }) => {
        await press(rendered, "tab")
        const frame = await rendered.capture()
        expect(heavyOn(frame, "w-1")).toBe(true)
        expect(heavyOn(frame, "w-2")).toBe(true)
        expect(pointedAt(frame, "w-1")).toBe(true)
        expect(pointedAt(frame, "w-2")).toBe(false)
        await pass(settle)
        await press(rendered, "d")
        expect(answered(commands)).toEqual([["r-2", "Deny"]])
      })
    })

    test("is on both beside the card the keys are on, one with no request, no pointer", async () => {
      await scene(two(), wide, async ({ rendered }) => {
        await press(rendered, "tab", "down")
        const frame = await rendered.capture()
        expect(heavyOn(frame, "w-3")).toBe(true)
        expect(heavyOn(frame, "w-2")).toBe(true)
        expect(heavyOn(frame, "w-1")).toBe(true)
        expect(pointedAt(frame, "w-1")).toBe(false)
        expect(pointedAt(frame, "w-2")).toBe(false)
      })
    })

    test("goes with each request, the pointer with the second", async () => {
      await scene(two(), wide, async ({ rendered, view }) => {
        await press(rendered, "enter")
        view.set(askingView([permission("r-2", "w-1")], 3))
        const frame = await rendered.capture()
        expect(heavyOn(frame, "w-1")).toBe(true)
        expect(heavyOn(frame, "w-2")).toBe(false)
        expect(has(frame, "▸  Title")).toBe(false)
      })
    })
  })

  test("draws no pointer with one waiting, the frame enough", async () => {
    await scene(oneRequest(), wide, async ({ rendered }) => {
      await press(rendered, "g")
      expect(has(await rendered.capture(), "▸  Title")).toBe(false)
    })
  })

  test("on compact lines is the oldest's bar, or the line the keys are on alone", async () => {
    const view = viewOf(6, [permission("r-1", "w-6"), permission("r-2", "w-1")])
    await scene(view, { width: 100, height: 28 }, async ({ rendered }) => {
      await press(rendered, "enter")
      const inTickets = await rendered.capture()
      expect(heavyOn(inTickets, "w-6")).toBe(true)
      expect(heavyOn(inTickets, "w-1")).toBe(false)
      await press(rendered, "tab")
      const onLine = await rendered.capture()
      expect(has(onLine, "[ Deny ]")).toBe(false)
      expect(heavyOn(onLine, "w-1")).toBe(true)
      expect(heavyOn(onLine, "w-6")).toBe(false)
    })
  })

  test("on a compact line keeps its line as others fold into +N more", () => {
    const view = viewOf(6, [permission("r-1", "w-6")])
    const kept = (framed: string | null) =>
      compactShown(view.cards, "w-1", 5, framed).map((card): string => card.ticket)
    expect(kept("w-6")).toEqual(["w-1", "w-6"])
    expect(kept(null)).toEqual(["w-1", "w-6"])
    const others = viewOf(6, [
      permission("r-1", "w-6"),
      permission("r-2", "w-2"),
      permission("r-3", "w-3"),
    ])
    expect(compactShown(others.cards, "w-1", 5, "w-6").map((card): string => card.ticket)).toEqual([
      "w-1",
      "w-6",
    ])
  })

  test("on a compact line is its heavy bar, from inside Tickets, and it isn't left out", async () => {
    const view = viewOf(6, [permission("r-1", "w-6")])
    await scene(view, { width: 100, height: 28 }, async ({ rendered }) => {
      await press(rendered, "enter")
      const frame = await rendered.capture()
      expect(has(frame, "■ allow?")).toBe(true)
      expect(has(frame, "[ Deny ]")).toBe(false)
      expect(insideNow(frame)).toBe(true)
      expect(heavyOn(frame, "w-6")).toBe(true)
      expect(heavyOn(frame, "w-1")).toBe(false)
    })
  })
})

describe("the hint", () => {
  for (const [where, keys] of places) {
    test(`names g and the request's ticket from ${where}`, async () => {
      await scene(oneRequest(), wide, async ({ rendered }) => {
        await press(rendered, ...keys)
        expect(has(await rendered.capture(), "g request on w-2")).toBe(true)
      })
    })
  }

  test("names it on the request's own card, too", async () => {
    await scene(oneRequest(), wide, async ({ rendered, pass }) => {
      await press(rendered, "g")
      await pass(settle)
      const frame = await rendered.capture()
      expect(insideNow(frame)).toBe(true)
      expect(has(frame, "g request on w-2")).toBe(true)
    })
  })

  test("names the oldest's ticket, the next once it is answered, and nothing with none", async () => {
    const two = askingView([permission("r-1", "w-2"), permission("r-2", "w-1")])
    await scene(two, wide, async ({ rendered, view }) => {
      expect(has(await rendered.capture(), "g request on w-2")).toBe(true)
      view.set(askingView([permission("r-2", "w-1")]))
      const next = await rendered.capture()
      expect(has(next, "g request on w-1")).toBe(true)
      expect(has(next, "g request on w-2")).toBe(false)
      view.set(askingView([]))
      expect(has(await rendered.capture(), "g request")).toBe(false)
    })
  })

  test("leaves out a request with no card, naming the oldest that has one", () => {
    const view = viewOf(1, [permission("r-1", "gone"), permission("r-2", "w-1")])
    expect(targetOf(view)).toBe("w-1")
    const named = dashboardHint(view, true).find((key) => key.keys === "g")
    expect(named?.does).toBe("request on w-1")
    const none = viewOf(1, [permission("r-1", "gone")])
    expect(dashboardHint(none, true).map((key) => key.keys)).not.toContain("g")
  })

  test("draws the ticket's ID sanitised", () => {
    const hostile = "w\x1b[31m-1"
    const view = viewOf(1, [permission("r-1", hostile)], () => hostile)
    const named = dashboardHint(view, true).find((key) => key.keys === "g")
    expect(named?.does).toBe(`request on ${sanitizeLine(hostile)}`)
    expect(named?.does).not.toContain("\x1b")
  })

  test("doesn't move the table a line as the keys move, at the widths where it wraps", () => {
    const longer = (i: number) => (i === 1 ? "w-149z.5.long" : `w-${i + 1}`)
    const held = { ...permission("r-1", "w-2"), defaultToNo: true }
    for (const [requests, nameOf] of [
      [[permission("r-1", "w-2")], undefined],
      [[question("q-1", "w-2")], undefined],
      [[held], undefined],
      [[{ ...question("q-1", "w-2"), ticket: "w-149z.5.long" as TicketId }], longer],
      [[{ ...held, ticket: "w-149z.5.long" as TicketId }], longer],
      [[question("q-1", "w-1"), permission("r-2", "w-2")], undefined],
    ] as const) {
      const view = viewOf(2, requests, nameOf)
      for (let width = 60; width <= 135; width++) {
        const at = (highlighted: string | null, panel: Panel, inside: boolean) => {
          const focus = { panel, inside }
          const laid = dashboardLayout(view, theme, width, 40, highlighted, undefined, focus)
          return [laid.table, laid.current, laid.hint.length + laid.spare]
        }
        const target = targetOf(view)
        const top = at(target, "tickets", false)
        expect(at(null, "tickets", true)).toEqual(top)
        expect(at("w-1", "current", true)).toEqual(top)
        expect(at(view.cards[1]?.ticket ?? null, "current", true)).toEqual(top)
        expect(at(target, "current", true)).toEqual(top)
      }
    }
  })

  test("doesn't move what is drawn over it as g goes in, where it wraps", async () => {
    for (const width of [70, 100, 111]) {
      const view = viewOf(2, [permission("r-1", "w-2")])
      await scene(view, { width, height: 40 }, async ({ rendered }) => {
        const before = linesAt(await rendered.capture())
        await press(rendered, "g")
        const frame = await rendered.capture()
        expect(insideNow(frame)).toBe(true)
        expect(linesAt(frame)).toEqual(before)
      })
    }
  })
})

describe("g", () => {
  for (const [where, keys] of places) {
    test(`from ${where} lands on the request's card, Deny focused`, async () => {
      await scene(oneRequest(), wide, async ({ rendered, commands, pass }) => {
        await press(rendered, ...keys, "g")
        const frame = await rendered.capture()
        expect(insideNow(frame)).toBe(true)
        expect(heavyOn(frame, "w-2")).toBe(true)
        expect(heavyOn(frame, "w-1")).toBe(false)
        expect(lit(frame, "[ Deny ]")).toBe(true)
        expect(lit(frame, "[ Allow ]")).toBe(false)
        await pass(settle)
        await press(rendered, "enter")
        expect(answered(commands)).toEqual([["r-1", "Deny"]])
      })
    })
  }

  test("from the younger request's card goes to the oldest's", async () => {
    const view = askingView([permission("r-1", "w-2"), permission("r-2", "w-1")])
    await scene(view, wide, async ({ rendered, commands, pass }) => {
      await press(rendered, "tab", "g")
      const frame = await rendered.capture()
      expect(has(frame, "▸  Title of w-2")).toBe(true)
      expect(has(frame, "▸  Title of w-1")).toBe(false)
      await pass(settle)
      await press(rendered, "enter")
      expect(answered(commands)).toEqual([["r-1", "Deny"]])
    })
  })

  test("goes to a worker's question as to a permission", async () => {
    await scene(
      askingView([question("q-9", "w-2")]),
      wide,
      async ({ rendered, commands, pass }) => {
        await press(rendered, "enter", "g")
        await pass(settle)
        await press(rendered, "1", "enter")
        expect(answered(commands)).toEqual([["q-9", "Choose"]])
      },
    )
  })

  test("goes back to Deny on a card you stepped to Allow on and left", async () => {
    await scene(oneRequest(), wide, async ({ rendered, pass }) => {
      await press(rendered, "g")
      await pass(settle)
      await press(rendered, "right")
      expect(lit(await rendered.capture(), "[ Allow ]")).toBe(true)
      await press(rendered, "escape", "up", "g")
      const frame = await rendered.capture()
      expect(lit(frame, "[ Deny ]")).toBe(true)
      expect(lit(frame, "[ Allow ]")).toBe(false)
    })
  })

  test("does nothing with the card already focused: its button stays", async () => {
    await scene(oneRequest(), wide, async ({ rendered, commands, pass }) => {
      await press(rendered, "g")
      await pass(settle)
      await press(rendered, "right", "g")
      const frame = await rendered.capture()
      expect(insideNow(frame)).toBe(true)
      expect(lit(frame, "[ Allow ]")).toBe(true)
      await press(rendered, "enter")
      expect(answered(commands)).toEqual([["r-1", "Allow"]])
    })
  })

  test("then Esc comes out to the top level on Current, as from any card", async () => {
    await scene(oneRequest(), wide, async ({ rendered }) => {
      await press(rendered, "enter", "g")
      expect(insideNow(await rendered.capture())).toBe(true)
      await press(rendered, "escape")
      const frame = await rendered.capture()
      expect(insideNow(frame)).toBe(false)
      expect(has(frame, "arrows panels")).toBe(true)
      // On Current: every frame in it heavy, as no card is yet.
      expect(heavyOn(frame, "w-1")).toBe(true)
      expect(heavyOn(frame, "w-2")).toBe(true)
    })
  })

  test("does nothing with no request", async () => {
    await scene(viewOf(2), wide, async ({ rendered }) => {
      await press(rendered, "g")
      const frame = await rendered.capture()
      expect(insideNow(frame)).toBe(false)
      expect(heavyOn(frame, "w-1")).toBe(false)
    })
  })

  test("waits under the key help and a box, which take the keys", async () => {
    await scene(oneRequest(), wide, async ({ rendered }) => {
      await press(rendered, "?", "g", "escape")
      expect(insideNow(await rendered.capture())).toBe(false)
      await press(rendered, "s", "g")
      expect(has(await rendered.capture(), "[ Deny ]")).toBe(true)
      await press(rendered, "escape")
      expect(insideNow(await rendered.capture())).toBe(false)
    })
  })

  describe("where no buttons are drawn", () => {
    const compact = () => viewOf(6, [permission("r-1", "w-6")])
    const small = { width: 100, height: 28 }
    const ended = () =>
      projected(workersOf(1), [permission("r-1", "w-1")], { endOfRun: ["w-1" as TicketId] })

    for (const [where, view, size] of [
      ["on a compact line", compact, small],
      ["behind the end-of-run box", ended, wide],
      [
        "below the smallest size",
        () => viewOf(1, [permission("r-1", "w-1")]),
        { width: 58, height: 14 },
      ],
    ] as const) {
      test(`${where}, the hint names it, and g opens the request's Answer box`, async () => {
        await scene(view(), size, async ({ rendered, commands, pass }) => {
          const before = await rendered.capture()
          expect(has(before, "[ Deny ]")).toBe(false)
          expect(has(before, "g request on")).toBe(true)
          await press(rendered, "g")
          expect(has(await rendered.capture(), "[ Deny ]")).toBe(true)
          await pass(settle)
          await press(rendered, "enter")
          expect(answered(commands)).toEqual([["r-1", "Deny"]])
        })
      })

      test(`${where}, Esc closes the box with the keys on the line, and g opens it again`, async () => {
        await scene(view(), size, async ({ rendered }) => {
          await press(rendered, "g", "escape")
          const frame = await rendered.capture()
          expect(has(frame, "[ Deny ]")).toBe(false)
          await press(rendered, "g")
          expect(has(await rendered.capture(), "[ Deny ]")).toBe(true)
          await press(rendered, "escape", "escape")
          expect(has(await rendered.capture(), "[ Deny ]")).toBe(false)
        })
      })
    }

    test("Esc after the box comes out to the top level", async () => {
      await scene(compact(), small, async ({ rendered }) => {
        await press(rendered, "g")
        await press(rendered, "escape")
        expect(insideNow(await rendered.capture())).toBe(true)
        await press(rendered, "escape")
        expect(insideNow(await rendered.capture())).toBe(false)
      })
    })
  })
})

describe("nothing moves by itself", () => {
  for (const [where, keys] of places) {
    test(`after any wait with no key, the focus stays at ${where}`, async () => {
      await scene(oneRequest(), wide, async ({ rendered, pass }) => {
        await press(rendered, ...keys)
        const before = timeless(await rendered.capture())
        for (const wait of [settle, 5000, 60_000, 600_000]) {
          await pass(wait)
          expect(timeless(await rendered.capture())).toBe(before)
        }
      })
    })
  }

  test("a request coming with no key pressed takes nothing, shown at once", async () => {
    await scene(askingView([]), wide, async ({ rendered, view, pass }) => {
      await press(rendered, "enter")
      await pass(60_000)
      view.set(oneRequest())
      await pass(60_000)
      const frame = await rendered.capture()
      expect(insideNow(frame)).toBe(true)
      expect(has(frame, "▸")).toBe(true)
      expect(has(frame, "g request on w-2")).toBe(true)
      expect(heavyOn(frame, "w-2")).toBe(true)
    })
  })

  test("Enter meant for a row still opens the row, however long the request has waited", async () => {
    await scene(oneRequest(), wide, async ({ rendered, commands, pass }) => {
      await press(rendered, "enter")
      await pass(60_000)
      await press(rendered, "enter")
      expect(answered(commands)).toEqual([])
    })
  })
})
