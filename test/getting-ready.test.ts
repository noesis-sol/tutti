// The line a run draws while it gets ready (src/run/gettingReady.ts, § 7.1): drawn on a terminal
// after frameInterval with the step under way, erased with nothing left when it ends, nothing
// drawn for a start sooner than that, off a terminal or on a dumb one, erased by an interrupt;
// the embedded Claude Code's extraction under it; and a run that can't start saying why once it
// has gone.
import { describe, expect, test } from "bun:test"
import { Console, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { resolveWith, type Sources } from "../src/agent/claudeBinary.ts"
import { cannotStart } from "../src/main.ts"
import { eraseLine, makePrinter, type Out } from "../src/print/organLine.ts"
import { gettingReady, readySteps } from "../src/run/gettingReady.ts"
import { frameInterval, spinnerFrames } from "../src/ui/spinner.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

/** A terminal that keeps what is written to it, in order, with what else the test notes. */
const terminal = (tty = true) => {
  const writes: Array<string> = []
  const out: Out = { write: (text) => void writes.push(text), columns: () => 80, tty }
  return { writes, out }
}

const run = <A>(effect: Effect.Effect<A>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

const flush = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

/** A frame forward, and the spinner given its turn. */
const frame = Effect.andThen(TestClock.adjust(frameInterval), flush)

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is stripped
const sgr = /\x1b\[[0-9;]*m/g

/** What a write shows, its erase and styles left out. */
const shown = (write: string): string => write.replace(eraseLine, "").replace(sgr, "")

const onTerminal = { dumb: false }

describe("the getting-ready line", () => {
  test("drawn after a frame, with each step in turn, and erased with nothing left", async () => {
    const { writes, out } = terminal()
    await run(
      Effect.gen(function* () {
        const ready = yield* gettingReady(out, onTerminal)
        yield* flush
        expect(writes).toEqual([])
        yield* frame
        yield* TestClock.adjust("3 seconds")
        yield* flush
        yield* ready.step(readySteps.backlog)
        yield* TestClock.adjust("3 seconds")
        yield* flush
        yield* ready.step(readySteps.starting)
        yield* frame
        yield* ready.end
        const ended = writes.length
        yield* TestClock.adjust("5 seconds")
        yield* flush
        expect(writes.length).toBe(ended)
      }),
    )
    expect(shown(writes[0] as string)).toBe(
      `${spinnerFrames[0]} Getting ready  checking the setup and your Claude login · 0:00`,
    )
    // Each frame's text, its spinner left out: the step, then the time.
    const texts = writes.slice(0, -1).map((write) => shown(write).slice(2))
    expect(texts).toContain("Getting ready  checking the setup and your Claude login · 0:03")
    expect(texts).toContain("Getting ready  reading the backlog · 0:06")
    expect(texts.at(-1)).toBe("Getting ready  starting the run · 0:06")
    expect(new Set(texts.map((text) => text.replace(/ · \d+:\d+$/, "")))).toEqual(
      new Set([
        "Getting ready  checking the setup and your Claude login",
        "Getting ready  reading the backlog",
        "Getting ready  starting the run",
      ]),
    )
    // Ended, the line is erased and the cursor left at the start of the empty line.
    expect(writes.at(-1)).toBe(eraseLine)
    for (const write of writes) {
      expect(write.startsWith(eraseLine)).toBe(true)
      expect(write).not.toContain("\n")
    }
  })

  test("in the terminal's own colours: the spinner bold, the time faint, under NO_COLOR too", async () => {
    const { writes, out } = terminal()
    await run(
      Effect.gen(function* () {
        const ready = yield* gettingReady(out, onTerminal)
        yield* frame
        yield* ready.end
      }),
    )
    expect(writes[0]).toBe(
      `${eraseLine}\x1b[1m${spinnerFrames[0]}\x1b[0m Getting ready  ` +
        `\x1b[2mchecking the setup and your Claude login · 0:00\x1b[0m`,
    )
  })

  test("a start under a frame draws nothing", async () => {
    const { writes, out } = terminal()
    await run(
      Effect.gen(function* () {
        const ready = yield* gettingReady(out, onTerminal)
        yield* TestClock.adjust("50 millis")
        yield* flush
        yield* ready.end
        yield* TestClock.adjust("5 seconds")
        yield* flush
      }),
    )
    expect(writes).toEqual([])
  })

  test("nothing where stdout isn't a terminal, nor on a dumb one", async () => {
    for (const [tty, dumb] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      const { writes, out } = terminal(tty)
      await run(
        Effect.gen(function* () {
          const ready = yield* gettingReady(out, { dumb })
          yield* TestClock.adjust("5 seconds")
          yield* flush
          const extracted = yield* ready.unpacking(Effect.succeed("/tmp/claude"))
          expect(extracted).toBe("/tmp/claude")
          yield* ready.end
        }),
      )
      expect(writes).toEqual([])
    }
  })

  test("an interrupt while it is drawn erases it", async () => {
    const { writes, out } = terminal()
    await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          Effect.andThen(gettingReady(out, onTerminal), Effect.never),
        )
        yield* frame
        expect(writes.length).toBe(1)
        yield* Fiber.interrupt(starting)
        yield* TestClock.adjust("5 seconds")
        yield* flush
      }),
    )
    expect(writes).toHaveLength(2)
    expect(writes.at(-1)).toBe(eraseLine)
  })

  test("a failure that ends its fiber erases it", async () => {
    const { writes, out } = terminal()
    await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* gettingReady(out, onTerminal)
            yield* Effect.sleep("250 millis")
            return yield* Effect.die("panic")
          }),
        )
        yield* TestClock.adjust("250 millis")
        yield* flush
        yield* Effect.exit(Fiber.join(starting))
        yield* TestClock.adjust("5 seconds")
        yield* flush
      }),
    )
    expect(writes.at(-1)).toBe(eraseLine)
  })

  test("--feature's organ lines come after it has gone: one spinner at a time", async () => {
    const { writes, out } = terminal()
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "256", noColor: true })
    await run(
      Effect.gen(function* () {
        const ready = yield* gettingReady(out, onTerminal)
        yield* frame
        yield* ready.end
        const planning = yield* makePrinter(out, theme).organ("Planning the feature")
        yield* frame
        yield* frame
        yield* planning.done("Planned the feature")
      }),
    )
    const readyFrames = writes.map(shown).map((each) => each.includes("Getting ready"))
    const lastReady = readyFrames.lastIndexOf(true)
    const firstPlan = writes.findIndex((each) => each.includes("Planning the feature"))
    expect(lastReady).toBe(0)
    expect(writes[1]).toBe(eraseLine)
    expect(firstPlan).toBe(2)
    expect(writes.slice(firstPlan).some((each) => each.includes("Getting ready"))).toBe(false)
  })
})

