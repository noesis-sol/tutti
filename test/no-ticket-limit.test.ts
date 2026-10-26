// A run has no ticket limit unless --limit (or TUTTI_LIMIT) gives one (§ 8.2), as orchestra 0.8.5's:
// with none it starts every ticket it can and ends READY_EMPTY or DRAINED, never LIMIT_REACHED; its
// dispatch lines say `[n]` and its dispatch records leave `limit` out. A limit given still stops it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { defaultSettings, defaultUserConfig, resolve } from "../src/cli/AppConfig.ts"
import { noFlags } from "../src/cli/flags.ts"
import { decided } from "../src/run/choose.ts"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { dispatchLine, make, progress } from "../src/run/schedule.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { filling } from "./filling.ts"
import {
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-no-ticket-limit-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

const issue = (id: TicketId, labels: ReadonlyArray<string> = []): Issue =>
  ({ id, title: id, labels }) as unknown as Issue

describe("the dispatch line", () => {
  test("says n/limit with a limit, and n alone with none", () => {
    expect(progress(3, 40)).toBe("3/40")
    expect(progress(3, null)).toBe("3")
    expect(String(dispatchLine(41, null, issue("t-41" as TicketId)))).toBe(
      "[41] t-41 dispatching: t-41",
    )
    expect(String(dispatchLine(2, 5, issue("t-2" as TicketId)))).toBe("[2/5] t-2 dispatching: t-2")
    expect(String(dispatchLine(1, null, issue("s" as TicketId, ["solo"])))).toBe(
      "[1] s dispatching solo: s",
    )
  })
})

describe("the run's configuration", () => {
  const configOf = (env: Readonly<Record<string, string>>) => {
    const resolved = resolve({
      repo: "/work/project",
      flags: noFlags,
      env: (name) => env[name],
      user: defaultUserConfig,
      settings: defaultSettings,
    })
    if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
    return resolved.success
  }

  test("has no limit unless --limit or TUTTI_LIMIT gives one", () => {
    expect(appConfig().limit).toBeNull()
    expect(configOf({}).limit).toBeNull()
    expect(configOf({ TUTTI_LIMIT: "7" }).limit).toBe(7)
  })

  test("no limit decides nothing for the start question; a limit of 0 does", () => {
    const flags = { tickets: false, ticket: null, feature: null, spec: null, plain: false } as const
    expect(decided({ ...flags, limit: null })).toBe(false)
    expect(decided({ ...flags, limit: 0 })).toBe(true)
  })
})

describe("the scheduler with no limit", () => {
  test("starts more tickets than the old default of 40, and never reaches a limit", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `t-${i + 1}`)
    const [count, reached, records] = await Effect.runPromise(
      Effect.gen(function* () {
        const schedule = yield* make({
          concurrent: ids.length,
          limit: null,
          scope: null,
          excludeTypes: ["epic"],
          start: { start: () => Effect.never },
        })
        const fiber = yield* Effect.forkChild(filling(schedule))
        for (let i = 0; i < 200; i++) yield* Effect.yieldNow
        const count = yield* schedule.started
        const reached = yield* schedule.limitReached
        const records = yield* Effect.flatMap(Captured, (captured) => captured.records)
        yield* Fiber.interrupt(fiber)
        yield* schedule.interrupt
        return [count, reached, records] as const
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(beadsLayer(ids.map((id) => ({ id }))), ledgerLayer(), runFibersLayer).pipe(
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )
    expect(count).toBe(45)
    expect(reached).toBe(false)
    const dispatches = records.filter((record) => record.kind === "dispatch")
    expect(dispatches).toHaveLength(45)
    for (const record of dispatches) expect(record).not.toHaveProperty("limit")
    expect(dispatches.map((record) => record.text)).toContain("[41] t-41 dispatching: t-41")
  })
})

/** Claims its ticket, commits a file and closes it. */
const works = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** A whole run on main, one ticket at a time, with `limit` if given, each worktree made first. */
const runs = (tickets: ReadonlyArray<TicketId>, limit?: number): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: 1,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: "scripts/check.sh" } },
  }
  return scenario(
    {
      config: { repo, worktrees: root, settings, ...(limit === undefined ? {} : { limit }) },
      backlog: tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo, files: { "README.md": "tutti\n" } },
      worktrees: { root },
      scripts: (world: World) =>
        Object.fromEntries(tickets.map((id) => [id, [works(world, root, id)]])),
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

describe("a whole run", () => {
  test("with no limit given starts every ticket and ends READY_EMPTY, never LIMIT_REACHED", async () => {
    const ran = await runs(["a" as TicketId, "b" as TicketId, "c" as TicketId])
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expectLog(ran, [
      "[1] a dispatching: a",
      "[2] b dispatching: b",
      "[3] c dispatching: c",
      "READY_EMPTY after 3 tickets",
    ])
    expect(ran.log.some((text) => text.includes("LIMIT_REACHED"))).toBe(false)
    const dispatches = ran.events.filter((record) => record.kind === "dispatch")
    expect(dispatches).toHaveLength(3)
    for (const record of dispatches) expect(record).not.toHaveProperty("limit")
  })

  test("with a limit given still stops at it, LIMIT_REACHED", async () => {
    const ran = await runs(["a" as TicketId, "b" as TicketId, "c" as TicketId], 2)
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Queued" })
    expectLog(ran, [
      "[1/2] a dispatching: a",
      "[2/2] b dispatching: b",
      "LIMIT_REACHED at 2 tickets",
    ])
    expect(ran.events.filter((record) => record.kind === "dispatch")).toEqual([
      expect.objectContaining({ ticket: "a", n: 1, limit: 2 }),
      expect.objectContaining({ ticket: "b", n: 2, limit: 2 }),
    ])
  })
})
