import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import fc from "fast-check"
import {
  CappedFile,
  type Command,
  exec,
  type FileBounds,
  fileCutNote,
} from "../src/services/exec.ts"

// Real processes, which under load can outlast bun's 5 s default.
setDefaultTimeout(30_000)

const runExit = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(Effect.exit(Effect.provide(effect, BunServices.layer)))

const sh = (script: string, more: Partial<Command> = {}): Command => ({
  command: "sh",
  args: ["-c", script],
  timeLimit: "10 seconds",
  ...more,
})

const tempDir = () => mkdtempSync(join(tmpdir(), "tutti-exec-bounds-"))

/** What a CappedFile writes of `chunks`: what it writes as they come, then what it writes at the end. */
const written = (bounds: FileBounds, chunks: ReadonlyArray<string>): string => {
  const capped = new CappedFile(bounds)
  const parts = chunks.map((chunk) => Buffer.from(capped.take(Buffer.from(chunk))).toString())
  return parts.join("") + Buffer.from(capped.end()).toString()
}

/** What a file bounded by `bounds` holds of `whole`. */
const expected = (bounds: FileBounds, whole: string): string => {
  if (whole.length <= bounds.head + bounds.tail) return whole
  const left = whole.length - bounds.head - bounds.tail
  return (
    whole.slice(0, bounds.head) +
    fileCutNote(left, bounds) +
    whole.slice(whole.length - bounds.tail)
  )
}

describe("CappedFile", () => {
  test("writes an output within its bounds whole", () => {
    expect(written({ head: 4, tail: 4 }, ["abc", "defgh"])).toBe("abcdefgh")
  })

  test("keeps the first and last bytes of a longer one, saying how many it left out", () => {
    expect(written({ head: 3, tail: 2 }, ["abcd", "efg", "hij"])).toBe(
      `abc${fileCutNote(5, { head: 3, tail: 2 })}ij`,
    )
  })

  test("holds the first bytes and the last whatever the chunks", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: fc.constantFrom("a", "b", "\n"), maxLength: 40 })),
        fc.nat(30),
        fc.nat(30),
        (chunks, head, tail) => {
          const bounds = { head, tail }
          expect(written(bounds, chunks)).toBe(expected(bounds, chunks.join("")))
        },
      ),
    )
  })
})

describe("exec's output file", () => {
  // 2000 numbered lines of 5 bytes, "0000\n" to "1999\n": 10000 bytes.
  const lines = "i=0; while [ $i -lt 2000 ]; do printf '%04d\\n' $i; i=$((i+1)); done"
  const whole = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, "0")}\n`).join("")
  const bounds = { head: 1000, tail: 3000 }

  test("holds the first and last bytes of an output past its bounds", async () => {
    const file = join(tempDir(), "check.log")
    const exit = await runExit(exec(sh(lines, { outputFile: file, fileBounds: bounds })))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(expected(bounds, whole))
  })

  test("bounds a descriptor it was given as it bounds a file", async () => {
    const file = join(tempDir(), "check.log")
    const fd = openSync(file, "w")
    try {
      const exit = await runExit(exec(sh(lines, { outputFd: fd, fileBounds: bounds })))
      expect(Exit.isSuccess(exit)).toBe(true)
    } finally {
      closeSync(fd)
    }
    expect(readFileSync(file, "utf8")).toBe(expected(bounds, whole))
  })

  test("writes the last bytes of a command that ran past its time limit", async () => {
    const file = join(tempDir(), "check.log")
    const exit = await runExit(
      exec(
        sh(`${lines}; echo end; sleep 30`, {
          outputFile: file,
          fileBounds: bounds,
          timeLimit: "1 second",
          killGrace: "100 millis",
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(expected(bounds, `${whole}end\n`))
  })

  test("keeps the whole of an output within its bounds, as before", async () => {
    const file = join(tempDir(), "check.log")
    const exit = await runExit(exec(sh(lines, { outputFile: file })))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(whole)
  })
})
