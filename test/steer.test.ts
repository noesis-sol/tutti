// Steering (§ 4.3, § 7.5, § 10), with the harness under TestClock: a message you send steers the
// worker and reaches it as you typed it, recorded by its length only; a steered worker gets no
// continue nudges, and its idle grace counts from your last message; Release gives it back to the
// run; an interrupt steers it too, stops its turn and cancels the messages still queued; and
// HandBackNow hands a steered worker the conflict that waited for it. The screen's commands reach
// steer.ts through the run's one consumer.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Fiber, Queue, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Attention } from "../src/agent/Attention.ts"
import { UiCommand } from "../src/run/commands.ts"
import type { EventRecord } from "../src/run/events.ts"
import { makeHandBacks, type RebaseStop } from "../src/run/handback.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { emptyQueue, type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag, type TicketPhase } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { idleGrace, nudgeText, untilSettled } from "../src/run/settle.ts"
import type { StartTicket } from "../src/run/start.ts"
import { handBackNow, interrupt, lengthOf, release, sendMessage } from "../src/run/steer.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  awaitInterrupt,
  canUseTool,
  coalescedTurn,
  init,
  interruptedResult,
  Recording,
  result,
  run,
  type SessionScript,
  sessionState,
  sleep,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  type Ran,
  type Scripts,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1"
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }
const tiny = backlog().ticket(id, { title: "One ticket" })

