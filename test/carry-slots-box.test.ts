// A carried-over worker waiting for a slot beside one waiting on you (§ 5's Scheduling, D19): the
// run takes it up once the slot frees, so the end-of-run box isn't shown meanwhile, though the
// worker in the slot is all that runs and it waits on you.

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, SubscriptionRef } from "effect"
import { Attention } from "../src/agent/Attention.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { RunView } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import type { TicketRecord } from "../src/services/Store.ts"
import { bash, canUseTool, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, expectLog, expectPhases, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-slots-box-${name}-`)))

/** What the last run saved of a ticket, its worktree under `root`: suspended by a quit. */
const saved = (root: string, id: string): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  suspended: "quit",
  phase: "Stopped",
  resumes: 0,
  metadata: {},
})

/** Claims its ticket, does `first`, then commits a change naming it and closes it. */
const finishes = (
  world: World,
  root: string,
  id: TicketId,
  first: ReadonlyArray<SessionScript[number]>,
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...first,
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

test("no end-of-run box while a carried-over worker waits for the slot of one waiting on you", async () => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let boxed: RunView | undefined
  let endedEarly = false
  const ran = await scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
      backlog: backlog()
        .ticket("t-1", { status: "in_progress" })
        .ticket("t-2", { status: "in_progress" }).seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      state: { version: 1, tickets: { "t-1": saved(root, "t-1"), "t-2": saved(root, "t-2") } },
      scripts: (world: World) => ({
        "t-1": [
          finishes(world, root, "t-1" as TicketId, [
            canUseTool("Bash", { command: "rm -rf build" }),
          ]),
        ],
        "t-2": [finishes(world, root, "t-2" as TicketId, [])],
      }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["t-1", "t-2"]) {
        mkdirSync(join(root, id), { recursive: true })
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
      for (let i = 0; i < 2000; i++) {
        if ((yield* texts).some((each) => each.includes("waits for a free slot"))) break
        yield* Effect.promise(() => Bun.sleep(5))
      }
      // Two minutes on, t-1's request is open, short of BLOCKED's four.
      for (let i = 0; i < 2; i++) {
        yield* advance("1 minute")
        yield* Effect.promise(() => Bun.sleep(5))
      }
      for (let i = 0; i < 3; i++) {
        yield* advance("100 millis")
        yield* Effect.promise(() => Bun.sleep(10))
      }
      boxed = shown === undefined ? undefined : yield* SubscriptionRef.get(shown.view)
      endedEarly = fiber.pollUnsafe() !== undefined
      const attention = yield* Attention
      const open = (yield* attention.current).find((request) => request.ticket === "t-1")
      if (open !== undefined) yield* attention.answer(open.id, { _tag: "Allow" }, "screen")
      for (let i = 0; i < 30 && fiber.pollUnsafe() === undefined; i++) {
        yield* advance("1 minute")
        yield* Effect.promise(() => Bun.sleep(5))
      }
      return yield* Fiber.join(fiber)
    }),
  )
  expect(endedEarly).toBe(false)
  expect(boxed).toBeDefined()
  expect(boxed?.endOfRun ?? null).toBeNull()
  expectLog(ran, [
    "  t-2, carried over from the last run, waits for a free slot to be resumed",
    /RESUMED: t-2 /,
  ])
  expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
}, 60_000)
