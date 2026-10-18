import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createTestRenderer } from "@opentui/core/testing"
import { Duration, Effect, Exit, Option, Scope } from "effect"
import fc from "fast-check"
import {
  type Mode2027,
  mode2027Query,
  mode2027QueryLimit,
  parseMode2027Reply,
  queryMode2027,
  restoreMode2027,
  type Terminal,
} from "../src/ui/mode2027.ts"
import { fatalEvents, open, rendererConfig } from "../src/ui/renderer.ts"

const da1 = "\x1b[?62;22c"
const decrpm = (state: number) => `\x1b[?2027;${state}$y`

describe("a DECRPM reply", () => {
  test("says the mode as the terminal has it", () => {
    expect(parseMode2027Reply(decrpm(1))).toEqual(Option.some("on"))
    expect(parseMode2027Reply(decrpm(3))).toEqual(Option.some("on"))
    expect(parseMode2027Reply(decrpm(2))).toEqual(Option.some("off"))
    expect(parseMode2027Reply(decrpm(4))).toEqual(Option.some("off"))
    expect(parseMode2027Reply(decrpm(0))).toEqual(Option.some("unknown"))
    expect(parseMode2027Reply(da1)).toEqual(Option.none())
    expect(parseMode2027Reply("\x1b[?2026;1$y")).toEqual(Option.none())
  })

  test("is found among whatever else the terminal sent, and nothing else is taken for one", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.integer({ min: 0, max: 4 }), (a, b, state) => {
        fc.pre(!`${a}${b}`.includes("\x1b[?2027;"))
        expect(parseMode2027Reply(`${a}${b}`)).toEqual(Option.none())
        expect(Option.isSome(parseMode2027Reply(`${a}${decrpm(state)}${b}`))).toBe(true)
      }),
    )
  })
})

test("the mode is set back on only when the terminal had it on", () => {
  expect(restoreMode2027("on")).toBe("\x1b[?2027h")
  expect(restoreMode2027("off")).toBe("\x1b[?2027l")
  expect(restoreMode2027("unknown")).toBe("\x1b[?2027l")
})

/** A terminal that answers the query with `answer`, or doesn't when it is undefined. */
const fakeTerminal = (answer: string | undefined, tty = true) => {
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean
    isRaw: boolean
    flowing: boolean
  }
  stdin.isTTY = tty
  stdin.isRaw = false
  stdin.flowing = false
  const written: Array<string> = []
  const terminal: Terminal = {
    stdin: Object.assign(stdin, {
      setRawMode: (mode: boolean) => {
        stdin.isRaw = mode
      },
      resume: () => {
        stdin.flowing = true
      },
      pause: () => {
        stdin.flowing = false
      },
    }),
    stdout: {
      isTTY: tty,
      write: (text: string) => {
        written.push(text)
        // Answered in two chunks, as a terminal may.
        if (answer !== undefined) {
          const half = Math.floor(answer.length / 2)
          queueMicrotask(() => {
            stdin.emit("data", Buffer.from(answer.slice(0, half)))
            stdin.emit("data", answer.slice(half))
          })
        }
      },
    },
  }
  return { terminal, stdin, written }
}

describe("asking the terminal", () => {
  test("sends DECRQM then DA1 in raw mode, and leaves stdin as it was once answered", async () => {
    for (const [answer, mode] of [
      [`${decrpm(1)}${da1}`, "on"],
      [`${decrpm(2)}${da1}`, "off"],
      [`${decrpm(0)}${da1}`, "unknown"],
      [da1, "unknown"],
    ] as const) {
      const { terminal, stdin, written } = fakeTerminal(answer)
      let rawWhileAsked: boolean | undefined
      const write = terminal.stdout.write
      terminal.stdout.write = (text) => {
        rawWhileAsked = stdin.isRaw
        return write(text)
      }
      const started = performance.now()
      expect(await Effect.runPromise(queryMode2027(terminal))).toBe(mode)
      expect(performance.now() - started).toBeLessThan(Duration.toMillis(mode2027QueryLimit))
      expect(written).toEqual([mode2027Query])
      expect(rawWhileAsked).toBe(true)
      expect([stdin.isRaw, stdin.flowing, stdin.listenerCount("data")]).toEqual([false, false, 0])
    }
  })

  test("is unknown after the time limit without an answer, its listener gone", async () => {
    const { terminal, stdin } = fakeTerminal(undefined)
    const started = performance.now()
    expect(await Effect.runPromise(queryMode2027(terminal))).toBe("unknown")
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      Duration.toMillis(mode2027QueryLimit) - 5,
    )
    expect([stdin.isRaw, stdin.flowing, stdin.listenerCount("data")]).toEqual([false, false, 0])
  })

  test("keeps a DECRPM reply heard before the time limit, with no DA1 after it", async () => {
    const { terminal } = fakeTerminal(decrpm(1))
    expect(await Effect.runPromise(queryMode2027(terminal))).toBe("on")
  })

  test("is unknown, and asks nothing, when stdin or stdout isn't a terminal", async () => {
    const { terminal, written } = fakeTerminal(`${decrpm(1)}${da1}`, false)
    expect(await Effect.runPromise(queryMode2027(terminal))).toBe("unknown")
    expect(written).toEqual([])
  })
})

describe("the renderer's lifecycle", () => {
  /** Opens a shell over a test renderer, the terminal having mode 2027 `before`. */
  const opened = async (before: Mode2027) => {
    const { renderer } = await createTestRenderer({ ...rendererConfig, width: 40, height: 10 })
    const events: Array<string> = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.provide(scope)(
        open({
          chosen: "dark",
          make: async () => {
            events.push("made")
            return renderer
          },
          report: () => events.push(`reported, destroyed ${renderer.isDestroyed}`),
          mode2027: {
            ask: Effect.sync(() => {
              events.push("asked")
              return before
            }),
            write: (sequence) =>
              events.push(`wrote ${JSON.stringify(sequence)}, destroyed ${renderer.isDestroyed}`),
          },
        }),
      ),
    )
    return { renderer, events, scope }
  }

  test("asks before the renderer is made and sets the mode back once it has closed", async () => {
    for (const [before, sequence] of [
      ["on", "\x1b[?2027h"],
      ["off", "\x1b[?2027l"],
      ["unknown", "\x1b[?2027l"],
    ] as const) {
      const { events, scope } = await opened(before)
      expect(events).toEqual(["asked", "made"])
      await Effect.runPromise(Scope.close(scope, Exit.void))
      expect(events).toEqual(["asked", "made", `wrote ${JSON.stringify(sequence)}, destroyed true`])
    }
  })

  test("sets it back before a fatal error is reported, and only once", async () => {
    const { events, scope } = await opened("off")
    const handler = process.listeners(fatalEvents[0]).at(-1) as (error: unknown) => Promise<void>
    await handler(new Error("boom"))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(events).toEqual([
      "asked",
      "made",
      `wrote ${JSON.stringify("\x1b[?2027l")}, destroyed true`,
      "reported, destroyed true",
    ])
  })
})
