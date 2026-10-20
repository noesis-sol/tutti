// Bun's node:child_process can lose a command's exit and its output (tutti-cje): its process group
// is gone and reaped, but no 'exit', data or 'end' ever comes, and the spawner's kill and finalizer
// wait on that exit forever. A spawner that loses them on purpose stands in for it here.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  type Command,
  CommandNotRun,
  CommandTimedOut,
  exec,
  LostExitGrace,
  ProcessGroups,
} from "../src/services/exec.ts"

setDefaultTimeout(30_000)

/** Spawns for real, and loses the exit and the output as Bun does. */
const losingSpawner = Effect.map(ChildProcessSpawner.ChildProcessSpawner, (real) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* real.spawn(command)
      yield* Effect.addFinalizer(() => Effect.never)
      return ChildProcessSpawner.makeHandle({
        ...handle,
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: (options) => Effect.andThen(Effect.ignore(handle.kill(options)), Effect.never),
        stdout: Stream.never,
        stderr: Stream.never,
        all: Stream.never,
      })
    }),
  ),
)

const runLosing = (command: Command, groups: Set<number>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* losingSpawner
      return yield* Effect.exit(
        exec(command).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(LostExitGrace, Duration.millis(300)),
          Effect.provideService(ProcessGroups, groups),
        ),
      )
    }).pipe(Effect.provide(BunServices.layer)),
  )

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

describe("exec, when the command's exit is lost", () => {
  test("fails with CommandNotRun once the group has gone, and forgets the group", async () => {
    const groups = new Set<number>()
    const started = Date.now()
    const exit = await runLosing(
      { command: "sh", args: ["-c", "echo out; exit 3"], timeLimit: "20 seconds" },
      groups,
    )
    const error = failure(exit)
    expect(error).toBeInstanceOf(CommandNotRun)
    expect((error as CommandNotRun).reason).toContain("exit")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(groups.size).toBe(0)
  })

  test("fails with CommandNotRun, not CommandTimedOut, when it ended before its time limit", async () => {
    const groups = new Set<number>()
    const exit = await runLosing(
      { command: "sh", args: ["-c", "exit 0"], timeLimit: "100 millis" },
      groups,
    )
    expect(failure(exit)).toBeInstanceOf(CommandNotRun)
    expect(groups.size).toBe(0)
  })

  test("is interrupted before it knows the exit is lost, and its scope still closes", async () => {
    const groups = new Set<number>()
    const started = Date.now()
    await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* losingSpawner
        const fiber = yield* Effect.forkChild(
          exec({ command: "sh", args: ["-c", "exit 0"], timeLimit: "20 seconds" }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(LostExitGrace, Duration.seconds(2)),
            Effect.provideService(ProcessGroups, groups),
          ),
        )
        yield* Effect.sleep("300 millis")
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(BunServices.layer)),
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(groups.size).toBe(0)
  })

  test("still fails with CommandTimedOut when the time limit killed it", async () => {
    const groups = new Set<number>()
    const started = Date.now()
    const exit = await runLosing(
      { command: "sh", args: ["-c", "sleep 30"], timeLimit: "300 millis", killGrace: "1 second" },
      groups,
    )
    expect(failure(exit)).toBeInstanceOf(CommandTimedOut)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(groups.size).toBe(0)
  })
})
