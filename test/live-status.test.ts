import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Ref, type Scope, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { probeFile, probeWorker } from "../src/run/environment.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { RunView } from "../src/run/runView.ts"
import { make, type QueueShown } from "../src/run/schedule.ts"
import { unclosedIn } from "../src/run/scope.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { Beads, Issue, TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { writeRunFile } from "../src/services/Worktrees.ts"
import {
  bash,
  claimsAndCloses,
  result,
  type SessionScript,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, type Env, expectExitCode, type Scripts, scenario, type World } from "./harness.ts"

// The run keeps the dashboard's status live: the scheduler shows its solo ticket and the tickets
// it draws from as they change, the stops say `· stopping`, the probe's session shows as a card.

/** An open task named `id`, with `fields` over it. */
const issue = (id: TicketId, fields: Partial<Issue> = {}): Issue => ({
  id,
  title: id,
  description: "",
  design: "",
  acceptance: "",
  notes: "",
  status: "open",
  type: "task",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "2026-10-20T00:00:00Z",
  closeReason: "",
  ...fields,
})

const filter = { excludeTypes: ["chore"] }

describe("the tickets the queue draws from", () => {
  test("are those not closed the run takes: no question, no epic, no excluded type", () => {
    const open = [
      issue("t-1" as TicketId),
      issue("t-2" as TicketId, { status: "in_progress" }),
      issue("e" as TicketId, { type: "epic" }),
      issue("c" as TicketId, { type: "chore" }),
      issue("q" as TicketId, { labels: ["human"] }),
    ]
    expect(unclosedIn(open, null, filter)).toBe(2)
  })

  test("in a scoped run, are its ticket and its descendants", () => {
    const open = [
      issue("e" as TicketId, { type: "epic" }),
      issue("e.1" as TicketId, { parent: "e" as TicketId }),
      issue("e.2" as TicketId, { parent: "e" as TicketId }),
      issue("e.2.1" as TicketId, { parent: "e.2" as TicketId }),
      issue("other" as TicketId),
      issue("o.1" as TicketId, { parent: "other" as TicketId }),
    ]
    expect(unclosedIn(open, "e" as TicketId, filter)).toBe(3)
    expect(unclosedIn(open, "e.2" as TicketId, filter)).toBe(2)
    expect(unclosedIn(open, "o.1" as TicketId, filter)).toBe(1)
  })

  test("in a scope, count no more than without one, whatever parents tickets name", () => {
    const ids = ["a", "b", "c", "d", "e"].map((id) => id as TicketId)
    const tickets = fc.uniqueArray(
      fc.record({
        id: fc.constantFrom(...ids),
        parent: fc.option(
          fc.oneof(
            fc.constantFrom(...ids),
            fc.string().map((id) => id as TicketId),
          ),
          {
            nil: undefined,
          },
        ),
        type: fc.constantFrom("task", "epic", "chore"),
      }),
      { selector: (each) => each.id },
    )
    fc.assert(
      fc.property(tickets, fc.option(fc.constantFrom(...ids), { nil: null }), (each, scope) => {
        const open = each.map(({ id, parent, type }) =>
          issue(id, { type, ...(parent === undefined ? {} : { parent }) }),
        )
        const all = unclosedIn(open, null, filter)
        const scoped = unclosedIn(open, scope, filter)
        expect(scoped).toBeGreaterThanOrEqual(0)
        expect(scoped).toBeLessThanOrEqual(all)
      }),
    )
  })
})

type SchedulerEnv = Beads | Ledger | Log | EventStream | RunFibers | Scope.Scope

