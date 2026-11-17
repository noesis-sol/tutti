// A run's pulls from Linear (§ 5 item 20, tutti-qatu.7): with the settings' linear block, one pull
// before the first fill and one every pull_every in a fiber of the run's, each listing the team's
// issues from Linear's API and pulling by key only an issue no ticket links and one whose deferred
// ticket was handed over; never a ticket the run's ledger has. A pull that fails warns once and the
// run goes on; without the block nothing of it runs.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Fiber, Layer, Result } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { line } from "../src/core/log.ts"
import {
  choose,
  type LinearPulls,
  listOverlap,
  make as makePulls,
  pulledLine,
  pullFailedLine,
} from "../src/run/linearPull.ts"
import { run } from "../src/run/run.ts"
import { sayer } from "../src/run/say.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  filterOf,
  LinearIssues,
  type ListedIssue,
  linearApi,
  liveLinearIssues,
  readPage,
} from "../src/services/LinearIssues.ts"
import { type LinearKey, linearKey } from "../src/services/linearSync.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import {
  Backlog,
  layer as backlogLayer,
  type LinearSeed,
  linearUrl,
  type Seed,
} from "../src/testing/Beads.ts"
import * as TestEvents from "../src/testing/EventStream.ts"
import { Listings, layer as linearIssuesLayer } from "../src/testing/LinearIssues.ts"
import * as TestLog from "../src/testing/Log.ts"
import { expectExitCode, expectLog, expectPhases, scenario, type World } from "./harness.ts"

const key = (text: string): LinearKey => {
  const found = linearKey(text)
  if (found === undefined) throw new Error(`${text} is no Linear key`)
  return found
}

const listed = (text: string, state: string): ListedIssue => ({ key: key(text), state })

/** A ticket linked to the Linear issue `linked`, with `status`. */
const ticket = (id: string, linked: string, status: Issue["status"]): Issue => ({
  id: id as TicketId,
  title: id,
  description: "",
  design: "",
  acceptance: "",
  notes: "",
  status,
  priority: 2,
  type: "task",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "",
  closeReason: "",
  externalRef: linearUrl(linked),
  linearKey: key(linked),
})

describe("what a pull takes", () => {
  test("an issue no ticket links, unless done; a deferred ticket's issue that left Backlog", () => {
    const chosen = choose(
      [
        listed("NOE-1", "unstarted"),
        listed("NOE-2", "backlog"),
        listed("NOE-3", "completed"),
        listed("NOE-4", "canceled"),
        listed("NOE-5", "unstarted"),
        listed("NOE-6", "completed"),
        listed("NOE-7", "backlog"),
        listed("NOE-1", "unstarted"),
      ],
      [ticket("t-5", "NOE-5", "deferred"), ticket("t-6", "NOE-6", "deferred")],
      new Set(),
    )
    expect(chosen).toEqual({
      added: [key("NOE-1"), key("NOE-2"), key("NOE-7")],
      released: [key("NOE-5")],
      updated: [key("NOE-6")],
    })
  })

  test("never a linked ticket that isn't deferred, nor one the run's ledger has", () => {
    const chosen = choose(
      [
        listed("NOE-1", "unstarted"),
        listed("NOE-2", "unstarted"),
        listed("NOE-3", "completed"),
        listed("NOE-4", "unstarted"),
        listed("NOE-5", "unstarted"),
      ],
      [
        ticket("t-1", "NOE-1", "in_progress"),
        ticket("t-2", "NOE-2", "deferred"),
        ticket("t-3", "NOE-3", "open"),
        ticket("t-4", "NOE-4", "closed"),
        // Two tickets on one issue: it is pulled only when both may change.
        ticket("t-5", "NOE-5", "deferred"),
        ticket("t-6", "NOE-5", "open"),
      ],
      new Set(["t-2"]),
    )
    expect(chosen).toEqual({ added: [], released: [], updated: [] })
  })

  test("says what it added, released and updated, and what bd couldn't pull", () => {
    expect<string>(
      pulledLine("NOE", true, {
        added: [key("NOE-5"), key("NOE-6")],
        released: [key("NOE-3")],
        updated: [],
        failed: [{ key: "NOE-9", why: "not found in Linear" }],
      }),
    ).toBe(
      "LINEAR: pulled from NOE at the start: added NOE-5, NOE-6; released NOE-3; could not pull NOE-9 (not found in Linear)",
    )
    expect<string>(
      pulledLine("NOE", false, { added: [], released: [], updated: [], failed: [] }),
    ).toBe("LINEAR: pulled from NOE: nothing new")
  })
})

