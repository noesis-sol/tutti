import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import {
  allowedByRule,
  answered,
  denied,
  detail,
  fixing,
  hold,
  type Line,
  Log,
  line,
  message,
  permission,
  phaseBug,
  question,
  released,
  resolving,
  type Sink,
  stamp,
  start,
  steered,
  tagged,
  ticketLine,
  usageLimit,
  usageLimitLifted,
  usageWarning,
} from "../src/run/log.ts"
import { layer as capturedLayer, texts } from "../src/testing/Log.ts"

// 2026-10-17 09:05:03 local time, as the log dates its lines.
const at = new Date(2026, 9, 17, 9, 5, 3).getTime()

const temp = () => join(mkdtempSync(join(tmpdir(), "tutti-log-")), "tutti.log")

/** A console that keeps what is logged to it, as stdout would show it. */
const capturingConsole = () => {
  const printed: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
  })
  return { printed, console }
}

/** Runs `effect` with the live log at `file`, the clock at `at`, and `console` for stdout. */
const live = <A>(
  file: string,
  effect: Effect.Effect<A, never, Log>,
  options: { readonly sink?: Sink; readonly console?: Console.Console } = {},
): Promise<A> => {
  const logLayer = Log.layer({ file, ...(options.sink ? { sink: options.sink } : {}) }).pipe(
    Layer.provide(BunServices.layer),
  )
  const program = Effect.andThen(TestClock.setTime(at), effect).pipe(
    Effect.provide(Layer.merge(logLayer, TestClock.layer())),
  )
  return Effect.runPromise(
    options.console ? Effect.provideService(program, Console.Console, options.console) : program,
  )
}

const write = (...lines: ReadonlyArray<Line>) =>
  Effect.gen(function* () {
    yield* (yield* Log).write(...lines)
  })

// What sanitised text may not hold in a log line: a C0 control (a newline or tab included), DEL, a
// C1 control, a bidi override or isolate.
const unsafe = (text: string): boolean =>
  [...text].some((char) => {
    const c = char.codePointAt(0) as number
    return (
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    )
  })

// Text that is mostly the pieces of control sequences and line breaks.
const hostile = fc.string({
  unit: fc.oneof(
    fc.constantFrom(
      ...["\x1b", "[", "]", "P", "\\", "52;c;", "m", "2J", "\x07", "\x9b", "\x9c", "\x9d"],
      ...["\r", "\n", "\r\n", "\t", "\x00", "\x7f", "\u202e", "\u2067", "a", " ", "é", "→"],
    ),
    fc.integer({ min: 0, max: 0xa0 }).map((c) => String.fromCharCode(c)),
  ),
})

describe("a line's format", () => {
  test("the local time as orchestra dates it, then the text", () => {
    expect(stamp(at)).toBe("2026-10-17 09:05:03")
    expect(stamp(new Date(2027, 0, 2, 23, 0, 59).getTime())).toBe("2027-01-02 23:00:59")
  })

  test("written lines are appended to the file, each dated and on its own line", async () => {
    const file = temp()
    writeFileSync(file, "2026-10-16 22:41:42 an earlier run's line\n")
    await live(
      file,
      write(line`DRAIN: stopping after the ${2} running tickets finish`, steered("tut-9a1")),
    )
    expect(readFileSync(file, "utf8")).toBe(
      "2026-10-16 22:41:42 an earlier run's line\n" +
        "2026-10-17 09:05:03 DRAIN: stopping after the 2 running tickets finish\n" +
        "2026-10-17 09:05:03   STEERED: tut-9a1\n",
    )
  })

  test("the run's lines are kept as written, for the reviewer", async () => {
    const lines = await live(
      temp(),
      Effect.gen(function* () {
        const log = yield* Log
        yield* log.write(line`one`)
        yield* TestClock.adjust("61 seconds")
        yield* log.write(detail`two`)
        return yield* log.lines
      }),
    )
    expect(lines).toEqual(["2026-10-17 09:05:03 one", "2026-10-17 09:06:04   two"])
  })

  test("a block written at once stays together while other fibers write", async () => {
    const file = temp()
    const block = start({ version: "v0.1.0", repo: "/r", base: "main", settings: [] })
    const others = Array.from({ length: 20 }, (_, i) => line`other ${i}`)
    await live(
      file,
      Effect.all([write(...block, detail`second`, detail`third`), ...others.map((l) => write(l))], {
        concurrency: "unbounded",
      }),
    )
    const lines = readFileSync(file, "utf8").trimEnd().split("\n")
    expect(lines).toHaveLength(23)
    const first = lines.findIndex((l) => l.includes("START"))
    expect(lines.slice(first, first + 3).map((l) => l.slice(20))).toEqual([
      "START tutti v0.1.0 in /r on main ()",
      "  second",
      "  third",
    ])
  })
})

