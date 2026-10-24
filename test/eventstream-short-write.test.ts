import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { decodeLine, type Event } from "../src/run/events.ts"
import { EventStream, eventsFile } from "../src/run/eventstream.ts"

const run = "2026-10-02T09:12:03.98+02:00"

// What the file does with each write, in turn: take it whole, take only its first `n` bytes, or
// throw, as a full disk does.
type Step = "whole" | number | "ENOSPC"

/** Runs `events` through a stream in a new checkout whose writes go as `steps` say. */
const withSteps = (steps: ReadonlyArray<Step>, events: ReadonlyArray<Event>) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-events-short-")))
  const warnings: Array<string> = []
  let call = 0
  const cut = (fd: number, bytes: Uint8Array): number => {
    const step = steps[call++] ?? "whole"
    if (step === "ENOSPC") throw new Error("ENOSPC: no space left on device, write")
    return writeSync(fd, step === "whole" ? bytes : bytes.subarray(0, step))
  }
  Effect.runSync(
    Effect.gen(function* () {
      const stream = yield* EventStream
      for (const event of events) yield* stream.emit(event)
    }).pipe(
      Effect.provide(
        EventStream.layer({
          repo,
          run,
          warn: (message) => Effect.sync(() => warnings.push(message)),
          writeSync: cut,
        }),
      ),
    ),
  )
  const text = readFileSync(join(repo, eventsFile), "utf8")
  return { text, lines: text.split("\n").slice(0, -1), warnings }
}

const info = (text: string): Event => ({ kind: "info", text })

const texts = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line) => {
    const record = decodeLine(line)
    return Result.isSuccess(record) && record.success.kind === "info" ? [record.success.text] : []
  })

describe("a write to the event stream cut short", () => {
  test("is ended with a newline at once, so the next record has a line of its own", () => {
    const { text, lines, warnings } = withSteps(
      ["whole", 20],
      [info("one"), info("two"), info("three")],
    )
    expect(text).toEndWith("\n")
    expect(lines).toHaveLength(3)
    expect(texts(lines)).toEqual(["one", "three"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("wrote 20 of a record's ")
  })

  test("is ended ahead of the next record where its newline can't be written", () => {
    const { text, lines, warnings } = withSteps(
      [20, "ENOSPC", "ENOSPC", "whole"],
      [info("one"), info("two"), info("three")],
    )
    expect(text).toEndWith("\n")
    expect(lines).toHaveLength(2)
    expect(texts(lines)).toEqual(["three"])
    expect(warnings).toHaveLength(1)
  })

  test("is ended ahead of the next record where its newline is cut short too", () => {
    const { lines } = withSteps([20, 0, "whole"], [info("one"), info("two")])
    expect(lines).toHaveLength(2)
    expect(texts(lines)).toEqual(["two"])
  })

  test("stays torn while the next records are cut short too, and is ended by the first whole one", () => {
    // The second record's write takes the first's newline and 5 bytes of its own, the third's only
    // the second's newline, so the fourth needs none ahead of it and lands whole.
    const { lines } = withSteps(
      [20, 0, 6, 0, 1, "whole"],
      [info("one"), info("two"), info("three"), info("four")],
    )
    expect(texts(lines)).toEqual(["four"])
    expect(lines.filter((line) => line.length > 0)).toHaveLength(3)
  })

  test("a write that fails whole leaves no part, and the next record follows on its own line", () => {
    const { lines } = withSteps(["ENOSPC", "whole"], [info("one"), info("two")])
    expect(lines).toHaveLength(1)
    expect(texts(lines)).toEqual(["two"])
  })
})
