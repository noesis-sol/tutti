// Choosing light or dark from the terminal's answer (queryAppearance, on fake TTY streams under
// TestClock), and a scheme file that is there but can't be read.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  backgroundQueryLimit,
  type LoadedScheme,
  loadScheme,
  orchestra,
  queryAppearance,
  type SchemeFolders,
  type TerminalStreams,
} from "../src/ui/theme.ts"

const query = "\x1b]11;?\x07\x1b[c"
const deviceAttributes = "\x1b[?62;22c"

/**
 * A fake terminal: stdin and stdout that are TTYs (or not), recording what is written and the raw
 * modes set, and answering the query with `replies`, each a chunk on stdin, a tick after the write.
 */
const fakeTerminal = (
  options: {
    readonly tty?: boolean
    readonly raw?: boolean
    readonly replies?: ReadonlyArray<string>
  } = {},
) => {
  const listeners = new Set<(chunk: Buffer | string) => void>()
  const written: Array<string> = []
  const rawModes: Array<boolean> = []
  let flowing = false
  const stdin = {
    isTTY: options.tty ?? true,
    isRaw: options.raw ?? false,
    setRawMode(mode: boolean) {
      rawModes.push(mode)
      stdin.isRaw = mode
    },
    on(_event: "data", listener: (chunk: Buffer | string) => void) {
      listeners.add(listener)
    },
    off(_event: "data", listener: (chunk: Buffer | string) => void) {
      listeners.delete(listener)
    },
    resume() {
      flowing = true
    },
    pause() {
      flowing = false
    },
  }
  const stdout = {
    isTTY: options.tty ?? true,
    write(text: string) {
      written.push(text)
      for (const reply of options.replies ?? []) {
        queueMicrotask(() => {
          for (const listener of [...listeners]) listener(Buffer.from(reply))
        })
      }
    },
  }
  const streams: TerminalStreams = { stdin, stdout }
  return {
    streams,
    written,
    rawModes,
    isRaw: () => stdin.isRaw,
    listening: () => listeners.size,
    flowing: () => flowing,
  }
}

/** queryAppearance on `streams`, under TestClock: its time limit passes only when moved. */
const ask = (streams: TerminalStreams) =>
  Effect.runPromise(queryAppearance(streams).pipe(Effect.provide(TestClock.layer())))

describe("asking the terminal for its background", () => {
  test("not a terminal: none at once, and nothing is asked", async () => {
    for (const [stdinTty, stdoutTty] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const terminal = fakeTerminal()
      const streams: TerminalStreams = {
        stdin: { ...terminal.streams.stdin, isTTY: stdinTty },
        stdout: { ...terminal.streams.stdout, isTTY: stdoutTty },
      }
      expect(await ask(streams)).toEqual(Option.none())
      expect(terminal.written).toEqual([])
      expect(terminal.rawModes).toEqual([])
      expect(terminal.listening()).toBe(0)
    }
  })

  test("a dark background's reply gives dark", async () => {
    const terminal = fakeTerminal({
      replies: ["\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\", deviceAttributes],
    })
    expect(await ask(terminal.streams)).toEqual(Option.some("dark"))
    expect(terminal.written).toEqual([query])
  })

  test("a light background's reply gives light", async () => {
    const terminal = fakeTerminal({ replies: ["\x1b]11;rgb:ffff/ffff/ffff\x07", deviceAttributes] })
    expect(await ask(terminal.streams)).toEqual(Option.some("light"))
  })

  test("a reply split over chunks is read whole", async () => {
    const terminal = fakeTerminal({ replies: ["\x1b]11;rgb:fd", "fd/f6f6/e3e3", "\x07"] })
    expect(await ask(terminal.streams)).toEqual(Option.some("light"))
  })

  test("only the device attributes reply: none, without waiting out the limit", async () => {
    // The clock never moves, so an answer at all is one before the limit.
    const terminal = fakeTerminal({ replies: [deviceAttributes] })
    expect(await ask(terminal.streams)).toEqual(Option.none())
    expect(terminal.listening()).toBe(0)
  })

  test("no reply: none once the limit passes, and not before", async () => {
    const terminal = fakeTerminal()
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(queryAppearance(terminal.streams))
        yield* Effect.yieldNow
        yield* TestClock.adjust("249 millis")
        // Still waiting: listening, in raw mode.
        expect(terminal.listening()).toBe(1)
        expect(terminal.isRaw()).toBe(true)
        yield* TestClock.adjust("1 millis")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(answer).toEqual(Option.none())
    expect(terminal.written).toEqual([query])
    expect(terminal.listening()).toBe(0)
    expect(terminal.flowing()).toBe(false)
    expect(terminal.isRaw()).toBe(false)
  })

  test("raw mode is restored as it was, whether or not the terminal answers", async () => {
    for (const raw of [false, true]) {
      const answered = fakeTerminal({ raw, replies: ["\x1b]11;#000000\x07"] })
      expect(await ask(answered.streams)).toEqual(Option.some("dark"))
      expect(answered.rawModes).toEqual([true, raw])
      expect(answered.isRaw()).toBe(raw)
      expect(answered.listening()).toBe(0)
      expect(answered.flowing()).toBe(false)

      const silent = fakeTerminal({ raw })
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(queryAppearance(silent.streams))
          yield* Effect.yieldNow
          yield* TestClock.adjust(backgroundQueryLimit)
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(TestClock.layer())),
      )
      expect(silent.rawModes).toEqual([true, raw])
      expect(silent.isRaw()).toBe(raw)
    }
  })
})

