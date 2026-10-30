// The processes a ticket's worker left running in its worktree (src/services/Strays.ts), stopped
// when the trash deletes the worktree's folder or git removes it: real processes, each in a process
// group of its own as a test runner's stray worker is, found by their directory or executable; one
// outside the folder is left running.
import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Duration, Effect, Layer } from "effect"
import * as fc from "fast-check"
import { Trash, layer as trashLayer } from "../src/run/trash.ts"
import { processAlive } from "../src/services/processTree.ts"
import {
  inFolder,
  type Listed,
  parseLsof,
  type Stray,
  Strays,
  straysIn,
  layer as straysLayer,
} from "../src/services/Strays.ts"
import { trashFolder } from "../src/services/Worktrees.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as testStraysLayer } from "../src/testing/Strays.ts"
import { layer as worktreesLayer } from "../src/testing/Worktrees.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-strays-${name}-`)))

const started: Array<number> = []

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
})

/** Starts `command` in `cwd`, the leader of a process group of its own, as a stray worker is. */
const stray = async (cwd: string, command: string, args: ReadonlyArray<string>) => {
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" })
  child.unref()
  const pid = child.pid
  if (pid === undefined) throw new Error(`${command} didn't start`)
  started.push(pid)
  // Until lsof can see where it runs: exec'd, its directory set.
  await Bun.sleep(100)
  return pid
}

/** Waits up to `ms` for process `pid` to have gone. */
const gone = async (pid: number, ms = 2000) => {
  const until = Date.now() + ms
  while (processAlive(pid) && Date.now() < until) await Bun.sleep(20)
  return !processAlive(pid)
}

const live = (grace: Duration.Input = "2 seconds") =>
  straysLayer({ grace }).pipe(Layer.provide(BunServices.layer))

const stopping = (path: string, grace?: Duration.Input) =>
  Effect.runPromise(
    Effect.flatMap(Strays, (strays) => strays.stop(path)).pipe(Effect.provide(live(grace))),
  )

describe("Strays.stop", () => {
  test("stops a process whose directory is in the folder, and leaves one outside it", async () => {
    const inside = folder("inside")
    mkdirSync(join(inside, "packages", "web"), { recursive: true })
    const outside = folder("outside")
    const kept = await stray(outside, "sleep", ["60"])
    const left = await stray(join(inside, "packages", "web"), "sleep", ["61"])
    const stopped = await stopping(inside)
    expect(stopped).toEqual([{ pid: left, command: "sleep" }])
    expect(await gone(left)).toBe(true)
    expect(processAlive(kept)).toBe(true)
  })

  test("stops a process whose executable is in the folder, wherever it runs", async () => {
    const inside = folder("exe")
    const elsewhere = folder("cwd")
    // A copy of bun, as a worktree's node_modules holds Electron's: macOS kills a copy of one of
    // its own binaries, such as /bin/sleep, as it starts.
    const copy = join(inside, "spinner")
    copyFileSync(process.execPath, copy, constants.COPYFILE_FICLONE)
    const left = await stray(elsewhere, copy, ["-e", "setInterval(() => {}, 1000)"])
    // A fresh executable's first exec is scanned on macOS, up to a second or two, before it runs:
    // until then it is the test's fork, outside the folder.
    let stopped: ReadonlyArray<Stray> = []
    for (let i = 0; i < 50 && stopped.length === 0 && processAlive(left); i++) {
      stopped = await stopping(inside)
      if (stopped.length === 0) await Bun.sleep(100)
    }
    expect(stopped).toEqual([{ pid: left, command: "spinner" }])
    expect(await gone(left)).toBe(true)
  })

  test("a process that ignores SIGTERM gets a SIGKILL after the grace", async () => {
    const inside = folder("stubborn")
    const left = await stray(inside, "/bin/sh", ["-c", "trap '' TERM; exec sleep 60"])
    const stopped = await stopping(inside, "300 millis")
    expect(stopped.map((each) => each.pid)).toEqual([left])
    expect(await gone(left)).toBe(true)
  })

  test("a folder that isn't there has none", async () => {
    expect(await stopping(join(folder("empty"), "gone"))).toEqual([])
  })
})

