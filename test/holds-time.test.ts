// The holds that come with time (§ 4.3, § 4.5): TICKET_LIMIT, LONG_RUNNING and BLOCKED, as whole
// runs under TestClock, and the pure parts of them.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, SubscriptionRef } from "effect"
import * as fc from "fast-check"
import { Attention, type AttentionRequest, blockedAfter } from "../src/agent/Attention.ts"
import {
  addStop,
  blockedAt,
  blockedLifted,
  blockedStop,
  exitCodeOf,
  isBlockedOn,
  liftStops,
  noStops,
  stopFor,
  stopsLine,
} from "../src/run/holds.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { RunView } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  hitsUsageLimit,
  result,
  type SessionScript,
  sleep,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-holds-${name}-`)))

/**
 * Claims its ticket, does `first` (time passing, a permission asked), commits and closes it, as a
 * worker does.
 */
const finishes = (
  world: World,
  root: string,
  id: string,
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

/** A worker that takes `takes` to finish its ticket. */
const takes = (world: World, root: string, id: string, takes: Duration.Input): SessionScript =>
  finishes(world, root, id, [sleep(takes)])

/** A worker that asks permission for `rm -rf build`, then finishes its ticket once answered. */
const asks = (world: World, root: string, id: string): SessionScript =>
  finishes(world, root, id, [canUseTool("Bash", { command: "rm -rf build" })])

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}: ${(yield* texts).join("\n")}`)
  })

/** Moves TestClock on by `total`, a minute at a time, letting the run catch up after each. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const minutes = Duration.toMinutes(Duration.fromInputUnsafe(total))
    for (let i = 0; i < minutes; i++) {
      yield* advance("1 minute")
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly concurrent?: number
  readonly ticketLimit?: Duration.Duration
  readonly scripts: (world: World, root: string) => Scripts
  /** Runs beside the run, before it is joined; `view` reads the dashboard's RunView. */
  readonly during?: (view: Effect.Effect<RunView>) => Effect.Effect<void, unknown, Env>
}

/** A whole run on main with a dashboard, each ticket's worktree made in git first. */
const runs = (plan: Plan) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: plan.concurrent ?? 1,
    workers: { ...defaults.workers, ticket_limit: plan.ticketLimit ?? null },
  }
  return scenario(
    {
      config: { repo, settings },
      backlog: plan.tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      // RunView is written at most 30 times a second, on the Clock: move it on to see the latest.
      const view = Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          yield* advance("100 millis")
          yield* Effect.promise(() => Bun.sleep(10))
        }
        if (shown === undefined) throw new Error("the run showed no dashboard")
        return yield* SubscriptionRef.get(shown.view)
      })
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
        }),
      )
      if (plan.during !== undefined) yield* plan.during(view)
      return yield* Fiber.join(fiber)
    }),
  )
}

/** A request open since `createdAt`, from `ticket`'s worker. */
const request = (id: string, ticket: string, createdAt: number): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
    summary: "rm -rf build",
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt,
})

const limit = Duration.toMillis(blockedAfter)

