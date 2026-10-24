import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { Notifier } from "../src/services/Notifier.ts"
import { Tty } from "../src/services/Tty.ts"
import { frameInterval, spinnerFrames } from "../src/ui/spinner.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { advance, scenario, tty } from "./harness.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

describe("the harness's terminal", () => {
  test("is an 80×24 256-colour TTY unless the setup gives one", async () => {
    const read = Effect.gen(function* () {
      const terminal = yield* Tty
      return { ...terminal, size: yield* terminal.size }
    })
    const fixed = await scenario({}, read)
    expect(fixed.exit).toMatchObject({
      _tag: "Success",
      value: {
        stdinIsTty: true,
        stdoutIsTty: true,
        dumb: false,
        colourDepth: "256",
        size: { columns: 80, rows: 24 },
      },
    })
    const given = await scenario(
      { tty: tty({ stdoutIsTty: false, size: { columns: 132, rows: 40 } }) },
      read,
    )
    expect(given.exit).toMatchObject({
      _tag: "Success",
      value: { stdinIsTty: true, stdoutIsTty: false, size: { columns: 132, rows: 40 } },
    })
  })

  test("captures the notifications, sanitised, in Ran", async () => {
    const ran = await scenario(
      {},
      Effect.gen(function* () {
        const notifier = yield* Notifier
        yield* notifier.notify("t-1 merged")
        yield* notifier.notify("t-2 \x1b[31mneeds\x1b[0m your answer")
      }),
    )
    expect(ran.notices).toEqual(["t-1 merged", "t-2 needs your answer"])
  })

  test("has a run without notifications give none", async () => {
    const ran = await scenario({}, Effect.void)
    expect(ran.notices).toEqual([])
  })

  test("turns a spinner only as the clock is moved on", async () => {
    const written: Array<string> = []
    const out: Out = { write: (text) => written.push(text), columns: () => 80, tty: true }
    const printer = makePrinter(out, theme)
    const ran = await scenario(
      {},
      Effect.gen(function* () {
        const line = yield* printer.organ("Writing the report")
        yield* Effect.yieldNow
        const before = written.length
        yield* advance(frameInterval)
        yield* advance(frameInterval)
        yield* advance(frameInterval)
        const frames = written.slice(before)
        yield* line.done("Report written")
        return frames
      }),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success" })
    if (ran.exit._tag !== "Success") return
    expect(ran.exit.value.map((frame) => frame.match(/[⣾⣽⣻⢿⡿⣟⣯⣷]/)?.[0])).toEqual(
      spinnerFrames.slice(0, 3),
    )
  })
})