describe("the trash", () => {
  test("a worktree's folder set aside is deleted once what was left running in it is stopped", async () => {
    const root = folder("root")
    const aside = join(root, trashFolder, "t-1-abc")
    const worktree = join(aside, "t-1")
    mkdirSync(worktree, { recursive: true })
    const outside = folder("beside")
    const kept = await stray(outside, "sleep", ["60"])
    const left = await stray(worktree, "sleep", ["61"])
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const trash = yield* Trash
        yield* trash.delete(aside, "t-1" as never)
        yield* trash.settled
        return yield* texts
      }).pipe(
        Effect.provide(
          trashLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(worktreesLayer({ root }), live(), eventsLayer(), logLayer()),
            ),
          ),
        ),
      ),
    )
    expect(await gone(left)).toBe(true)
    expect(existsSync(aside)).toBe(false)
    expect(processAlive(kept)).toBe(true)
    expect(lines).toEqual([`  t-1: stopped 1 process left running in ${aside}: sleep`])
  })

  test("what an earlier run left in the trash is stopped before its folder is deleted", async () => {
    const root = folder("left")
    const aside = join(root, trashFolder, "t-2-def")
    mkdirSync(join(aside, "t-2"), { recursive: true })
    const calls: Array<string> = []
    const left = {
      [aside]: [
        { pid: 4242, command: "node" },
        { pid: 4243, command: "Electron" },
      ],
    }
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const trash = yield* Trash
        yield* trash.clearLeft
        yield* trash.settled
        yield* trash.stopLeft(join(root, "t-3"), "t-3" as never)
        return yield* texts
      }).pipe(
        Effect.provide(
          trashLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                worktreesLayer({ root }),
                testStraysLayer(left, calls),
                eventsLayer(),
                logLayer(),
              ),
            ),
          ),
        ),
      ),
    )
    expect(calls).toEqual([aside, join(root, "t-3")])
    expect(existsSync(aside)).toBe(false)
    expect(lines).toEqual([
      `  stopped 2 processes left running in ${aside}: node, Electron`,
      `  deleted ${aside}, a merged worktree's folder an earlier run left`,
    ])
  })
})

describe("lsof's listing", () => {
  const listing = [
    "p101",
    "cvitest worker",
    "n/w/t-1",
    "n/usr/local/bin/node",
    "p102",
    "cnode",
    "n/w/t-10",
    "p103",
    "cElectron",
    "n/elsewhere",
    "n/w/t-1/node_modules/electron/Electron",
    "",
  ].join("\n")

  test("gives each process with its command and paths", () => {
    expect(parseLsof(listing)).toEqual([
      { pid: 101, command: "vitest worker", paths: ["/w/t-1", "/usr/local/bin/node"] },
      { pid: 102, command: "node", paths: ["/w/t-10"] },
      {
        pid: 103,
        command: "Electron",
        paths: ["/elsewhere", "/w/t-1/node_modules/electron/Electron"],
      },
    ])
  })

  test("the strays are those with a path in the folder, not one beside it, nor one spared", () => {
    expect(straysIn(parseLsof(listing), "/w/t-1", [])).toEqual([
      { pid: 101, command: "vitest worker" },
      { pid: 103, command: "Electron" },
    ])
    expect(straysIn(parseLsof(listing), "/w/t-1", [101])).toEqual([
      { pid: 103, command: "Electron" },
    ])
  })

  test("any text parses to processes with whole PIDs, whatever its paths and names say", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        for (const each of parseLsof(text) as ReadonlyArray<Listed>) {
          expect(Number.isSafeInteger(each.pid)).toBe(true)
          expect(each.paths.every((path) => path !== "" && !path.includes("\n"))).toBe(true)
        }
      }),
    )
  })

  test("a path is in a folder only as the folder or under it", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (name, rest) => {
        const folderPath = `/w/${name.replaceAll("/", "_")}`
        expect(inFolder(folderPath, `${folderPath}/${rest}`)).toBe(true)
        expect(inFolder(folderPath, folderPath)).toBe(true)
        expect(inFolder(folderPath, `${folderPath}x${rest.replaceAll("/", "")}`)).toBe(false)
      }),
    )
  })
})
