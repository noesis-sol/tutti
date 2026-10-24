// A setup problem a worker's first system/init shows (§ 4.1: MCP servers it wasn't given, an API key
// billed beside the subscription) stops the run as a setup problem found at startup does: the host
// ends the worker Gone with `setup`, and its ticket, neither resumed nor deferred, is reopened and
// waits for the next run; the run holds with SETUP_PROBLEM and ends with exit 2, not ENVIRONMENT.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { notGivenProblem } from "../src/agent/mcp.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store } from "../src/services/Store.ts"
import { init, type SessionScript, wait } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import {
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-setup-problem-${name}-`)))

const problem = notGivenProblem(["claude.ai Gmail"])

/**
 * A session whose first system/init shows the setup problem, a server the worker wasn't given: the
 * host ends it before it does anything.
 */
const meetsProblem: SessionScript = [
  wait,
  init({ mcp_servers: [{ name: "claude.ai Gmail", status: "connected", source: "claudeai" }] }),
]

interface Plan {
  readonly tickets: ReadonlyArray<readonly [string, "open" | "in_progress"]>
  readonly scripts: Scripts
  readonly concurrent?: number
  /** state.json as the last run left it, for the tickets it carries over. */
  readonly state?: (root: string) => State
}

/** A whole run on main, each ticket's worktree made in git first; its state.json at the end. */
const runs = async (
  plan: Plan,
): Promise<Ran<Outcome> & { readonly root: string; readonly after: State | undefined }> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let after: State | undefined
  const ran = await scenario(
    {
      config: {
        repo,
        settings: { ...appConfig().settings, concurrent: plan.concurrent ?? 1 },
      },
      backlog: plan.tickets.reduce((b, [id, status]) => b.ticket(id, { status }), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: plan.scripts,
      ...(plan.state === undefined ? {} : { state: plan.state(root) }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const [id] of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      const outcome = yield* Fiber.join(fiber)
      after = yield* (yield* Store).state
      return outcome
    }),
  )
  return { ...ran, root, after }
}

const stopLine = (id: string, root: string) =>
  `SETUP_PROBLEM: ${id}'s worker was stopped before it did anything: ${problem}; ${id} is reopened (worktree ${join(root, id)}); fix the setup, then run again`

describe("a setup problem in a worker's first system/init", () => {
  test("stops the run with SETUP_PROBLEM, exit 2, its ticket reopened and nothing else started", async () => {
    const ran = await runs({
      tickets: [
        ["t-1", "open"],
        ["t-2", "open"],
      ],
      scripts: { "t-1": [meetsProblem] },
    })
    expectExitCode(ran, 2)
    // t-2 never started: the stop holds the run.
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Queued" })
    expectLog(ran, ["[1] t-1 dispatching: t-1", stopLine("t-1", ran.root)])
    expect(ran.log.some((l) => l.includes("t-2 dispatching"))).toBe(false)
    expect(ran.log.some((l) => l.startsWith("ENVIRONMENT"))).toBe(false)
    expect(ran.log.some((l) => l.includes("deferred"))).toBe(false)
    const issue = ran.issues.find((each) => each.id === "t-1")
    expect(issue?.status).toBe("open")
    expect(issue?.notes).toContain(
      `tutti: reopened; its worker was stopped before it did anything, over a setup problem: ${problem}.`,
    )
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "stop", detail: "SETUP_PROBLEM", ticket: "t-1" }),
    )
    expect(ran.events.find((record) => record.kind === "end")).toMatchObject({ code: 2 })
    // Its worktree is kept, and nothing is left for the next run to resume.
    expect(ran.worktreeCalls.some((call) => call.op === "remove")).toBe(false)
    expect(ran.after?.tickets["t-1"]?.suspended).toBeUndefined()
    expect(ran.after?.tickets["t-1"]?.phase).toBe("Waiting")
  })

  test("the running tickets finish first: HOLD, then the stop", async () => {
    const ran = await runs({
      tickets: [
        ["t-1", "open"],
        ["t-2", "open"],
      ],
      concurrent: 2,
      scripts: { "t-1": [meetsProblem], "t-2": [meetsProblem] },
    })
    expectExitCode(ran, 2)
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Waiting" })
    const stops = ran.log.filter((l) => l.startsWith("SETUP_PROBLEM"))
    expect(stops).toHaveLength(1)
    expect(stops[0]).toContain("; also SETUP_PROBLEM: ")
    expect(ran.log.some((l) => l.startsWith("HOLD: SETUP_PROBLEM: "))).toBe(true)
  })

  test("a worker carried over from the last run is neither resumed again nor paused", async () => {
    const ran = await runs({
      tickets: [["t-1", "in_progress"]],
      scripts: { "t-1": [meetsProblem] },
      state: (root) => {
        // The worktree is on disk, as the last run left it: carry-over drops one that is gone.
        mkdirSync(join(root, "t-1"), { recursive: true })
        return {
          version: 1,
          tickets: {
            "t-1": {
              session: "session-t-1",
              worktree: join(root, "t-1"),
              branch: "tutti/t-1",
              suspended: "quit",
              phase: "Stopped",
              resumes: 0,
              metadata: {},
            },
          },
        }
      },
    })
    expectExitCode(ran, 2)
    expectPhases(ran, { "t-1": "Waiting" })
    // Resumed once, as the last run left it, and not again once its setup problem ended it.
    expect(ran.sent.filter((sent) => sent._tag === "Resumed")).toHaveLength(1)
    expect(ran.log.some((l) => l.startsWith("PAUSED"))).toBe(false)
    expect(ran.log).toContain(stopLine("t-1", ran.root))
    expect(ran.issues.find((each) => each.id === "t-1")?.status).toBe("open")
    expect(ran.after?.tickets["t-1"]?.suspended).toBeUndefined()
  })
})
