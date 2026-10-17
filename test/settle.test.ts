import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Fiber, type Scope } from "effect"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Attention } from "../src/agent/Attention.ts"
import type { EventRecord } from "../src/run/events.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Cause, type TicketPhase } from "../src/run/phase.ts"
import { answers, idleGrace, namesTicket, nudgeText, untilSettled } from "../src/run/settle.ts"
import type { StartTicket } from "../src/run/start.ts"
import { requeueWaiting, type Worked, work } from "../src/run/work.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  claimsAndCloses,
  defers,
  filesQuestion,
  gone,
  run,
  type SessionScript,
  turn,
} from "../src/testing/AgentHost.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectLog,
  type Ran,
  type Scripts,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1"
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

/** A folder for the worktrees, so a test knows where its ticket's is before it starts. */
const worktreesRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-settle-")))

/** A merge queue that only puts the ticket in line, ToMerge, and notes what it was offered. */
const lineOnly = (offered: Array<FinishedTicket>): Effect.Effect<MergeQueue, never, Ledger> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    return {
      offer: (finished, cause = (place) => Cause.Verified({ place })) => {
        offered.push(finished)
        return ledger.transition(finished.id, cause(offered.length))
      },
      state: Effect.succeed(emptyQueue),
      changes: undefined as never,
      settled: Effect.succeed(emptyQueue),
    } satisfies MergeQueue
  })

/** What a ticket's fiber gave, and what the queue was offered. */
interface Done {
  readonly worked: Worked
  readonly offered: ReadonlyArray<FinishedTicket>
}

/**
 * Dispatches the ticket and runs its fiber on main, its worktree in `root` on tutti/t-1 in the
 * in-memory git; `during` runs beside it (to move the clock, steer it, …) before it is joined.
 */
const working = (
  setup: Setup & { readonly root: string },
  during: (
    fiber: Fiber.Fiber<Worked, unknown>,
  ) => Effect.Effect<void, unknown, Env | Ledger> = () => Effect.void,
): Promise<Ran<Done>> =>
  scenario(
    { ...setup, worktrees: { root: setup.root } },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(setup.root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Cause.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Cause.Dispatched())
      const offered: Array<FinishedTicket> = []
      const queue = yield* lineOnly(offered)
      const fiber = yield* Effect.forkChild(work(ticket, { base: "main", queue }))
      yield* during(fiber)
      const worked = yield* Fiber.join(fiber)
      return { worked, offered } satisfies Done
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Done, unknown, Env | Scope.Scope>,
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phaseOf = (ran: Ran<Done>): TicketPhase | undefined => resultOf(ran).worked.phase

const records = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

/** The phase records' moves, as `from → to`. */
const moves = (ran: Ran<unknown>) =>
  records(ran, "phase").map((record) =>
    record.kind === "phase" ? `${record.from ?? "outside"} → ${record.to}` : "",
  )

/** The messages the ticket's worker was sent, as text. */
const sentTexts = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id ? [String(sent.message.message.content)] : [],
  )

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What the worker's commands do to the in-memory Beads and git, its worktree in `root`. */
const commands = (world: World, root: string) => {
  const path = join(root, id)
  return {
    claim: orDie(world.beads.update(id, { claim: true })),
    commit: (
      message: string,
      files: Readonly<Record<string, string | null>> = { "a.txt": "a\n" },
    ) => orDie(world.repository.commit(path, message, files)),
    write: (files: Readonly<Record<string, string>>) => orDie(world.repository.write(path, files)),
    close: orDie(world.beads.close(id, "done")),
    defer: orDie(world.beads.defer(id)),
    status: (status: string) => orDie(world.beads.update(id, { status })),
  }
}

/** Scripts for the one ticket, made from the world and the worktrees' folder. */
const scripts =
  (root: string, sessions: (c: ReturnType<typeof commands>, world: World) => SessionScript) =>
  (world: World): Scripts => ({ [id]: [sessions(commands(world, root), world)] })