describe("BLOCKED, as the open requests say", () => {
  test("a ticket trips once a request of its worker has been open for blockedAfter", () => {
    const open = [request("r1", "t-1", 0), request("r2", "t-1", 10), request("r3", "t-2", 60_000)]
    expect(blockedAt(open, new Set(), limit - 1, blockedAfter)).toEqual({ trips: [], lifts: [] })
    expect(blockedAt(open, new Set(), limit, blockedAfter)).toEqual({
      trips: [{ ticket: "t-1", what: "Bash(rm -rf build)" }],
      lifts: [],
    })
    // Held already, it doesn't trip again.
    expect(blockedAt(open, new Set(["t-1"]), limit + 60_000, blockedAfter)).toEqual({
      trips: [{ ticket: "t-2", what: "Bash(rm -rf build)" }],
      lifts: [],
    })
  })

  test("a ticket held lifts once none of its requests is open, a new one too", () => {
    const open = [request("r3", "t-2", limit * 2)]
    expect(blockedAt(open, new Set(["t-1", "t-2"]), limit * 2, blockedAfter)).toEqual({
      trips: [],
      lifts: ["t-1"],
    })
  })

  test("its stop and lift lines name the ticket and what it waits on", () => {
    const stop = blockedStop("t-1", "Bash(rm -rf build)")
    expect(String(stop.text)).toBe("BLOCKED >4min: t-1 needs you: Bash(rm -rf build)")
    expect(stop).toMatchObject({ why: "BLOCKED", code: 3, ticket: "t-1" })
    expect(String(blockedLifted("t-1"))).toBe("HOLD lifted: t-1's requests were answered")
  })

  test("a request's words can't break the stop's line", () => {
    fc.assert(
      fc.property(fc.string(), (what) => {
        const text = String(blockedStop("t-1", what).text)
        expect(text.startsWith("BLOCKED >4min: t-1 needs you: ")).toBe(true)
        for (const control of ["\n", "\r", "\u001b"]) expect(text).not.toContain(control)
      }),
    )
  })

  test("lifting a ticket's stop keeps the others, the first left deciding the exit code", () => {
    const one = blockedStop("t-1", "a")
    const two = blockedStop("t-2", "b")
    const dirty = stopFor("DIRTY_TREE", "uncommitted changes in /repo")
    const lifted = liftStops(addStop(addStop(addStop(noStops, one), dirty), two), (stop) =>
      isBlockedOn(stop, "t-1"),
    )
    expect(exitCodeOf(lifted)).toBe(5)
    expect(String(stopsLine(lifted))).toBe(
      "DIRTY_TREE: uncommitted changes in /repo; also BLOCKED >4min: t-2 needs you: b",
    )
    expect(liftStops(addStop(noStops, one), (stop) => isBlockedOn(stop, "t-1"))).toEqual(noStops)
  })
})

