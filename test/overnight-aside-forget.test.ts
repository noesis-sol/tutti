// A ticket an overnight run set aside, closed or deleted since by hand rather than undeferred,
// never comes back through bd ready to resume its kept session: the next run's start forgets its
// record in state.json, without taking it up (tutti-dmxe). One bd can't show is kept.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { overnightWhy } from "../src/run/overnightAside.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readAgainAfter } from "../src/run/schedule.ts"
import { Beads, BeadsFailed } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store, type TicketRecord } from "../src/services/Store.ts"
import type { Seed } from "../src/testing/Beads.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-overnight-forget-${name}-`)))

/** What an overnight run left of `id` as it set it aside, its worktree under `root`. */
const asideRecord = (root: string, id: string): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  suspended: overnightWhy("BLOCKED"),
  phase: "Deferred",
  resumes: 0,
  metadata: {},
})

interface Plan {
  readonly backlog: ReadonlyArray<Seed>
  readonly around?: (run: Effect.Effect<Outcome, never, Env>) => Effect.Effect<Outcome, never, Env>
}

/** A plain run on main, after an overnight run that set t-1 aside, its worktree there. */
const runs = async (plan: Plan) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let state: State | undefined
  const ran: Ran<Outcome> = await scenario(
    {
      backlog: plan.backlog,
      config: { repo },
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, tickets: { "t-1": asideRecord(root, "t-1") } },
    },
    Effect.gen(function* () {
      mkdirSync(join(root, "t-1"), { recursive: true })
      yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
        branch: "tutti/t-1",
        base: "main",
      })
      const running = Effect.scoped(run({ version: "0.1.0-test", base: "main" }))
      const fiber = yield* Effect.forkChild(
        plan.around === undefined ? running : plan.around(running),
      )
      const outcome = yield* Fiber.join(fiber)
      state = yield* (yield* Store).state
      return outcome
    }),
  )
  if (state === undefined) throw new Error(`the run failed: ${ran.exit}`)
  return { ran, state, root }
}

const sessionsOf = (ran: Ran<unknown>, id: string) =>
  ran.sent.flatMap((sent) =>
    (sent._tag === "Started" || sent._tag === "Resumed") && sent.ticket === id
      ? [`${sent._tag} ${sent.session.sessionId}`]
      : [],
  )

describe("a later run and a ticket an overnight run set aside, never undeferred", () => {
  test("closed since, its record is forgotten, its worktree left as it is", async () => {
    const { ran, state, root } = await runs({
      backlog: backlog().ticket("t-1", { status: "closed" }).seeds,
    })
    expectExitCode(ran, 0)
    expectPhases(ran, {})
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expect(ran.log.some((text) => text.includes("carried over"))).toBe(false)
    expectLog(ran, [
      `  t-1, set aside by an overnight run, is forgotten: it is closed, so it won't be undeferred; worktree ${join(root, "t-1")} left as it is`,
    ])
    expect(state.tickets["t-1"]).toBeUndefined()
    expect(existsSync(join(root, "t-1"))).toBe(true)
  })

  test("deleted since, its record is forgotten", async () => {
    const { ran, state, root } = await runs({ backlog: [] })
    expectExitCode(ran, 0)
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expectLog(ran, [
      `  t-1, set aside by an overnight run, is forgotten: bd has no such ticket, so it won't be undeferred; worktree ${join(root, "t-1")} left as it is`,
    ])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("one bd can't show is kept, unsaid", async () => {
    const { ran, state, root } = await runs({
      backlog: backlog().ticket("t-1", { status: "closed" }).seeds,
      around: (running) =>
        Effect.gen(function* () {
          const beads = yield* Beads
          const fiber = yield* Effect.forkChild(
            running.pipe(
              Effect.provideService(Beads, {
                ...beads,
                show: (id) =>
                  id === "t-1"
                    ? Effect.fail(
                        new BeadsFailed({
                          command: "bd show t-1 --json",
                          exitCode: 1,
                          stderr: "database is locked",
                          noSuchIssue: false,
                        }),
                      )
                    : beads.show(id),
              }),
            ),
          )
          // bd is read three times, a few seconds apart.
          for (let i = 0; i < 3; i++) yield* advance(readAgainAfter)
          return yield* Fiber.join(fiber)
        }),
    })
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expect(ran.log.some((text) => text.includes("t-1"))).toBe(false)
    expect(state.tickets["t-1"]).toEqual(asideRecord(root, "t-1"))
  })
})
