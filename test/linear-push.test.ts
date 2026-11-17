// Pushing to Linear in a run (tutti-qatu.8): a linked ticket is pushed as its worker starts, as it
// closes and as it is deferred or set aside, read from the ledger's changes; a ticket filed in the
// run is pushed once and linked, but never a question, an epic or an ephemeral one, nor the
// backlog's history. Pushes run one at a time in the background, so a ticket's step never waits on
// one; a failed push is tried again at the end and then listed, LINEAR_PUSH_FAILED, and the end
// waits for the queue only so long. Without the settings' linear block no push runs.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Fiber, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import {
  filedIn,
  followChanges,
  type LinearPushes,
  make,
  pushesBetween,
} from "../src/run/linearPush.ts"
import { Move } from "../src/run/phase.ts"
import { run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import type { EventRecord } from "../src/services/events.ts"
import { Git } from "../src/services/Git.ts"
import { bash, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import {
  Backlog,
  layer as beadsLayer,
  type LinearSeed,
  linearUrl,
  type Seed,
} from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, expectExitCode, scenario, type World } from "./harness.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | Captured | RunFibers | Scope.Scope

/** Before the run began: the backlog's history. */
const before = "1969-12-31T00:00:00.000Z"

const layers = (seeds: ReadonlyArray<Seed>, issues: ReadonlyArray<LinearSeed>) =>
  Layer.mergeAll(beadsLayer(seeds, { linearTeam: { issues } }), ledgerLayer(), runFibersLayer).pipe(
    Layer.provideMerge(TestClock.layer()),
  )

const within = <A, E>(
  seeds: ReadonlyArray<Seed>,
  issues: ReadonlyArray<LinearSeed>,
  effect: Effect.Effect<A, E, Env>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers(seeds, issues))))

/** Lets forked fibers run, without moving the clock, until `done` or for long enough. */
const until = <R>(done: Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000 && !(yield* done); i++) yield* Effect.yieldNow
  })

/** Lets forked fibers run a while, without moving the clock. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 500; i++) yield* Effect.yieldNow
})

/** The pushes of a run that began at the clock's start. */
const pushes = make({ since: 0 })

/** Waits until `pushes` has nothing queued or under way. */
const idle = (p: LinearPushes) => until(Effect.map(p.busy, (busy) => !busy))

const stateOf = (key: string) =>
  Effect.map(
    Effect.flatMap(Backlog, (backlog) => backlog.linearIssues),
    (issues) => issues.find((issue) => issue.key === key)?.state,
  )

const lines = Effect.map(texts, (all) => all.filter((text) => /LINEAR/.test(text)))

const linearRecords = Effect.map(
  Effect.flatMap(Captured, (captured) => captured.records),
  (records) => records.filter((record) => record.kind === "linear"),
)

/** A ticket linked to the Linear issue NOE-1, from before the run, open in both. */
const linked: Seed = { id: "t-1", externalRef: linearUrl("NOE-1"), createdAt: before }
const team: ReadonlyArray<LinearSeed> = [{ key: "NOE-1", title: "t-1" }]

describe("which tickets a run pushes", () => {
  const issue = (fields: Partial<Issue>): Issue => ({
    id: "t-2" as TicketId,
    title: "a follow-up",
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
    createdAt: "2026-11-17T10:00:00Z",
    closeReason: "",
    ...fields,
  })
  const since = Date.parse("2026-11-17T10:00:00.700Z")

  test("a ticket filed since the second the run began, not a question, an epic or a wisp", () => {
    expect(filedIn(issue({}), since)).toBe(true)
    expect(filedIn(issue({ createdAt: "2026-11-17T09:59:59Z" }), since)).toBe(false)
    expect(filedIn(issue({ labels: ["human"] }), since)).toBe(false)
    expect(filedIn(issue({ type: "epic" }), since)).toBe(false)
    expect(filedIn(issue({ ephemeral: true }), since)).toBe(false)
    expect(filedIn(issue({ externalRef: linearUrl("NOE-3") }), since)).toBe(false)
    expect(filedIn(issue({ createdAt: "" }), since)).toBe(false)
  })

  test("the ledger's moves: a start from the queue, Done, Deferred and Review", async () => {
    const asked = await within(
      [],
      [],
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const id = (name: string) => name as TicketId
        const all: Array<{ ticket: string; why: string }> = []
        const step = (effect: Effect.Effect<unknown>) =>
          Effect.gen(function* () {
            const was = yield* ledger.current
            yield* effect
            all.push(...pushesBetween(was, yield* ledger.current))
          })
        yield* ledger.transition(id("a"), Move.Ready(), { title: "a" })
        yield* step(ledger.transition(id("a"), Move.Dispatched()))
        yield* step(ledger.transition(id("a"), Move.NoChange()))
        yield* ledger.transition(id("b"), Move.Ready(), { title: "b" })
        yield* step(ledger.transition(id("b"), Move.Dispatched()))
        yield* step(ledger.transition(id("b"), Move.Defer({ why: "by the worker" })))
        yield* ledger.transition(id("c"), Move.Ready(), { title: "c" })
        yield* step(ledger.transition(id("c"), Move.Dispatched()))
        yield* step(ledger.transition(id("c"), Move.Aside({ why: "CHECKS_FAILED" })))
        return all
      }),
    )
    expect(asked).toEqual([
      { ticket: "a", why: "started" },
      { ticket: "a", why: "closed" },
      { ticket: "b", why: "started" },
      { ticket: "b", why: "deferred" },
      { ticket: "c", why: "started" },
      { ticket: "c", why: "set aside" },
    ])
  })
})