/** Waits, yielding, until the log has a line matching `pattern`, then a little more. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 20_000; i++) {
      if ((yield* texts).some((each) => pattern.test(each))) break
      yield* Effect.yieldNow
    }
    for (let i = 0; i < 200; i++) yield* Effect.yieldNow
  })

/** Lets every fiber run as far as it can without the clock moving. */
const quiet = Effect.gen(function* () {
  for (let i = 0; i < 2_000; i++) yield* Effect.yieldNow
})

const tiny = backlog().ticket(id, { title: "One ticket" })

describe("the outcome of a settled worker", () => {
  test("closed, a commit naming it, clean and on its branch: ToMerge, in the merge queue", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) =>
        claimsAndCloses(id, { claim: c.claim, commit: c.commit(`Change (${id})`), close: c.close }),
      ),
    })
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "ToMerge", place: 1 }))
    expect(resultOf(ran).offered).toEqual([
      { id, title: "One ticket", branch: `tutti/${id}`, worktree: join(root, id) },
    ])
    expect(moves(ran)).toEqual(["outside → Queued", "Queued → Working", "Working → ToMerge"])
    expectLog(ran, [`  ${id} settled: its worker is idle`])
    expect(sentTexts(ran)).toHaveLength(1)
    // Its session stays open while it waits to merge.
    expect(ran.sent.some((sent) => sent._tag === "Closed")).toBe(false)
  })

  test("closed with no commits of its own and a clean worktree: Done, no change", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) => turn([...bash(`bd close ${id}`, c.close)])),
    })
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({
        _tag: "Done",
        outcome: expect.objectContaining({ _tag: "NoChange" }),
      }),
    )
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id, force: false })
    const closed = records(ran, "closed")
    expect(closed).toEqual([expect.objectContaining({ detail: "no change to merge" })])
    expectLog(ran, [
      `  ${id} closed with no change: tutti/${id} has no commits beyond main and its worktree is clean, so there is nothing to merge; worktree and branch removed`,
    ])
    expect(ran.sent.at(-1)).toEqual(expect.objectContaining({ _tag: "Closed", ticket: id }))
  })

  test("closed with commits that together change nothing: Done, no change", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) =>
        turn([
          run(c.commit(`Add it (${id})`, { "a.txt": "a\n" })),
          run(c.commit(`Revert it (${id})`, { "a.txt": null })),
          run(c.close),
        ]),
      ),
    })
    expect(phaseOf(ran)?._tag).toBe("Done")
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id, force: true })
    expectLog(ran, [/the commits on tutti\/t-1, taken together, change nothing/])
  })

  test("closed without a commit naming it while it has changes: Review", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) => turn([run(c.commit("Change something (t-10)")), run(c.close)])),
    })
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CLOSED_WITHOUT_COMMIT" }),
    )
    expect(records(ran, "warn")).toEqual([
      expect.objectContaining({ ticket: id, aside: true, detail: "closed without a commit" }),
    ])
    expectLog(ran, [
      `  CLOSED_WITHOUT_COMMIT: no commit on tutti/${id} names ${id}; worktree ${join(root, id)} left for review`,
    ])
  })

  test("closed with only uncommitted changes: Review, without a commit", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) => turn([run(c.write({ "a.txt": "a\n" })), run(c.close)])),
    })
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CLOSED_WITHOUT_COMMIT" }),
    )
  })

  test("closed with a commit naming it and uncommitted changes: Review", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) =>
        turn([run(c.commit(`Change (${id})`)), run(c.write({ "b.txt": "b\n" })), run(c.close)]),
      ),
    })
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CLOSED_UNCOMMITTED" }),
    )
    expectLog(ran, [/CLOSED_UNCOMMITTED: t-1 closed \(\w{7} Change \(t-1\)\) but .* b\.txt/])
  })

  test("closed off its branch: Review, OFF_BRANCH", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c, world) =>
        turn([
          run(c.commit(`Change (${id})`)),
          run(
            Effect.flatMap(world.repository.head("HEAD", join(root, id)), (head) =>
              world.repository.checkout(join(root, id), head),
            ),
          ),
          run(c.close),
        ]),
      ),
    })
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Review", why: "OFF_BRANCH" }))
    expectLog(ran, [
      /OFF_BRANCH: t-1 closed, but its worktree .* has a detached HEAD, not tutti\/t-1/,
    ])
  })

  test("a question it filed that blocks it: Asked", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c, world) =>
        filesQuestion(id, {
          claim: c.claim,
          file: orDie(
            Effect.andThen(
              world.beads.create({ title: "Which way?", labels: ["human"], blocks: [id] }),
              world.beads.update(id, { status: "open" }),
            ),
          ),
        }),
      ),
    })
    const phase = phaseOf(ran)
    expect(phase?._tag).toBe("Asked")
    const question = phase?._tag === "Asked" ? phase.question : ""
    expect(records(ran, "asked")).toEqual([
      expect.objectContaining({ ticket: id, detail: `${question}: Which way?` }),
    ])
    expectLog(ran, [
      new RegExp(`ASKED: t-1 waits on your answer to ${question} \\(Which way\\?\\)`),
    ])
  })

  test("deferred by its worker: Deferred", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) => defers(id, { claim: c.claim, defer: c.defer })),
    })
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({ _tag: "Deferred", why: "by the worker" }),
    )
    expect(records(ran, "deferred")).toEqual([
      expect.objectContaining({ ticket: id, detail: "by the worker" }),
    ])
  })

  test("left open with nothing to wait for: deferred for review by tutti", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) => turn([run(c.claim), run(c.status("open"))])),
    })
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({ _tag: "Deferred", why: "still open, noted for review" }),
    )
    expect(ran.issues.find((issue) => issue.id === id)?.status).toBe("deferred")
  })

  test("stopped with nothing done, having linked a blocker not merged: Waiting, then Queued", async () => {
    const root = worktreesRoot()
    const ran = await working(
      {
        root,
        backlog: backlog().ticket("t-0").ticket(id, { title: "One ticket" }).seeds,
        scripts: scripts(root, (c, world) =>
          turn([run(c.claim), run(orDie(world.beads.addDependency(id, "t-0")))]),
        ),
      },
      (fiber) =>
        Effect.gen(function* () {
          yield* Fiber.join(fiber)
          // t-0 isn't merged: the ticket waits.
          expect(yield* requeueWaiting).toEqual([])
          yield* (yield* Beads).close("t-0", "done")
          expect(yield* requeueWaiting).toEqual([id])
          expect((yield* (yield* Ledger).current).tickets.get(id)?.phase._tag).toBe("Queued")
        }),
    )
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Waiting", for: "t-0" }))
    expect(moves(ran).slice(2)).toEqual(["Working → Waiting", "Waiting → Queued"])
    expect(ran.issues.find((issue) => issue.id === id)?.status).toBe("open")
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id, force: false })
    expect(records(ran, "waits")).toEqual([expect.objectContaining({ ticket: id, detail: "t-0" })])
    expectLog(ran, [
      "  WAITS_FOR_MERGE: t-1 waits for t-0 to merge; its worker stopped with nothing done, so it is back in the queue until it does; worktree and branch removed",
    ])
  })

  test("a blocker closed but not merged in this run still holds it", async () => {
    const root = worktreesRoot()
    const ran = await working(
      {
        root,
        backlog: backlog().ticket("t-0").ticket(id, { title: "One ticket" }).seeds,
        scripts: scripts(root, (c, world) =>
          turn([run(c.claim), run(orDie(world.beads.addDependency(id, "t-0")))]),
        ),
      },
      (fiber) =>
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* (yield* Beads).close("t-0", "done")
          yield* ledger.transition("t-0", Cause.Ready(), { title: "t-0" })
          yield* ledger.transition("t-0", Cause.Dispatched())
          yield* ledger.transition("t-0", Cause.Verified({ place: 1 }))
          yield* Fiber.join(fiber)
          expect(yield* requeueWaiting).toEqual([])
        }),
    )
    expect(phaseOf(ran)?._tag).toBe("Waiting")
  })

  test("with work of its own, a linked blocker doesn't make it wait", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: backlog().ticket("t-0").ticket(id, { title: "One ticket" }).seeds,
      scripts: scripts(root, (c, world) =>
        turn([
          run(c.claim),
          run(c.commit(`Half of it (${id})`)),
          run(orDie(world.beads.addDependency(id, "t-0"))),
          run(c.status("open")),
        ]),
      ),
    })
    expect(phaseOf(ran)?._tag).toBe("Deferred")
  })
})

