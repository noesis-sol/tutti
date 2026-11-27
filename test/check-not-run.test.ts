// A merge check that can't be run (§ 5 item 7): the shell's exit 127 or 126, its command not found
// or not executable, is CheckNotRun, its reason the output's first line, not a failure of the
// ticket's. Nothing is handed back to its worker and nothing is set aside: the ticket waits in line
// (CHECK_NOT_RUN), the run takes no new tickets, and once the base moves on the tickets waiting are
// checked again in their turns (RECHECK).

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer } from "effect"
import { line } from "../src/core/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { defaultSettings } from "../src/run/resolveConfig.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { TicketId } from "../src/services/Beads.ts"
import {
  CheckFailed,
  CheckNotRun,
  CheckOutput,
  Checks,
  notRunCodes,
  resultOf,
} from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const check = "scripts/check-fast.sh"
const missing = `sh: ${check}: No such file or directory`

/** What resultOf gives for a check that exited with `exitCode`, having printed `printed`. */
const resulted = (exitCode: number, printed: string) => {
  const output = new CheckOutput()
  output.write(new TextEncoder().encode(printed))
  return Effect.runSync(Effect.exit(resultOf("fast", check, exitCode, output, "/dev/fd/9")))
}

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

describe("a check that exits 127 or 126", () => {
  test("is the shell's not found and not executable", () => {
    expect([...notRunCodes].sort()).toEqual([126, 127])
  })

  for (const exitCode of [127, 126]) {
    test(`${exitCode} could not be run, its reason the output's first line`, () => {
      const error = failure(resulted(exitCode, `\n  ${missing}\nmore\n`))
      expect(error).toBeInstanceOf(CheckNotRun)
      expect(error).toMatchObject({ check: "fast", command: check, reason: missing })
      expect(error.message).toBe(`'${check}' could not be run: ${missing}`)
    })
  }

  test("printing nothing, its reason says the code", () => {
    expect(failure(resulted(127, ""))).toMatchObject({
      _tag: "CheckNotRun",
      reason: "it exited with 127, printing nothing",
    })
  })

  test("1 fails, as ever", () => {
    expect(failure(resulted(1, "1 fail\n"))).toBeInstanceOf(CheckFailed)
  })
})

describe("the live layer", () => {
  const checksLayer = (command: string) => {
    const { checks } = defaultSettings
    const settings = {
      ...defaultSettings,
      checks: { ...checks, fast: { command, timeout: Duration.seconds(10) } },
    }
    return Checks.layer.pipe(
      Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
      Layer.provideMerge(BunServices.layer),
    )
  }
  const fast = (command: string, script?: string) => {
    const cwd = mkdtempSync(join(tmpdir(), "tutti-check-not-run-"))
    if (script !== undefined) {
      writeFileSync(join(cwd, "check.sh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    }
    const outputFile = join(cwd, "check.log")
    return Effect.runPromise(
      Effect.exit(
        Effect.provide(
          Effect.gen(function* () {
            return yield* (yield* Checks).fast({ cwd, outputFile })
          }),
          checksLayer(command),
        ),
      ),
    )
  }

  test("a script that isn't there could not be run, the shell's line its reason", async () => {
    const error = failure(await fast(`./${"check-fast.sh"}`))
    expect(error).toBeInstanceOf(CheckNotRun)
    expect((error as CheckNotRun).reason).toContain("check-fast.sh")
  })

  test("a script that isn't executable could not be run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tutti-check-not-run-"))
    writeFileSync(join(cwd, "check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 })
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          Effect.gen(function* () {
            return yield* (yield* Checks).fast({ cwd, outputFile: join(cwd, "check.log") })
          }),
          checksLayer("./check.sh"),
        ),
      ),
    )
    expect(failure(exit)).toBeInstanceOf(CheckNotRun)
  })

  test("a suite inside it that exits 127, the script going on to exit 1, fails", async () => {
    const error = failure(await fast("./check.sh", "no-such-tool-tutti-test\necho '1 fail'\nexit 1"))
    expect(error).toBeInstanceOf(CheckFailed)
    expect(error).toMatchObject({ exitCode: 1 })
  })
})