describe("Linear's API's answers", () => {
  const page = (nodes: ReadonlyArray<unknown>, next: string | null = null) =>
    JSON.stringify({
      data: { issues: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
    })

  test("a page's issues by key and state, and the cursor of the next", () => {
    const read = readPage(
      200,
      page(
        [
          { identifier: "NOE-1", state: { type: "unstarted" } },
          { identifier: "not a key", state: { type: "backlog" } },
          { identifier: "NOE-2", state: null },
        ],
        "c1",
      ),
    )
    expect(read).toEqual(
      Result.succeed({
        issues: [
          { key: key("NOE-1"), state: "unstarted" },
          { key: key("NOE-2"), state: "" },
        ],
        next: "c1",
      }),
    )
  })

  test("Linear's error, an HTTP status, or a body that isn't a list, as why", () => {
    expect(
      readPage(400, JSON.stringify({ errors: [{ message: "Authentication required" }] })),
    ).toEqual(Result.fail("Linear's API said: Authentication required"))
    expect(readPage(503, "<html>down</html>")).toEqual(
      Result.fail("Linear's API answered HTTP 503"),
    )
    expect(readPage(200, "{}")).toEqual(Result.fail("Linear's API answered with no list of issues"))
  })

  test("any body reads as a page of keys or a reason on one line, never more", () => {
    const node = fc.record({
      identifier: fc.oneof(fc.string(), fc.constantFrom("NOE-1", "AB-22", "--help", "noe-1")),
      state: fc.oneof(fc.constant(null), fc.record({ type: fc.string() })),
    })
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.oneof(
          fc.string(),
          fc.array(node).map((nodes) => page(nodes)),
          fc.string().map((message) => JSON.stringify({ errors: [{ message }] })),
        ),
        (status, body) => {
          const read = readPage(status, body)
          if (Result.isSuccess(read)) {
            for (const issue of read.success.issues) expect(linearKey(issue.key)).toBe(issue.key)
          } else {
            expect(read.failure).not.toMatch(/[\n\r]/)
          }
        },
      ),
    )
  })

  test("the live source sends the key to Linear's API alone, a page at a time", async () => {
    const sent: Array<{ url: string; authorization: string | undefined; body: unknown }> = []
    const pages = [
      page([{ identifier: "NOE-1", state: { type: "unstarted" } }], "c1"),
      page([{ identifier: "NOE-2", state: { type: "backlog" } }]),
    ]
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.sync(() => {
          const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array()
          sent.push({
            url: url.href,
            authorization: request.headers.authorization,
            body: JSON.parse(new TextDecoder().decode(body)),
          })
          return HttpClientResponse.fromWeb(
            request,
            new Response(pages[sent.length - 1] ?? "{}", { status: 200 }),
          )
        }),
      ),
    )
    const source = liveLinearIssues({ LINEAR_API_KEY: "lin_api_test" }, http)
    const issues = await Effect.runPromise(source.list("NOE", 60_000))
    expect(issues).toEqual([
      { key: key("NOE-1"), state: "unstarted" },
      { key: key("NOE-2"), state: "backlog" },
    ])
    expect(sent.map((each) => [each.url, each.authorization])).toEqual([
      [linearApi, "lin_api_test"],
      [linearApi, "lin_api_test"],
    ])
    expect(sent.map((each) => (each.body as { variables: unknown }).variables)).toEqual([
      { filter: filterOf("NOE", 60_000), after: null },
      { filter: filterOf("NOE", 60_000), after: "c1" },
    ])
    expect(filterOf("NOE", 60_000)).toEqual({
      team: { key: { eq: "NOE" } },
      updatedAt: { gt: "1970-01-01T00:01:00.000Z" },
    })
    expect(filterOf("NOE", null)).toEqual({
      team: { key: { eq: "NOE" } },
      state: { type: { nin: ["completed", "canceled"] } },
    })
    // Without the key it asks nothing.
    const without = await Effect.runPromise(
      Effect.flip(liveLinearIssues({}, http).list("NOE", null)),
    )
    expect(without.reason).toBe("no LINEAR_API_KEY in the environment to list Linear's issues with")
    expect(sent).toHaveLength(2)
  })
})