/** Runs `effect` in a scope over the in-memory backlog with `seeds`, under TestClock. */
const scheduled = <A, E>(
  seeds: ReadonlyArray<Seed>,
  effect: Effect.Effect<A, E, SchedulerEnv>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

describe("the scheduler shows the queue", () => {
  test("its solo ticket next, then running, then gone; and the tickets not closed", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0 },
      { id: "s", priority: 1, labels: ["solo"] },
      { id: "t-2", priority: 2 },
      { id: "c", status: "closed" },
    ]
    const steps = await scheduled(
      seeds,
      Effect.gen(function* () {
        const shown = yield* Ref.make<ReadonlyArray<QueueShown>>([])
        const gates = new Map<string, Deferred.Deferred<void>>()
        const gate = (id: string) => {
          const known = gates.get(id)
          if (known !== undefined) return known
          const made = Deferred.makeUnsafe<void>()
          gates.set(id, made)
          return made
        }
        const schedule = yield* make({
          concurrent: 3,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          start: { start: (issue) => Deferred.await(gate(issue.id)) },
          show: (queue) => Ref.update(shown, (all) => [...all, queue]),
        })
        const last = Effect.map(Ref.get(shown), (all) => all.at(-1))
        const finish = (id: string) => Effect.andThen(Deferred.succeed(gate(id), undefined), flush)
        const steps: Array<QueueShown | undefined> = []
        yield* schedule.fillTrying
        steps.push(yield* last)
        yield* finish("t-1")
        yield* schedule.fillTrying
        steps.push(yield* last)
        yield* finish("s")
        yield* schedule.fillTrying
        steps.push(yield* last)
        // Only a change is shown: none is shown twice in a row.
        const all = (yield* Ref.get(shown)).map((each) => JSON.stringify(each))
        expect(all.filter((each, i) => each === all[i - 1])).toEqual([])
        return steps
      }),
    )
    const none = { waits: {}, skips: {} }
    expect(steps).toEqual([
      { solo: { ticket: "s", running: false }, unclosed: 3, ...none },
      { solo: { ticket: "s", running: true }, unclosed: 3, ...none },
      { solo: null, unclosed: 3, ...none },
    ])
  })
})

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-live-${name}-`)))

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

/** Claims, commits and closes its ticket, once `gate` opens if given, as a worker does. */
const finishesAfter = (
  world: World,
  root: string,
  id: TicketId,
  gate?: Deferred.Deferred<void>,
): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.andThen(
      gate === undefined ? Effect.void : Deferred.await(gate),
      Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    ),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

interface Plan {
  readonly seeds: ReadonlyArray<Seed>
  readonly concurrent: number
  readonly scripts: (world: World, root: string, repo: string) => Scripts
  /** Runs beside the run, before it is joined; `view` reads the dashboard's RunView. */
  readonly during: (view: Effect.Effect<RunView>) => Effect.Effect<void, unknown, Env>
}

/** A whole run on main with a dashboard, each ticket's worktree made in git first. */
const runs = (plan: Plan) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = { ...appConfig().settings, concurrent: plan.concurrent }
  return scenario(
    {
      config: { repo, settings },
      backlog: plan.seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root, repo),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const seed of plan.seeds) {
        yield* git.addWorktree(repo, join(root, seed.id), {
          branch: `tutti/${seed.id}`,
          base: "main",
        })
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
      yield* plan.during(view)
      return yield* Fiber.join(fiber)
    }),
  )
}

describe("the run's dashboard", () => {
  test("says the solo ticket next and running, and In queue's of N, as they change", async () => {
    const gates = {
      "t-1": Deferred.makeUnsafe<void>(),
      s: Deferred.makeUnsafe<void>(),
      "t-2": Deferred.makeUnsafe<void>(),
    }
    const seen: Array<Pick<RunView, "title"> & { readonly unclosed: number | null }> = []
    const look = (view: Effect.Effect<RunView>) =>
      Effect.map(view, (now) => {
        seen.push({ title: now.title, unclosed: now.totals.unclosed })
      })
    const ran = await runs({
      seeds: [
        { id: "t-1", priority: 0 },
        { id: "s", priority: 1, labels: ["solo"] },
        { id: "t-2", priority: 2 },
      ],
      concurrent: 2,
      scripts: (world, root) => ({
        "t-1": [finishesAfter(world, root, "t-1" as TicketId, gates["t-1"])],
        s: [finishesAfter(world, root, "s" as TicketId, gates.s)],
        "t-2": [finishesAfter(world, root, "t-2" as TicketId, gates["t-2"])],
      }),
      during: (view) =>
        Effect.gen(function* () {
          yield* untilLogged(/solo ticket s is next/)
          yield* look(view)
          yield* Deferred.succeed(gates["t-1"], undefined)
          yield* untilLogged(/s dispatching solo/)
          yield* look(view)
          yield* Deferred.succeed(gates.s, undefined)
          yield* untilLogged(/t-2 dispatching/)
          yield* look(view)
          yield* Deferred.succeed(gates["t-2"], undefined)
        }),
    })
    expectExitCode(ran, 0)
    expect(seen.map((each) => [each.title.solo, each.title.stopping, each.unclosed])).toEqual([
      [{ ticket: "s", running: false }, false, 3],
      [{ ticket: "s", running: true }, false, 2],
      [null, false, 1],
    ])
  })

  test("says stopping while the environment holds the run, and shows the probe's card", async () => {
    const probeGate = Deferred.makeUnsafe<void>()
    // A worker its environment fails: it ends its turn at once, without claiming anything.
    const givesUp: SessionScript = turn([], result("Every command was refused."))
    const seen: Array<{ readonly stopping: boolean; readonly probe: string | null }> = []
    const look = (view: Effect.Effect<RunView>) =>
      Effect.map(view, (now) => {
        const card = now.cards.find((each) => each.ticket === "probe")
        seen.push({
          stopping: now.title.stopping,
          probe: card === undefined ? null : `worker ${card.worker}`,
        })
      })
    const ran = await runs({
      seeds: [{ id: "t-1" }, { id: "t-2" }],
      concurrent: 1,
      scripts: (world, root, repo) => ({
        "t-1": [givesUp, finishesAfter(world, root, "t-1" as TicketId)],
        "t-2": [givesUp, finishesAfter(world, root, "t-2" as TicketId)],
        [probeWorker]: [
          turn([
            step(Deferred.await(probeGate)),
            ...bash(
              "echo ok > .tutti/run/probe",
              Effect.orDie(writeRunFile(repo, probeFile, "ok\n")),
            ),
          ]),
        ],
      }),
      during: (view) =>
        Effect.gen(function* () {
          yield* untilLogged(/^PROBE: /)
          yield* look(view)
          yield* advance("10 minutes")
          yield* untilLogged(/probe session started/)
          yield* look(view)
          yield* Deferred.succeed(probeGate, undefined)
          yield* untilLogged(/^PROBE_OK: /)
          yield* look(view)
        }),
    })
    expectExitCode(ran, 0)
    expect(seen).toEqual([
      { stopping: true, probe: null },
      { stopping: true, probe: "worker 0" },
      { stopping: false, probe: null },
    ])
  })
})