const defaults = TestAppConfig.appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-check-not-run-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket, and after `takes` commits a change and closes it. */
const works = (world: World, root: string, id: TicketId, takes: Duration.Input): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(takes),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** Waits, in real time, until the run has written no log line or record for 30 ms. */
const caughtUp = Effect.gen(function* () {
  const captured = yield* Captured
  let said = -1
  for (let i = 0, still = 0; i < 1000 && still < 6; i++) {
    const now = (yield* texts).length + (yield* captured.records).length
    still = now === said ? still + 1 : 0
    said = now
    yield* Effect.promise(() => Bun.sleep(5))
  }
})

/** Moves TestClock on by `total`, a ready poll at a time, once the run has caught up each time. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const polls = Duration.toMillis(Duration.fromInputUnsafe(total)) / Duration.toMillis(readyPoll)
    for (let i = 0; i < polls; i++) {
      yield* caughtUp
      yield* advance(readyPoll)
    }
  })

const ids = ["a", "b", "c", "d"] as const

/**
 * A run of two workers over a, b, c and d, a's worker done in a minute and the others' in 10, its
 * merge check playing `fast`; `meanwhile` runs a minute in, and then 30 minutes pass.
 */
const runWith = (
  fast: ReadonlyArray<{ readonly exitCode: number; readonly output: string }>,
  meanwhile: (repo: string) => Effect.Effect<void, unknown, Repository>,
): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: {
        repo,
        worktrees: root,
        settings: {
          ...defaults,
          concurrent: 2,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: backlog()
        .ticket("a", { priority: 0 })
        .ticket("b", { priority: 1 })
        .ticket("c", { priority: 2 })
        .ticket("d", { priority: 3 }).seeds,
      git: { dir: repo, files: { "README.md": "tutti\n" } },
      worktrees: { root },
      checks: { fast },
      scripts: (world: World) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            [works(world, root, id as TicketId, id === "a" ? "1 minute" : "10 minutes")],
          ]),
        ),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ids) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* passes("2 minutes")
      yield* meanwhile(repo)
      yield* passes("30 minutes")
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The tickets whose workers were dispatched. */
const dispatched = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "dispatch" && record.ticket !== undefined ? [record.ticket] : [],
  )

const outcomeOf = (ran: Ran<Outcome>): Outcome => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the run failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("a merge check that could not be run", () => {
  for (const exitCode of [127, 126]) {
    test(`exit ${exitCode}: no hand-back, nothing set aside, and no new tickets start`, async () => {
      const ran = await runWith([{ exitCode, output: `${missing}\n` }], () => Effect.void)
      expectExitCode(ran, 2)
      expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
      expect(ran.log.some((text) => text.includes("FIXING"))).toBe(false)
      expect(ran.log.some((text) => text.includes("CHECKS_FAILED"))).toBe(false)
      const why = `'${check}' could not be run (${missing}) on tutti/a on top of main: nothing was checked; no new tickets start until it can`
      expectLog(ran, [`  CHECK_NOT_RUN: ${why}`, `CHECK_NOT_RUN: ${why}`])
      // c may have taken a's slot as a's check began; once the run holds, d never starts.
      expect(dispatched(ran)).not.toContain("d")
      const phases = outcomeOf(ran).phases
      // a and b wait to merge, for the next run.
      expect(phases.a?._tag).toBe("Stopped")
      expect(phases.b?._tag).toBe("Stopped")
      expect(ran.events).toContainEqual(
        expect.objectContaining({ kind: "phase", ticket: "a", cause: "CheckNotRun" }),
      )
    }, 30_000)
  }

  test("the tickets waiting merge once the base moves on with the command there", async () => {
    const ran = await runWith([{ exitCode: 127, output: `${missing}\n` }], (repo) =>
      Effect.gen(function* () {
        yield* (yield* Repository).commit(repo, "Commit the check script", { [check]: "exit 0\n" })
      }),
    )
    expectExitCode(ran, 0)
    expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
    expect(ran.log.some((text) => text.includes("FIXING"))).toBe(false)
    expectLog(ran, [
      /^ {2}CHECK_NOT_RUN: /,
      /^ {2}RECHECK: main has moved on from [0-9a-f]{7}, where a's check could not be run; checking the tickets waiting to merge again, a first$/,
    ])
    const phases = outcomeOf(ran).phases
    for (const id of ids) expect({ id, phase: phases[id]?._tag }).toEqual({ id, phase: "Done" })
    expect(dispatched(ran)).toContain("d")
  }, 30_000)
})