describe("the pulls on their own", () => {
  const minute = Duration.minutes(1)

  interface Pulling {
    readonly pulls: LinearPulls
    readonly wakes: () => number
  }

  /**
   * The pulls of a run with a pull every `every`, over a backlog of `seeds` and a Linear team of
   * `issues`, the ledger holding `held`: `body` given them, then the log, the records, the backlog
   * and the listings asked for.
   */
  const pulling = <A>(
    setup: {
      readonly seeds?: ReadonlyArray<Seed>
      readonly issues?: ReadonlyArray<LinearSeed>
      readonly held?: ReadonlyArray<string>
      readonly every?: Duration.Duration
    },
    body: (pulling: Pulling) => Effect.Effect<A, unknown, Backlog | Listings | Beads>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        let wakes = 0
        const source = yield* LinearIssues
        if (source === null) return yield* Effect.die("no LinearIssues source")
        const pulls = yield* makePulls({
          linear: { team: "NOE", pull_every: setup.every ?? minute },
          source,
          beads: yield* Beads,
          held: Effect.succeed(new Set(setup.held ?? [])),
          sayer: yield* sayer,
          wakeUp: Effect.sync(() => void wakes++),
        })
        const value = yield* body({ pulls, wakes: () => wakes })
        return {
          value,
          log: yield* TestLog.texts,
          records: (yield* (yield* TestEvents.Captured).records).filter(
            (record) => record.kind === "linear",
          ),
          issues: yield* (yield* Backlog).issues,
          asked: yield* (yield* Listings).asked,
        }
      }).pipe(
        Effect.provide(
          linearIssuesLayer.pipe(
            Layer.provideMerge(
              backlogLayer(setup.seeds ?? [], { linearTeam: { issues: setup.issues ?? [] } }),
            ),
            Layer.provideMerge(
              Layer.mergeAll(TestLog.layer(), TestEvents.layer(), BunServices.layer),
            ),
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )

  /** Lets the forked pulls run. */
  const settle = Effect.promise(() => Bun.sleep(5))

  /** Forks the pulls every pull_every, moves TestClock on by `minutes` minutes, then stops them. */
  const every = (
    pulls: LinearPulls,
    minutes: number,
    between?: (at: number) => Effect.Effect<void, unknown, Backlog | Listings>,
  ) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(pulls.every)
      yield* settle
      for (let at = 1; at <= minutes; at++) {
        if (between !== undefined) yield* between(at)
        yield* TestClock.adjust(minute)
        yield* settle
      }
      yield* Fiber.interrupt(fiber)
    })

  const statusOf = (issues: ReadonlyArray<Issue>, id: string) =>
    issues.find((issue) => issue.id === id)?.status

  test("the start's pull adds the issues not done, Backlog's deferred, and wakes nothing", async () => {
    const ran = await pulling(
      {
        issues: [
          { key: "NOE-1", state: "unstarted", title: "Todo one" },
          { key: "NOE-2", state: "backlog" },
          { key: "NOE-3", state: "completed" },
        ],
      },
      ({ pulls, wakes }) => Effect.as(pulls.atStart, wakes()),
    )
    expect(ran.value).toBe(0)
    expect(ran.asked).toEqual([{ team: "NOE", since: null }])
    expect(ran.issues.map((issue) => [issue.title, issue.status, issue.linearKey])).toEqual([
      ["Todo one", "open", "NOE-1"],
      ["NOE-2", "deferred", "NOE-2"],
    ])
    expect(ran.log).toEqual(["LINEAR: pulled from NOE at the start: added NOE-1, NOE-2"])
    expect(ran.records).toMatchObject([
      { kind: "linear", sync: "pull", start: true, added: ["NOE-1", "NOE-2"] },
    ])
  })

  test("a pull during the run adds what was filed since and wakes a look; none when nothing", async () => {
    const ran = await pulling({}, ({ pulls, wakes }) =>
      Effect.gen(function* () {
        yield* pulls.atStart
        yield* every(pulls, 3, (at) =>
          at === 2
            ? Effect.flatMap(Backlog, (b) => b.putLinear({ key: "NOE-4", title: "Filed" }))
            : Effect.void,
        )
        return wakes()
      }),
    )
    expect(ran.value).toBe(1)
    expect(ran.issues.map((issue) => [issue.title, issue.status, issue.linearKey])).toEqual([
      ["Filed", "open", "NOE-4"],
    ])
    expect(ran.log).toEqual([
      "LINEAR: pulled from NOE at the start: nothing new",
      "LINEAR: pulled from NOE: nothing new",
      "LINEAR: pulled from NOE: added NOE-4",
      "LINEAR: pulled from NOE: nothing new",
    ])
    // Each lists the changes since the one before began, less the overlap.
    const overlap = Duration.toMillis(listOverlap)
    expect(ran.asked.map((each) => each.since)).toEqual([
      null,
      0 - overlap,
      60_000 - overlap,
      120_000 - overlap,
    ])
  })

  test("releases a deferred ticket whose issue moved to Todo, and wakes a look", async () => {
    const ran = await pulling(
      {
        seeds: [{ id: "t-1", status: "deferred", externalRef: linearUrl("NOE-1") }],
        issues: [{ key: "NOE-1", state: "backlog" }],
      },
      ({ pulls, wakes }) =>
        Effect.gen(function* () {
          yield* pulls.atStart
          yield* every(pulls, 1, () =>
            Effect.flatMap(Backlog, (b) => b.putLinear({ key: "NOE-1", state: "unstarted" })),
          )
          return wakes()
        }),
    )
    expect(ran.value).toBe(1)
    expect(statusOf(ran.issues, "t-1")).toBe("open")
    expect(ran.log.at(-1)).toBe("LINEAR: pulled from NOE: released NOE-1")
    expect(ran.records.at(-1)).toMatchObject({ released: ["NOE-1"] })
  })

  test("leaves a ticket the run holds exactly as it was, though its issue changed in Linear", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", title: "Worked", status: "in_progress", externalRef: linearUrl("NOE-1") },
      { id: "t-2", title: "Set aside", status: "deferred", externalRef: linearUrl("NOE-2") },
    ]
    const ran = await pulling(
      {
        seeds,
        held: ["t-1", "t-2"],
        issues: [
          { key: "NOE-1", state: "started", title: "Worked" },
          { key: "NOE-2", state: "backlog", title: "Set aside" },
        ],
      },
      ({ pulls }) =>
        Effect.gen(function* () {
          const before = yield* (yield* Backlog).issues
          yield* pulls.atStart
          yield* every(pulls, 1, () =>
            Effect.gen(function* () {
              const linear = yield* Backlog
              yield* linear.putLinear({ key: "NOE-1", state: "unstarted", title: "Renamed" })
              yield* linear.putLinear({ key: "NOE-2", state: "unstarted", title: "Renamed too" })
            }),
          )
          return before
        }),
    )
    expect(ran.issues).toEqual(ran.value)
    expect(ran.log.at(-1)).toBe("LINEAR: pulled from NOE: nothing new")
  })

  test("a listing that fails, and a pull that times out, each warn once and change nothing", async () => {
    const ran = await pulling({}, ({ pulls }) =>
      Effect.gen(function* () {
        const listings = yield* Listings
        const linear = yield* Backlog
        yield* listings.fail({ reason: "Internal server error" })
        yield* pulls.atStart
        yield* every(pulls, 3, (at) =>
          Effect.gen(function* () {
            if (at === 1) {
              yield* linear.putLinear({ key: "NOE-1" })
              yield* linear.fail("linear sync --pull", { timedOut: true })
            }
          }),
        )
      }),
    )
    expect(ran.log).toEqual([
      pullFailedLine("Linear's API said: Internal server error"),
      pullFailedLine("bd took longer than 1m"),
      "LINEAR: pulled from NOE: added NOE-1",
      "LINEAR: pulled from NOE: nothing new",
    ])
    expect(ran.records.slice(0, 2)).toMatchObject([
      { start: true, why: "Linear's API said: Internal server error" },
      { why: "bd took longer than 1m" },
    ])
    // A pull that failed moves the listing on from nothing: the next lists every issue not done.
    expect(ran.asked.map((each) => each.since)).toEqual([
      null,
      null,
      null,
      120_000 - Duration.toMillis(listOverlap),
    ])
    expect<ReadonlyArray<string | undefined>>(ran.issues.map((issue) => issue.linearKey)).toEqual([
      "NOE-1",
    ])
  })

  test("pull_every 0 pulls only at the start", async () => {
    const ran = await pulling({ every: Duration.zero }, ({ pulls }) =>
      Effect.gen(function* () {
        yield* pulls.atStart
        yield* every(pulls, 30)
      }),
    )
    expect(ran.asked).toHaveLength(1)
  })

  test("a pull is skipped while a pull or a push holds the sync", async () => {
    const ran = await pulling({}, ({ pulls }) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(pulls.every)
        yield* settle
        // A push holds it over the first pull's time; the second runs.
        yield* pulls.busy.withPermits(1)(Effect.andThen(TestClock.adjust(minute), settle))
        yield* TestClock.adjust(minute)
        yield* settle
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(ran.asked).toHaveLength(1)
    expect(ran.log).toEqual(["LINEAR: pulled from NOE: nothing new"])
  })
})