/** What you type: its emoji is one character, as the MESSAGE line counts them. */
const secret = "Look at the flaky test in undo.ts first 🙂"
const yours = "11111111-2222-4333-8444-555555555555"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-steer-${name}-`)))

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  let places = 0
  return {
    offer: (finished, cause = (place) => Cause.Verified({ place })) =>
      ledger.transition(finished.id, cause(++places)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    recheck: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/** What the ticket's fiber gave, and the ledger then. */
interface Done {
  readonly worked: Worked
  readonly ledger: State
}

/**
 * Dispatches the ticket and runs its fiber on main, its worktree in `root`; `during` runs beside it
 * (steering it, moving the clock) before it is joined.
 */
const working = (
  setup: Setup & { readonly root: string },
  during: (fiber: Fiber.Fiber<Worked, unknown>) => Effect.Effect<void, unknown, Env | Ledger>,
): Promise<Ran<Done>> =>
  scenario(
    { backlog: tiny.seeds, ...setup, worktrees: { root: setup.root } },
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
      const queue = yield* lineOnly
      const fiber = yield* Effect.forkChild(work(ticket, { base: "main", queue }))
      yield* during(fiber)
      const worked = yield* Fiber.join(fiber)
      return { worked, ledger: yield* ledger.current } satisfies Done
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Done, unknown, Env | Scope.Scope>,
  )

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What the worker's commands do to the in-memory Beads and git, its worktree in `root`. */
const commands = (world: World, root: string) => ({
  claim: orDie(world.beads.update(id, { claim: true })),
  commit: orDie(world.repository.commit(join(root, id), `Change (${id})`, { "a.txt": "a\n" })),
  close: orDie(world.beads.close(id, "done")),
})

/** The ticket's one session, made from the world and the worktrees' folder. */
const scripts =
  (root: string, session: (c: ReturnType<typeof commands>) => SessionScript) =>
  (world: World): Scripts => ({ [id]: [session(commands(world, root))] })

/** Lets every fiber run as far as it can without the clock moving. */
const quiet = Effect.gen(function* () {
  for (let i = 0; i < 2_000; i++) yield* Effect.yieldNow
})

/** Waits, yielding, until the ticket's worker has been sent `n` messages. */
const untilSent = (n: number) =>
  Effect.gen(function* () {
    const recording = yield* Recording
    for (let i = 0; i < 20_000; i++) {
      if ((yield* recording.messages(id)).length >= n) break
      yield* Effect.yieldNow
    }
    yield* quiet
  })

/** The messages the ticket's worker was sent. */
const messagesOf = (ran: Ran<unknown>, to = id) =>
  ran.sent.flatMap((sent) => (sent._tag === "Message" && sent.ticket === to ? [sent.message] : []))

const textsOf = (ran: Ran<unknown>) =>
  messagesOf(ran).map((message) => String(message.message.content))

const recordsOf = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

const steeredNow = Effect.map(
  Effect.flatMap(Ledger, (ledger) => ledger.current),
  (state) => state.tickets.get(id)?.steered,
)

const phaseOf = (ran: Ran<Done>): TicketPhase | undefined => resultOf(ran).worked.phase

/** Neither the log nor the event stream has the message's text anywhere. */
const expectNoText = (ran: Ran<unknown>, text: string) => {
  expect(ran.log.some((each) => each.includes(text))).toBe(false)
  expect(JSON.stringify(ran.events)).not.toContain(text)
}

describe("a message you send", () => {
  test("steers the worker and is delivered as you typed it, recorded by its length only", async () => {
    const root = folder("message")
    const ran = await working(
      {
        root,
        scripts: scripts(root, (c) => [
          ...turn([run(c.claim), sleep("1 minute")]),
          ...turn([run(c.commit), run(c.close)]),
        ]),
      },
      () =>
        Effect.gen(function* () {
          yield* untilSent(1)
          expect(yield* sendMessage(id, secret, yours)).toBe(true)
          const entry = (yield* (yield* Ledger).current).tickets.get(id)
          expect(entry?.steered).toBe(true)
          expect(entry?.lastMessage).toBe(0)
          yield* advance("1 minute")
        }),
    )
    expect(phaseOf(ran)?._tag).toBe("ToMerge")
    const [first, mine, ...more] = messagesOf(ran)
    expect(first?.client_composed).toBe(true)
    // Yours: not client_composed, origin human, under the composer's uuid, word for word.
    expect(mine).toMatchObject({ uuid: yours, origin: { kind: "human" } })
    expect(mine?.client_composed).toBeUndefined()
    expect(mine?.message.content).toBe(secret)
    // Steered, it got no nudge.
    expect(more).toEqual([])
    const length = lengthOf(secret)
    expect(length).toBe(secret.length - 1)
    expectLog(ran, ["  STEERED: t-1", `  MESSAGE: you → t-1 (${length} characters)`])
    expect(recordsOf(ran, "steered")).toEqual([
      expect.objectContaining({ ticket: id, text: "  STEERED: t-1" }),
    ])
    expect(recordsOf(ran, "message")).toEqual([expect.objectContaining({ ticket: id, length })])
    expectNoText(ran, secret)
    expect(resultOf(ran).ledger.tickets.get(id)?.tallies.messages).toBe(1)
  })

  test("a second message steers no further: one STEERED line, two tallied", async () => {
    const root = folder("twice")
    const ran = await working(
      {
        root,
        scripts: scripts(root, (c) => [
          ...turn([run(c.claim), sleep("1 minute")]),
          ...coalescedTurn([run(c.commit), run(c.close)]),
        ]),
      },
      () =>
        Effect.gen(function* () {
          yield* untilSent(1)
          yield* sendMessage(id, "one", "00000000-0000-4000-8000-0000000000a1")
          yield* sendMessage(id, "two!", "00000000-0000-4000-8000-0000000000a2")
          yield* advance("1 minute")
        }),
    )
    expect(ran.log.filter((each) => each === "  STEERED: t-1")).toHaveLength(1)
    expectLog(ran, ["  MESSAGE: you → t-1 (3 characters)", "  MESSAGE: you → t-1 (4 characters)"])
    expect(resultOf(ran).ledger.tickets.get(id)?.tallies.messages).toBe(2)
  })

  test("to a worker with no session: not sent, nothing recorded, still steered", async () => {
    const ran = await scenario(
      { backlog: tiny.seeds },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition(id, Cause.Ready(), { title: ticket.title })
        yield* ledger.transition(id, Cause.Dispatched())
        expect(yield* sendMessage(id, secret, yours)).toBe(false)
        return yield* ledger.current
      }).pipe(Effect.provide(Ledger.layer)),
    )
    const state = resultOf(ran)
    expect(state.tickets.get(id)?.steered).toBe(true)
    expect(state.tickets.get(id)?.tallies.messages).toBe(0)
    expect(recordsOf(ran, "message")).toEqual([])
    expect(ran.log.some((each) => each.startsWith("  MESSAGE:"))).toBe(false)
  })
})

describe("a steered worker", () => {
  test("gets no nudges, and its grace for PAUSED counts from your last message", async () => {
    const root = folder("grace")
    const ran = await working(
      {
        root,
        scripts: scripts(root, (c) => [
          ...turn([run(c.claim), sleep("1 minute")]),
          ...turn([]),
          ...turn([]),
        ]),
      },
      (fiber) =>
        Effect.gen(function* () {
          yield* untilSent(1)
          yield* sendMessage(id, "first", "00000000-0000-4000-8000-0000000000b1")
          // Its turn ends, and its answer to your message: idle from 1 minute in.
          yield* advance("1 minute")
          yield* quiet
          yield* advance("5 minutes")
          yield* sendMessage(id, "second", "00000000-0000-4000-8000-0000000000b2")
          yield* quiet
          // 14 minutes since it first went idle, 9 since your last message.
          yield* advance(Duration.subtract(idleGrace, Duration.minutes(1)))
          yield* quiet
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* advance("1 minute")
        }),
    )
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }))
    expect(textsOf(ran).slice(1)).toEqual(["first", "second"])
    expect(textsOf(ran)).not.toContain(nudgeText(id))
  })

  test("released, is the run's again: the RELEASED line, then the nudge it was owed", async () => {
    const root = folder("release")
    const ran = await working(
      {
        root,
        scripts: scripts(root, (c) => [
          ...turn([run(c.claim), sleep("1 minute")]),
          ...turn([]),
          ...turn([run(c.commit), run(c.close)]),
        ]),
      },
      () =>
        Effect.gen(function* () {
          yield* untilSent(1)
          yield* sendMessage(id, "wait", "00000000-0000-4000-8000-0000000000c1")
          yield* advance("1 minute")
          yield* untilSent(2)
          // Idle with its ticket in progress, and steered: nothing more is sent.
          expect((yield* (yield* AgentHost).current(id))._tag).toBe("Idle")
          expect((yield* (yield* Recording).messages(id)).length).toBe(2)
          yield* release(id)
          expect(yield* steeredNow).toBe(false)
          // Released already: nothing more to say.
          yield* release(id)
        }),
    )
    expect(phaseOf(ran)?._tag).toBe("ToMerge")
    expect(textsOf(ran).slice(1)).toEqual(["wait", nudgeText(id)])
    expect(ran.log.filter((each) => each === "  RELEASED: t-1")).toHaveLength(1)
    expectLog(ran, ["  STEERED: t-1", "  RELEASED: t-1"])
    expect(recordsOf(ran, "released")).toEqual([
      expect.objectContaining({ ticket: id, text: "  RELEASED: t-1" }),
    ])
  })
})

describe("an interrupt", () => {
  test("stops the turn and steers the worker: no nudge, PAUSED once the grace runs out", async () => {
    const root = folder("interrupt")
    const ran = await working(
      {
        root,
        scripts: scripts(root, (c) => [
          wait,
          init(),
          sessionState("running"),
          run(c.claim),
          awaitInterrupt,
          interruptedResult,
          sessionState("idle"),
        ]),
      },
      (fiber) =>
        Effect.gen(function* () {
          yield* untilSent(1)
          expect(yield* interrupt(id)).toBe(true)
          yield* quiet
          expect(yield* steeredNow).toBe(true)
          expect(yield* (yield* AgentHost).current(id)).toMatchObject({
            _tag: "Failed",
            interrupted: true,
          })
          yield* advance(Duration.subtract(idleGrace, Duration.minutes(1)))
          yield* quiet
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* advance("1 minute")
        }),
    )
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }))
    expect(messagesOf(ran)).toHaveLength(1)
    expect(ran.sent.filter((sent) => sent._tag === "Interrupted")).toHaveLength(1)
    expectLog(ran, ["  STEERED: t-1"])
    expect(recordsOf(ran, "steered")).toHaveLength(1)
    expect(resultOf(ran).ledger.tickets.get(id)?.lastMessage).toBeNull()
  })

  test("cancels your messages still queued behind the turn", async () => {
    const root = folder("cancel")
    const ran = await working(
      {
        root,
        scripts: scripts(root, (c) => [
          wait,
          init(),
          sessionState("running"),
          run(c.claim),
          awaitInterrupt,
          interruptedResult,
          sessionState("idle"),
        ]),
      },
      () =>
        Effect.gen(function* () {
          yield* untilSent(1)
          yield* sendMessage(id, secret, yours)
          yield* interrupt(id)
          yield* quiet
          yield* advance(idleGrace)
        }),
    )
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Stopped", why: "PAUSED" }))
    expect(ran.sent).toContainEqual(expect.objectContaining({ _tag: "CancelAsync", uuid: yours }))
    expect(ran.sent).toContainEqual(
      expect.objectContaining({
        _tag: "Interrupted",
        receipt: { stillQueued: [], cancelled: [yours] },
      }),
    )
    expectNoText(ran, secret)
  })
})

// HandBackNow: a ticket whose conflict waited for its steered worker.

const options = { repo: "/repo", base: "main" }
const check = "scripts/check-fast.sh"
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
    },
  },
} satisfies Setup

const worktrees = new Map<string, string>()
const worktreeOf = (ticketId: string) => worktrees.get(ticketId) ?? ""

/** A hand-back turn in which the worker resolves the conflict, writing `files`, and finishes. */
const resolves = (world: World, ticketId: string, files: Files): SessionScript =>
  turn([
    run(
      Effect.suspend(() =>
        Effect.asVoid(world.repository.continueRebase(worktreeOf(ticketId), files)),
      ),
    ),
  ])

/** Ticket a, finished by its worker: committed, closed, Working, its session saved and idle. */
const finished = (files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const host = yield* AgentHost
    const worktree = yield* (yield* Worktrees).prepare("a")
    worktrees.set("a", worktree.path)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, "Do a (a)", files)
    yield* (yield* Beads).close("a", "done")
    const ledger = yield* Ledger
    yield* ledger.transition("a", Cause.Ready(), { title: "Ticket a" })
    yield* ledger.transition("a", Cause.Dispatched())
    yield* (yield* Store).saveSession("a", {
      session: "session-a",
      worktree: worktree.path,
      branch: worktree.branch,
    })
    yield* host.start("a", { sessionId: "session-a", cwd: worktree.path })
    yield* untilSettled("a")
    return {
      id: "a",
      title: "Ticket a",
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Its worker's first session: it finished the ticket and is idle, then plays `then`. */
const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

/** The client_composed messages ticket a's worker was sent. */
const composed = (ran: Ran<unknown>) =>
  messagesOf(ran, "a").flatMap((message) =>
    message.client_composed === true ? [String(message.message.content)] : [],
  )

/** The phases ticket a moved through, with the cause of each move. */
const pathOf = (ran: Ran<unknown>) =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === "a" ? [`${record.to}:${record.cause}`] : [],
  )

const untilPhase = (ticketId: string, tag: PhaseTag) =>
  Effect.flatMap(Ledger, (ledger) =>
    ledger.changes.pipe(
      Stream.filter((state) => state.tickets.get(ticketId)?.phase._tag === tag),
      Stream.runHead,
    ),
  )

/** What a HandBackNow scenario hands back: a's phase, and the hand-backs still waiting. */
interface HandedNow {
  readonly phase: TicketPhase | undefined
  readonly waiting: ReadonlyArray<RebaseStop>
  readonly handed: boolean
}

describe("HandBackNow", () => {
  test("hands a steered worker its waiting conflict: Blocked → ToMerge, rebased, handed back", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").seeds,
        ...withCheck,
        scripts: (world) => ({
          a: [
            finishedSession(resolves(world, "a", { "a.txt": "both\n" })),
            resolves(world, "a", { "a.txt": "both\n" }),
          ],
        }),
      },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const queue = yield* makeQueue(options)
        const finishedA = yield* finished({ "a.txt": "a\n" })
        yield* (yield* Repository).commit((yield* Repository).dir, "Land something else", {
          "a.txt": "main's a\n",
        })
        yield* ledger.steer("a", "message")
        yield* queue.offer(finishedA)
        yield* queue.settled
        expect((yield* ledger.current).tickets.get("a")?.phase).toMatchObject({
          _tag: "Blocked",
          why: "MERGE_CONFLICT",
        })
        expect((yield* queue.handBacks.waiting).map((stop) => stop.ticket.id)).toEqual(["a"])
        const handed = yield* handBackNow("a", queue, options)
        yield* untilPhase("a", "Done")
        yield* queue.settled
        return {
          phase: (yield* ledger.current).tickets.get("a")?.phase,
          waiting: yield* queue.handBacks.waiting,
          handed,
        } satisfies HandedNow
      }).pipe(Effect.provide(Ledger.layer)),
    )
    const out = resultOf(ran)
    expect(out.handed).toBe(true)
    expect(out.phase?._tag).toBe("Done")
    expect(out.waiting).toEqual([])
    expect(pathOf(ran)).toEqual([
      "Queued:Ready",
      "Working:Dispatched",
      "ToMerge:Verified",
      "Merging:ItsTurn",
      "Blocked:Block",
      "ToMerge:HandedOver",
      "Merging:ItsTurn",
      "Resolving:ConflictsHandedBack",
      "ToMerge:Verified",
      "Merging:ItsTurn",
      "Done:FastForwarded",
    ])
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: a closed, .*you have steered its worker, so the hand-back waits in its view/,
      "  you handed a's conflict with main to its worker; tutti/a is back in the merge queue, to be rebased again and the conflict handed back",
      /^ {2}RESOLVING: tutti\/a conflicts with main in a\.txt; handed back to its worker/,
    ])
    // The hand-back went to the steered worker that once.
    expect(composed(ran)).toHaveLength(1)
  })

  test("with no hand-back waiting, or the ticket not blocked on it, nothing moves", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const queue = yield* lineOnly
        yield* ledger.transition("a", Cause.Ready(), { title: "Ticket a" })
        yield* ledger.transition("a", Cause.Dispatched())
        const none = yield* handBackNow("a", queue, options)
        const stop: RebaseStop = {
          ticket: { id: "a", title: "Ticket a", branch: "tutti/a", worktree: "/w/a" },
          onto: "abc",
          fork: "def",
          head: "123",
          own: 1,
          files: ["a.txt"],
        }
        yield* queue.handBacks.wait(stop)
        // Working, not Blocked: the hand-back stays waiting, and no waiver is left behind.
        const working = yield* handBackNow("a", queue, options)
        return {
          phase: (yield* ledger.current).tickets.get("a")?.phase,
          waiting: yield* queue.handBacks.waiting,
          handed: none || working || (yield* queue.handBacks.waived("a")),
        } satisfies HandedNow
      }).pipe(Effect.provide(Ledger.layer)),
    )
    const out = resultOf(ran)
    expect(out.handed).toBe(false)
    expect(out.phase?._tag).toBe("Working")
    expect(out.waiting.map((stop) => stop.ticket.id)).toEqual(["a"])
    expect(ran.log).toEqual([])
  })
})

// The screen's commands, through the run's one consumer.

describe("the run takes steering's commands from the screen", () => {
  test("SendMessage and Release reach the worker; one for a ticket with no worker is dropped", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("a").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World): Scripts => ({
          a: [
            [
              wait,
              init(),
              sessionState("running"),
              run(Effect.asVoid(Effect.orDie(world.beads.update("a", { claim: true })))),
              canUseTool("Bash", { command: "rm -rf build" }),
              run(
                Effect.asVoid(
                  Effect.orDie(
                    world.repository.commit(join(root, "a"), "Change (a)", { "a.txt": "x\n" }),
                  ),
                ),
              ),
              run(Effect.asVoid(Effect.orDie(world.beads.close("a", "done")))),
              result("Closed a."),
              // Your message, queued behind the turn, has a turn of its own.
              wait,
              init(),
              result(),
              sessionState("idle"),
            ],
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          runTutti({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard,
          }),
        )
        const attention = yield* Attention
        const until = (what: string, found: () => Effect.Effect<boolean>) =>
          Effect.gen(function* () {
            for (let i = 0; i < 2000; i++) {
              if (yield* found()) return
              yield* Effect.promise(() => Bun.sleep(2))
            }
            throw new Error(`waited in vain for ${what}: ${(yield* texts).join("\n")}`)
          })
        yield* until("the dashboard", () => Effect.sync(() => shown !== undefined))
        const inputs = shown as ScreenInputs
        const send = (command: UiCommand) =>
          Effect.gen(function* () {
            yield* Queue.offer(inputs.commands, command)
            yield* until("the command to be taken", () =>
              Effect.map(Queue.size(inputs.commands), (n) => n === 0),
            )
            yield* Effect.promise(() => Bun.sleep(10))
          })
        for (let i = 0; i < 60; i++) {
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(1))
          if ((yield* attention.current).length > 0) break
        }
        yield* until("a's request", () =>
          Effect.map(attention.current, (all) => all.some((request) => request.ticket === "a")),
        )
        // No worker b: dropped.
        yield* send(UiCommand.SendMessage({ ticket: "b", text: "hello", uuid: yours }))
        yield* send(UiCommand.SendMessage({ ticket: "a", text: secret, uuid: yours }))
        yield* send(UiCommand.Release({ ticket: "a" }))
        const requestId = ((yield* attention.current)[0] as { readonly id: string }).id
        yield* send(UiCommand.Answer({ requestId, answer: { _tag: "Allow" } }))
        for (let i = 0; i < 3; i++) {
          yield* advance("1 minute")
          yield* Effect.promise(() => Bun.sleep(3))
        }
        return yield* Fiber.join(fiber)
      }) as Effect.Effect<Outcome, unknown, Env | Scope.Scope>,
    )
    expectExitCode(ran, 0)
    expect(messagesOf(ran, "a").map((message) => message.uuid)).toContain(yours)
    expect(messagesOf(ran, "b")).toEqual([])
    expectLog(ran, [
      "  STEERED: a",
      `  MESSAGE: you → a (${lengthOf(secret)} characters)`,
      "  RELEASED: a",
    ])
    expectNoText(ran, secret)
  }, 30_000)
})
