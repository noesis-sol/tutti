import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { answeredText } from "../src/run/asked.ts"
import { askedWhy, carryOnText, questionKey } from "../src/run/carry.ts"
import type { EventRecord } from "../src/run/events.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readAgainAfter } from "../src/run/schedule.ts"
import { Beads, BeadsFailed } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store, type TicketRecord } from "../src/services/Store.ts"
import {
  bash,
  claimsAndCloses,
  failStart,
  filesQuestion,
  result,
  sleep,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

const defaults = appConfig().settings

/** A new folder, its real path: the main checkout's, or the worktrees'. */
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-carry-${name}-`)))

/** What the last run saved of a ticket, its worktree under `root`: suspended by a quit. */
const savedRecord = (
  root: string,
  id: string,
  fields: Partial<TicketRecord> = {},
): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  suspended: "quit",
  phase: "Stopped",
  resumes: 0,
  metadata: {},
  ...fields,
})

interface Plan {
  readonly backlog: ReadonlyArray<Seed>
  /** What the last run saved, by ticket, each worktree under `root`. */
  readonly saved: (root: string) => Readonly<Record<string, TicketRecord>>
  /** The tickets whose worktrees are there, in git, as the last run left them. */
  readonly worktrees?: ReadonlyArray<string>
  readonly scripts?: (world: World, root: string) => Scripts
  /** Readies the repository and Beads before the run starts, the worktrees made. */
  readonly before?: (repo: string, root: string) => Effect.Effect<void, unknown, Env>
  readonly around?: (run: Effect.Effect<Outcome, never, Env>) => Effect.Effect<Outcome, never, Env>
  readonly config?: Setup["config"]
}

/** A plain run, and state.json as it left it. */
interface Carried {
  readonly ran: Ran<Outcome>
  readonly state: State
  readonly root: string
}

/** A whole plain run on main, after an earlier run that left `plan.saved` in state.json. */
const runs = async (plan: Plan): Promise<Carried> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let state: State | undefined
  const ran = await scenario(
    {
      backlog: plan.backlog,
      config: { ...plan.config, repo },
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, tickets: plan.saved(root) },
      scripts: (world: World) => plan.scripts?.(world, root) ?? {},
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.worktrees ?? []) {
        mkdirSync(join(root, id), { recursive: true })
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      if (plan.before !== undefined) yield* plan.before(repo, root)
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

/** What a ticket's worker's commands do to the in-memory Beads and git. */
const commands = (world: World, root: string, id: string) => {
  const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))
  return {
    claim: orDie(world.beads.update(id, { claim: true })),
    commit: orDie(
      world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
    ),
    close: orDie(world.beads.close(id, "done")),
  }
}

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
    sent._tag === "Message" && sent.ticket === id ? [String(sent.message.message.content)] : [],
  )

const records = <K extends EventRecord["kind"]>(ran: Ran<unknown>, kind: K) =>
  ran.events.filter((record): record is Extract<EventRecord, { kind: K }> => record.kind === kind)

/** The phase records of the ticket's entry into the run: its cause, and the phase it entered. */
const entries = (ran: Ran<unknown>, id: string) =>
  records(ran, "phase").flatMap((record) =>
    record.ticket === id && record.from === undefined ? [`${record.cause} ${record.to}`] : [],
  )

/** The commit a branch's worktree makes, naming its ticket, as its worker left it. */
const committed = (root: string, id: string) =>
  Effect.flatMap(Repository, (repository) =>
    repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
  )

describe("carry-over: a suspended worker", () => {
  test("is resumed with its session, told to carry on, and its ticket merges", async () => {
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1", { status: "in_progress", title: "One" }).seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    // The saved session, resumed: no new one is drawn.
    expect(sessionsOf(ran, "t-1")).toEqual(["Resumed session-t-1"])
    expect(textsOf(ran, "t-1")).toEqual([carryOnText("t-1", "quit")])
    expect(entries(ran, "t-1")).toEqual(["Resumed Working"])
    expect(records(ran, "resumed")).toEqual([
      expect.objectContaining({ ticket: "t-1", session: "session-t-1", why: "suspended" }),
    ])
    expect(records(ran, "dispatch")).toEqual([])
    expectLog(ran, [
      /^ {2}RESUMED: t-1 was suspended as the last run ended \(quit\); resuming its session session-t-1 \(worktree .*t-1\)$/,
      /READY_EMPTY after 0 tickets/,
    ])
    expect(state.tickets["t-1"]?.suspended).toBeUndefined()
  })

  test("is told this run's facts: its ticket limit, counted afresh, and the scope", async () => {
    const { ran } = await runs({
      backlog: backlog().epic("e-1", []).ticket("t-1", { status: "in_progress", parent: "e-1" })
        .seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1", { suspended: "TICKET_LIMIT" }) }),
      worktrees: ["t-1"],
      config: {
        ticket: "e-1",
        settings: {
          ...defaults,
          workers: { ...defaults.workers, ticket_limit: Duration.hours(1) },
        },
      },
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
    })
    expectPhases(ran, { "t-1": "Done" })
    const [told] = textsOf(ran, "t-1")
    expect(told).toStartWith(carryOnText("t-1", "TICKET_LIMIT"))
    expect(told).toContain("You have about 1h for this ticket")
    expect(told).toContain("This run works on e-1 and its subtickets only.")
  })

  test("has its ticket limit counted afresh from its resume", async () => {
    let early = true
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
      config: {
        settings: {
          ...defaults,
          workers: { ...defaults.workers, ticket_limit: Duration.hours(1) },
        },
      },
      scripts: () => ({ "t-1": [turn([...bash("make"), sleep("3 hours")], result("done"))] }),
      around: (running) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(running)
          const minutes = (n: number) =>
            Effect.forEach(
              Array.from({ length: n }),
              () =>
                Effect.andThen(
                  advance("1 minute"),
                  Effect.promise(() => Bun.sleep(3)),
                ),
              { discard: true },
            )
          yield* minutes(59)
          early = (yield* texts).some((each) => each.includes("TICKET_LIMIT"))
          yield* minutes(5)
          return yield* Fiber.join(fiber)
        }),
    })
    expect(early).toBe(false)
    expectLog(ran, [/^HOLD: TICKET_LIMIT: t-1 still working after 1h/])
    expect(state.tickets["t-1"]).toEqual(
      expect.objectContaining({ suspended: "TICKET_LIMIT", phase: "Stopped", resumes: 1 }),
    )
    // An hour of minutes, each given the run a moment of real time: more than 5 s under load.
  }, 30_000)

  test("takes a slot without counting toward --limit", async () => {
    const { ran } = await runs({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).ticket("t-2").seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1", "t-2"],
      config: { limit: 1, settings: { ...defaults, concurrent: 1 } },
      scripts: (world, root) => ({
        "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))],
        "t-2": [claimsAndCloses("t-2", commands(world, root, "t-2"))],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    // --limit 1 still starts t-2: the resumed worker counted toward nothing.
    expect(records(ran, "dispatch")).toEqual([
      expect.objectContaining({ ticket: "t-2", n: 1, limit: 1 }),
    ])
    expect(sessionsOf(ran, "t-2")).toHaveLength(1)
    // One slot: t-2 waited for t-1's fiber to end, which put t-1 in line to merge.
    const kinds = ran.events.map((record) =>
      record.kind === "dispatch"
        ? `dispatch ${record.ticket}`
        : record.kind === "phase" && record.to === "ToMerge"
          ? `toMerge ${record.ticket}`
          : "",
    )
    expect(kinds.indexOf("toMerge t-1")).toBeLessThan(kinds.indexOf("dispatch t-2"))
    expectLog(ran, [/RESUMED: t-1/, /\[1\/1\] t-2 dispatching/, /LIMIT_REACHED at 1 tickets/])
  })

  test("whose session can't be resumed is dropped, WORKER_GONE, left for review", async () => {
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
      scripts: () => ({ "t-1": [[failStart("the transcript is gone")]] }),
    })
    expectPhases(ran, { "t-1": "Review" })
    expect(sessionsOf(ran, "t-1")).toEqual(["Resumed session-t-1"])
    expectLog(ran, [
      /^ {2}WORKER_GONE: t-1 is in progress, but its worker is gone and its session could not be resumed \(the transcript is gone\)/,
    ])
    expect(state.tickets["t-1"]).toBeUndefined()
  })
})

describe("carry-over: an asked ticket", () => {
  const question = backlog()
    .ticket("q-1", { labels: ["human"], title: "Which way?" })
    .ticket("t-1", { blockedBy: ["q-1"] })

  test("still waiting on its question comes back Asked, and is saved again", async () => {
    const { ran, state } = await runs({
      backlog: question.seeds,
      saved: (root) => ({
        "t-1": savedRecord(root, "t-1", {
          suspended: askedWhy,
          phase: "Asked",
          metadata: { [questionKey]: "q-1" },
        }),
      }),
      worktrees: ["t-1"],
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Asked" })
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expect(entries(ran, "t-1")).toEqual(["StillAsked Asked"])
    expectLog(ran, [
      "  t-1, carried over from the last run, still waits on your answer to q-1 (Which way?); answer with: bd human respond q-1",
    ])
    expect(state.tickets["t-1"]).toEqual(
      expect.objectContaining({
        suspended: askedWhy,
        phase: "Asked",
        metadata: { [questionKey]: "q-1" },
      }),
    )
  })

  test("answered between runs is resumed, told so, and finishes", async () => {
    const { ran } = await runs({
      backlog: backlog()
        .ticket("q-1", { labels: ["human"], title: "Which way?", status: "closed" })
        .ticket("t-1", { blockedBy: ["q-1"] }).seeds,
      saved: (root) => ({
        "t-1": savedRecord(root, "t-1", {
          suspended: askedWhy,
          phase: "Asked",
          metadata: { [questionKey]: "q-1" },
        }),
      }),
      worktrees: ["t-1"],
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(sessionsOf(ran, "t-1")).toEqual(["Resumed session-t-1"])
    expect(textsOf(ran, "t-1")).toEqual([answeredText("t-1", "q-1", "Which way?")])
    expect(entries(ran, "t-1")).toEqual(["StillAsked Asked"])
    expect(records(ran, "resumed")).toEqual([expect.objectContaining({ why: "answered" })])
  })

  test("a worker suspended with its ticket now waiting on a question comes back Asked", async () => {
    const { ran } = await runs({
      backlog: question.seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
    })
    expectPhases(ran, { "t-1": "Asked" })
    expect(sessionsOf(ran, "t-1")).toEqual([])
  })

  test("a run that ends with a ticket Asked saves it, with its question", async () => {
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1").seeds,
      saved: () => ({}),
      scripts: (world) => ({
        "t-1": [
          filesQuestion("t-1", {
            claim: Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
            file: Effect.asVoid(
              Effect.orDie(
                Effect.andThen(
                  world.beads.create({ title: "Which way?", labels: ["human"], blocks: ["t-1"] }),
                  world.beads.update("t-1", { status: "open" }),
                ),
              ),
            ),
          }),
        ],
      }),
    })
    expectPhases(ran, { "t-1": "Asked" })
    const phase = (ran.exit._tag === "Success" ? ran.exit.value : undefined)?.phases["t-1"]
    const asked = phase?._tag === "Asked" ? phase.question : ""
    expect(asked).not.toBe("")
    expect(state.tickets["t-1"]).toEqual(
      expect.objectContaining({
        suspended: askedWhy,
        phase: "Asked",
        metadata: { [questionKey]: asked },
      }),
    )
  })
})

describe("carry-over: the other cases", () => {
  test("a ticket closed between runs is merged: ToMerge, then Done", async () => {
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1", { status: "closed" }).seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
      before: (_, root) => committed(root, "t-1"),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expect(entries(ran, "t-1")).toEqual(["Unmerged ToMerge"])
    expectLog(ran, ["  t-1, carried over from the last run, is closed, so it waits to merge"])
    expect(state.tickets["t-1"]?.suspended).toBeUndefined()
  })

  test("a ticket closed and merged by hand between runs is dropped", async () => {
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1", { status: "closed" }).seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
      before: (repo, root) =>
        Effect.andThen(
          committed(root, "t-1"),
          Effect.flatMap(Git, (git) => git.fastForward(repo, "tutti/t-1")),
        ),
    })
    expectPhases(ran, {})
    expectLog(ran, [
      /^ {2}t-1, carried over from the last run, is dropped: tutti\/t-1 is on main already \([0-9a-f]{7} Change \(t-1\)\)$/,
    ])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("a ticket deferred meanwhile is shown as deferred, and not resumed", async () => {
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1", { status: "deferred" }).seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
    })
    expectPhases(ran, {})
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expectLog(ran, [
      /^ {2}t-1, carried over from the last run, is deferred since, so it isn't resumed; worktree .*t-1 left as it is$/,
    ])
    expect(records(ran, "info")).toContainEqual(
      expect.objectContaining({
        ticket: "t-1",
        text: expect.stringContaining("is deferred since"),
      }),
    )
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("a ticket deleted from Beads is dropped", async () => {
    const { ran, state } = await runs({
      backlog: [],
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
    })
    expectExitCode(ran, 0)
    expectPhases(ran, {})
    expectLog(ran, ["  t-1, carried over from the last run, is dropped: bd has no such ticket"])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("a ticket whose worktree is gone is dropped, its session not resumed", async () => {
    const { ran, state, root } = await runs({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      scripts: (world, root) => ({ "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }),
    })
    expectPhases(ran, {})
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expectLog(ran, [
      `  t-1, carried over from the last run, is dropped: its worktree ${join(root, "t-1")} is gone`,
    ])
    expect(state.tickets["t-1"]).toBeUndefined()
  })

  test("a ticket that can't be checked is kept for the next run", async () => {
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1"],
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
    expectPhases(ran, {})
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expectLog(ran, [
      "  t-1, carried over from the last run, is kept for the next run: bd can't show it: database is locked",
    ])
    expect(state.tickets["t-1"]).toEqual(expect.objectContaining({ suspended: "quit" }))
  })

  test("a ticket outside a scoped run is kept for a later run", async () => {
    const { ran, state } = await runs({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).ticket("t-2").seeds,
      saved: (root) => ({ "t-1": savedRecord(root, "t-1") }),
      worktrees: ["t-1", "t-2"],
      config: { ticket: "t-2" },
      scripts: (world, root) => ({ "t-2": [claimsAndCloses("t-2", commands(world, root, "t-2"))] }),
    })
    expectPhases(ran, { "t-2": "Done" })
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expectLog(ran, [
      "  t-1, carried over from the last run, is kept for a later run: it is outside this run's scope",
    ])
    expect(state.tickets["t-1"]).toEqual(expect.objectContaining({ suspended: "quit" }))
  })

  test("a ticket the last run didn't suspend isn't carried over", async () => {
    const { ran } = await runs({
      backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
      saved: (root) => {
        const { suspended: _, phase: __, ...record } = savedRecord(root, "t-1")
        return { "t-1": record }
      },
      worktrees: ["t-1"],
    })
    expectPhases(ran, {})
    expect(sessionsOf(ran, "t-1")).toEqual([])
    expect(ran.log.some((each) => each.includes("carried over"))).toBe(false)
  })
})
