// bd failing part-way through a run: the test Beads layer's fail makes the next call of a bd
// command fail or time out, as the test Git layer's does for git. A failure the run can do without
// costs it only the part bd couldn't give: the START block's DEFERRED_FREE list, the closing line's
// scope, the reopening of a ticket the environment hold put back.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Beads, BeadsFailed, BeadsTimedOut, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  claimsAndCloses,
  result,
  type SessionScript,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import {
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-bdf-${name}-`)))

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

interface Plan {
  readonly seeds: ReadonlyArray<Seed>
  /** The tickets workers run, each given a worktree in git first. */
  readonly tickets?: ReadonlyArray<string>
  readonly ticket?: TicketId
  readonly settings?: Partial<ReturnType<typeof appConfig>["settings"]>
  readonly scripts?: (world: World, root: string, repo: string) => Scripts
  /** Runs before the run starts: the faults it makes bd give. */
  readonly before?: Effect.Effect<void, never, Backlog>
  /** Runs beside the run, before it is joined. */
  readonly during?: Effect.Effect<void>
}

/** A whole run on main, one ticket at a time. */
const runs = (plan: Plan): Promise<Ran<Outcome> & { readonly repo: string }> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: {
        repo,
        ticket: plan.ticket ?? null,
        settings: { ...appConfig().settings, concurrent: 1, ...plan.settings },
      },
      backlog: plan.seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts?.(world, root, repo) ?? {},
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets ?? []) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      if (plan.before !== undefined) yield* plan.before
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      if (plan.during !== undefined) yield* plan.during
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, repo }))
}

/** Makes the next call of the bd command `op` fail as `fault` says. */
const failing = (op: string, fault: Parameters<Backlog["Service"]["fail"]>[1] = {}) =>
  Effect.flatMap(Backlog, (backlog) => backlog.fail(op, fault))

describe("the test Beads layer's fail", () => {
  const seeds: ReadonlyArray<Seed> = [{ id: "t-1" }, { id: "t-2" }]
  const provided = <A, E>(effect: Effect.Effect<A, E, Backlog | Beads>) =>
    Effect.runPromise(Effect.provide(effect, beadsLayer(seeds)))

  test("fails the next call of the command, once, as bd would", async () => {
    const [first, second] = await provided(
      Effect.gen(function* () {
        const beads = yield* Beads
        yield* failing("show", { stderr: "Error: database is locked\n" })
        const first = yield* Effect.flip(beads.show("t-1" as TicketId))
        const second = yield* beads.show("t-1" as TicketId)
        return [first, second] as const
      }),
    )
    expect(first).toBeInstanceOf(BeadsFailed)
    expect(first).toMatchObject({
      command: "bd show t-1 --json",
      exitCode: 1,
      stderr: "Error: database is locked\n",
      noSuchIssue: false,
    })
    expect(second.id).toBe("t-1" as TicketId)
  })

  test("only for the issue it names, as many times as it says, and times out when asked", async () => {
    const outcomes = await provided(
      Effect.gen(function* () {
        const beads = yield* Beads
        yield* failing("update", { id: "t-2", timedOut: true, times: 2 })
        const other = yield* beads.update("t-1" as TicketId, { status: "deferred" })
        const first = yield* Effect.flip(beads.update("t-2" as TicketId, { status: "deferred" }))
        const second = yield* Effect.flip(beads.setMetadata("t-2" as TicketId, "k", "v"))
        const third = yield* beads.update("t-2" as TicketId, { status: "deferred" })
        return { other, first, second, third }
      }),
    )
    expect(outcomes.other.status).toBe("deferred")
    expect(outcomes.first).toBeInstanceOf(BeadsTimedOut)
    expect(outcomes.first).toMatchObject({ command: "bd update t-2 --json" })
    expect(outcomes.second).toBeInstanceOf(BeadsTimedOut)
    expect(outcomes.third.status).toBe("deferred")
  })
})

const unlisted = (reason: string) =>
  `cannot list the deferred tickets whose blockers have merged: ${reason}`

describe("bd failing to list the deferred tickets whose blockers have merged", () => {
  test("drops the DEFERRED_FREE list with a line in the log, and the run goes on", async () => {
    const ran = await runs({
      seeds: [
        { id: "b-1", status: "closed" },
        { id: "k-1", status: "deferred", blockedBy: ["b-1"] },
        { id: "t-1" },
      ],
      tickets: ["t-1"],
      scripts: (world, root) => ({ "t-1": [finishes(world, root, "t-1" as TicketId)] }),
      before: failing("show", { id: "k-1", stderr: "Error: database is locked\n" }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      "START tutti 0.1.0-test",
      unlisted("bd show k-1 --json: Error: database is locked"),
      "[1] t-1 dispatching: t-1",
      /^READY_EMPTY after 1 tickets$/,
    ])
    expect(ran.log.some((text) => text.includes("DEFERRED_FREE"))).toBe(false)
  })

  test("a scoped run whose subtickets bd can't list says so too", async () => {
    const ran = await runs({
      seeds: [
        { id: "b-1", status: "closed" },
        { id: "e-1", type: "epic" },
        { id: "e-1.1", parent: "e-1", status: "deferred", blockedBy: ["b-1"] },
      ],
      ticket: "e-1" as TicketId,
      before: failing("list", { id: "e-1", timedOut: true }),
    })
    expectExitCode(ran, 0)
    expectLog(ran, [
      "START tutti 0.1.0-test",
      unlisted("bd list --parent=e-1 --json: bd timed out"),
    ])
    expect(ran.log.some((text) => text.includes("DEFERRED_FREE"))).toBe(false)
  })
})

describe("bd failing to read a scope as its run ends", () => {
  const seeds: ReadonlyArray<Seed> = [
    { id: "e-1", type: "epic" },
    { id: "e-1.1", parent: "e-1", status: "deferred" },
  ]

  test("its subtickets unlisted: SCOPE_UNREADABLE, with bd's error", async () => {
    const ran = await runs({
      seeds,
      ticket: "e-1" as TicketId,
      before: failing("list", {
        id: "e-1",
        stderr: "Error: database is locked\n",
        times: Number.POSITIVE_INFINITY,
      }),
    })
    expectExitCode(ran, 0)
    expect(ran.log.at(-1)).toBe(
      "READY_EMPTY after 0 tickets; SCOPE_UNREADABLE: could not list e-1's subtickets: Error: database is locked",
    )
  })

  test("the ticket itself unread: SCOPE_UNREADABLE, with bd's error", async () => {
    const ran = await runs({
      seeds,
      ticket: "e-1" as TicketId,
      before: failing("show", { id: "e-1", timedOut: true, times: Number.POSITIVE_INFINITY }),
    })
    expectExitCode(ran, 0)
    expect(ran.log.at(-1)).toBe(
      "READY_EMPTY after 0 tickets; SCOPE_UNREADABLE: could not read e-1: bd timed out",
    )
  })
})

describe("bd refusing to reopen a ticket the environment hold puts back", () => {
  /** A worker its environment fails: it ends its turn at once, claiming and changing nothing. */
  const givesUp: SessionScript = turn([], result("Every command was refused."))

  test("logs REOPEN_FAILED with the command that reopens it, and the hold goes on", async () => {
    const ran = await runs({
      seeds: [{ id: "t-1" }, { id: "t-2" }],
      tickets: ["t-1", "t-2"],
      settings: {
        environment_hold: { ...appConfig().settings.environment_hold, probe: Duration.zero },
      },
      // t-2's worker, the second to fail at once, makes bd refuse the next write to t-1: the hold's
      // reopening, after t-1 was set aside.
      scripts: (world) => ({
        "t-1": [givesUp],
        "t-2": [
          turn(
            [
              step(
                world.backlog.fail("update", { id: "t-1", stderr: "Error: database is locked\n" }),
              ),
            ],
            result("Every command was refused."),
          ),
        ],
      }),
    })
    expectExitCode(ran, 7)
    const refused =
      "  REOPEN_FAILED: t-1 failed at once like the tickets before it, and bd could not reopen it: Error: database is locked; reopen it with: bd update t-1 --status open"
    expectLog(ran, [
      "  t-1 still open -> noted and deferred; nothing done, so its worktree and branch are removed",
      "  t-2 still open -> noted and deferred; nothing done, so its worktree and branch are removed",
      refused,
      "  t-2 reopened: its worker failed at once, like the tickets before it",
      /^ENVIRONMENT: the last 2 tickets \(t-1, t-2\)/,
    ])
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "warn", ticket: "t-1", text: refused }),
    )
    // t-1 stays deferred, as the hold found it; t-2 is open again, for the next run.
    const t1 = ran.issues.find((issue) => issue.id === "t-1")
    expect(t1?.status).toBe("deferred")
    expect(t1?.notes).not.toContain("tutti: reopened")
    expect(ran.issues.find((issue) => issue.id === "t-2")?.status).toBe("open")
  })
})
