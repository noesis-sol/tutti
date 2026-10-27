// Keeping the machine awake (§ 8.2; src/run/keepAwake.ts): the system's keep-awake command for
// tutti's PID, the START block's warning where there is none, and the command held until the run's
// scope closes. Whether a run keeps it awake: keep-awake-default.test.ts.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, SubscriptionRef } from "effect"
import {
  type AwakeCommand,
  awakeCommandOf,
  keepAwake,
  keepAwakePlan,
  keepingAwakeLine,
} from "../src/run/keepAwake.ts"
import type { Log } from "../src/run/log.ts"
import { ProcessGroups } from "../src/services/exec.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"

// Each test starts a real process, and stopping one waits on its exit.
setDefaultTimeout(30_000)

const tempDir = () => mkdtempSync(join(tmpdir(), "tutti-keep-awake-"))

/** Runs `effect` with a captured log and a registry of process groups of its own. */
const runWith = <A, E>(
  groups: Set<number>,
  effect: Effect.Effect<A, E, BunServices.BunServices | Log>,
) =>
  Effect.runPromise(
    Effect.exit(
      effect.pipe(
        Effect.provide(logLayer()),
        Effect.provide(BunServices.layer),
        Effect.provideService(ProcessGroups, groups),
      ),
    ),
  )

/** Waits until `ready` holds, up to 10 s. */
const until = (ready: () => boolean, what: string) =>
  Effect.promise(async () => {
    const deadline = Date.now() + 10_000
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`${what} never came`)
      await Bun.sleep(20)
    }
  })

/** Waits until the captured log has `line`, and gives its lines. */
const logged = (line: string) =>
  Effect.gen(function* () {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
      const lines = yield* texts
      if (lines.includes(line)) return lines
      yield* Effect.sleep("20 millis")
    }
    return yield* texts
  })

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")

describe("the keep-awake command", () => {
  test("is caffeinate on macOS and systemd-inhibit on Linux, both given tutti's PID", () => {
    expect(awakeCommandOf("darwin", 4242)).toEqual({
      command: "caffeinate",
      args: ["-i", "-w", "4242"],
    })
    expect(awakeCommandOf("linux", 4242)).toEqual({
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=tutti",
        "--why=a run of workers",
        "--mode=block",
        "tail",
        "--pid=4242",
        "-f",
        "/dev/null",
      ],
    })
    expect(awakeCommandOf("win32", 4242)).toBeNull()
  })

  test("the log names it as run", () => {
    const awake = awakeCommandOf("linux", 7) as AwakeCommand
    expect<string>(keepingAwakeLine(awake)).toBe(
      "keeping the machine awake while the run goes: systemd-inhibit --what=idle:sleep --who=tutti '--why=a run of workers' --mode=block tail --pid=7 -f /dev/null",
    )
  })
})

describe("keepAwakePlan", () => {
  const on = { on: true, platform: "darwin", pid: 99 } as const

  test("off, does nothing and looks for nothing", () => {
    const looked: Array<string> = []
    const plan = keepAwakePlan({
      ...on,
      on: false,
      which: (command) => {
        looked.push(command)
        return null
      },
    })
    expect(plan).toEqual({ _tag: "Off" })
    expect(looked).toEqual([])
  })

  test("on, runs the system's command when it is on the PATH", () => {
    expect(keepAwakePlan({ ...on, which: (command) => `/usr/bin/${command}` })).toEqual({
      _tag: "Command",
      command: { command: "caffeinate", args: ["-i", "-w", "99"] },
    })
  })

  test("warns when the command isn't on the PATH", () => {
    expect(keepAwakePlan({ ...on, platform: "linux", which: () => null })).toEqual({
      _tag: "Missing",
      warning:
        "keep awake: systemd-inhibit isn't on the PATH, so nothing keeps the machine awake and the run sleeps with it; set the machine not to sleep",
    })
  })

  test("warns on a system tutti knows no command for", () => {
    expect(keepAwakePlan({ ...on, platform: "freebsd", which: (c) => c })).toEqual({
      _tag: "Missing",
      warning:
        "keep awake: tutti can't keep the machine awake on freebsd; set it not to sleep, or the run sleeps with it",
    })
  })
})

describe("keepAwake", () => {
  test("holds the command until the scope closes, which stops it", async () => {
    const dir = tempDir()
    const file = join(dir, "calls")
    const awake: AwakeCommand = {
      command: "sh",
      args: [
        "-c",
        `trap 'echo stopped >> calls; exit 0' TERM; echo "started in $(pwd -P)" > calls; while :; do sleep 0.05; done`,
      ],
    }
    const groups = new Set<number>()
    const exit = await runWith(
      groups,
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const holding = yield* SubscriptionRef.make(false)
            yield* keepAwake(awake, dir, holding)
            yield* until(() => read(file).startsWith("started"), "the command's start")
            expect(groups.size).toBe(1)
            expect(yield* SubscriptionRef.get(holding)).toBe(true)
          }),
        )
        return yield* texts
      }),
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual([keepingAwakeLine(awake)])
    expect(read(file)).toMatch(/^started in .*tutti-keep-awake-.*\nstopped\n$/u)
    expect(groups.size).toBe(0)
  })

  test("a command that ends by itself while the run goes is a line in the log, and no longer holds", async () => {
    const awake: AwakeCommand = { command: "sh", args: ["-c", "echo gone >&2; exit 3"] }
    const ended = "sh ended (exit status 3: gone): nothing keeps the machine awake"
    const holding = Effect.runSync(SubscriptionRef.make(false))
    const exit = await runWith(
      new Set(),
      Effect.scoped(Effect.andThen(keepAwake(awake, tempDir(), holding), logged(ended))),
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual([keepingAwakeLine(awake), ended])
    expect(SubscriptionRef.getUnsafe(holding)).toBe(false)
  })

  test("a command that can't start is a line in the log, and the run goes on", async () => {
    const awake: AwakeCommand = { command: "tutti-no-such-keep-awake", args: ["-i"] }
    const holding = Effect.runSync(SubscriptionRef.make(false))
    const exit = await runWith(
      new Set(),
      Effect.scoped(
        Effect.andThen(
          keepAwake(awake, tempDir(), holding),
          Effect.gen(function* () {
            for (let tries = 0; tries < 500; tries++) {
              const lines = yield* texts
              if (lines.length > 1) return lines
              yield* Effect.sleep("20 millis")
            }
            return yield* texts
          }),
        ),
      ),
    )
    const lines = Exit.isSuccess(exit) ? exit.value : []
    expect(lines[0]).toBe(keepingAwakeLine(awake))
    expect(lines[1]).toMatch(
      /^tutti-no-such-keep-awake ended \(.+\): nothing keeps the machine awake$/u,
    )
    expect(SubscriptionRef.getUnsafe(holding)).toBe(false)
  })
})
