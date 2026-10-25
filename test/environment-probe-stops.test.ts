// The environment probe lifts only its own stop (§ 4.9): BLOCKED and TICKET_LIMIT, raised while it
// waited on a worker waiting on you, stay after it passes, and end the run with their exit code.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { probeFile, probeWorker } from "../src/run/environment.ts"
import { addStop, blockedStop, noStops, stopFor, swapStop } from "../src/run/holds.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { writeRunFile } from "../src/services/Worktrees.ts"
import { bash, canUseTool, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, expectExitCode, expectLog, type Ran, scenario } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-probe-${name}-`)))

/** A worker its environment fails: it ends its turn at once, without claiming or changing anything. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** A worker that asks permission for `rm -rf build` and waits on you for it. */
const asks: SessionScript = turn(
  [canUseTool("Bash", { command: "rm -rf build" })],
  result("Never answered."),
)

/** The probe's session running its command, which writes `.tutti/run/probe` in `repo`. */
const probeRuns = (repo: string): SessionScript =>
  turn(bash("echo ok > .tutti/run/probe", Effect.orDie(writeRunFile(repo, probeFile, "ok\n"))))

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}: ${(yield* texts).join("\n")}`)
  })

/** Moves TestClock on by `minutes`, a minute at a time, letting the run catch up after each. */
const passes = (minutes: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < minutes; i++) {
      yield* advance("1 minute")
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

describe("the stops the probe keeps", () => {
  const environment = stopFor("ENVIRONMENT", "the machine; check the machine, then restart")
  const blocked = blockedStop("t-3" as TicketId, "Bash(rm -rf build)")
  const limit = stopFor("TICKET_LIMIT", "t-3 still working after 6m", { ticket: "t-3" as TicketId })
  const raised = addStop(addStop(addStop(noStops, environment), blocked), limit)

  test("a pass lifts only the probe's stop, the next one first", () => {
    expect(swapStop(raised, environment, null)).toEqual([blocked, limit])
    expect(swapStop(addStop(noStops, environment), environment, null)).toEqual(noStops)
  })

  test("a failure takes the probe's stop's place, the others kept after it", () => {
    const failed = stopFor("ENVIRONMENT", "the probe ran no command")
    expect(swapStop(raised, environment, failed)).toEqual([failed, blocked, limit])
  })

  test("a stop not there changes nothing", () => {
    const other = stopFor("ENVIRONMENT", "another")
    expect(swapStop(raised, other, null)).toEqual(raised)
  })
})

describe("a probe passing while a worker waits on you", () => {
  test("keeps BLOCKED and TICKET_LIMIT raised during its wait, and the run ends on them", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const tickets = ["t-1", "t-2", "t-3"]
    const defaults = appConfig().settings
    const ran: Ran<Outcome> = await scenario(
      {
        config: {
          repo,
          settings: {
            ...defaults,
            concurrent: 3,
            workers: { ...defaults.workers, ticket_limit: Duration.minutes(6) },
          },
        },
        backlog: backlog().ticket("t-1").ticket("t-2").ticket("t-3", { priority: 3 }).seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: {
          // One session each: a ticket started again after the probe would find none to play.
          "t-1": [givesUp],
          "t-2": [givesUp],
          "t-3": [asks],
          [probeWorker]: [probeRuns(repo)],
        },
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        yield* untilLogged(/^PROBE: /)
        // BLOCKED trips at 4m and TICKET_LIMIT at 6m, both before the probe's session at 10m.
        yield* passes(9)
        const before = yield* texts
        expect(before.some((text) => text.includes("BLOCKED >4min: t-3"))).toBe(true)
        expect(before.some((text) => text.includes("TICKET_LIMIT: t-3"))).toBe(true)
        expect(before.some((text) => text.startsWith("PROBE_OK: "))).toBe(false)
        yield* passes(2)
        yield* untilLogged(/^PROBE_OK: /)
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 3)
    expectLog(ran, [
      /^PROBE: the run holds for the environment; in 10m /,
      "PROBE_OK: a session without a ticket ran a command 10m after the hold; taking tickets again",
      /^BLOCKED >4min: t-3 needs you: Bash\(rm -rf build\); also TICKET_LIMIT: t-3 still working after 6m /,
    ])
    // The stops kept the run from taking the tickets the probe put back in the queue.
    expect(ran.log.filter((text) => /t-[12] dispatching/.test(text))).toHaveLength(2)
    expect(ran.events.find((record) => record.kind === "end")).toMatchObject({ code: 3 })
    expect(ran.log.at(-1)).toMatch(/^BLOCKED >4min: t-3 .*; also TICKET_LIMIT: t-3 /)
  }, 30_000)
})