/** A project folder and a user folder for schemes, empty. */
const emptyFolders = (): SchemeFolders => {
  const top = mkdtempSync(join(tmpdir(), "tutti-theme-appearance-"))
  const folders = { project: join(top, "project"), user: join(top, "user") }
  mkdirSync(folders.project)
  mkdirSync(folders.user)
  return folders
}

const loadIn = (name: string, folders: SchemeFolders): Promise<LoadedScheme> =>
  Effect.runPromise(loadScheme(name, folders).pipe(Effect.provide(BunServices.layer)))

const dusk = JSON.stringify({ name: "dusk", colours: {} })

/** Puts something unreadable at `<folder>/<name>.json`: a folder, or a file no one may read. */
const unreadable = {
  "a folder in its place": (folder: string, name: string) => {
    mkdirSync(join(folder, `${name}.json`))
  },
  "a file without read permission": (folder: string, name: string) => {
    const path = join(folder, `${name}.json`)
    writeFileSync(path, dusk)
    chmodSync(path, 0o000)
  },
} as const

// Root reads a file whatever its permissions.
const isRoot = process.getuid?.() === 0

describe("a scheme file that can't be read", () => {
  for (const [what, place] of Object.entries(unreadable)) {
    const skip = isRoot && what === "a file without read permission"

    test.skipIf(skip)(`${what}, in the project's or the user's folder: not used`, async () => {
      for (const where of ["project", "user"] as const) {
        const folders = emptyFolders()
        place(folders[where], "dusk")
        const loaded = await loadIn("dusk", folders)
        const path = join(folders[where], "dusk.json")
        expect(loaded.scheme).toBe(orchestra)
        expect(loaded.warnings).toEqual([])
        expect(
          loaded.fallback?.startsWith(`colour scheme 'dusk' isn't used: ${path} can't be read: `),
        ).toBe(true)
      }
    })

    test.skipIf(skip)(`${what}, in the project's folder, hides the user's file`, async () => {
      const folders = emptyFolders()
      place(folders.project, "dusk")
      writeFileSync(join(folders.user, "dusk.json"), dusk)
      const loaded = await loadIn("dusk", folders)
      expect(loaded.scheme).toBe(orchestra)
      expect(loaded.fallback).toContain(`${join(folders.project, "dusk.json")} can't be read: `)
    })

    test.skipIf(skip)(`${what}, with a built-in's name: the built-in, quietly`, async () => {
      const folders = emptyFolders()
      place(folders.project, "orchestra")
      expect(await loadIn("orchestra", folders)).toEqual({
        scheme: orchestra,
        fallback: null,
        warnings: [],
      })
    })
  }
})
