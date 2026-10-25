// An overnight run sets a stuck ticket aside rather than hold the run (§ 5 item 10, tutti-kkb.52):
// PAUSED, BLOCKED and TICKET_LIMIT each defer their ticket while another goes on and merges, as
// whole runs under TestClock; without --overnight the same holds the run; and a stop like
// DIRTY_TREE still stops an overnight run.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, SubscriptionRef } from "effect"
import * as fc from "fast-check"
import {
  type AttentionRequest,
  permissionResult,
  tuttiDenialMessage,
} from "../src/agent/Attention.ts"
import { answered, line } from "../src/run/log.ts"
import {
  asideLine,
  asideNote,
  blockedStuck,
  limitStuck,
  overnightWhy,
  pausedStuck,
} from "../src/run/overnightAside.ts"
import { run } from "../src/run/run.ts"
import type { RunView } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { StartedWorker } from "../src/run/start.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { nothingEarlier } from "../src/services/Worktrees.ts"
import {
  bash,
  canUseTool,
  gone,
  result,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { Repository } from "../src/testing/Git.ts"
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

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-overnight-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket, does `first`, commits and closes it, as a worker does. */
const finishes = (
  world: World,
  root: string,
  id: TicketId,
  first: ReadonlyArray<SessionScript[number]>,
): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      ...first,
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** A worker that takes `takes` to finish its ticket. */
const takes = (world: World, root: string, id: TicketId, takes: Duration.Input): SessionScript =>
  finishes(world, root, id, [sleep(takes)])

/**
 * A worker that asks permission for `rm -rf build`, then, answered, works on for 2h before it
 * finishes: an overnight run stops it long before.
 */
const asks = (world: World, root: string, id: TicketId): SessionScript =>
  finishes(world, root, id, [canUseTool("Bash", { command: "rm -rf build" }), sleep("2 hours")])

/** A worker that claims its ticket and is gone, then gone again once resumed: PAUSED at once. */
const goesTwice = (world: World, id: TicketId): ReadonlyArray<SessionScript> => [
  [...turn([step(orDie(world.beads.update(id, { claim: true })))]).slice(0, -2), gone("exit 1")],
  [gone("exit 1")],
]

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
  readonly overnight: boolean
  readonly concurrent?: number
  readonly ticketLimit?: Duration.Duration
  readonly scripts: (world: World, root: string) => Scripts
  /** Runs beside the run, before it is joined; `view` reads the dashboard's RunView. */
  readonly during?: (view: Effect.Effect<RunView>) => Effect.Effect<void, unknown, Env>
}

/** A whole run on main with a dashboard, overnight or not, each ticket's worktree made first. */
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
      config: { repo, settings, overnight: plan.overnight },
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

const notesOf = (
  ran: { readonly issues: ReadonlyArray<{ id: string; notes?: string }> },
  id: string,
) => ran.issues.find((issue) => issue.id === id)?.notes ?? ""