describe("the time holds in a run", () => {
  test("TICKET_LIMIT holds the run; its worker goes on, isn't waited for, and is suspended", async () => {
    // t-1 takes 3h with a 1h limit; t-2 finishes at 30m, t-3 starts then and finishes at 75m.
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3", "t-4"],
      concurrent: 2,
      ticketLimit: Duration.hours(1),
      scripts: (world, root) => ({
        "t-1": [takes(world, root, "t-1", "3 hours")],
        "t-2": [takes(world, root, "t-2", "30 minutes")],
        "t-3": [takes(world, root, "t-3", "45 minutes")],
        "t-4": [takes(world, root, "t-4", "1 minute")],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* passes("59 minutes")
          expect((yield* texts).some((text) => text.includes("TICKET_LIMIT"))).toBe(false)
          yield* passes("2 minutes")
          yield* untilLogged(/^HOLD: TICKET_LIMIT: /)
          yield* passes("20 minutes")
        }),
    })
    expectExitCode(ran, 3)
    expectPhases(ran, { "t-1": "Stopped", "t-2": "Done", "t-3": "Done", "t-4": "Queued" })
    const stop =
      /^TICKET_LIMIT: t-1 still working after 1h \(worktree .*t-1\); its worker goes on, and is suspended when the run ends$/
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      "[2] t-2 dispatching: t-2",
      "[3] t-3 dispatching: t-3",
      /^HOLD: TICKET_LIMIT: t-1 still working after 1h .*; no new tickets while the 1 running finish$/,
      /^ {2}t-3 closed .*; merged into main/,
      stop,
    ])
    expect(ran.log.some((text) => text.includes("t-4 dispatching"))).toBe(false)
    // Its worker was never interrupted or sent anything; the run's end closed its session.
    expect(ran.sent.filter((s) => s.ticket === "t-1").map((s) => s._tag)).toEqual([
      "Started",
      "Message",
      "Closed",
    ])
    const suspended = ran.events.filter((record) => record.kind === "suspended")
    expect(suspended).toEqual([expect.objectContaining({ ticket: "t-1", why: "TICKET_LIMIT" })])
    const notes = ran.issues.find((issue) => issue.id === "t-1")?.notes ?? ""
    expect(notes).toContain("tutti: its worker was still working after the 1h ticket limit")
    expect(ran.events.at(-1)).toMatchObject({ kind: "end", code: 3 })
  }, 30_000)

  test("the time a worker waits for the usage limit doesn't count toward its ticket limit", async () => {
    // Limited at once until 2h, then 30m to finish: 2h30m after its dispatch, 30m of work.
    const ran = await runs({
      tickets: ["t-1"],
      ticketLimit: Duration.hours(1),
      scripts: (world, root) => ({
        "t-1": [[...hitsUsageLimit(2 * 3600), ...takes(world, root, "t-1", "30 minutes")]],
      }),
      during: () => passes("3 hours"),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(ran.log).toContain("USAGE_LIMIT lifted")
    expect(ran.log.some((text) => text.includes("TICKET_LIMIT"))).toBe(false)
  }, 30_000)

  test("LONG_RUNNING is said once at 2h without a limit, and holds nothing", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      scripts: (world, root) => ({ "t-1": [takes(world, root, "t-1", "3 hours")] }),
      during: () =>
        Effect.gen(function* () {
          yield* passes("119 minutes")
          expect((yield* texts).some((text) => text.includes("LONG_RUNNING"))).toBe(false)
          yield* passes("2 minutes")
          yield* untilLogged(/LONG_RUNNING/)
          yield* passes("60 minutes")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(ran.log.filter((text) => text.includes("LONG_RUNNING"))).toEqual([
      "  LONG_RUNNING: t-1 still working after 2h; still waiting on it, as no ticket limit is set (--ticket-limit)",
    ])
    expect(ran.events.filter((record) => record.kind === "warn")).toEqual([
      expect.objectContaining({ ticket: "t-1", text: expect.stringContaining("LONG_RUNNING") }),
    ])
  }, 30_000)

  test("BLOCKED holds the run at 4 minutes, with its banner, and answering lifts it", async () => {
    let held: RunView | undefined
    let lifted: RunView | undefined
    // t-1 asks at once; t-2 finishes at 10m, while the run holds, so t-3 waits for the answer.
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      concurrent: 2,
      scripts: (world, root) => ({
        "t-1": [asks(world, root, "t-1")],
        "t-2": [takes(world, root, "t-2", "10 minutes")],
        "t-3": [takes(world, root, "t-3", "1 minute")],
      }),
      during: (view) =>
        Effect.gen(function* () {
          yield* passes("3 minutes")
          expect((yield* texts).some((text) => text.includes("BLOCKED"))).toBe(false)
          yield* passes("2 minutes")
          yield* untilLogged(/^HOLD: BLOCKED/)
          held = yield* view
          yield* passes("8 minutes")
          yield* untilLogged(/^ {2}t-2 closed .*; merged into main/)
          expect((yield* texts).some((text) => text.includes("t-3 dispatching"))).toBe(false)
          yield* (yield* Attention).answer("r1", { _tag: "Allow" }, "screen")
          yield* untilLogged(/^HOLD lifted/)
          lifted = yield* view
          yield* passes("5 minutes")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      "HOLD: BLOCKED >4min: t-1 needs you: Bash(rm -rf build); no new tickets while the 2 running finish",
      /^ {2}t-2 closed .*; merged into main/,
      "HOLD lifted: t-1's requests were answered",
      "[3] t-3 dispatching: t-3",
    ])
    expect(held?.banners).toContainEqual({ _tag: "Hold", word: "BLOCKED", resetsAt: null })
    expect(held?.totals.queueHeld).toBe(true)
    expect(lifted?.banners.some((b) => b._tag === "Hold" && b.word === "BLOCKED")).toBe(false)
    const holds = ran.events.filter((record) => record.kind === "hold")
    expect(holds).toEqual([
      expect.objectContaining({ ticket: "t-1", text: expect.stringMatching(/^HOLD: BLOCKED/) }),
      expect.objectContaining({ ticket: "t-1", lifted: true }),
    ])
    expect(ran.events.some((record) => record.kind === "stop")).toBe(false)
  }, 30_000)
})
