// The ticket in the worker view's head (§ 7.5, tutti-cxgo.1): its type and priority on line 1, its
// description under it (2 lines, 3 on 40 rows, none at the minimum size), `▾ whole ticket  t` when
// there is more, and the whole ticket in a framed panel that t, a click or Esc opens and closes,
// scrolling with PgUp/PgDn and the wheel; all of it sanitised. TicketHead.tsx's pure parts, which
// read text a ticket author wrote, are checked as properties.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Queue, Scope } from "effect"
import fc from "fast-check"
import { Transcripts, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, ticketText } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { sanitize } from "../src/ui/sanitize.ts"
import {
  checklist,
  descriptionLimit,
  descriptionLines,
  inlineSegments,
  moreControl,
  panelCap,
  proseOf,
  wholeTicket,
} from "../src/ui/TicketHead.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { transcriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type Settable, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

const title = "Read Chrome's AccountBookmarks"

const description =
  "Chromium keeps bookmarks saved to the Google account in a second file, **AccountBookmarks**, " +
  "beside `Bookmarks`. mnemos reads only Bookmarks, so those bookmarks never reach the index, and " +
  "a search for one finds nothing. The fix reads both files and labels each bookmark with the " +
  "file it came from, so that a search can tell them apart."

/** t-1's issue, with `fields` over a bug at P2 with nothing but its title. */
const issueOf = (fields: Partial<Issue> = {}): Issue => ({
  id: "t-1" as TicketId,
  title,
  description: "",
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
  ...fields,
})