describe("what an overnight run says of a ticket it sets aside", () => {
  const worker: StartedWorker = {
    ticket: "t-1" as TicketId,
    worktree: {
      id: "t-1" as TicketId,
      path: "/w/t-1",
      branch: "tutti/t-1",
      reused: false,
      fresh: true,
      earlier: nothingEarlier,
    },
    session: "5e55",
    message: "00000000-0000-4000-8000-000000000001" as StartedWorker["message"],
  }
  const request: AttentionRequest = {
    id: "r1",
    ticket: "t-1" as TicketId,
    kind: {
      _tag: "Permission",
      tool: "Bash",
      input: { command: "rm -rf build" },
      suggestions: [],
      summary: "rm -rf build",
    },
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    createdAt: 0,
  }

  test("its line says what its worker did, and why it was deferred", () => {
    expect(String(asideLine("t-1" as TicketId, blockedStuck(request), "/w/t-1"))).toBe(
      "  t-1: its worker was blocked on a permission request for over 4m -> noted and deferred, the run being an overnight one (BLOCKED); worktree /w/t-1 kept for review",
    )
    expect(String(asideLine("t-1" as TicketId, limitStuck("2h"), "/w/t-1"))).toBe(
      "  t-1: its worker was still working after the 2h ticket limit -> noted and deferred, the run being an overnight one (TICKET_LIMIT); worktree /w/t-1 kept for review",
    )
    expect(String(asideLine("t-1" as TicketId, pausedStuck(undefined, "10m"), "/w/t-1"))).toBe(
      "  t-1: its ticket was still in_progress, its worker idle for 10m -> noted and deferred, the run being an overnight one (PAUSED); worktree /w/t-1 kept for review",
    )
    expect(overnightWhy("BLOCKED")).toBe("set aside overnight: BLOCKED")
  })

  test("its note says what it waited on, that it was denied, and what is kept", () => {
    expect(asideNote(worker, blockedStuck(request))).toBe(
      "tutti: its worker was blocked on a permission request for over 4m (Bash(rm -rf build)), and nobody was there to answer, the run being an overnight one (BLOCKED): its request was denied, its worker was stopped, and t-1 deferred for review. Its worktree /w/t-1, branch tutti/t-1, and its session 5e55 are kept; bring it back with: bd undefer t-1",
    )
    expect(asideNote(worker, limitStuck("1h"))).not.toContain("denied")
  })

  test("a request's words reach its note, never its line", () => {
    fc.assert(
      fc.property(fc.string(), (summary) => {
        const asked = { ...request, kind: { ...request.kind, summary } } as AttentionRequest
        const text = String(asideLine("t-1" as TicketId, blockedStuck(asked), "/w/t-1"))
        expect(text.startsWith("  t-1: its worker was blocked on a permission request")).toBe(true)
        for (const control of ["\n", "\r", "\u001b"]) expect(text).not.toContain(control)
      }),
    )
  })

  test("tutti's denial is in nobody's name, its line saying so", () => {
    const denied = permissionResult(request, {
      _tag: "Deny",
      reason: "the run sets its ticket aside",
      byTutti: true,
    })
    expect(denied).toMatchObject({
      behavior: "deny",
      message: `${tuttiDenialMessage}: the run sets its ticket aside`,
    })
    expect(
      String(
        answered({
          id: "t-1" as TicketId,
          kind: "permission",
          what: "Bash(rm -rf build)",
          verdict: "denied",
          via: "--overnight",
        }).line,
      ),
    ).toContain("Bash(rm -rf build) denied, by tutti, the run being an overnight one")
  })
})