describe("the run's pushes", () => {
  test("a linked ticket's status goes to its Linear issue as it changes", async () => {
    const seen = await within(
      [linked],
      team,
      Effect.gen(function* () {
        const p = yield* pushes
        const beads = yield* Beads
        yield* beads.update("t-1" as TicketId, { claim: true })
        yield* p.changed("t-1" as TicketId, "started")
        yield* idle(p)
        const started = yield* stateOf("NOE-1")
        yield* beads.close("t-1" as TicketId, "done")
        yield* p.changed("t-1" as TicketId, "closed")
        yield* idle(p)
        return { started, closed: yield* stateOf("NOE-1"), lines: yield* lines }
      }),
    )
    expect(seen.started).toBe("started")
    expect(seen.closed).toBe("completed")
    expect(seen.lines).toEqual([
      "  LINEAR: t-1 started, pushed to NOE-1 (updated)",
      "  LINEAR: t-1 closed, pushed to NOE-1 (updated)",
    ])
  })

  test("a start waits for the worker's claim, read again every 15 s", async () => {
    const seen = await within(
      [linked],
      team,
      Effect.gen(function* () {
        const p = yield* pushes
        yield* p.changed("t-1" as TicketId, "started")
        yield* settle
        const unclaimed = { state: yield* stateOf("NOE-1"), lines: yield* lines }
        yield* (yield* Beads).update("t-1" as TicketId, { claim: true })
        yield* settle
        const early = yield* stateOf("NOE-1")
        yield* TestClock.adjust(Duration.seconds(15))
        yield* settle
        yield* idle(p)
        return { unclaimed, early, claimed: yield* stateOf("NOE-1") }
      }),
    )
    expect(seen.unclaimed).toEqual({ state: "unstarted", lines: [] })
    expect(seen.early).toBe("unstarted")
    expect(seen.claimed).toBe("started")
  })

  test("a follow-up filed in the run is pushed once and linked; a question, an epic, a wisp and the history never are", async () => {
    const seen = await within(
      [
        linked,
        { id: "old", createdAt: before },
        { id: "q", labels: ["human"] },
        { id: "e", type: "epic" },
        { id: "w", ephemeral: true },
        { id: "f", title: "A follow-up" },
      ],
      team,
      Effect.gen(function* () {
        const p = yield* pushes
        yield* p.scan
        yield* idle(p)
        yield* p.scan
        yield* idle(p)
        // Neither the history nor a question is pushed as its status changes either.
        yield* p.changed("old" as TicketId, "closed")
        yield* p.changed("q" as TicketId, "closed")
        yield* idle(p)
        const backlog = yield* Backlog
        return {
          refs: Object.fromEntries(
            (yield* backlog.issues).map((issue) => [
              issue.id,
              (issue.linearKey as string | undefined) ?? null,
            ]),
          ),
          titles: (yield* backlog.linearIssues).map((issue) => issue.title),
          lines: yield* lines,
          records: yield* linearRecords,
        }
      }),
    )
    expect(seen.refs).toEqual({ "t-1": "NOE-1", old: null, q: null, e: null, w: null, f: "NOE-2" })
    expect(seen.titles).toEqual(["t-1", "A follow-up"])
    expect(seen.lines).toEqual(["  LINEAR: f filed, pushed to NOE-2 (created)"])
    expect(seen.records).toMatchObject([
      { kind: "linear", sync: "push", ticket: "f", issue: "NOE-2", outcome: "created" },
    ])
  })

  test("a failed push is said, tried again at the end, and listed if it still fails; the run goes on", async () => {
    const seen = await within(
      [linked, { id: "t-2", externalRef: linearUrl("NOE-2"), createdAt: before }],
      [...team, { key: "NOE-2" }],
      Effect.gen(function* () {
        const p = yield* pushes
        const backlog = yield* Backlog
        yield* backlog.fail("linear sync --push", { id: "t-1", stderr: "Error: Linear is down" })
        yield* backlog.fail("linear sync --push", {
          id: "t-2",
          stderr: "Error: Linear is down",
          times: 2,
        })
        yield* (yield* Beads).close("t-1" as TicketId, "done")
        yield* (yield* Beads).close("t-2" as TicketId, "done")
        yield* p.changed("t-1" as TicketId, "closed")
        yield* p.changed("t-2" as TicketId, "closed")
        yield* idle(p)
        const during = yield* lines
        yield* p.finish
        return {
          during,
          after: (yield* lines).slice(during.length),
          t1: yield* stateOf("NOE-1"),
          t2: yield* stateOf("NOE-2"),
          last: (yield* linearRecords).filter((record) => "last" in record),
        }
      }),
    )
    expect(seen.during).toEqual([
      "  LINEAR: t-1 closed, not pushed: Linear is down; tried again at the run's end",
      "  LINEAR: t-2 closed, not pushed: Linear is down; tried again at the run's end",
    ])
    expect(seen.after).toEqual([
      "  LINEAR: t-1 closed, pushed to NOE-1 (updated)",
      "  LINEAR_PUSH_FAILED: t-2: Linear is down",
    ])
    expect(seen.t1).toBe("completed")
    expect(seen.t2).toBe("unstarted")
    expect(seen.last).toMatchObject([
      { ticket: "t-2", outcome: "failed", why: "Linear is down", last: true },
    ])
  })

  test("a ticket's step doesn't wait on a push, and the end waits for one only its time", async () => {
    const seen = await within(
      [linked],
      team,
      Effect.gen(function* () {
        const beads = yield* Beads
        const ledger = yield* Ledger
        const hung = yield* Deferred.make<void>()
        // Linear doesn't answer: every push hangs.
        const p = yield* make({ since: 0 }).pipe(
          Effect.provideService(Beads, {
            ...beads,
            linearPush: (ids) => Effect.andThen(Deferred.await(hung), beads.linearPush(ids)),
          }),
        )
        yield* Effect.forkScoped(followChanges(ledger.changes, p))
        yield* settle
        yield* beads.update("t-1" as TicketId, { claim: true })
        yield* ledger.transition("t-1" as TicketId, Move.Ready(), { title: "t-1" })
        yield* ledger.transition("t-1" as TicketId, Move.Dispatched())
        yield* settle
        const pushing = yield* p.busy
        // The merge closes it and moves it to Done while its start's push hangs.
        yield* beads.close("t-1" as TicketId, "done")
        const moved = yield* ledger.transition("t-1" as TicketId, Move.NoChange())
        const phase = (yield* ledger.current).tickets.get("t-1" as TicketId)?.phase._tag
        const finishing = yield* Effect.forkChild(p.finish)
        yield* settle
        const waiting = finishing.pollUnsafe() === undefined
        yield* TestClock.adjust(Duration.minutes(1))
        yield* Fiber.join(finishing)
        return { pushing, moved: moved._tag, phase, waiting, lines: yield* lines }
      }),
    )
    expect(seen).toEqual({
      pushing: true,
      moved: "Success",
      phase: "Done",
      waiting: true,
      lines: ["  LINEAR_PUSH_FAILED: t-1: not pushed within the run end's 1m"],
    })
  })
})

