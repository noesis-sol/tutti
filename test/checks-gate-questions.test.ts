// The checks gate's open questions once it passes (§ 4.14, src/run/checksGate.ts): every gate
// question still open for the spec is closed, as the tree's tickets wait on each of them, not only
// the first the gate found (tutti-fnvd.14).
import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { line } from "../src/core/log.ts"
import { fastScript, fullScript } from "../src/project/runners.ts"
import { gateKey, gateQuestionTitle, gateSpecKey } from "../src/run/checksGate.ts"
import { run } from "../src/run/run.ts"
import { HumanLabel, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { backlog, expectExitCode, expectLog, scenario, type World } from "./harness.ts"

const fast = "scripts/check-fast.sh"
const full = "scripts/check-full.sh"
const spec = "shop.md"
const defaults = appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-checks-gate-questions-${name}-`)))

/** Runners with a suite each. */
const realRunners = {
  [fast]: fastScript([{ name: "unit", command: "bun test", foundIn: "", serial: false }]),
  [full]: fullScript([{ name: "e2e", command: "bun run e2e", foundIn: "", serial: false }], false),
}

/** A gate question for the spec, open, asked about runners as they no longer are. */
const question = (id: string): Seed => ({
  id,
  title: gateQuestionTitle,
  labels: [HumanLabel],
  metadata: { [gateSpecKey]: spec, [gateKey]: "runners as they were" },
})

/** Claims, commits `files` and closes its ticket, as a worker does. */
const commits = (world: World, root: string, id: string, files: Record<string, string>) =>
  claimsAndCloses(id as TicketId, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id as TicketId, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id as TicketId, "done"))),
  })

test("a pass closes every gate question still open, the tree's tickets waiting on each", async () => {
  const repo = folder("repo")
  const root = folder("worktrees")
  // Two questions open, as when bd couldn't list the first as a hold filed the second.
  const seeds = [
    ...backlog()
      .ticket("s-1", { type: "epic", metadata: { spec } })
      .ticket("s-1.1", { parent: "s-1", priority: 0, labels: ["solo"], metadata: { spec } })
      .ticket("s-1.2", { parent: "s-1", blockedBy: ["s-1.1", "s-8", "s-9"], metadata: { spec } })
      .seeds,
    question("s-8"),
    question("s-9"),
  ]
  const ran = await scenario(
    {
      config: {
        repo,
        ticket: "s-1" as TicketId,
        specPath: spec,
        settings: {
          ...defaults,
          concurrent: 1,
          checks: {
            ...defaults.checks,
            setup: { ...defaults.checks.setup, command: null },
            fast: { command: fast, timeout: Duration.minutes(10) },
            full: { command: full, timeout: Duration.minutes(60) },
          },
        },
      },
      git: { dir: repo },
      worktrees: { root },
      backlog: seeds,
      scripts: (world) => ({
        "s-1.1": [commits(world, root, "s-1.1", realRunners)],
        "s-1.2": [commits(world, root, "s-1.2", { "shop.ts": "export {}\n" })],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["s-1.1", "s-1.2"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const running = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      return yield* Fiber.join(running)
    }),
  )
  expectExitCode(ran, 0)
  for (const id of ["s-8", "s-9"]) {
    expect(ran.issues.find((each) => each.id === id)?.status).toBe("closed")
  }
  // Each before the pass, in whatever order bd lists them.
  for (const id of ["s-8", "s-9"]) {
    expectLog(ran, [
      new RegExp(`^CHECKS_GATE: closed ${id}: the checks gate passed on main at \\w+$`),
      /^CHECKS_GATE: passed on main at \w+ in \w+: /,
      /s-1\.2 dispatching/,
    ])
  }
})
