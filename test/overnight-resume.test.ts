// A ticket an overnight run set aside carries on in its worker's session once undeferred
// (tutti-jml1): its session is kept in state.json, suspended `set aside overnight: <why>`, which
// carry-over leaves alone, and its start resumes it when bd ready lists the ticket again, in the
// same run or a later one; a session that can't be resumed gives way to a new one.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import type { EventRecord } from "../src/run/events.ts"
import { overnightWhy } from "../src/run/overnightAside.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { asideResumedText } from "../src/run/told.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store, type TicketRecord } from "../src/services/Store.ts"
import {
  bash,
  canUseTool,
  failStart,
  result,
  type SessionScript,
  sleep,
  turn,
  withoutNotes,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-overnight-resume-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket, does `first`, commits and closes it, as a worker does. */
const finishes = (
  world: World,
  root: string,
  id: TicketId,
  first: ReadonlyArray<SessionScript[number]> = [],
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

/** The ticket's sessions as they were started and resumed: `Started s` or `Resumed s`. */
const sessionsOf = (ran: Ran<unknown>, id: string) =>
  ran.sent.flatMap((sent) =>
    (sent._tag === "Started" || sent._tag === "Resumed") && sent.ticket === id
      ? [`${sent._tag} ${sent.session.sessionId}`]
      : [],
  )

/** The messages the ticket's worker was sent, as text. */
const textsOf = (ran: Ran<unknown>, id: string) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id
      ? [withoutNotes(String(sent.message.message.content))]
      : [],
  )

const resumedRecords = (ran: Ran<unknown>) =>
  ran.events.filter(
    (record): record is Extract<EventRecord, { kind: "resumed" }> => record.kind === "resumed",
  )

describe("an overnight run keeps a set-aside ticket's session, and resumes it once undeferred", () => {
  test("in the same run: saved as set aside, then resumed and finished", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = appConfig().settings
    let aside: TicketRecord | undefined
    let after: State | undefined
    const ran = await scenario(
      {
        config: { repo, settings: { ...defaults, concurrent: 2 }, overnight: true },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        // t-1's first session asks, and works on for 2h once answered; its resumed one finishes.
        // t-2 keeps the run going meanwhile.
        scripts: (world) => ({
          "t-2": [finishes(world, root, "t-2" as TicketId, [sleep("20 minutes")])],
          "t-1": [
            finishes(world, root, "t-1" as TicketId, [
              canUseTool("Bash", { command: "rm -rf build" }),
              sleep("2 hours"),
            ]),
            finishes(world, root, "t-1" as TicketId),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["t-1", "t-2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
        )
        yield* passes("5 minutes")
        yield* untilLogged(/t-1: its worker was blocked/)
        // A ready poll finds it gone from bd ready before it is undeferred.
        yield* passes("2 minutes")
        aside = yield* (yield* Store).ticket("t-1" as TicketId)
        yield* (yield* Beads).update("t-1" as TicketId, { status: "open" })
        yield* passes("3 minutes")
        yield* untilLogged(/^ {2}t-1 closed .*; merged into main/)
        yield* passes("15 minutes")
        const outcome = yield* Fiber.join(fiber)
        after = yield* (yield* Store).state
        return outcome
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    const [started] = sessionsOf(ran, "t-1")
    const session = started?.replace(/^Started /, "") ?? ""
    expect(aside).toEqual(
      expect.objectContaining({
        session,
        worktree: join(root, "t-1"),
        suspended: overnightWhy("BLOCKED"),
        phase: "Deferred",
      }),
    )
    // One session, started once and resumed, not a second one drawn.
    expect(sessionsOf(ran, "t-1")).toEqual([`Started ${session}`, `Resumed ${session}`])
    expectLog(ran, [
      /^ {2}t-1: its worker was blocked on a permission request for over 4m -> noted and deferred/,
      `  RESUMED: t-1 was set aside overnight (BLOCKED) and is undeferred; resuming its session ${session} (worktree ${join(root, "t-1")})`,
      /^ {2}t-1 closed .*; merged into main/,
    ])
    expect(resumedRecords(ran)).toEqual([
      expect.objectContaining({ ticket: "t-1", session, why: "set_aside" }),
    ])
    expect(textsOf(ran, "t-1").at(-1)).toBe(
      asideResumedText("t-1" as TicketId, overnightWhy("BLOCKED"), true),
    )
    // Merged, it is forgotten.
    expect(after?.tickets["t-1"]).toBeUndefined()
  }, 30_000)
})

/** What an overnight run left of `id` as it set it aside for `why`, its worktree under `root`. */
const asideRecord = (
  root: string,
  id: string,
  why = overnightWhy("TICKET_LIMIT"),
): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  suspended: why,
  phase: "Deferred",
  resumes: 0,
  metadata: {},
})

interface Later {
  readonly backlog: ReadonlyArray<Seed>
  readonly saved: (root: string) => Readonly<Record<string, TicketRecord>>
  readonly worktrees: ReadonlyArray<string>
  readonly scripts: (world: World, root: string) => Scripts
}

/** A later, plain run on main, after an overnight run that left `plan.saved` in state.json. */
const later = async (plan: Later) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let state: State | undefined
  const ran = await scenario(
    {
      backlog: plan.backlog,
      config: { repo },
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, tickets: plan.saved(root) },
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.worktrees) {
        mkdirSync(join(root, id), { recursive: true })
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      yield* passes("10 minutes")
      const outcome: Outcome = yield* Fiber.join(fiber)
      state = yield* (yield* Store).state
      return outcome
    }),
  )
  if (state === undefined) throw new Error(`the run failed: ${ran.exit}`)
  return { ran, state, root }
}

