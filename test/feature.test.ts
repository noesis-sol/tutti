// The run after --feature, or New feature, has filed its epic (§ 4.10, src/run/feature.ts): scoped
// to the epic, as --ticket <epic> scopes one. The interview that files it: interview.test.ts.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { scopedTo } from "../src/run/feature.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { backlog, expectExitCode, expectPhases, scenario } from "./harness.ts"

/** A new folder, its real path. */
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-feature-${name}-`)))

describe("the run after --feature", () => {
  test("runs scoped to the filed epic: its tickets in their order, nothing else", async () => {
    const repo = folder("run-repo")
    const root = folder("run-worktrees")
    // The epic and its tickets as the interview files them, beside a ticket outside it.
    const ids = ["test-2.1" as TicketId, "test-2.2" as TicketId]
    const ran = await scenario(
      {
        config: { repo },
        git: { dir: repo },
        worktrees: { root },
        backlog: backlog()
          .ticket("other")
          .ticket("test-2", { type: "epic" })
          .ticket("test-2.1", { parent: "test-2" })
          .ticket("test-2.2", { parent: "test-2", blockedBy: ["test-2.1"] }).seeds,
        scripts: (world) =>
          Object.fromEntries(
            ids.map((id) => [
              id,
              [
                claimsAndCloses(id, {
                  claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
                  commit: Effect.asVoid(
                    world.repository.commit(join(root, id), `Change (${id})`, {
                      [`${id}.txt`]: "x\n",
                    }),
                  ),
                  close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
                }),
              ],
            ]),
          ),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ids) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          scopedTo("test-2" as TicketId)(
            run({ version: "0.1.0-test", base: "main", start: [line`START`] }),
          ),
        )
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "test-2.1": "Done", "test-2.2": "Done" })
    expect(ran.issues.find((issue) => issue.id === "other")?.status).toBe("open")
    expect(ran.log).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^READY_EMPTY after 2 tickets; SCOPE_DONE: test-2/),
      ]),
    )
    const dispatched = ran.log.filter((text) => text.includes("dispatching"))
    expect(dispatched.map((text) => text.replace(/^\[\d+\] /, "").split(" ")[0])).toEqual(ids)
  })
})
