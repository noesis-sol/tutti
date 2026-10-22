// The environment probe's session ending without running its command (§ 4.9): stopped (Idle, or
// Closed under it), its turn failed, or gone. Each fails the probe, and the run ends
// ENVIRONMENT, exit 7, saying how.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { probeWorker } from "../src/run/environment.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import {
  apiErrorResult,
  awaitInterrupt,
  gone,
  init,
  result,
  type SessionScript,
  sessionState,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  type Ran,
  scenario,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-pe-${name}-`)))

/** A worker its environment fails: it ends its turn at once, without claiming or changing anything. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** A probe session that starts its turn and runs nothing, until tutti interrupts or closes it. */
const hangs: SessionScript = [wait, init(), sessionState("running"), awaitInterrupt]

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}: ${(yield* texts).join("\n")}`)
  })

/**
 * A whole run on main whose two tickets fail at once, holding it, and whose probe's session plays
 * `probe`; `then` runs once that session has started.
 */
const probes = (
  probe: SessionScript,
  then: Effect.Effect<void, unknown, Env> = Effect.void,
): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const tickets = ["t-1", "t-2"]
  return scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
      backlog: backlog().ticket("t-1").ticket("t-2").seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: { "t-1": [givesUp], "t-2": [givesUp], [probeWorker]: [probe] },
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
      yield* advance("10 minutes")
      yield* untilLogged(/probe session started/)
      yield* then
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The closing line of a run whose probe failed `why`. */
const failed = (why: string) =>
  `ENVIRONMENT: the last 2 tickets (t-1, t-2) each settled within 2m of starting without being claimed or changed; a session probing the machine 10m later failed too: ${why}; check the machine, then restart`

const expectProbeFailed = (ran: Ran<Outcome>, why: string) => {
  expectExitCode(ran, 7)
  expectLog(ran, [/^PROBE: /, /probe session started/, failed(why)])
  expect(ran.log.some((text) => text.startsWith("PROBE_OK"))).toBe(false)
  expect(ran.events.find((record) => record.kind === "end")).toMatchObject({ code: 7 })
}

describe("the probe's session ending without running its command", () => {
  test("Idle: its turn ends having run nothing", async () => {
    const ran = await probes(turn([], result("Nothing to do.")))
    expectProbeFailed(ran, "it stopped without running its command")
  })

  test("Closed: its session is closed under it", async () => {
    const ran = await probes(
      hangs,
      Effect.flatMap(AgentHost, (host) => host.close(probeWorker)),
    )
    expectProbeFailed(ran, "it stopped without running its command")
  })

  test("Failed: its turn fails, with the turn's error", async () => {
    const ran = await probes(turn([], apiErrorResult("API Error: 500 Internal server error", 500)))
    expectProbeFailed(
      ran,
      "its turn failed without running its command: API Error: 500 Internal server error",
    )
  })

  test("Gone: its session ends by itself, with why", async () => {
    const ran = await probes([
      wait,
      init(),
      sessionState("running"),
      gone("Claude Code exited with code 1"),
    ])
    expectProbeFailed(
      ran,
      "it went away without running its command: Claude Code exited with code 1",
    )
  })
})