// Whole runs.

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-linear-push-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

const block = { team: "NOE", pull_every: Duration.minutes(10) }

/**
 * A whole run of the linked ticket t-1, whose worker claims it, files a follow-up, a question and
 * an epic (each deferred, so the run doesn't take them up), commits and closes it; with the
 * settings' linear block where `linear` is true. `before` runs as the run starts.
 */
const wholeRun = (linear: boolean, before?: Effect.Effect<void, never, Backlog>) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const id = "t-1" as TicketId
  return scenario(
    {
      config: {
        repo,
        settings: appConfig().settings,
        ...(linear ? { linear: block } : {}),
      },
      backlog: [
        linked,
        // The backlog's history, deferred so the run doesn't take it up.
        { id: "old", status: "deferred", createdAt: "1969-12-31T00:00:00.000Z" },
      ],
      bd: { linearTeam: { issues: team } },
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => {
        const files = (title: string, fields: { labels?: ReadonlyArray<string>; type?: string }) =>
          orDie(
            Effect.flatMap(
              world.beads.create({ title, discoveredFrom: [id], ...fields }),
              (issue) => world.beads.defer(issue.id),
            ),
          )
        return {
          "t-1": [
            turn([
              ...bash("bd update t-1 --claim", orDie(world.beads.update(id, { claim: true }))),
              ...bash('bd create "A follow-up"', files("A follow-up", {})),
              ...bash('bd create "A question"', files("A question", { labels: ["human"] })),
              ...bash('bd create "An epic"', files("An epic", { type: "epic" })),
              ...bash(
                'git commit -am "Change (t-1)"',
                orDie(world.repository.commit(join(root, id), "Change (t-1)", { "t.txt": "x\n" })),
              ),
              ...bash("bd close t-1", orDie(world.beads.close(id, "done"))),
            ]),
          ],
        }
      },
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, join(root, id), { branch: "tutti/t-1", base: "main" })
      if (before !== undefined) yield* before
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main" }))
      for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 200; j++) yield* Effect.yieldNow
        yield* advance(readyPoll)
      }
      const outcome = yield* Fiber.join(fiber)
      return { ...outcome, linear: yield* (yield* Backlog).linearIssues }
    }),
  )
}