describe("an overnight run sets a stuck ticket aside and goes on", () => {
  test("BLOCKED: its request denied, its worker stopped, deferred, and the run goes on", async () => {
    let shown: RunView | undefined
    // t-1 asks at once; t-2 finishes at 10m; t-3 takes t-1's slot once it is set aside, at 4m.
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      overnight: true,
      concurrent: 2,
      scripts: (world, root) => ({
        "t-1": [asks(world, root, "t-1" as TicketId)],
        "t-2": [takes(world, root, "t-2" as TicketId, "10 minutes")],
        "t-3": [takes(world, root, "t-3" as TicketId, "1 minute")],
      }),
      during: (view) =>
        Effect.gen(function* () {
          yield* passes("5 minutes")
          yield* untilLogged(/t-1: its worker was blocked/)
          yield* passes("2 minutes")
          yield* untilLogged(/^ {2}t-3 closed .*; merged into main/)
          shown = yield* view
          yield* passes("8 minutes")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Deferred", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      /^ {2}PERMISSION: t-1's worker: Bash\(rm -rf build\) denied \(.*\), by tutti, the run being an overnight one$/,
      /^ {2}t-1: its worker was blocked on a permission request for over 4m -> noted and deferred, the run being an overnight one \(BLOCKED\); worktree .*t-1 kept for review$/,
      "[3] t-3 dispatching: t-3",
      /^ {2}t-2 closed .*; merged into main/,
    ])
    expect(ran.log.some((text) => /HOLD|BLOCKED >4min/.test(text))).toBe(false)
    expect(ran.events.some((record) => record.kind === "stop" || record.kind === "hold")).toBe(
      false,
    )
    expect(ran.events).toContainEqual(
      expect.objectContaining({
        kind: "attention_answered",
        ticket: "t-1",
        answer: "deny",
        via: "overnight",
      }),
    )
    expect(ran.events).toContainEqual(
      expect.objectContaining({
        kind: "deferred",
        ticket: "t-1",
        detail: "set aside overnight: BLOCKED",
      }),
    )
    // Stopped mid-turn, its session closed and the worker ended, its slot freed.
    expect(ran.sent.filter((s) => s.ticket === "t-1").map((s) => s._tag)).toEqual([
      "Started",
      "Message",
      "Interrupted",
      "Closed",
      "Ended",
    ])
    const notes = notesOf(ran, "t-1")
    expect(notes).toContain("(Bash(rm -rf build)), and nobody was there to answer")
    expect(notes).toContain("bring it back with: bd undefer t-1")
    expect(ran.issues.find((issue) => issue.id === "t-1")?.status).toBe("deferred")
    // Its row says why before its title; the run's totals count it set aside.
    const row = shown?.rows.find((each) => each.ticket === "t-1")
    expect(row).toMatchObject({ word: "deferred", note: "(set aside overnight: BLOCKED) t-1" })
    expect(shown?.totals.deferred).toBe(1)
    expect(ran.log.some((text) => /Set aside 1|1 set aside/.test(text))).toBe(true)
  }, 30_000)

  test("TICKET_LIMIT: its worker stopped at the limit, deferred, and its slot taken", async () => {
    // t-1 takes 3h with a 1h limit; t-2 finishes at 30m and t-3 starts then; t-4 takes t-1's slot.
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3", "t-4"],
      overnight: true,
      concurrent: 2,
      ticketLimit: Duration.hours(1),
      scripts: (world, root) => ({
        "t-1": [takes(world, root, "t-1" as TicketId, "3 hours")],
        "t-2": [takes(world, root, "t-2" as TicketId, "30 minutes")],
        "t-3": [takes(world, root, "t-3" as TicketId, "45 minutes")],
        "t-4": [takes(world, root, "t-4" as TicketId, "1 minute")],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* passes("61 minutes")
          yield* untilLogged(/t-1: its worker was still working/)
          yield* passes("20 minutes")
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Deferred", "t-2": "Done", "t-3": "Done", "t-4": "Done" })
    expectLog(ran, [
      "[3] t-3 dispatching: t-3",
      /^ {2}t-1: its worker was still working after the 1h ticket limit -> noted and deferred, the run being an overnight one \(TICKET_LIMIT\); worktree .*t-1 kept for review$/,
      "[4] t-4 dispatching: t-4",
      /^ {2}t-3 closed .*; merged into main/,
    ])
    expect(ran.log.some((text) => text.includes("HOLD") || /^TICKET_LIMIT/.test(text))).toBe(false)
    expect(ran.sent.filter((s) => s.ticket === "t-1").map((s) => s._tag)).toEqual([
      "Started",
      "Message",
      "Interrupted",
      "Closed",
      "Ended",
    ])
    expect(ran.events.some((record) => record.kind === "suspended")).toBe(false)
    const notes = notesOf(ran, "t-1")
    expect(notes).toContain("its worker was still working after the 1h ticket limit, and nobody")
    // The note an ordinary run writes at the limit isn't written too.
    expect(notes).not.toContain("ticket limit (worktree")
  }, 30_000)

  test("PAUSED: deferred rather than hold the run, and the next ticket merges", async () => {
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      overnight: true,
      scripts: (world, root) => ({
        "t-1": goesTwice(world, "t-1" as TicketId),
        "t-2": [takes(world, root, "t-2" as TicketId, "1 minute")],
      }),
      during: () => passes("3 minutes"),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Deferred", "t-2": "Done" })
    expectLog(ran, [
      /^ {2}t-1: its ticket was still in_progress, its worker is gone \(.*exit 1.*\) -> noted and deferred, the run being an overnight one \(PAUSED\); worktree .*t-1 kept for review$/,
      "[2] t-2 dispatching: t-2",
      /^ {2}t-2 closed .*; merged into main/,
    ])
    expect(ran.log.some((text) => text.includes("PAUSED:"))).toBe(false)
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "deferred", detail: "set aside overnight: PAUSED" }),
    )
  }, 30_000)

  test("without --overnight, PAUSED holds the run as before", async () => {
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      overnight: false,
      scripts: (world, root) => ({
        "t-1": goesTwice(world, "t-1" as TicketId),
        "t-2": [takes(world, root, "t-2" as TicketId, "1 minute")],
      }),
      during: () => passes("3 minutes"),
    })
    expectExitCode(ran, 3)
    expectPhases(ran, { "t-1": "Stopped", "t-2": "Queued" })
    expectLog(ran, [/^PAUSED: t-1 still in_progress/])
  }, 30_000)

  test("DIRTY_TREE still stops an overnight run", async () => {
    const ran = await runs({
      tickets: ["t-1"],
      overnight: true,
      scripts: (world, root) => {
        const stray = Effect.flatMap(Repository, (repository) =>
          repository.write(repository.dir, { "stray.txt": "x\n" }),
        ).pipe(Effect.provideService(Repository, world.repository))
        return { "t-1": [finishes(world, root, "t-1" as TicketId, [step(stray)])] }
      },
      during: () => passes("2 minutes"),
    })
    expectExitCode(ran, 5)
    expectPhases(ran, { "t-1": "Blocked" })
    expectLog(ran, [/^DIRTY_TREE: /])
  }, 30_000)
})
