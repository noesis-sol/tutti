// The rule over the worker view's transcript (§ 7.5, tutti-3fyr): named `Output`, as the ticket's
// box is named `Ticket`, in the box name's look and column; with the box, with the box grown to the
// whole ticket, and at the minimum size where there is none. A pane too narrow for the name keeps
// the bare rule, and the rule over the composer stays bare.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Scope } from "effect"
import fc from "fast-check"
import { Transcripts, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { transcriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { transcriptName, transcriptRule } from "../src/ui/WorkerView.tsx"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"
const title = "Read Chrome's AccountBookmarks"

const issue: Issue = {
  id: "t-1" as TicketId,
  title,
  description: Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the description.`).join(
    "\n\n",
  ),
  design: "",
  acceptance: "",
  notes: "",
  status: "in_progress",
  priority: 2,
  type: "bug",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "",
  closeReason: "",
}

const viewOf = (): RunView => {
  const entry: Entry = {
    ticket: "t-1" as TicketId,
    title,
    issue,
    phase: TicketPhase.Working(),
    since: began,
    worker: 1,
    row: 0,
    rechecking: false,
    steered: false,
    lastMessage: null,
    tallies: emptyTallies,
  }
  return project({
    ledger: { tickets: new Map([["t-1" as TicketId, entry]]), rows: 1, windDown: null, bugs: [] },
    workers: new Map([["t-1", WS.Idle({ at: began })]]),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })
}

const said = (words: string) =>
  ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

/** The worker view of t-1 at `size`, its transcript one line of text. */
const scene = async (
  size: { readonly width: number; readonly height: number },
  body: (rendered: Rendered) => Promise<void>,
) => {
  const line = JSON.stringify({
    v: transcriptVersion,
    seq: 1,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message: said("Reading the scripts."),
  })
  const transcripts = Effect.runSync(
    Effect.gen(function* () {
      return yield* Transcripts
    }).pipe(Effect.provide(memoryLayer({ "t-1": [line] }))),
  )
  const scope = Effect.runSync(Scope.make())
  const feed = Effect.runSync(transcriptFeed(transcripts).pipe(Scope.provide(scope)))
  const shell: ShellValue = {
    view: external(viewOf()),
    screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 67_000,
    transcripts: feed,
  }
  try {
    await withRender(<Root value={shell} />, size, body)
  } finally {
    Effect.runSync(Scope.close(scope, Exit.void))
  }
}

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.trimEnd())

/** Captures frames until `ok` holds of one, or 5 s have gone. */
const until = async (rendered: Rendered, ok: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ok(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** The row of the rule over the transcript in `frame`. */
const ruleRow = (frame: Frame): number =>
  linesOf(frame).findIndex((line) => line.startsWith(`── ${transcriptName} `))

/** The span of `text` on row `y` of `frame`. */
const spanOf = (frame: Frame, y: number, text: string) =>
  frame.spans.lines[y]?.spans.find((each) => each.text === text)

/** Checks the rule over the transcript in `frame`, `width` wide: named, in the box name's look. */
const named = (frame: Frame, width: number) => {
  const y = ruleRow(frame)
  expect(y).toBeGreaterThan(0)
  const rule = linesOf(frame)[y] ?? ""
  expect(rule).toMatch(/^── Output ─+$/)
  expect(Bun.stringWidth(rule)).toBe(width)
  const name = spanOf(frame, y, transcriptName)
  expect((name?.attributes ?? 0) & 1).toBe(1)
  expect(name?.fg.toInts()).toEqual(theme.rgba("emphasis", "fg").toInts())
  // The rest of the rule as the bare rule over the composer draws it.
  const rest = frame.spans.lines[y]?.spans.filter((each) => each.text !== transcriptName) ?? []
  expect(rest.length).toBeGreaterThan(0)
  for (const each of rest) expect(each.fg.toInts()).toEqual(theme.rgba("frame", "fg").toInts())
  // The rule over the composer stays bare.
  const bare = linesOf(frame).findIndex((line, at) => at > y && /^─+$/.test(line))
  expect(bare).toBeGreaterThan(y)
  expect(Bun.stringWidth(linesOf(frame)[bare] ?? "")).toBe(width)
  return { y, x: rule.indexOf(transcriptName) }
}

describe("the rule over the transcript", () => {
  test("at 80x24, Output in the box name's look, in Ticket's column; the composer's rule bare", async () => {
    await scene({ width: 80, height: 24 }, async (rendered) => {
      const frame = await until(rendered, has("Reading the scripts."))
      const lines = linesOf(frame)
      const top = lines.findIndex((line) => line.startsWith("╭─ Ticket "))
      expect(top).toBeGreaterThan(0)
      const { y, x } = named(frame, 80)
      expect(lines[y - 1]).toStartWith("╰")
      expect(x).toBe(lines[top]?.indexOf("Ticket") ?? -1)
      const ticket = spanOf(frame, top, "Ticket")
      const output = spanOf(frame, y, transcriptName)
      expect(output?.fg.toInts()).toEqual(ticket?.fg.toInts())
      expect(output?.attributes).toBe(ticket?.attributes)
    })
  })

  test("with the box grown to the whole ticket, still named under it", async () => {
    await scene({ width: 80, height: 30 }, async (rendered) => {
      await until(rendered, has("Reading the scripts."))
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("t")
      })
      const frame = await until(rendered, has("▴ less"))
      const lines = linesOf(frame)
      const { y, x } = named(frame, 80)
      expect(lines[y - 1]).toMatch(/^╰.*▴ less.*╯$/)
      expect(x).toBe(lines.find((line) => line.startsWith("╭─ Ticket "))?.indexOf("Ticket") ?? -1)
    })
  })

  test("at the minimum size, no box: under the title alone, in the same column", async () => {
    await scene({ width: 60, height: 16 }, async (rendered) => {
      const frame = await until(rendered, has("Reading the scripts."))
      const lines = linesOf(frame)
      expect(frame.chars).not.toContain("╭─ Ticket")
      expect(lines[1]).toEndWith("bug · P2")
      const { y, x } = named(frame, 60)
      expect(lines[y - 1]).toBe(`  ${title}`)
      expect(x).toBe(3)
    })
  })
})

describe("transcriptRule", () => {
  test("a pane too narrow for the name and a ─ after it keeps the bare rule", () => {
    const text = (width: number) =>
      transcriptRule(theme, width)
        .map((each) => each.text)
        .join("")
    expect(text(10)).toBe("─".repeat(10))
    expect(text(1)).toBe("─")
    expect(text(11)).toBe("── Output ─")
  })

  test("is the width it is given, named from 11 columns", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), (width) => {
        const rule = transcriptRule(theme, width)
        expect(widthOf(rule)).toBe(width)
        expect(rule.some((each) => each.text === transcriptName)).toBe(width >= 11)
      }),
    )
  })
})