describe("the tags' lines", () => {
  test("START: the run, how it runs, and its notes below", () => {
    expect<unknown>(
      start({
        version: "v0.1.0",
        repo: "/work/project",
        base: "main",
        scope: "ticket tut-1",
        settings: [
          ["done so far", "0"],
          ["concurrent", "4"],
          ["permission mode", "auto"],
        ],
        notes: [
          "billing: subscription",
          "permission mode: default (auto mode isn't available here)",
        ],
      }),
    ).toEqual([
      "START tutti v0.1.0 in /work/project on main · ticket tut-1 (done so far: 0, concurrent: 4, permission mode: auto)",
      "  billing: subscription",
      "  permission mode: default (auto mode isn't available here)",
    ])
  })

  test("HOLD, at the margin, says whether tickets still run", () => {
    expect<unknown>(hold("START_FAILED for tut-1", 2)).toBe(
      "HOLD: START_FAILED for tut-1; no new tickets while the 2 running finish",
    )
    expect<unknown>(hold("START_FAILED for tut-1", 0)).toBe("HOLD: START_FAILED for tut-1")
  })

  test("RESOLVING and FIXING name the ticket's branch, not a tab", () => {
    expect<unknown>(
      resolving({ id: "tut-7", base: "main", files: ["a.ts", "b.ts"], limit: "20m" }),
    ).toBe(
      "  RESOLVING: tutti/tut-7 conflicts with main in a.ts, b.ts; handed back to its worker to resolve (up to 20m)",
    )
    expect<unknown>(
      fixing({
        id: "tut-7",
        base: "main",
        failure: "'scripts/check-fast.sh' fails",
        attempt: 1,
        attempts: 2,
        limit: "20m",
      }),
    ).toBe(
      "  FIXING: 'scripts/check-fast.sh' fails on tutti/tut-7 rebased onto main; handed back to its worker to fix (1 of 2, up to 20m)",
    )
  })

  test("MERGE_CONFLICT and CHECKS_FAILED are a ticket's warnings", () => {
    expect<unknown>(ticketLine("CHECKS_FAILED")`${"tut-3"} closed, but its check fails`).toBe(
      "  CHECKS_FAILED: tut-3 closed, but its check fails",
    )
    expect<unknown>(tagged("DIRTY_TREE")`uncommitted changes in ${"/r"}; stopping`).toBe(
      "DIRTY_TREE: uncommitted changes in /r; stopping",
    )
  })

  test("PERMISSION says how to answer with tutti answer (§ 7.6)", () => {
    expect<unknown>(
      permission({
        id: "tut-9a1",
        requestId: "a3f9",
        what: "Bash(rm -rf build)",
        why: "held by the safety check",
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
      }),
    ).toBe(
      "  PERMISSION: tut-9a1's worker asks: Bash(rm -rf build) (held by the safety check); answer with: tutti answer a3f9 allow --confirm | deny",
    )
    expect<unknown>(
      permission({
        id: "tut-2",
        requestId: "b001",
        what: "Read(foo.txt)",
        defaultToNo: false,
        suppressAlwaysAllowRule: false,
      }),
    ).toBe(
      "  PERMISSION: tut-2's worker asks: Read(foo.txt); answer with: tutti answer b001 allow | allow-run | deny",
    )
  })

  test("QUESTION lists each question's options", () => {
    expect<unknown>(
      question({
        id: "tut-4",
        requestId: "c2",
        questions: [{ question: "Which store?", options: ["SQLite", "Dolt"] }],
      }),
    ).toBe(
      "  QUESTION: tut-4's worker asks: Which store? (SQLite | Dolt); answer with: tutti answer c2 allow --choice <option>",
    )
  })

  test("answers and the rules they leave", () => {
    expect<unknown>(
      answered({
        id: "tut-9a1",
        kind: "permission",
        what: "Bash(rm -rf build)",
        verdict: "denied",
        detail: "use the clean script",
        via: "tutti answer",
      }),
    ).toBe(
      "  PERMISSION: tut-9a1's worker: Bash(rm -rf build) denied (use the clean script), via tutti answer",
    )
    expect<unknown>(
      answered({
        id: "tut-4",
        kind: "question",
        what: "Which store?",
        verdict: "answered",
        detail: "Dolt",
        via: "screen",
      }),
    ).toBe("  QUESTION: tut-4's worker: Which store? answered (Dolt)")
    expect<unknown>(allowedByRule("tut-5", "Bash(bun test)")).toBe(
      "  ALLOWED: tut-5's worker: Bash(bun test), by a rule you allowed for this run",
    )
  })

  test("DENIED, STEERED, RELEASED and MESSAGE as § 4.3, § 4.5 and § 7.5 word them", () => {
    expect<unknown>(
      denied({ id: "tut-9a1", what: "Bash(rm -rf build)", by: "classifier", reason: "too wide" }),
    ).toBe("  DENIED: tut-9a1's worker: Bash(rm -rf build), by the classifier: too wide")
    expect<unknown>(
      denied({ id: "tut-9a1", what: "Bash(rm -rf $T/*)", by: "safetyCheck", reason: "held" }),
    ).toBe("  DENIED: tut-9a1's worker: Bash(rm -rf $T/*), by the safety check: held")
    expect<unknown>(
      denied({ id: "tut-9a1", what: "Bash(ls)", by: "sandbox\u001b[2J", reason: "no" }),
    ).toBe("  DENIED: tut-9a1's worker: Bash(ls), by sandbox: no")
    expect<unknown>(
      denied({ id: "tut-9a1", what: "Bash(ls)", by: "constructor", reason: "no" }),
    ).toBe("  DENIED: tut-9a1's worker: Bash(ls), by constructor: no")
    expect<unknown>(steered("tut-9a1")).toBe("  STEERED: tut-9a1")
    expect<unknown>(released("tut-9a1")).toBe("  RELEASED: tut-9a1")
    expect<unknown>(message("tut-9a1", "x".repeat(212))).toBe(
      "  MESSAGE: you → tut-9a1 (212 characters)",
    )
    expect<unknown>(message("tut-9a1", "👍🏽 ok")).toBe("  MESSAGE: you → tut-9a1 (5 characters)")
  })

  test("USAGE, USAGE_LIMIT and PHASE_BUG", () => {
    expect<unknown>(usageWarning({ percent: 85, limit: "five-hour", resets: "14:05" })).toBe(
      "USAGE: 85% of the five-hour limit · resets 14:05",
    )
    expect<unknown>(usageLimit({ limit: "five-hour", resets: "14:05" })).toBe(
      "USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at 14:05",
    )
    expect<unknown>(usageLimit({ limit: "seven-day" })).toBe(
      "USAGE_LIMIT: the seven-day limit is reached; no new tickets until it resets",
    )
    expect<unknown>(usageLimitLifted).toBe("USAGE_LIMIT lifted")
    expect<unknown>(
      phaseBug({ id: "tut-1", from: "Queued", to: "Merging", cause: "MergeStarted" }),
    ).toBe("  PHASE_BUG: tut-1 Queued → Merging (MergeStarted)")
  })
})