describe("a later run and a ticket an overnight run set aside", () => {
  test("undeferred, it is dispatched and its kept session resumed, not carried over", async () => {
    const { ran, state, root } = await later({
      backlog: backlog().ticket("t-1").seeds,
      saved: (root) => ({ "t-1": asideRecord(root, "t-1") }),
      worktrees: ["t-1"],
      scripts: (world, root) => ({ "t-1": [finishes(world, root, "t-1" as TicketId)] }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(sessionsOf(ran, "t-1")).toEqual(["Resumed session-t-1"])
    expect(ran.log.some((text) => text.includes("carried over"))).toBe(false)
    expectLog(ran, [
      /t-1 dispatching/,
      `  RESUMED: t-1 was set aside overnight (TICKET_LIMIT) and is undeferred; resuming its session session-t-1 (worktree ${join(root, "t-1")})`,
    ])
    expect(textsOf(ran, "t-1")).toEqual([
      asideResumedText("t-1" as TicketId, overnightWhy("TICKET_LIMIT"), false),
    ])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("still deferred, it is left alone, its session kept for when it is undeferred", async () => {
    const { ran, state, root } = await later({
      backlog: backlog().ticket("t-1", { status: "deferred" }).ticket("t-2").seeds,
      saved: (root) => ({ "t-1": asideRecord(root, "t-1", overnightWhy("BLOCKED")) }),
      worktrees: ["t-1", "t-2"],
      scripts: (world, root) => ({ "t-2": [finishes(world, root, "t-2" as TicketId)] }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-2": "Done" })
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expect(ran.log.some((text) => text.includes("t-1"))).toBe(false)
    expect(state.tickets["t-1"]).toEqual(asideRecord(root, "t-1", overnightWhy("BLOCKED")))
  })

  test("a kept session that can't be resumed gives way to a new one in the same worktree", async () => {
    const { ran } = await later({
      backlog: backlog().ticket("t-1").seeds,
      saved: (root) => ({ "t-1": asideRecord(root, "t-1") }),
      worktrees: ["t-1"],
      scripts: (world, root) => ({
        "t-1": [[failStart("the transcript is gone")], finishes(world, root, "t-1" as TicketId)],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    const sessions = sessionsOf(ran, "t-1")
    expect(sessions[0]).toBe("Resumed session-t-1")
    expect(sessions).toHaveLength(2)
    expect(sessions[1]).toMatch(/^Started /)
    expect(sessions[1]).not.toBe("Started session-t-1")
    expectLog(ran, [
      "  t-1's session session-t-1, kept as an overnight run set it aside, could not be resumed (the transcript is gone); starting a new one",
    ])
    expect(resumedRecords(ran)).toEqual([])
  })
})
