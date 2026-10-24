// A ticket deferred as its worker stops at the usage limit (§ 4.12), as orchestra 0.8.1 has it: the
// worker's rules tell it to commit and stop at the limit without deferring its ticket, and one that
// defers it all the same has the ticket put back in progress, waiting in the hold, and carries it on
// after the reset rather than its ticket being set aside.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { usageLimitNote } from "../src/project/prompt.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { limitDeferralNote } from "../src/run/settle.ts"
import { resetText } from "../src/run/told.ts"
import { Beads, type Status } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  defers,
  hitsUsageLimit,
  run as runStep,
  type SessionScript,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectPhases,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

// Whole runs waiting out a hold take up to a second on an idle machine.
setDefaultTimeout(30_000)

// TestClock starts at the epoch, so a limit resetting at 3600 (seconds) resets an hour into the run.
const hour = 3600

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-limit-deferral-${name}-`)))

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

/** A whole run of `tickets` on main, one at a time, each ticket's worktree made in git first. */
const runs = (
  tickets: ReadonlyArray<string>,
  scripts: (world: World, root: string) => Scripts,
  during: Effect.Effect<void, unknown, Env> = Effect.void,
) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
      backlog: tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* during
      return yield* Fiber.join(fiber)
    }),
  )
}

/**
 * Claims its ticket, defers it, and ends its turn on the limit resetting at `at` (seconds): a
 * worker that took the limit for a reason it can't finish.
 */
const defersAtLimit = (world: World, id: string, at: number): SessionScript => {
  // Its wait, system/init and running, then its turn's end on the limit.
  const limited = hitsUsageLimit(at)
  return [
    ...limited.slice(0, 3),
    ...bash(
      `bd update ${id} --claim`,
      Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    ),
    ...bash(`bd defer ${id}`, Effect.asVoid(Effect.orDie(world.beads.defer(id)))),
    ...limited.slice(3),
  ]
}

/** Told to carry on, it notes the ticket's status in `seen`, commits and closes it, not claiming. */
const carriesOn = (world: World, root: string, id: string, seen: Array<Status>): SessionScript =>
  turn([
    runStep(
      Effect.orDie(world.beads.show(id)).pipe(
        Effect.flatMap((issue) => Effect.sync(() => seen.push(issue.status))),
        Effect.asVoid,
      ),
    ),
    ...bash(
      `git commit -am "Change (${id})"`,
      Effect.asVoid(
        Effect.orDie(
          world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
        ),
      ),
    ),
    ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
  ])

describe("a ticket deferred as its worker stops at the usage limit", () => {
  test("the worker's rules tell it to stop at the limit without deferring", () => {
    expect(usageLimitNote).toContain(
      "At the account's usage limit, commit what you have and stop, without deferring or closing the ticket for it",
    )
  })

  test("is put back in progress, waits in the hold and carries on after the reset", async () => {
    const seen: Array<Status> = []
    let held: { readonly status: Status; readonly notes: string } | undefined
    const ran = await runs(
      ["t-1"],
      (world, root) => ({
        "t-1": [[...defersAtLimit(world, "t-1", hour), ...carriesOn(world, root, "t-1", seen)]],
      }),
      Effect.gen(function* () {
        yield* untilLogged(/^USAGE_LIMIT: nothing else runs/)
        yield* untilLogged(/t-1: its worker deferred it as it stopped at the usage limit/)
        const beads = yield* Beads
        held = yield* beads.show("t-1")
        yield* advance("2 hours")
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(held?.status).toBe("in_progress")
    expect(held?.notes).toContain(limitDeferralNote)
    expect(seen).toEqual(["in_progress"])
    expect(ran.log).toContain(
      "  t-1: its worker deferred it as it stopped at the usage limit; back in progress, it waits for the reset",
    )
    expect(ran.log).toContain("USAGE_LIMIT lifted")
    expect(ran.log).toContain("  t-1: the usage limit has reset; its worker carries on")
    expect(
      ran.sent.filter(
        (each) =>
          each._tag === "Message" &&
          each.ticket === "t-1" &&
          String(each.message.message.content) === resetText("t-1"),
      ),
    ).toHaveLength(1)
  })

  test("a deferral its worker makes in a turn that ends cleanly still sets the ticket aside", async () => {
    const ran = await runs(["t-1"], (world) => ({
      "t-1": [defers("t-1", { defer: Effect.asVoid(Effect.orDie(world.beads.defer("t-1"))) })],
    }))
    expectPhases(ran, { "t-1": "Deferred" })
    expect(ran.log.some((text) => text.includes("back in progress"))).toBe(false)
  })
})