describe("sanitising", () => {
  test("an argument's control sequences go and its line breaks become spaces", () => {
    const title = "Fix\x1b]52;c;cm0gLXJmIC8=\x07 the\x1b[2J build\r\nnow\u202e\tplease\x9b"
    expect<unknown>(line`tut-1 dispatching: ${title}`).toBe(
      "tut-1 dispatching: Fix the build now please",
    )
    expect<unknown>(
      resolving({ id: "t\x1b[31m-1", base: "main", files: ["a\nb.ts"], limit: "20m" }),
    ).toBe(
      "  RESOLVING: tutti/t-1 conflicts with main in a b.ts; handed back to its worker to resolve (up to 20m)",
    )
  })

  test("a line written to the file never carries what its arguments held", async () => {
    const file = temp()
    const title = "evil\x1b]0;owned\x07\nfake 2026-10-17 09:05:03 START"
    await live(file, write(line`tut-1 dispatching: ${title}`))
    expect<unknown>(readFileSync(file, "utf8")).toBe(
      "2026-10-17 09:05:03 tut-1 dispatching: evil fake 2026-10-17 09:05:03 START\n",
    )
  })

  test("property: no builder's line holds a control character, whatever its arguments", () => {
    const builders: ReadonlyArray<(s: string) => Line> = [
      (s) => line`a ${s} b ${[s, s]}`,
      (s) => detail`${s}`,
      (s) => tagged("HOLD")`${s}`,
      (s) => ticketLine("MERGE_CONFLICT")`${s}`,
      (s) =>
        start({
          version: s,
          repo: s,
          base: s,
          scope: s,
          settings: [[s, s]],
          notes: [s],
        })[0] as Line,
      (s) => start({ version: s, repo: s, base: s, settings: [], notes: [s] })[1] as Line,
      (s) => hold(s, 2),
      (s) => resolving({ id: s, base: s, files: [s, s], limit: s }),
      (s) => fixing({ id: s, base: s, failure: s, attempt: 1, attempts: 2, limit: s }),
      (s) =>
        permission({
          id: s,
          requestId: s,
          what: s,
          why: s,
          defaultToNo: false,
          suppressAlwaysAllowRule: false,
        }),
      (s) => question({ id: s, requestId: s, questions: [{ question: s, options: [s, s] }] }),
      (s) =>
        answered({
          id: s,
          kind: "permission",
          what: s,
          verdict: "denied",
          detail: s,
          via: "screen",
        }),
      (s) => allowedByRule(s, s),
      (s) => denied({ id: s, what: s, by: "rule", reason: s }),
      (s) => steered(s),
      (s) => released(s),
      (s) => message(s, s),
      (s) => usageWarning({ percent: 1, limit: s, resets: s }),
      (s) => usageLimit({ limit: s, resets: s }),
      (s) => phaseBug({ id: s, from: s, to: s, cause: s }),
    ]
    fc.assert(
      fc.property(hostile, fc.nat({ max: builders.length - 1 }), (text, which) => {
        const built = (builders[which] as (s: string) => Line)(text)
        expect(unsafe(built)).toBe(false)
      }),
    )
  })

  test("property: each write is exactly its lines in the file", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(hostile, { minLength: 1, maxLength: 5 }), async (titles) => {
        const file = temp()
        await live(file, write(...titles.map((t) => line`title: ${t}`)))
        const lines = readFileSync(file, "utf8").split("\n")
        expect<unknown>(lines.pop()).toBe("")
        expect<unknown>(lines).toHaveLength(titles.length)
        for (const each of lines) expect<unknown>(each).toMatch(/^2026-10-17 09:05:03 title: /)
      }),
      { numRuns: 30 },
    )
  })
})

