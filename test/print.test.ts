import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { decodeReferences, renderMarkdown, ruleWidth } from "../src/print/markdown.ts"
import {
  eraseLine,
  frameInterval,
  makePrinter,
  type Out,
  spinnerFrames,
} from "../src/print/organLine.ts"
import { closing, Ending, printSummary, type Summary, summary } from "../src/print/summary.ts"
import { emptyView, type Row } from "../src/run/runView.ts"
import { makeTheme, orchestra, type Theme } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const noColour = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is stripped
const sgr = /\x1b\[[0-9;]*m/g

/** `text` without its styles. */
const strip = (text: string): string => text.replace(sgr, "")

/** The ANSI sequence that sets `role`'s colour. */
const colour = (role: Parameters<Theme["ansi"]>[0]): string => theme.ansi(role, "fg")

/** Whether `text`, its SGR sequences left out, holds what a terminal would act on. */
const unsafe = (text: string): boolean =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is sought
  /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/.test(text.replace(sgr, ""))

const row = (ticket: string, mark: string, word: string, note: string): Row => ({
  ticket,
  title: note,
  mark,
  word,
  note,
  verdict: null,
})

const ended = (rows: ReadonlyArray<Row>, totals: Partial<Summary["totals"]> = {}): Summary => ({
  version: "0.1.0",
  branch: "main",
  scope: null,
  took: 125_000,
  totals: { ...emptyView.totals, slots: 4, ...totals },
  rows,
})

describe("the summary", () => {
  test("has the title, the totals and every ticket, as wide as the terminal", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(`tut-${i}`, "✓", "done", `abc${i} merged into main`),
    )
    const out = summary(ended(rows, { completed: 40 }), theme, 80)
    const lines = strip(out).split("\n")
    expect(lines[0]).toBe("")
    expect(lines[1]).toContain(" tutti ")
    expect(lines[1]).toContain("0.1.0")
    expect(lines[1]).toContain("main · 2m5s")
    expect(strip(out)).toContain("✓ 40")
    for (let i = 0; i < 40; i++) expect(strip(out)).toContain(`tut-${i} `)
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80)
    expect(out).toContain(theme.styles.title.paint(" tutti "))
    expect(out).toContain(theme.styles.tickets.paint("Tickets"))
  })

  test("a scoped run's title names its ticket", () => {
    const out = strip(summary({ ...ended([]), scope: "tut-7" }, theme, 80))
    expect(out).toContain("main · ticket tut-7 · 2m5s")
  })

  test("without tickets, it has the title and totals only", () => {
    const out = strip(summary(ended([]), theme, 80))
    expect(out).not.toContain("Tickets")
    expect(out).toContain("Completed")
  })

  test("zeros are faint and counts in their total's style", () => {
    const out = summary(ended([], { completed: 2, needsYou: 1 }), theme, 80)
    expect(out).toContain(theme.styles.closed.paint("✓ 2"))
    expect(out).toContain(theme.styles.stop.paint("? 1"))
    expect(out).toContain(theme.styles.dim.paint("0 of 4"))
    expect(out).toContain(theme.styles.dim.paint("0"))
  })

  test("a narrow terminal gets the totals on one line", () => {
    const out = strip(summary(ended([], { completed: 2 }), theme, 20))
    expect(out).toContain("✓ 2 · ↷ 0 · ? 0 · ▶ 0/4 · queue 0")
    expect(out).not.toContain("╭")
  })

  test("each row takes its state's style, and a finished row's note is faint", () => {
    const out = summary(
      ended([
        row("tut-1", "✓", "done", "abc1234 merged into main"),
        row("tut-2", "■", "stopped", "Two"),
        row("tut-3", "◷", "to merge", "Three"),
      ]),
      theme,
      80,
    )
    const { closed, stop, toMerge, dim } = theme.styles
    expect(out).toContain(closed.paint("✓ done"))
    expect(out).toContain(closed.paint("tut-1"))
    expect(out).toContain(dim.paint("abc1234 merged into main"))
    expect(out).toContain(stop.paint("■ stopped"))
    expect(out).toContain(stop.paint("tut-2"))
    expect(out).not.toContain(dim.paint("Two"))
    expect(out).toContain(toMerge.paint("◷ to merge"))
  })

  test("a long ticket ID never makes the table wider than the terminal", () => {
    for (const width of [40, 41, 44, 60]) {
      const out = strip(
        summary(ended([row("tutti-nrg.5.11.long", "✓", "done", "x")]), theme, width),
      )
      for (const line of out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("a long note is cut to the table", () => {
    const out = strip(summary(ended([row("tut-1", "↷", "deferred", "x".repeat(200))]), theme, 60))
    expect(out).toContain("x…")
    for (const line of out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60)
  })
})

describe("the closing line", () => {
  const done = (text: string, tickets = 3, limit: number | null = null) =>
    closing(Ending.Done({ text, tickets, limit, took: 125_000 }), theme)

  test("READY_EMPTY completes the Run, done bold, its facts faint", () => {
    const out = done("READY_EMPTY after 3 tickets")
    expect(out).toBe(
      `${theme.styles.closed.paint("♪ Completed the Run")}  ${theme.styles.dim.paint("3 tickets · 2m5s")}`,
    )
  })

  test("LIMIT_REACHED and DRAINED say how the run ended", () => {
    expect(strip(done("LIMIT_REACHED at 5 tickets", 5, 5))).toBe(
      "♪ Reached the ticket limit (5)  5 tickets · 2m5s",
    )
    expect(strip(done("DRAINED after 1 ticket", 1))).toBe(
      "♪ Stopped after the running tickets, as asked  1 ticket · 2m5s",
    )
  })

  test("a run under a second gives no time; none started is no tickets", () => {
    const out = closing(
      Ending.Done({ text: "READY_EMPTY after 0 tickets", tickets: 0, limit: null, took: 400 }),
      theme,
    )
    expect(strip(out)).toBe("♪ Completed the Run  no tickets")
  })

  test("a stop's line is needsYou bold", () => {
    const out = closing(Ending.Stopped({ text: "PAUSED: tut-3 is still in progress" }), theme)
    expect(out).toBe(theme.styles.stop.paint("■ PAUSED: tut-3 is still in progress"))
    expect(theme.styles.stop.open).toContain(colour("needsYou"))
  })

  test("the scope line follows: SCOPE_DONE done, SCOPE_OPEN notice", () => {
    const scopeDone = done("READY_EMPTY after 3 tickets; SCOPE_DONE: tut-1 and its 2 subtickets")
    expect(scopeDone.split("\n")[1]).toBe(
      theme.styles.done.paint("  SCOPE_DONE: tut-1 and its 2 subtickets"),
    )
    const scopeOpen = closing(
      Ending.Stopped({ text: "PAUSED: tut-2; SCOPE_OPEN: tut-1: 1 of its 2 subtickets not done" }),
      theme,
    )
    expect(scopeOpen.split("\n")).toEqual([
      theme.styles.stop.paint("■ PAUSED: tut-2"),
      theme.styles.deferred.paint("  SCOPE_OPEN: tut-1: 1 of its 2 subtickets not done"),
    ])
    expect(theme.styles.deferred.open).toBe(colour("notice"))
  })

  test("printSummary prints the summary, then the closing line", async () => {
    let written = ""
    const out: Out = { write: (text) => (written += text), columns: () => 80, tty: true }
    await Effect.runPromise(
      printSummary(
        makePrinter(out, theme),
        ended([row("tut-1", "✓", "done", "merged")]),
        Ending.Done({ text: "READY_EMPTY after 1 ticket", tickets: 1, limit: null, took: 0 }),
        theme,
        80,
      ),
    )
    const lines = strip(written).trimEnd().split("\n")
    expect(lines.at(-1)).toBe("♪ Completed the Run  1 ticket")
    expect(lines.some((line) => line.includes("tut-1"))).toBe(true)
  })
})

describe("organ lines", () => {
  /** A terminal `columns` wide that keeps what is written. */
  const terminal = (columns = 80, tty = true) => {
    const writes: Array<string> = []
    const out: Out = { write: (text) => void writes.push(text), columns: () => columns, tty }
    return { writes, out }
  }

  const run = <A>(effect: Effect.Effect<A>) =>
    Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

  const flush = Effect.gen(function* () {
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow
  })

  test("the spinner turns by rewriting one line, then the final line replaces it", async () => {
    const { writes, out } = terminal()
    await run(
      Effect.gen(function* () {
        const printer = makePrinter(out, theme)
        const line = yield* printer.organ("Writing the run report")
        yield* flush
        expect(writes).toEqual([])
        yield* TestClock.adjust(frameInterval)
        yield* flush
        yield* TestClock.adjust(frameInterval)
        yield* flush
        yield* line.detail("3 tickets")
        yield* TestClock.adjust("12 seconds")
        yield* flush
        yield* line.done("Wrote the run report")
      }),
    )
    const { picked, say, dim, organ } = theme.styles
    expect(writes[0]).toBe(
      `${eraseLine}${picked.paint(spinnerFrames[0])} ${say.paint("Writing the run report")} ${dim.paint("0:00")}`,
    )
    expect(writes[1]).toBe(
      `${eraseLine}${picked.paint(spinnerFrames[1])} ${say.paint("Writing the run report")} ${dim.paint("0:00")}`,
    )
    expect(writes).toContain(
      `${eraseLine}${picked.paint(spinnerFrames[2])} ${say.paint("Writing the run report")} ${dim.paint("3 tickets · 0:00")}`,
    )
    expect(writes.at(-2)).toBe(eraseLine)
    expect(writes.at(-1)).toBe(
      `${organ.paint("◆ ")}${say.paint("Wrote the run report")} ${dim.paint("(12s)")}\n`,
    )
    for (const write of writes.slice(0, -1)) expect(write.startsWith(eraseLine)).toBe(true)
    for (const write of writes.slice(0, -1)) expect(write).not.toContain("\n")
  })

  test("what is printed while it turns goes above it, and it is drawn again", async () => {
    const { writes, out } = terminal()
    await run(
      Effect.gen(function* () {
        const printer = makePrinter(out, theme)
        const line = yield* printer.organ("Triage")
        yield* TestClock.adjust(frameInterval)
        yield* flush
        yield* printer.print("a line")
        yield* line.warn("Triage failed")
      }),
    )
    const drawn = writes[0] as string
    expect(writes[1]).toBe(`${eraseLine}a line\n${drawn.slice(eraseLine.length)}`)
    expect(writes.at(-1)).toBe(
      `${theme.styles.organ.paint("◆ ")}${theme.styles.deferred.paint("Triage failed")}\n`,
    )
  })

  test("a step that ends before the first frame shows only its final line, without a time", async () => {
    const { writes, out } = terminal()
    await run(
      Effect.gen(function* () {
        const line = yield* makePrinter(out, theme).organ("Quick")
        yield* line.done("Quick")
      }),
    )
    expect(writes).toEqual([
      `${theme.styles.organ.paint("◆ ")}${theme.styles.say.paint("Quick")}\n`,
    ])
  })

  test("the spinner line is cut to the terminal, never wrapping", async () => {
    const { writes, out } = terminal(20)
    await run(
      Effect.gen(function* () {
        const line = yield* makePrinter(out, theme).organ("a very long organ step text here")
        yield* TestClock.adjust(frameInterval)
        yield* flush
        yield* line.done("ok")
      }),
    )
    expect(Bun.stringWidth(strip(writes[0] as string).slice(eraseLine.length))).toBeLessThan(20)
  })

  test("where the output isn't a terminal, there is no spinner", async () => {
    const { writes, out } = terminal(80, false)
    await run(
      Effect.gen(function* () {
        const line = yield* makePrinter(out, theme).organ("Report")
        yield* TestClock.adjust("2 seconds")
        yield* flush
        yield* line.done("Report written")
      }),
    )
    expect(writes.map(strip)).toEqual(["◆ Report written (2s)\n"])
  })
})

describe("the report's Markdown", () => {
  const render = (md: string, width = 80) => renderMarkdown(md, theme, width)
  const bold = "\x1b[1m"
  const faint = "\x1b[2m"
  const italic = "\x1b[3m"

  test("headings: H1 heading1, H2 heading2, H3 and below heading3, all bold", () => {
    const out = render("# One\n\n## Two\n\n### Three\n\n#### Four").split("\n")
    expect(out[0]).toBe(`${bold}${colour("heading1")}One\x1b[0m`)
    expect(out[2]).toBe(`${bold}${colour("heading2")}Two\x1b[0m`)
    expect(out[4]).toBe(`${bold}${colour("heading3")}Three\x1b[0m`)
    expect(out[6]).toBe(`${bold}${colour("heading3")}Four\x1b[0m`)
  })

  test("lists: bullets, numbers from the list's start, nested items indented", () => {
    expect(strip(render("- a\n- b\n  - c\n\n3. three\n4. four"))).toBe(
      "• a\n• b\n  • c\n\n3. three\n4. four",
    )
  })

  test("a task's checkbox goes after its bullet, its text beside it", () => {
    expect(strip(render("- [ ] task\n- [x] done the task that wraps onto the next line", 30))).toBe(
      "• [ ] task\n• [x] done the task that wraps\n      onto the next line",
    )
  })

  test("a list item that wraps goes on under its text", () => {
    expect(strip(render("- one two three four five six seven eight nine ten", 20))).toBe(
      "• one two three four\n  five six seven\n  eight nine ten",
    )
  })

  test("emphasis: strong bold, emphasis italic, nested", () => {
    const out = render("**bold _both_** and *it*")
    expect(out).toContain(`${bold}bold\x1b[0m`)
    expect(out).toContain(`${bold}${italic}both\x1b[0m`)
    expect(out).toContain(`${italic}it\x1b[0m`)
  })

  test("code: inline code and code blocks in the code role", () => {
    const out = render("Run `bd ready` now.\n\n```sh\nbd ready\n\tbd show x\n```")
    expect(out).toContain(`${colour("code")}bd ready\x1b[0m`)
    const lines = out.split("\n")
    expect(lines[2]).toBe(`  ${colour("code")}bd ready\x1b[0m`)
    expect(lines[3]).toBe(`  ${colour("code")}    bd show x\x1b[0m`)
  })

  test("links: the link role, not underlined, with their URL faint", () => {
    const out = render("See [the docs](https://example.com/docs) and <https://a.example>.")
    expect(out).toContain(
      `${colour("link")}the docs\x1b[0m ${faint}https://example.com/docs\x1b[0m`,
    )
    expect(out).toContain(`${colour("link")}https://a.example\x1b[0m.`)
    expect(out).not.toContain("\x1b[4m")
  })

  test("quotes: faint italic behind a faint bar", () => {
    const out = render("> quoted *words*\n> go on")
    expect(out).toBe(`${faint}│ \x1b[0m${faint}${italic}quoted words go on\x1b[0m`)
    expect(strip(out)).toBe("│ quoted words go on")
  })

  test("rules: a faint line, at most 40 long", () => {
    expect(render("---", 80)).toBe(`${faint}${"─".repeat(ruleWidth)}\x1b[0m`)
    expect(strip(render("---", 30))).toBe("─".repeat(30))
  })

  test("tables: columns as wide as their widest cell, the header bold", () => {
    expect(strip(render("| a | bee |\n|---|---|\n| 1 | 2 |"))).toBe("a │ bee\n──┼────\n1 │ 2")
  })

  test("paragraphs wrap to the width, keeping their styles on every line", () => {
    const out = render("**one two three four five six**", 20).split("\n")
    expect(out.map(strip)).toEqual(["one two three four", "five six"])
    for (const line of out) expect(line.startsWith(bold)).toBe(true)
  })

  test("character references are read, escapes shown as written", () => {
    expect(strip(render("a &amp; b \\*c\\* &#32;d"))).toBe("a & b *c* d")
    expect(decodeReferences("&#x41;&#66;&lt;&unknown;")).toBe("AB<&unknown;")
  })

  test("NO_COLOR: no colours, bold and faint remain", () => {
    const out = renderMarkdown("# One\n\n[x](https://y.z) `c`", noColour, 80)
    expect(out).not.toContain("\x1b[38;")
    expect(out).not.toContain("\x1b[48;")
    expect(out).toContain(`${bold}One\x1b[0m`)
    expect(out).toContain(`${faint}https://y.z\x1b[0m`)
  })
})

describe("untrusted text", () => {
  // Text that is mostly the pieces of control sequences, Markdown and character references.
  const hostile = fc.string({
    unit: fc.oneof(
      fc.constantFrom(
        ...["\x1b", "[", "]", "\\", "\x07", "\x9b", "\x9c", "\r", "\n", "\t", "\x00", "‮"],
        ...["&#x1b;", "&#27;", "&#x9b;", "&#8238;", "&#0;", "*", "_", "`", "#", ">", "- ", "|"],
        ...["[a](", ")", "~~", "a", " ", "é", "31m"],
      ),
      fc.integer({ min: 0, max: 0xa0 }).map((c) => String.fromCodePoint(c)),
    ),
  })

  test("the rendered report holds no control sequence but tutti's styles", () => {
    fc.assert(
      fc.property(hostile, fc.integer({ min: 1, max: 120 }), (md, width) => {
        expect(unsafe(renderMarkdown(md, theme, width))).toBe(false)
      }),
    )
  })

  test("a character reference can't make an escape sequence", () => {
    const out = renderMarkdown("a &#x1b;]52;c;cGF5bG9hZA==&#7; b &#x1b;[2J c", theme, 80)
    expect(unsafe(out)).toBe(false)
    expect(out).not.toContain("\x1b]")
    expect(out).not.toContain("[2J")
  })

  test("the summary and the closing line hold none", () => {
    fc.assert(
      fc.property(hostile, hostile, hostile, (ticket, note, text) => {
        const out = summary(
          { ...ended([row(ticket, "▶", "working", note)]), branch: text, scope: ticket },
          theme,
          80,
        )
        expect(unsafe(out)).toBe(false)
        expect(strip(out).split("\n").length).toBe(10)
        expect(unsafe(closing(Ending.Stopped({ text }), theme))).toBe(false)
        expect(
          unsafe(closing(Ending.Done({ text, tickets: 1, limit: null, took: 0 }), theme)),
        ).toBe(false)
      }),
    )
  })

  test("organ lines hold none", async () => {
    await fc.assert(
      fc.asyncProperty(hostile, async (text) => {
        const writes: Array<string> = []
        const out: Out = { write: (t) => void writes.push(t), columns: () => 80, tty: true }
        await Effect.runPromise(
          Effect.gen(function* () {
            const printer = makePrinter(out, theme)
            const line = yield* printer.organ(text)
            yield* line.detail(text)
            yield* TestClock.adjust(frameInterval)
            for (let i = 0; i < 20; i++) yield* Effect.yieldNow
            yield* line.done(text)
            yield* printer.say(text)
            yield* printer.warn(text)
          }).pipe(Effect.provide(TestClock.layer())),
        )
        for (const write of writes) expect(unsafe(write.replaceAll(eraseLine, ""))).toBe(false)
      }),
      { numRuns: 50 },
    )
  })
})
