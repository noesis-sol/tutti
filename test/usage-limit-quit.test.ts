// Quitting during the usage-limit wait (§ 4.12, § 4.8): with the hold on and nothing else running,
// the run waits for the reset, and `q` quits it. The run ends INTERRUPTED, exit 130, not
// USAGE_LIMIT: the worker waiting for the limit is suspended, its session saved for the next run,
// and it is never told to carry on. A whole run with a dashboard under TestClock, the clock never
// moved to the reset.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Queue } from "effect"
import { UiCommand } from "../src/run/commands.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { resetText } from "../src/run/told.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { claimsAndCloses, hitsUsageLimit } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import {
  backlog,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  scenario,
} from "./harness.ts"

// A whole run takes up to a second on an idle machine: bun's 5 s default fails it when other
// checks run beside this one.
setDefaultTimeout(30_000)

// TestClock starts at the epoch: a limit resetting at 3600 (seconds) resets an hour into the run.
const hour = 3600

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-usage-quit-${name}-`)))

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

describe("quitting during the usage-limit wait", () => {
  test("q while the run waits for the reset ends it INTERRUPTED, exit 130, its worker suspended", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const tickets = ["t-1", "t-2"]
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        // t-1 hits the limit, and would finish were it told to carry on; t-2 never starts.
        scripts: {
          "t-1": [[...hitsUsageLimit(hour), ...claimsAndCloses("t-1" as TicketId)]],
          "t-2": [claimsAndCloses("t-2" as TicketId)],
        },
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard,
          }),
        )
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        if (shown === undefined) throw new Error("the run showed no dashboard")
        // The quit box's q: Quit now.
        yield* Queue.offer(shown.commands, UiCommand.Quit({ now: true }))
        const outcome = yield* Fiber.join(fiber)
        return { ...outcome, state: yield* (yield* Store).state }
      }),
    )
    expectExitCode(ran, 130)
    // No new tickets: t-2 never started; t-1 is stopped, not left waiting for the reset.
    expectPhases(ran, { "t-1": "Stopped", "t-2": "Queued" })
    expect(ran.log.some((text) => text.includes("t-2 dispatching"))).toBe(false)
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      /^USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at /,
      "QUIT from the dashboard: no new tickets; interrupting the workers of t-1 and saving their sessions for the next run",
      "INTERRUPTED: quit from the dashboard; t-1's session is saved for the next run",
    ])
    // Neither lifted nor ended by the limit: it ends on the quit, not USAGE_LIMIT (exit 8).
    expect(ran.log).not.toContain("USAGE_LIMIT lifted")
    expect(
      ran.log.some((text) => /^USAGE_LIMIT: .*run tutti again once it resets$/.test(text)),
    ).toBe(false)
    const stop = ran.events.find((record) => record.kind === "stop")
    expect(stop).toMatchObject({ detail: "INTERRUPTED" })
    expect(ran.events.at(-1)).toMatchObject({ kind: "end", code: 130 })
    expectEvents(ran, ["usage_limit", "hold", "warn", "suspended", "stop", "end"])
    // The worker is suspended: its session saved in state.json for the next run, and closed.
    if (Exit.isFailure(ran.exit)) throw new Error(`the run failed: ${ran.exit.cause}`)
    const saved = ran.exit.value.state.tickets["t-1"]
    expect(saved).toMatchObject({ suspended: "quit", phase: "Stopped" })
    expect(saved?.session).toEqual(expect.any(String))
    expect(ran.events.find((record) => record.kind === "suspended")).toMatchObject({
      ticket: "t-1",
      session: saved?.session,
      why: "quit",
    })
    const toT1 = ran.sent.filter((sent) => sent.ticket === "t-1")
    expect(toT1.map((sent) => sent._tag)).toEqual(["Started", "Message", "Interrupted", "Closed"])
    // It was never told the limit had reset.
    const texts1 = toT1.flatMap((sent) =>
      sent._tag === "Message" ? [String(sent.message.message.content)] : [],
    )
    expect(texts1).not.toContain(resetText("t-1" as TicketId))
  })
})
