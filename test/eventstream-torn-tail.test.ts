import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Result } from "effect"
import { decodeLine, type Event, encodeLine } from "../src/run/events.ts"
import { EventStream, eventsFile, stamp } from "../src/run/eventstream.ts"

const run = "2026-10-02T09:12:03.98+02:00"

/** Runs `events` through a stream in a new checkout whose events.jsonl starts as `before`. */
const withFile = (before: string | undefined, events: ReadonlyArray<Event>) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-events-torn-")))
  const file = join(repo, eventsFile)
  if (before !== undefined) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, before)
  }
  const warnings: Array<string> = []
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
        }),
      ),
    ),
  )
  const text = readFileSync(file, "utf8")
  return { text, lines: text.split("\n").slice(0, -1), warnings }
}

const info = (text: string): Event => ({ kind: "info", text })

const texts = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line) => {
    const record = decodeLine(line)
    return Result.isSuccess(record) && record.success.kind === "info" ? [record.success.text] : []
  })

// A record of an earlier run, whole with its newline, and one cut short in the middle.
const earlierRun = "2026-10-01T08:00:00.00+02:00"
const earlier = `${Result.getOrThrow(encodeLine(stamp(info("old"), earlierRun, 0)))}\n`
const cut = Result.getOrThrow(encodeLine(stamp(info("cut"), earlierRun, 1))).slice(0, 40)

describe("an events.jsonl an earlier run left", () => {
  test("cut short, without its newline, is ended ahead of this run's first record", () => {
    const { text, lines, warnings } = withFile(earlier + cut, [info("one"), info("two")])
    expect(text).toStartWith(`${earlier}${cut}\n`)
    expect(lines).toHaveLength(4)
    expect(texts(lines)).toEqual(["old", "one", "two"])
    expect(warnings).toEqual([])
  })

  test("of one byte, not a newline, is ended too", () => {
    const { lines } = withFile("{", [info("one")])
    expect(lines).toEqual(["{", expect.any(String)])
    expect(texts(lines)).toEqual(["one"])
  })

  test("ending in a newline gets no empty line ahead of this run's records", () => {
    const { text, lines } = withFile(earlier, [info("one")])
    expect(text).toStartWith(earlier)
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.length > 0)).toBe(true)
    expect(texts(lines)).toEqual(["old", "one"])
  })

  test("empty, or not there at all, starts with this run's first record", () => {
    for (const before of ["", undefined]) {
      const { lines } = withFile(before, [info("one")])
      expect(lines).toHaveLength(1)
      expect(texts(lines)).toEqual(["one"])
    }
  })
})