describe("the continue nudge and PAUSED", () => {
  test("two nudges, then PAUSED once the worker has been idle for the 10-minute grace", async () => {
    const root = worktreesRoot()
    const ran = await working(
      {
        root,
        backlog: tiny.seeds,
        scripts: scripts(root, (c) => [...turn([run(c.claim)]), ...turn([]), ...turn([])]),
      },
      (fiber) =>
        Effect.gen(function* () {
          yield* untilLogged(/told it to continue \(2 of 2\)/)
          yield* quiet
          yield* advance(Duration.subtract(idleGrace, Duration.seconds(1)))
          yield* quiet
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* advance(Duration.seconds(1))
        }),
    )
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }))
    const { stop } = resultOf(ran).worked
    expect(stop).toEqual(expect.objectContaining({ why: "PAUSED", code: 3, ticket: id }))
    const texts = sentTexts(ran)
    expect(texts).toHaveLength(3)
    expect(texts.slice(1)).toEqual([nudgeText(id), nudgeText(id)])
    const messages = ran.sent.flatMap((sent) => (sent._tag === "Message" ? [sent.message] : []))
    expect(messages.every((message) => message.client_composed === true)).toBe(true)
    expectLog(ran, [
      "  t-1's worker ended its turn with the ticket still in progress; told it to continue (1 of 2)",
      "  t-1's worker ended its turn with the ticket still in progress; told it to continue (2 of 2)",
      `HOLD: PAUSED: t-1 still in_progress, its worker idle for 10m (worktree ${join(root, id)}); stopping so it can be answered`,
    ])
    expectEvents(ran, ["phase", "hold", "stop"])
    expect(records(ran, "stop")).toEqual([
      expect.objectContaining({ detail: "PAUSED", ticket: id }),
    ])
    expect(ran.issues.find((issue) => issue.id === id)?.notes).toContain("still in_progress")
  })

  test("a nudge the worker takes up: it closes its ticket, which goes to merge", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) => [
        ...turn([run(c.claim)]),
        ...turn([run(c.commit(`Change (${id})`)), run(c.close)]),
      ]),
    })
    expect(phaseOf(ran)?._tag).toBe("ToMerge")
    expect(sentTexts(ran)).toEqual([expect.any(String), nudgeText(id)])
  })

  test("a steered worker gets no nudges, and its grace counts from your last message", async () => {
    const root = worktreesRoot()
    const ran = await working(
      {
        root,
        backlog: tiny.seeds,
        scripts: scripts(root, (c) => [...turn([run(c.claim)])]),
      },
      (fiber) =>
        Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.steer(id, "interrupt")
          yield* quiet
          yield* advance(Duration.minutes(5))
          yield* ledger.steer(id, "message")
          yield* advance(Duration.minutes(5))
          yield* quiet
          // 10 minutes idle, but only 5 since your message.
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* advance(Duration.minutes(5))
        }),
    )
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }))
    expect(sentTexts(ran)).toHaveLength(1)
  })

  test("a worker gone with its ticket in progress can't be nudged: PAUSED at once", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: scripts(root, (c) => [...turn([run(c.claim)]).slice(0, -2), gone("exit 1")]),
    })
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }))
    expect(sentTexts(ran)).toHaveLength(1)
    expectLog(ran, [/HOLD: PAUSED: t-1 still in_progress, its worker is gone \(exit 1\)/])
  })

  test("a worker that needs you has not settled: its ticket isn't read until you answer", async () => {
    const root = worktreesRoot()
    const ran = await working(
      {
        root,
        policy: waitForTest,
        backlog: tiny.seeds,
        scripts: scripts(root, (c) =>
          turn([run(c.claim), canUseTool("Bash", { command: "rm -rf build" }), run(c.close)]),
        ),
      },
      (fiber) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          const attention = yield* Attention
          yield* quiet
          yield* advance(Duration.hours(1))
          yield* quiet
          expect((yield* host.current(id))._tag).toBe("NeedsYou")
          expect(fiber.pollUnsafe()).toBeUndefined()
          expect((yield* texts).some((line) => line.includes("settled"))).toBe(false)
          const [request] = yield* attention.current
          yield* attention.answer(request?.id ?? "", { _tag: "Allow" }, "screen")
        }),
    )
    expect(phaseOf(ran)?._tag).toBe("Done")
    expect(sentTexts(ran)).toHaveLength(1)
  })
})