describe("the stdout sink", () => {
  test("plain mode prints the lines the file gets, dated the same", async () => {
    const file = temp()
    const { printed, console } = capturingConsole()
    await live(file, write(line`one`, steered("tut-1")), { sink: "stdout", console })
    expect(printed).toEqual(["2026-10-17 09:05:03 one", "2026-10-17 09:05:03   STEERED: tut-1"])
    expect(readFileSync(file, "utf8")).toBe(`${printed.join("\n")}\n`)
  })

  test("without it nothing is printed", async () => {
    const { printed, console } = capturingConsole()
    await live(temp(), write(line`one`), { console })
    expect(printed).toEqual([])
  })
})

describe("the test layer", () => {
  test("captures the lines, dated by the TestClock, and prints them with the stdout sink", async () => {
    const { printed, console } = capturingConsole()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(at)
        yield* write(line`one`, released("tut-1"))
        return { lines: yield* (yield* Log).lines, texts: yield* texts }
      }).pipe(
        Effect.provide(Layer.merge(capturedLayer({ sink: "stdout" }), TestClock.layer())),
        Effect.provideService(Console.Console, console),
      ),
    )
    expect(result.texts).toEqual(["one", "  RELEASED: tut-1"])
    expect(result.lines).toEqual([
      "2026-10-17 09:05:03 one",
      "2026-10-17 09:05:03   RELEASED: tut-1",
    ])
    expect(printed).toEqual([...result.lines])
  })
})