describe("a whole run", () => {
  const folder = (name: string) =>
    realpathSync(mkdtempSync(join(tmpdir(), `tutti-linear-pull-${name}-`)))

  /** A worker that takes `span`, commits and closes its ticket. */
  const works = (world: World, root: string, id: string, span: Duration.Input): SessionScript =>
    turn(
      [
        sleep(span),
        ...bash(
          `git commit -am "Change (${id})"`,
          Effect.asVoid(
            Effect.orDie(
              world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
            ),
          ),
        ),
        ...bash(
          `bd close ${id}`,
          Effect.asVoid(Effect.orDie(world.beads.close(id as TicketId, "done"))),
        ),
      ],
      result(`Closed ${id}.`),
    )

  /**
   * A whole run of `tickets`' worktrees, the clock moved on 10 s at a time for `minutes`, `during`
   * run at the start of each minute.
   */
  const runs = (setup: {
    readonly linear: { readonly pull_every: Duration.Duration } | null
    readonly seeds: ReadonlyArray<Seed>
    readonly issues: ReadonlyArray<LinearSeed>
    readonly tickets: ReadonlyArray<string>
    readonly scripts: (world: World, root: string) => Record<string, ReadonlyArray<SessionScript>>
    readonly minutes: number
    readonly during?: (minute: number) => Effect.Effect<void, unknown, Backlog>
  }) => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = TestAppConfig.appConfig().settings
    return scenario(
      {
        config: {
          repo,
          settings: { ...defaults, concurrent: 2 },
          linear: setup.linear === null ? null : { team: "NOE", ...setup.linear },
        },
        backlog: setup.seeds,
        bd: { linearTeam: { issues: setup.issues } },
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => setup.scripts(world, root),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of setup.tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        for (let step = 0; step < setup.minutes * 6; step++) {
          yield* Effect.promise(() => Bun.sleep(5))
          if (setup.during !== undefined && step % 6 === 0) yield* setup.during(step / 6)
          yield* TestClock.adjust("10 seconds")
        }
        const outcome = yield* Fiber.join(fiber)
        return { ...outcome, asked: yield* (yield* Listings).asked }
      }),
    )
  }

  test("the first fill follows the start's pull, and starts the ticket it added", async () => {
    const ran = await runs({
      linear: { pull_every: Duration.zero },
      seeds: [],
      issues: [{ key: "NOE-1", title: "From Linear" }],
      tickets: ["test-1"],
      scripts: (world, root) => ({ "test-1": [works(world, root, "test-1", "1 minute")] }),
      minutes: 30,
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "test-1": "Done" })
    expectLog(ran, [
      "START tutti 0.1.0-test",
      "LINEAR: pulled from NOE at the start: added NOE-1",
      "[1] test-1 dispatching: From Linear",
    ])
    expect<string | undefined>(ran.issues.find((issue) => issue.id === "test-1")?.linearKey).toBe(
      "NOE-1",
    )
    // pull_every 0: the start's pull alone.
    expect(ran.exit._tag === "Success" ? ran.exit.value.asked : []).toHaveLength(1)
  }, 30_000)

  test("a pull during the run adds a ticket, which starts before the ready poll, and leaves the held one as it was", async () => {
    const ran = await runs({
      // Off the ready poll's 30 s: a pull at 100 s.
      linear: { pull_every: Duration.seconds(50) },
      seeds: [{ id: "a", title: "Held", externalRef: linearUrl("NOE-1") }],
      issues: [{ key: "NOE-1", title: "Held" }],
      tickets: ["a", "test-2"],
      scripts: (world, root) => ({
        a: [works(world, root, "a", "5 minutes")],
        "test-2": [works(world, root, "test-2", "1 minute")],
      }),
      minutes: 30,
      during: (minute) =>
        minute === 1
          ? Effect.gen(function* () {
              const linear = yield* Backlog
              yield* linear.putLinear({
                key: "NOE-1",
                title: "Renamed in Linear",
                state: "unstarted",
              })
              yield* linear.putLinear({ key: "NOE-2", title: "Filed in Linear" })
            })
          : Effect.void,
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", "test-2": "Done" })
    expectLog(ran, [
      "LINEAR: pulled from NOE at the start: nothing new",
      "[1] a dispatching: Held",
      "LINEAR: pulled from NOE: added NOE-2",
      "[2] test-2 dispatching: Filed in Linear",
    ])
    // The look the pull woke started it at once, not the ready poll 30 s on.
    const dispatched = ran.events.find(
      (record) => record.kind === "dispatch" && record.ticket === "test-2",
    )
    expect(Date.parse(dispatched?.time ?? "")).toBe(100_000)
    expect(ran.issues.find((issue) => issue.id === "a")?.title).toBe("Held")
  }, 30_000)

  test("without the linear block no pull runs, and nothing of Linear is said", async () => {
    const ran = await runs({
      linear: null,
      seeds: [{ id: "a" }],
      issues: [{ key: "NOE-1" }],
      tickets: ["a"],
      scripts: (world, root) => ({ a: [works(world, root, "a", "1 minute")] }),
      minutes: 30,
    })
    expectExitCode(ran, 0)
    expect(ran.exit._tag === "Success" ? ran.exit.value.asked : [undefined]).toEqual([])
    // The log names its worktrees, whose folder has the test's name.
    expect(ran.log.filter((text) => /LINEAR|Linear/.test(text))).toEqual([])
    expect(ran.events.filter((record) => record.kind === "linear")).toEqual([])
    expect<ReadonlyArray<string>>(ran.issues.map((issue) => issue.id)).toEqual(["a"])
  }, 30_000)
})