const keyed = (issues: ReadonlyArray<Issue>) =>
  Object.fromEntries(
    issues.map((issue) => [issue.title, (issue.linearKey as string | undefined) ?? null]),
  )

const linearLines = (log: ReadonlyArray<string>) => log.filter((text) => /LINEAR/.test(text))

const linearOf = (events: ReadonlyArray<EventRecord>) =>
  events.filter((record) => record.kind === "linear")

/** The log's push lines: those of linearLines but the pulls' (linearPull.ts). */
const pushLines = (log: ReadonlyArray<string>) =>
  linearLines(log).filter((text) => !/^LINEAR(: pulled |_PULL_FAILED: )/.test(text))

/** The event stream's push records. */
const pushesOf = (events: ReadonlyArray<EventRecord>) =>
  linearOf(events).filter((record) => record.kind === "linear" && record.sync === "push")

describe("pushing in a whole run", () => {
  test("with the linear block: the ticket's status and its worker's follow-up, not its question or epic", async () => {
    const ran = await wholeRun(true)
    expectExitCode(ran, 0)
    expect(ran.exit._tag === "Success" && ran.exit.value.phases["t-1"]?._tag).toBe("Done")
    const linear = ran.exit._tag === "Success" ? ran.exit.value.linear : []
    expect(linear.map(({ key, title, state }) => ({ key, title, state }))).toEqual([
      { key: "NOE-1", title: "t-1", state: "completed" },
      { key: "NOE-2", title: "A follow-up", state: "backlog" },
    ])
    expect(keyed(ran.issues)).toEqual({
      "t-1": "NOE-1",
      old: null,
      "A follow-up": "NOE-2",
      "A question": null,
      "An epic": null,
    })
    // The worker closed t-1 before its claim was read again: its start's push is its close's.
    expect([...pushLines(ran.log)].sort()).toEqual([
      "  LINEAR: t-1 closed, pushed to NOE-1 (updated)",
      expect.stringMatching(/^ {2}LINEAR: test-\d+ filed, pushed to NOE-2 \(created\)$/),
    ])
    expect(pushesOf(ran.events).map((record) => record.text)).toEqual([...pushLines(ran.log)])
  })

  test("a push that keeps failing is listed at the end, and the run's outcome is unchanged", async () => {
    const ran = await wholeRun(
      true,
      Effect.flatMap(Backlog, (backlog) =>
        backlog.fail("linear sync --push", { stderr: "Error: Linear is down", times: Infinity }),
      ),
    )
    expectExitCode(ran, 0)
    expect(ran.exit._tag === "Success" && ran.exit.value.phases["t-1"]?._tag).toBe("Done")
    expect(linearLines(ran.log).filter((text) => /LINEAR_PUSH_FAILED/.test(text))).toEqual([
      "  LINEAR_PUSH_FAILED: t-1: Linear is down",
      expect.stringMatching(/^ {2}LINEAR_PUSH_FAILED: test-\d+: Linear is down$/),
    ])
  })

  test("without the linear block no push runs, and nothing of Linear is said", async () => {
    const ran = await wholeRun(false)
    expectExitCode(ran, 0)
    const linear = ran.exit._tag === "Success" ? ran.exit.value.linear : []
    expect(linear.map(({ key, state }) => ({ key, state }))).toEqual([
      { key: "NOE-1", state: "unstarted" },
    ])
    expect(keyed(ran.issues)["A follow-up"]).toBeNull()
    expect(linearLines(ran.log)).toEqual([])
    expect(linearOf(ran.events)).toEqual([])
  })
})