/** Worker 1 on t-1, its ledger entry holding `issue`. */
const viewOf = (issue: Issue | undefined): RunView => {
  const entry: Entry = {
    ticket: "t-1" as TicketId,
    title,
    ...(issue === undefined ? {} : { issue }),
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

interface Scene {
  readonly rendered: Rendered
  readonly view: Settable<RunView>
  readonly commands: Commands
}

/** The worker view of t-1 at `size`, its ticket `issue`, its transcript one line of text. */
const scene = async (
  issue: Issue | undefined,
  size: { readonly width: number; readonly height: number },
  body: (at: Scene) => Promise<void>,
  /** The real tree-sitter, for the Markdown with its marks concealed (test/render.ts). */
  treeSitter?: "real",
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
  const view = external(viewOf(issue))
  const commands = Effect.runSync(makeCommands)
  const shell: ShellValue = {
    view,
    screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 67_000,
    transcripts: feed,
  }
  try {
    await withRender(
      <Root value={shell} />,
      size,
      (rendered) => body({ rendered, view, commands }),
      treeSitter === undefined ? {} : { treeSitter },
    )
  } finally {
    Effect.runSync(Scope.close(scope, Exit.void))
  }
}

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.trimEnd())

const shownOf = (frame: Frame): string =>
  `\n${linesOf(frame)
    .filter((line) => line !== "")
    .join("\n")}\n`

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
const lacks = (text: string) => (frame: Frame) => !frame.chars.includes(text)

/** The commands offered since the last look, by tag. */
const taken = (commands: Commands) =>
  Effect.runSync(Queue.clear(commands)).map((command) => command._tag)

/** Clicks the first cell of `text` in `frame`. */
const clickOn = (rendered: Rendered, frame: Frame, text: string) => {
  const lines = linesOf(frame)
  const y = lines.findIndex((line) => line.includes(text))
  const row = lines[y] ?? ""
  const x = Bun.stringWidth(row.slice(0, row.indexOf(text)))
  return rendered.input((setup) => setup.mockMouse.click(x, y))
}

const typeKey = (rendered: Rendered, key: string) =>
  rendered.input(async (setup) => {
    await setup.mockInput.typeText(key)
  })

const pageDown = "\x1b[6~"

describe("the ticket's description in the head", () => {
  test("at 80x24, two lines, cut with …, and ▾ whole ticket  t at the end of the last", async () => {
    await scene(issueOf({ description }), { width: 80, height: 24 }, async ({ rendered }) => {
      const frame = await until(rendered, has("Reading the scripts."))
      expect(shownOf(frame).split("\n").slice(0, 6).join("\n")).toMatchInlineSnapshot(`
        "
         ← Dashboard   • t-1  done  1m07s  bug · P2   Read Chrome's AccountBookmarks
          1m07s  0 tokens  $0.00
          Chromium keeps bookmarks saved to the Google account in a second file,
          AccountBookmarks, beside Bookmarks. mnemos reads only Book…  ▾ whole ticket  t
        ────────────────────────────────────────────────────────────────────────────────"
      `)
      const lines = linesOf(frame)
      // Right aligned, in the link colour.
      expect(lines[3]?.endsWith("▾ whole ticket  t")).toBe(true)
      expect(Bun.stringWidth(lines[3] ?? "")).toBe(80)
      const control = frame.spans.lines[3]?.spans.find((each) => each.text.includes("▾"))
      expect(control?.fg.toInts()).toEqual(theme.rgba("link", "fg").toInts())
    })
  })

  test("at 120x40, three lines", async () => {
    const long = `${description} ${description}`
    await scene(
      issueOf({ description: long }),
      { width: 120, height: 40 },
      async ({ rendered }) => {
        const frame = await until(rendered, has("Reading the scripts."))
        const lines = linesOf(frame)
        expect(lines.slice(2, 5).every((line) => line.startsWith("  ") && line.trim() !== "")).toBe(
          true,
        )
        expect(lines[4]?.endsWith("▾ whole ticket  t")).toBe(true)
        expect(lines[4]).toContain("…")
        expect(lines[5]).toMatch(/^─+$/)
      },
    )
  })

  test("at 60x16, the minimum size, none; t still opens the whole ticket", async () => {
    await scene(issueOf({ description }), { width: 60, height: 16 }, async ({ rendered }) => {
      const frame = await until(rendered, has("Reading the scripts."))
      expect(frame.chars).not.toContain("Chromium")
      expect(frame.chars).not.toContain("whole ticket")
      await typeKey(rendered, "t")
      const open = await until(rendered, has("▴ less"))
      expect(open.chars).toContain("Chromium keeps")
      expect(linesOf(open).length).toBe(16)
    })
  })

  test("no control when the description shows whole and the ticket has nothing more", async () => {
    await scene(
      issueOf({ description: "Read the second file too." }),
      { width: 80, height: 24 },
      async ({ rendered }) => {
        const frame = await until(rendered, has("Reading the scripts."))
        expect(linesOf(frame)[2]).toBe("  Read the second file too.")
        expect(frame.chars).not.toContain("whole ticket")
      },
    )
  })

  test("the control when the description shows whole but the ticket has notes", async () => {
    await scene(
      issueOf({ description: "Read the second file too.", notes: "Started on it." }),
      { width: 80, height: 24 },
      async ({ rendered }) => {
        const frame = await until(rendered, has("Reading the scripts."))
        const line = linesOf(frame)[2] ?? ""
        expect(line.startsWith("  Read the second file too.")).toBe(true)
        expect(line.endsWith("▾ whole ticket  t")).toBe(true)
      },
    )
  })

  test("the control when the ticket's one more thing is a ticket it blocks", async () => {
    await scene(
      // As bd ready gives it: counted, not listed.
      issueOf({ description: "Read it.", dependentCount: 1 }),
      { width: 80, height: 24 },
      async ({ rendered }) => {
        const frame = await until(rendered, has("Reading the scripts."))
        expect(linesOf(frame)[2]?.endsWith("▾ whole ticket  t")).toBe(true)
      },
    )
    await scene(
      issueOf({ description: "Read it.", dependentCount: 0 }),
      { width: 80, height: 24 },
      async ({ rendered }) => {
        const frame = await until(rendered, has("Reading the scripts."))
        expect(frame.chars).not.toContain("whole ticket")
      },
    )
  })

  test("no description: No description., faint, with the control only when there is more", async () => {
    await scene(issueOf(), { width: 80, height: 24 }, async ({ rendered }) => {
      const frame = await until(rendered, has("Reading the scripts."))
      expect(linesOf(frame)[2]).toBe("  No description.")
      const span = frame.spans.lines[2]?.spans.find((each) => each.text.includes("No description"))
      expect(span?.attributes ?? 0).not.toBe(0)
    })
    await scene(
      issueOf({ acceptance: "- It reads AccountBookmarks" }),
      { width: 80, height: 24 },
      async ({ rendered }) => {
        const frame = await until(rendered, has("Reading the scripts."))
        const line = linesOf(frame)[2] ?? ""
        expect(line.startsWith("  No description.")).toBe(true)
        expect(line.endsWith("▾ whole ticket  t")).toBe(true)
      },
    )
  })

  test("line 1 has the ticket's type and priority, and its title in bold", async () => {
    await scene(issueOf({ description }), { width: 80, height: 24 }, async ({ rendered }) => {
      const frame = await until(rendered, has("Reading the scripts."))
      expect(linesOf(frame)[0]).toContain("t-1  done  1m07s  bug · P2   Read Chrome's")
      const span = frame.spans.lines[0]?.spans.find((each) => each.text.includes("Read Chrome"))
      expect((span?.attributes ?? 0) & 1).toBe(1)
    })
  })
})

const whole = issueOf({
  description,
  design: "Read **both** files in `lib.ts`.",
  acceptance:
    "- [ ] Account bookmarks are indexed under their own label\n- [x] Bookmarks still are",
  notes: "Started on the reader.",
  labels: ["bookmarks"],
  parent: "t-0" as TicketId,
  dependencies: [
    { id: "t-0" as TicketId, type: "parent-child" },
    { id: "t-9" as TicketId, type: "blocks" },
  ],
  dependents: [{ id: "t-5" as TicketId, type: "blocks" }],
})

describe("the whole ticket", () => {
  test("t opens it in place of the description, reading the ticket again; t closes it", async () => {
    await scene(
      whole,
      { width: 120, height: 40 },
      async ({ rendered, commands }) => {
        await until(rendered, has("Reading the scripts."))
        taken(commands)
        await typeKey(rendered, "t")
        const open = await until(rendered, has("▴ less"))
        expect(taken(commands)).toEqual(["ReadTicket"])
        const lines = linesOf(open)
        expect(lines[2]).toMatch(/^ {2}╭─+ ▴ less {2}t · Esc ─╮$/)
        expect(open.chars).toContain("Acceptance")
        expect(open.chars).toContain("☐ Account bookmarks are indexed under their own label")
        expect(open.chars).toContain("☑ Bookmarks still are")
        expect(open.chars).toContain("Links  parent t-0 · blocked by t-9 · blocks t-5")
        expect(open.chars).not.toContain("▾ whole ticket")
        // At most 60% of the pane; the transcript keeps its line.
        const panel = lines.filter((line) => /^ {2}[╭│╰]/.test(line))
        expect(panel.length).toBeLessThanOrEqual(panelCap(40))
        expect(open.chars).toContain("Reading the scripts.")
        expect(open.chars).toContain("t/Esc less · i write · Ctrl+X")
        await typeKey(rendered, "t")
        const closed = await until(rendered, lacks("▴ less"))
        expect(closed.chars).toContain("▾ whole ticket  t")
      },
      "real",
    )
  })

  test("Esc closes it before it leaves the view", async () => {
    await scene(whole, { width: 80, height: 24 }, async ({ rendered, commands }) => {
      await until(rendered, has("Reading the scripts."))
      await typeKey(rendered, "t")
      await until(rendered, has("▴ less"))
      taken(commands)
      await rendered.input((setup) => pressEscape(setup))
      const closed = await until(rendered, lacks("▴ less"))
      expect(closed.chars).toContain("▾ whole ticket  t")
      expect(taken(commands)).toEqual([])
      await rendered.input((setup) => pressEscape(setup))
      await until(rendered, () => true)
      expect(taken(commands)).toEqual(["CloseWorker"])
    })
  })

  test("a click on ▾ whole ticket opens it, one on ▴ less closes it", async () => {
    await scene(whole, { width: 80, height: 24 }, async ({ rendered, commands }) => {
      const frame = await until(rendered, has("Reading the scripts."))
      await clickOn(rendered, frame, "▾ whole ticket")
      const open = await until(rendered, has("▴ less"))
      expect(taken(commands)).toContain("ReadTicket")
      await clickOn(rendered, open, "▴ less")
      expect((await until(rendered, lacks("▴ less"))).chars).toContain("▾ whole ticket")
    })
  })

  test("it scrolls with PgDn and the wheel, the lines below counted in its bottom border", async () => {
    const notes = Array.from({ length: 30 }, (_, i) => `Note ${i + 1}.`).join("\n\n")
    await scene({ ...whole, notes }, { width: 80, height: 24 }, async ({ rendered }) => {
      await until(rendered, has("Reading the scripts."))
      await typeKey(rendered, "t")
      const open = await until(rendered, has("more lines"))
      const more = (frame: Frame) => Number(/↓ (\d+) more lines? ─╯/.exec(frame.chars)?.[1] ?? 0)
      const before = more(open)
      expect(before).toBeGreaterThan(20)
      // A page less a line: what the panel shows less one.
      const inside = panelCap(24) - 2
      await rendered.input(async (setup) => {
        setup.mockInput.pressKey(pageDown)
        await Bun.sleep(30)
      })
      const paged = await until(rendered, (frame) => more(frame) < before)
      expect(more(paged)).toBe(before - (inside - 1))
      // The transcript stays where it was.
      expect(paged.chars).toContain("Reading the scripts.")
      const y = linesOf(paged).findIndex((line) => line.includes("│"))
      await rendered.input(async (setup) => {
        await setup.mockMouse.scroll(10, y + 1, "down")
        await Bun.sleep(30)
      })
      const wheeled = await until(rendered, (frame) => more(frame) < more(paged))
      expect(more(wheeled)).toBeLessThan(more(paged))
    })
  })

  test("notes the run reads again show", async () => {
    await scene(
      whole,
      { width: 120, height: 40 },
      async ({ rendered, view }) => {
        await until(rendered, has("Reading the scripts."))
        await typeKey(rendered, "t")
        await until(rendered, has("▴ less"))
        await rendered.input(() => {
          view.set(viewOf({ ...whole, notes: "Added during the run." }))
        })
        expect((await until(rendered, has("Added during the run."))).chars).toContain(
          "Added during the run.",
        )
      },
      "real",
    )
  })

  test("before the run has read the ticket, t opens it reading", async () => {
    await scene(undefined, { width: 80, height: 24 }, async ({ rendered, commands }) => {
      const frame = await until(rendered, has("Reading the scripts."))
      expect(linesOf(frame)[2]).toMatch(/^─+$/)
      taken(commands)
      await typeKey(rendered, "t")
      expect((await until(rendered, has("Reading the ticket…"))).chars).toContain("▴ less")
      expect(taken(commands)).toEqual(["ReadTicket"])
    })
  })

  test("while the composer has the focus, t types", async () => {
    await scene(whole, { width: 80, height: 24 }, async ({ rendered, commands }) => {
      await until(rendered, has("Reading the scripts."))
      await typeKey(rendered, "i")
      await until(rendered, has("Enter send"))
      taken(commands)
      await typeKey(rendered, "t")
      const frame = await until(rendered, has("> t"))
      expect(frame.chars).not.toContain("▴ less")
      expect(taken(commands)).toEqual([])
    })
  })

  test("what a ticket author wrote reaches the terminal sanitised", async () => {
    const rlo = String.fromCharCode(0x202e)
    const evil = `Plain start \x1b]52;c;ZXZpbA==\x07then \x1b[2Jcleared ${rlo}reversed end`
    await scene(
      issueOf({ description: evil, notes: evil, labels: [`x\x1b[31mred`] }),
      { width: 80, height: 24 },
      async ({ rendered }) => {
        const frame = await until(rendered, has("Reading the scripts."))
        expect(frame.chars).toContain("Plain start then cleared reversed end")
        await typeKey(rendered, "t")
        const open = await until(rendered, has("▴ less"))
        for (const shown of [frame, open]) {
          expect(shown.chars).not.toContain("\x1b")
          expect(shown.chars).not.toContain(rlo)
          expect(shown.chars).not.toContain("ZXZpbA")
        }
        expect(open.chars).toContain("xred")
      },
    )
  })
})

describe("the layout with the ticket", () => {
  for (const size of [
    { width: 80, height: 24 },
    { width: 120, height: 40 },
    { width: 60, height: 16 },
  ]) {
    test(`at ${size.width}x${size.height} the view fills the pane, open or not`, async () => {
      await scene(whole, size, async ({ rendered }) => {
        const closed = await until(rendered, has("Reading the scripts."))
        await typeKey(rendered, "t")
        const open = await until(rendered, has("▴ less"))
        for (const frame of [closed, open]) {
          const lines = linesOf(frame)
          expect(lines.length).toBe(size.height)
          // The hint ends the pane, the head starts it.
          expect(lines[0]).toContain("← Dashboard")
          expect(lines.at(-1)?.trim()).not.toBe("")
          expect(frame.chars).toContain("> i to write to the worker")
        }
      })
    })
  }
})

const shown = ticketText(whole)

describe("the description's and the whole ticket's text", () => {
  const text = fc.string({
    unit: fc.constantFrom("a", "b", " ", "\n", "*", "`", "_", "#", "-", "[", "]", "(", ")", "界"),
    maxLength: 200,
  })

  test("the head's lines keep to the width and the limit, the control at the last's end", () => {
    fc.assert(
      fc.property(
        text,
        fc.integer({ min: 20, max: 140 }),
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        (written, width, limit, notes) => {
          const issue = ticketText(issueOf({ description: written, notes: notes ? "n" : "" }))
          const { lines, more } = descriptionLines(issue, theme, width, limit)
          expect(lines.length).toBeLessThanOrEqual(limit)
          for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(width)
          if (notes && limit > 0) expect(more).toBe(true)
          // The control, a click target, ends the last line; no other line has a target.
          const targets = lines.map((line) => line.filter((each) => each.target !== undefined))
          expect(targets.slice(0, -1).flat()).toEqual([])
          if (more) {
            const last = lines.at(-1) ?? []
            expect(last.slice(-(targets.at(-1)?.length ?? 0))).toEqual([...moreControl(theme)])
          }
        },
      ),
    )
  })

  test("the prose keeps every word of plain text, and its inline marks go", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 30 }), (words) => {
        const written = words.map((word, i) => (i % 3 === 0 ? `**${word}**` : word)).join(" ")
        const segments = inlineSegments(proseOf(written), theme)
        expect(segments.map((each) => each.text).join("")).toBe(words.join(" "))
      }),
    )
  })

  test("headings, rules and code blocks are left out of the prose; list items keep their text", () => {
    expect(proseOf("# Heading\n\nFirst line\n- an item\n---\n```\ncode\n```\n> quoted")).toBe(
      "First line an item quoted",
    )
  })

  test("acceptance criteria as a checklist: an item a line, ticked ones ☑", () => {
    expect(checklist("- [ ] one\n- [x] two\n  more of two\n* three\nfour")).toBe(
      "☐ one  \n☑ two more of two  \n☐ three  \n☐ four",
    )
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z ]{0,20}$/), { maxLength: 10 }),
        (items) => {
          const listed = checklist(items.map((item) => `- ${item}`).join("\n"))
          expect(listed === "" ? [] : listed.split("  \n")).toEqual(
            items.map((item) => `☐ ${item}`),
          )
        },
      ),
    )
  })

  test("the whole ticket has each field, its sections left out when empty", () => {
    const markdown = wholeTicket(shown)
    expect(markdown).toContain(description)
    expect(markdown).toContain("### Design\n\nRead **both** files in `lib.ts`.")
    expect(markdown).toContain("### Acceptance")
    expect(markdown).toContain("### Notes\n\nStarted on the reader.")
    expect(markdown).toContain("**Links**  parent t-0 · blocked by t-9 · blocks t-5")
    expect(markdown).toContain("**Labels**  bookmarks")
    expect(wholeTicket(ticketText(issueOf()))).toBe("*No description.*")
  })

  test("a code block left open in one field doesn't swallow the next", () => {
    const markdown = wholeTicket(ticketText(issueOf({ description: "```\nopen", notes: "n" })))
    expect(markdown.split("\n").filter((line) => line.startsWith("```")).length % 2).toBe(0)
    expect(markdown.endsWith("### Notes\n\nn")).toBe(true)
  })

  test("the issue's text is sanitised as it enters RunView", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (written) => {
        const text = ticketText(issueOf({ description: written, notes: written }))
        expect(text.description).toBe(sanitize(written))
        expect(text.notes).toBe(sanitize(written))
      }),
    )
  })

  test("the description's lines: 3 from 40 rows, 2 above the minimum size, none at it", () => {
    expect([16, 17, 24, 39, 40, 60].map(descriptionLimit)).toEqual([0, 2, 2, 2, 3, 3])
  })
})
