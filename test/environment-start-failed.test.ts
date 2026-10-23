// Sessions that don't start count toward the environment hold (§ 4.9, § 5 item 11): a worker whose
// session fails to start (START_FAILED) is set aside as it starts, and a row of them holds the run
// as workers failing at once do, its tickets reopened, rather than defer the queue a ticket at a
// time on a machine where Claude Code can't start sessions. A ticket set aside for another reason
// as it starts counts for nothing.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { type FastFail, fastFailsWhy } from "../src/run/environment.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { failStart, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { backlog, expectExitCode, expectLog, expectPhases, type Ran, scenario } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-esf-${name}-`)))

const launchFailed = "Claude Code couldn't be launched"

/** A session that can't start. */
const cantStart: SessionScript = [failStart(launchFailed)]

/** A worker its environment fails: it ends its turn at once, without claiming or changing anything. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** A whole run on main, one ticket at a time, with no probe, each ticket's worktree made first. */
const runs = (
  tickets: ReadonlyArray<string>,
  scripts: Readonly<Record<string, ReadonlyArray<SessionScript>>>,
): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: 1,
    environment_hold: { ...defaults.environment_hold, probe: Duration.zero },
  }
  return scenario(
    {
      config: { repo, settings },
      backlog: tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: () => scripts,
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        if (id.includes("/")) continue
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      return yield* Fiber.join(fiber)
    }),
  )
}

describe("the environment hold and sessions that don't start", () => {
  test("every start failing holds the run after a row, its tickets reopened, the rest left queued", async () => {
    const ran = await runs(["t-1", "t-2", "t-3", "t-4"], {
      "t-1": [cantStart],
      "t-2": [cantStart],
      "t-3": [cantStart],
      "t-4": [cantStart],
    })
    expectExitCode(ran, 7)
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Waiting", "t-3": "Queued", "t-4": "Queued" })
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      /t-1's worker didn't start: Claude Code couldn't be launched -> deferred/,
      "[2] t-2 dispatching: t-2",
      /t-2's worker didn't start: Claude Code couldn't be launched -> deferred/,
      "  t-1 reopened: its worker failed at once, like the tickets before it",
      "  t-2 reopened: its worker failed at once, like the tickets before it",
      "ENVIRONMENT: the sessions of the last 2 tickets (t-1, t-2) didn't start; check the machine, then restart",
    ])
    expect(ran.log.some((text) => text.includes("t-3 dispatching"))).toBe(false)
    expect(ran.events.filter((record) => record.kind === "reopened")).toEqual([
      expect.objectContaining({ ticket: "t-1" }),
      expect.objectContaining({ ticket: "t-2" }),
    ])
  })

  test("a session that didn't start and a worker failing at once make a row", async () => {
    const ran = await runs(["t-1", "t-2", "t-3"], {
      "t-1": [givesUp],
      "t-2": [cantStart],
      "t-3": [givesUp],
    })
    expectExitCode(ran, 7)
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Waiting", "t-3": "Queued" })
    expectLog(ran, [
      "ENVIRONMENT: the last 2 tickets (t-1, t-2) each failed at once: their session didn't start, or their worker settled within 2m of starting without being claimed or changed; check the machine, then restart",
    ])
  })

  test("a ticket set aside as it starts for another reason counts for nothing", async () => {
    // t/2's ID can't name a worktree: set aside without a session, it neither adds to the row of
    // sessions that didn't start nor ends it.
    const ran = await runs(["t-1", "t/2", "t-3", "t-4"], {
      "t-1": [cantStart],
      "t-3": [cantStart],
      "t-4": [cantStart],
    })
    expectExitCode(ran, 7)
    expectPhases(ran, { "t-1": "Waiting", "t/2": "Deferred", "t-3": "Waiting", "t-4": "Queued" })
    expectLog(ran, [
      "ENVIRONMENT: the sessions of the last 2 tickets (t-1, t-3) didn't start; check the machine, then restart",
    ])
  })
})

describe("fastFailsWhy", () => {
  const window = Duration.minutes(2)
  const row = (...hows: ReadonlyArray<FastFail["how"]>): ReadonlyArray<FastFail> =>
    hows.map((how, i) => ({ ticket: `t-${i + 1}`, how }))

  test("names each way the row failed, setups first", () => {
    expect(fastFailsWhy(row("start", "setup", "atOnce"), window, "bun install")).toBe(
      "the last 3 tickets (t-1, t-2, t-3) each failed at once: the setup 'bun install' failed in their worktree, or their session didn't start, or their worker settled within 2m of starting without being claimed or changed",
    )
    expect(fastFailsWhy(row("start", "setup"), window, null)).toBe(
      "the last 2 tickets (t-1, t-2) each failed at once: the setup failed in their worktree, or their session didn't start",
    )
  })

  test("a row of one way says it alone", () => {
    expect(fastFailsWhy(row("start", "start"), window, "bun install")).toBe(
      "the sessions of the last 2 tickets (t-1, t-2) didn't start",
    )
    expect(fastFailsWhy(row("setup", "setup"), window, null)).toBe(
      "the setup failed in the worktrees of the last 2 tickets (t-1, t-2)",
    )
    expect(fastFailsWhy(row("atOnce", "atOnce"), window, null)).toBe(
      "the last 2 tickets (t-1, t-2) each settled within 2m of starting without being claimed or changed",
    )
  })
})