describe("untilSettled", () => {
  test("a worker the host doesn't know has gone", async () => {
    const ran = await scenario({}, untilSettled("nobody"))
    expect(resultOf(ran)._tag).toBe("Gone")
  })
})

describe("answers", () => {
  const uuid = "00000000-0000-4000-8000-000000000002"
  const result = (fields: object) => ({ type: "result", subtype: "success", ...fields }) as never

  test("a result listing the send, or listing no sends at all, answers it", () => {
    expect(answers(result({ user_message_uuids: [uuid] }), uuid)).toBe(true)
    expect(answers(result({}), uuid)).toBe(true)
    expect(answers(result({ user_message_uuids: ["other"] }), uuid)).toBe(false)
  })

  test("its command_lifecycle completed answers it; queued or started doesn't", () => {
    const lifecycle = (state: string, command = uuid) =>
      ({ type: "command_lifecycle", command_uuid: command, state }) as never
    expect(answers(lifecycle("completed"), uuid)).toBe(true)
    expect(answers(lifecycle("queued"), uuid)).toBe(false)
    expect(answers(lifecycle("started"), uuid)).toBe(false)
    expect(answers(lifecycle("completed", "other"), uuid)).toBe(false)
  })
})

describe("namesTicket", () => {
  test("names the ticket as a whole ID only", () => {
    expect(namesTicket("Change it (t-1)", "t-1")).toBe(true)
    expect(namesTicket("t-1: change it", "t-1")).toBe(true)
    expect(namesTicket("Fix t-1.", "t-1")).toBe(true)
    expect(namesTicket("Fix t-1-x and t-10", "t-1")).toBe(false)
    expect(namesTicket("Fix t-1.2", "t-1")).toBe(false)
    expect(namesTicket("Fix xt-1", "t-1")).toBe(false)
    expect(namesTicket("Fix a.t-1", "t-1")).toBe(false)
    expect(namesTicket("Fix t-10, then t-1", "t-1")).toBe(true)
    expect(namesTicket("anything", "")).toBe(false)
  })

  test("finds the ID wherever a worker puts it, between any words", () => {
    const words = fc.string({ unit: fc.constantFrom(" ", "\n", "(", ")", ":", "a", "-", ".", "1") })
    fc.assert(
      fc.property(words, words, (before, after) => {
        const message = `${before} t-1 ${after}`
        expect(namesTicket(message, "t-1")).toBe(true)
      }),
    )
  })

  test("never names an ID inside a longer one", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("a", "Z", "0", "_") }), (tail) => {
        fc.pre(tail !== "")
        expect(namesTicket(`x t-1${tail} y`, "t-1")).toBe(false)
        expect(namesTicket(`x ${tail}t-1 y`, "t-1")).toBe(false)
        expect(namesTicket(`x t-1.${tail} y`, "t-1")).toBe(false)
      }),
    )
  })

  test("reads any text without failing", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary" }),
        fc.string({ minLength: 1 }),
        (message, ticketId) => {
          expect(typeof namesTicket(message, ticketId)).toBe("boolean")
        },
      ),
    )
  })
})
