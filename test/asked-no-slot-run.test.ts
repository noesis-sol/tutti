// A whole run on one slot (tutti-luwa, § 5.1): t-1 asks, t-2 takes the slot and t-1's question is
// answered while t-2 works. The look tells the dashboard: t-1 no longer needs you, its row says
// `↻ answered` and Up next lists it, until t-2's slot frees and it comes back.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Queue, SubscriptionRef } from "effect"
import type { DrainRequest } from "../src/run/drain.ts"
import { run } from "../src/run/run.ts"
import type { RunView } from "../src/run/runView.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  filesQuestion,
  hitsUsageLimit,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { advance, backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-asked-no-slot-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

const asks = (world: World, id: TicketId): SessionScript =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        world.beads.create({ title: "Which way?", labels: ["human"], blocks: [id] }),
        world.beads.update(id, { status: "open" }),
      ),
    ),
  })

const answers = (world: World, id: TicketId): Effect.Effect<void> =>
  orDie(
    Effect.gen(function* () {
      for (const dependency of (yield* world.beads.show(id)).dependencies) {
        if (dependency.issue?.labels.includes("human") === true) {
          yield* world.beads.close(dependency.id, "answered")
        }
      }
    }),
  )

const finishes = (
  world: World,
  root: string,
  id: TicketId,
  meanwhile: ReadonlyArray<SessionScript[number]>,
): SessionScript =>
  turn([
    ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
    ...meanwhile,
    ...bash(
      `git commit -am "Change (${id})"`,
      orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
    ),
    ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
  ])

/** What the view said of t-1, each time it changed. */
const said = (view: RunView): string => {
  const row = view.rows.find((each) => each.ticket === "t-1")
  const queued = view.queue.some((each) => each.ticket === "t-1" && each.answered !== undefined)
  return `${row?.word ?? "no row"} · ${view.totals.needsYou} · ${view.needs.length} · ${queued}`
}

describe("a question answered with no slot, in a whole run", () => {
  test("Needs you leaves it out, its row says answered, until its slot frees", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const seen: Array<string> = []
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          "t-1": [asks(world, "t-1" as TicketId), finishes(world, root, "t-1" as TicketId, [])],
          // t-2 answers t-1's question, then goes on past ready polls with the slot.
          "t-2": [
            finishes(world, root, "t-2" as TicketId, [
              sleep(Duration.times(readyPoll, 2)),
              step(answers(world, "t-1" as TicketId)),
              sleep(Duration.times(readyPoll, 3)),
            ]),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["t-1", "t-2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const look = Effect.gen(function* () {
          if (shown === undefined) return
          const now = said(yield* SubscriptionRef.get(shown.view))
          if (seen.at(-1) !== now) seen.push(now)
        })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", dashboard }),
        )
        for (let i = 0; i < 12; i++) {
          for (let j = 0; j < 200; j++) yield* Effect.yieldNow
          yield* look
          yield* advance(readyPoll)
          for (let j = 0; j < 200; j++) yield* Effect.yieldNow
          yield* look
        }
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expect(seen).toContain("for you · 1 · 1 · false")
    expect(seen).toContain("answered · 0 · 0 · true")
    const asked = seen.indexOf("for you · 1 · 1 · false")
    const answered = seen.indexOf("answered · 0 · 0 · true")
    expect(answered).toBeGreaterThan(asked)
    expect(seen.at(-1)).toContain(" · 0 · 0 · false")
  })

  test("a question answered while the usage limit holds: the same, though the look takes none back", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const seen: Array<string> = []
    let answeredAt = -1
    await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          "t-1": [asks(world, "t-1" as TicketId), turn([])],
          "t-2": [hitsUsageLimit(3600), turn([])],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        const beads = yield* Beads
        for (const id of ["t-1", "t-2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", dashboard }),
        )
        for (let i = 0; i < 12; i++) {
          for (let j = 0; j < 200; j++) yield* Effect.yieldNow
          if (shown !== undefined) {
            const view = yield* SubscriptionRef.get(shown.view)
            seen.push(said(view))
            const held = view.banners.length > 0 && view.needs.length > 0
            if (answeredAt < 0 && held) {
              for (const dependency of (yield* Effect.orDie(beads.show("t-1" as TicketId)))
                .dependencies) {
                if (dependency.issue?.labels.includes("human") === true) {
                  yield* Effect.orDie(beads.close(dependency.id, "answered"))
                }
              }
              answeredAt = seen.length
            }
          }
          yield* advance(readyPoll)
        }
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(answeredAt).toBeGreaterThan(0)
    expect(seen[answeredAt - 1]).toBe("for you · 1 · 1 · false")
    expect(seen.at(-1)).toBe("answered · 0 · 0 · true")
  })

  test("winding down, it says it resumes in the next run, as no slot brings it back in this one", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const drains = Effect.runSync(Queue.unbounded<DrainRequest>())
    const notes: Array<string> = []
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          "t-1": [asks(world, "t-1" as TicketId), finishes(world, root, "t-1" as TicketId, [])],
          "t-2": [
            finishes(world, root, "t-2" as TicketId, [
              step(
                Effect.andThen(
                  Queue.offer(drains, { on: true, how: "by SIGUSR1" }),
                  answers(world, "t-1" as TicketId),
                ),
              ),
              sleep(Duration.times(readyPoll, 3)),
            ]),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["t-1", "t-2"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", drains, dashboard }),
        )
        for (let i = 0; i < 12; i++) {
          for (let j = 0; j < 200; j++) yield* Effect.yieldNow
          if (shown !== undefined) {
            const view = yield* SubscriptionRef.get(shown.view)
            const row = view.rows.find((each) => each.ticket === "t-1")
            if (row?.word === "answered") notes.push(row.note)
          }
          yield* advance(readyPoll)
        }
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Asked", "t-2": "Done" })
    expect(notes.length).toBeGreaterThan(0)
    expect(new Set(notes)).toEqual(new Set(["(resumes at the next run) t-1"]))
  })
})
