// A ticket back in the queue to wait for a merge (WAITS_FOR_MERGE) counts for nothing toward the
// environment hold (§ 4.9, § 5 item 11): its worker stopped with nothing done, but because it
// started too early, not because the machine fails. It neither adds to the row of tickets failing
// at once nor ends it.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import {
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-wfm-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A worker its environment fails: it ends its turn at once, without claiming or changing anything. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** Claims its ticket, links `blocker` as blocking it and stops with it open and nothing done. */
const needs = (world: World, id: TicketId, blocker: TicketId): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      ...bash(`bd dep add ${id} ${blocker}`, orDie(world.beads.addDependency(id, blocker))),
      ...bash(`bd update ${id} --status open`, orDie(world.beads.update(id, { status: "open" }))),
    ],
    result(`${id} needs ${blocker}'s work first.`),
  )

/** A whole run on main, one ticket at a time, with no probe, each ticket's worktree made first. */
const runs = (
  tickets: ReadonlyArray<string>,
  scripts: (world: World) => Readonly<Record<string, ReadonlyArray<SessionScript>>>,
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
      scripts,
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      return yield* Fiber.join(fiber)
    }),
  )
}

describe("the environment hold and WAITS_FOR_MERGE", () => {
  test("a ticket waiting for a merge between two quick failures neither counts nor ends the row", async () => {
    // t-2's worker finds it needs t-1, which t-1's failing worker left unfinished, and stops with
    // nothing done. Counted as failing at once, it would hold the run with t-1 and t-2; counted as
    // any other settling, it would end the row and t-3 would hold nothing.
    const ran = await runs(["t-1", "t-2", "t-3"], (world) => ({
      "t-1": [givesUp],
      "t-2": [needs(world, "t-2" as TicketId, "t-1" as TicketId)],
      "t-3": [givesUp],
    }))
    expectExitCode(ran, 7)
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Waiting", "t-3": "Waiting" })
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      "[2] t-2 dispatching: t-2",
      /^ {2}WAITS_FOR_MERGE: t-2 waits for t-1 to merge; /,
      // A ticket waiting for a merge counts toward --limit once, as it starts again.
      "[2] t-3 dispatching: t-3",
      "  t-1 reopened: its worker failed at once, like the tickets before it",
      "  t-3 reopened: its worker failed at once, like the tickets before it",
      "ENVIRONMENT: the last 2 tickets (t-1, t-3) each settled within 2m of starting without being claimed or changed; check the machine, then restart",
    ])
    expect(ran.log.some((text) => text.includes("t-2 reopened"))).toBe(false)
    expect(ran.events.filter((record) => record.kind === "reopened")).toEqual([
      expect.objectContaining({ ticket: "t-1" }),
      expect.objectContaining({ ticket: "t-3" }),
    ])
  })
})