describe("the embedded Claude Code's extraction under it", () => {
  /** Sources with an embedded Claude Code, whose copy is `copy`, noting each extraction. */
  const embedded = (
    copy: string | null,
    ready: { readonly unpacking: Sources<never>["unpacking"] },
  ) => {
    const extracted: Array<string> = []
    const sources: Sources<never> = {
      cwd: "/work/project",
      embedded: "/$bunfs/root/claude-abc123",
      copied: () => copy,
      extract: (file) => {
        extracted.push(file)
        return "/tmp/claude-501/claude-agent-sdk-0123456789abcdef/claude-abc123"
      },
      unpacking: ready.unpacking,
      tidy: () => {},
      which: () => null,
      version: () => Effect.succeed("2.1.301 (Claude Code)"),
    }
    return { extracted, sources }
  }

  test("is said as unpacking, a frame drawn before the copy holds the thread, then the check", async () => {
    const { writes, out } = terminal()
    const { extracted, sources } = await run(
      Effect.gen(function* () {
        const ready = yield* gettingReady(out, onTerminal)
        const made = embedded(null, ready)
        const resolving = yield* Effect.forkChild(resolveWith(null, made.sources))
        yield* flush
        // The frame is drawn before the copy is made.
        yield* TestClock.adjust(frameInterval)
        yield* flush
        const claude = yield* Fiber.join(resolving)
        expect(claude.path).toBe("/tmp/claude-501/claude-agent-sdk-0123456789abcdef/claude-abc123")
        yield* frame
        yield* ready.end
        return made
      }),
    )
    expect(extracted).toEqual(["/$bunfs/root/claude-abc123"])
    expect(shown(writes[0] as string)).toBe(
      `${spinnerFrames[0]} Getting ready  unpacking Claude Code · 0:00`,
    )
    expect(shown(writes[1] as string)).toBe(
      `${spinnerFrames[1]} Getting ready  checking the setup and your Claude login · 0:00`,
    )
  })

  test("a copy extracted before is taken without unpacking", async () => {
    const { writes, out } = terminal()
    const { extracted } = await run(
      Effect.gen(function* () {
        const ready = yield* gettingReady(out, onTerminal)
        const made = embedded("/tmp/claude-501/kept/claude-abc123", ready)
        const claude = yield* resolveWith(null, made.sources)
        expect(claude.path).toBe("/tmp/claude-501/kept/claude-abc123")
        yield* ready.end
        return made
      }),
    )
    expect(extracted).toEqual([])
    expect(writes).toEqual([])
  })
})

describe("a run that can't start", () => {
  test("says why once the line has gone", async () => {
    const { writes, out } = terminal()
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      error: (...args: ReadonlyArray<unknown>) => void writes.push(`stderr: ${args.join(" ")}`),
    })
    const code = await run(
      Effect.gen(function* () {
        const ready = yield* gettingReady(out, onTerminal)
        yield* frame
        return yield* cannotStart(ready)("tutti isn't set up in this repository yet.")
      }).pipe(Effect.provideService(Console.Console, console)),
    )
    expect(code).toBe(2)
    expect(writes).toHaveLength(3)
    expect(writes[1]).toBe(eraseLine)
    expect(writes[2]).toBe("stderr: tutti isn't set up in this repository yet.")
  })
})
