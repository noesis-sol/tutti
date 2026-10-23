// A setup problem the live host finds as a worker's session starts, before its first turn (§ 4.1:
// MCP servers it wasn't given, an API key billed beside the subscription), stops the run as one its
// first system/init shows does: the session is sent nothing, its ticket is reopened, neither
// deferred nor counted toward the environment hold, and the run holds with SETUP_PROBLEM, exit 2.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { apiKeyProblem } from "../src/agent/AgentHostLive.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store } from "../src/services/Store.ts"
import { stopAtStart } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { backlog, expectExitCode, expectPhases, type Ran, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-setup-at-start-${name}-`)))

const problem = apiKeyProblem("ANTHROPIC_API_KEY")

/** A whole run on main of t-1 and t-2, t-1's session stopped as it starts; state.json at the end. */
const runs = async (): Promise<
  Ran<Outcome> & { readonly root: string; readonly after: State | undefined }
> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let after: State | undefined
  const ran = await scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
      backlog: backlog().ticket("t-1").ticket("t-2").seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: { "t-1": [[stopAtStart(problem)]] },
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["t-1", "t-2"]) {
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

describe("a setup problem found as a worker's session starts", () => {
  test("stops the run with SETUP_PROBLEM, exit 2, its ticket reopened and sent nothing", async () => {
    const ran = await runs()
    expectExitCode(ran, 2)
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Queued" })
    expect(ran.log).toContain(
      `SETUP_PROBLEM: t-1's worker was stopped before it did anything: ${problem}; t-1 is reopened (worktree ${join(ran.root, "t-1")}); fix the setup, then run again`,
    )
    expect(ran.log.some((l) => l.includes("t-2 dispatching"))).toBe(false)
    expect(ran.log.some((l) => l.startsWith("ENVIRONMENT"))).toBe(false)
    expect(ran.log.some((l) => l.includes("deferred"))).toBe(false)
    expect(ran.sent.filter((sent) => sent._tag === "Message")).toEqual([])
    expect(ran.issues.find((each) => each.id === "t-1")?.status).toBe("open")
    // The session never began: nothing is saved for the next run to resume.
    expect(ran.after?.tickets["t-1"]?.session).toBeUndefined()
  })
})
