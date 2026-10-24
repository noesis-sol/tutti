// A conflict hand-back waiting for its steered worker stays within reach (§ 4.3): its ticket,
// Blocked on MERGE_CONFLICT, keeps its worker's number and its card (`conflict waits for you`, no
// spinner), so that its view opens by click or Tab and Enter; and with a dashboard the run waits for it
// as for a worker waiting on you, the end-of-run box naming it, until it is handed over or the
// box's `q` ends the run, leaving it Blocked.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Layer, Queue, Result, type Scope, SubscriptionRef } from "effect"
import { Attention } from "../src/agent/Attention.ts"
import { resolve, UiCommand } from "../src/run/commands.ts"
import {
  type Entry,
  emptyTallies,
  handBackWaits,
  keepsWorker,
  Ledger,
  type State,
  showsCard,
} from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { Cause, TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import {
  conflictWaits,
  emptyStatus,
  handBackStatus,
  project,
  type RunView,
} from "../src/run/runView.ts"
import { type Dashboard, Screen, type ScreenInputs } from "../src/run/screen.ts"
import { Git } from "../src/services/Git.ts"
import {
  canUseTool,
  init,
  result,
  run,
  type SessionScript,
  sessionState,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { dashboardHint } from "../src/ui/Dashboard.tsx"
import { endOfRunText } from "../src/ui/EndOfRunBox.tsx"
import { advance, backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

const conflict = "MERGE_CONFLICT"

/** Runs `effect` against a fresh ledger. */
const withLedger = <A>(effect: Effect.Effect<A, never, Ledger>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, Layer.orDie(ledgerLayer())))

/** Takes `ticket` from the ready queue to its merge: Merging, its worker numbered. */
const toMerging = (ticket: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.transition(ticket, Cause.Ready(), { title: `Ticket ${ticket}` })
    yield* ledger.transition(ticket, Cause.Dispatched())
    yield* ledger.transition(ticket, Cause.Verified({ place: 1 }))
    yield* ledger.transition(ticket, Cause.ItsTurn())
  })

const workerOf = (state: State, ticket: string) => state.tickets.get(ticket)?.worker

describe("the ledger", () => {
  test("a ticket Blocked with its hand-back waiting keeps its worker's number", async () => {
    const seen = await withLedger(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* toMerging("a")
        // As notHandedBack does: the hand-back kept first, then the ticket Blocked on it.
        yield* ledger.handBackWaits("a")
        yield* ledger.transition("a", Cause.Block({ why: conflict }))
        const blocked = yield* ledger.current
        // Another ticket started meanwhile doesn't take a's number.
        yield* ledger.transition("b", Cause.Ready(), { title: "Ticket b" })
        yield* ledger.transition("b", Cause.Dispatched())
        const meanwhile = yield* ledger.current
        yield* ledger.transition("a", Cause.HandedOver({ place: 1 }))
        const handed = yield* ledger.current
        return { blocked, meanwhile, handed }
      }),
    )
    const a = seen.blocked.tickets.get("a") as Entry
    expect(a.phase).toEqual(TicketPhase.Blocked({ why: conflict }))
    expect(a.worker).toBe(1)
    expect(handBackWaits(a)).toBe(true)
    expect(keepsWorker(a)).toBe(true)
    expect(showsCard(a)).toBe(true)
    expect(workerOf(seen.meanwhile, "a")).toBe(1)
    expect(workerOf(seen.meanwhile, "b")).toBe(2)
    // Handed over, back in the merge queue with the same number; the hand-back no longer waits.
    const after = seen.handed.tickets.get("a") as Entry
    expect(after.phase).toEqual(TicketPhase.ToMerge({ place: 1 }))
    expect(after.worker).toBe(1)
    expect(after.handBack).toBe(false)
    expect(handBackWaits(after)).toBe(false)
  })

  test("a ticket Blocked with no hand-back waiting gives its number up, as before", async () => {
    const state = await withLedger(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* toMerging("a")
        yield* ledger.transition("a", Cause.Block({ why: conflict }))
        return yield* ledger.current
      }),
    )
    const a = state.tickets.get("a") as Entry
    expect(a.worker).toBeNull()
    expect(keepsWorker(a)).toBe(false)
    expect(showsCard(a)).toBe(false)
  })

  test("a hand-back noted for a ticket Blocked already numbers its worker", async () => {
    const state = await withLedger(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* toMerging("a")
        yield* ledger.transition("a", Cause.Block({ why: conflict }))
        yield* ledger.handBackWaits("a")
        return yield* ledger.current
      }),
    )
    expect(workerOf(state, "a")).toBe(1)
  })
})

/** a, Blocked on its conflict with its hand-back waiting, worker 1; b at work as worker 2. */
const blockedEntry: Entry = {
  ticket: "a",
  title: "Title of a",
  phase: TicketPhase.Blocked({ why: conflict }),
  since: 0,
  worker: 1,
  row: 0,
  rechecking: false,
  steered: true,
  handBack: true,
  lastMessage: null,
  tallies: emptyTallies,
}

const ledgerOf = (...entries: ReadonlyArray<Entry>): State => ({
  tickets: new Map(entries.map((entry) => [entry.ticket, entry])),
  rows: entries.length,
  windDown: null,
  bugs: [],
})

const viewOf = (ledger: State, endOfRun: ReadonlyArray<string> | null): RunView =>
  project({
    ledger,
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "main", concurrency: 2, endOfRun },
  })

describe("RunView", () => {
  test("gives the Blocked ticket a card: `conflict waits for you`, no spinner", () => {
    const view = viewOf(ledgerOf(blockedEntry), null)
    expect(view.cards).toHaveLength(1)
    const card = view.cards[0]
    expect(card?.ticket).toBe("a")
    expect(card?.worker).toBe(1)
    expect(card?.status).toBe(handBackStatus)
    expect(card?.status).toBe("conflict waits for you")
    expect(card?.motion).toBe("idle")
    expect(card?.steered).toBe(true)
    expect(dashboardHint(view, true).map((key) => key.keys)).toContain("Enter")
  })

  test("gives a Blocked ticket with no hand-back waiting no card", () => {
    const view = viewOf(ledgerOf({ ...blockedEntry, handBack: false, worker: null }), null)
    expect(view.cards).toEqual([])
  })

  test("names it in the end-of-run box", () => {
    const view = viewOf(ledgerOf(blockedEntry), ["a"])
    expect(view.endOfRun).toEqual([{ ticket: "a", asks: [conflictWaits] }])
    expect(endOfRunText(view.endOfRun ?? [])).toBe(
      "Everything else is done. 1 worker waits for you: a (a merge conflict waits for you)",
    )
    // Handed over, it is no longer named.
    const handed = viewOf(
      ledgerOf({ ...blockedEntry, phase: TicketPhase.ToMerge({ place: 1 }), handBack: false }),
      ["a"],
    )
    expect(handed.endOfRun).toBeNull()
  })
})

describe("the screen's commands", () => {
  test("open the Blocked ticket's view by its ticket", () => {
    const current = { ledger: ledgerOf({ ...blockedEntry, steered: false }), requests: [] }
    const opened = resolve(UiCommand.OpenWorker({ ticket: "a" }), current)
    expect(Result.isSuccess(opened) && opened.success.ticket).toBe("a")
    // Release and messages reach its worker though you have released it meanwhile.
    const released = resolve(UiCommand.Release({ ticket: "a" }), current)
    expect(Result.isSuccess(released)).toBe(true)
  })
})

// Whole runs with a screen: a's worker, steered by your message, finishes with a conflict with
// main, which waits for it. Nothing else runs: the run waits for it all the same.

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-handback-reachable-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/**
 * a's worker: it asks to run a command (you steer it meanwhile), lands a conflicting change on main
 * as it works, commits its own and closes the ticket; your message then has a turn of its own. It
 * resolves the conflict you hand it.
 */
const scripts = (world: World, repo: string, root: string) => {
  const worktree = join(root, "a")
  const first: SessionScript = [
    wait,
    init(),
    sessionState("running"),
    run(orDie(world.beads.update("a", { claim: true }))),
    canUseTool("Bash", { command: "ls" }),
    run(orDie(world.repository.commit(repo, "Land something else", { "a.txt": "main's a\n" }))),
    run(orDie(world.repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" }))),
    run(orDie(world.beads.close("a", "done"))),
    result("Closed a."),
    wait,
    init(),
    result(),
    sessionState("idle"),
    ...turn([run(orDie(world.repository.continueRebase(worktree, { "a.txt": "both\n" })))]),
  ]
  return { a: [first] }
}

interface Seen {
  readonly outcome: Outcome
  /** RunView once the hand-back waits. */
  readonly waiting: RunView
  /** Whether the run had ended 10 minutes after that. */
  readonly endedThen: boolean
  /** The screen after you pressed 1. */
  readonly opened: Screen
}

/** The run, steered to a's waiting hand-back, then `finish`: what you do about it. */
const steered = (
  finish: (
    send: (command: UiCommand) => Effect.Effect<void, never, Env>,
  ) => Effect.Effect<void, unknown, Env>,
): Promise<Ran<Seen>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: {
        repo,
        settings: {
          ...defaults,
          concurrent: 1,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: backlog().ticket("a").seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      scripts: (world: World) => scripts(world, repo, root),
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
      const until = <R>(what: string, found: () => Effect.Effect<boolean, never, R>) =>
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
      // RunView is written at most 30 times a second, on the Clock: move it on to see the latest.
      const view = Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          yield* advance("100 millis")
          yield* Effect.promise(() => Bun.sleep(10))
        }
        return yield* SubscriptionRef.get(inputs.view)
      })
      const requestOf = Effect.map(attention.current, (all) =>
        all.find((request) => request.ticket === "a"),
      )
      for (let i = 0; i < 60; i++) {
        yield* advance("1 second")
        yield* Effect.promise(() => Bun.sleep(1))
        if ((yield* requestOf) !== undefined) break
      }
      yield* until("a's request", () => Effect.map(requestOf, (request) => request !== undefined))
      yield* send(
        UiCommand.SendMessage({
          ticket: "a",
          text: "Keep it small",
          uuid: "11111111-2222-4333-8444-555555555555",
        }),
      )
      const request = yield* requestOf
      if (request === undefined) throw new Error("a has no request open")
      yield* send(UiCommand.Answer({ requestId: request.id, answer: { _tag: "Allow" } }))
      for (let i = 0; i < 200; i++) {
        if ((yield* SubscriptionRef.get(inputs.handBacks)).includes("a")) break
        yield* advance("1 second")
        yield* Effect.promise(() => Bun.sleep(2))
      }
      yield* until("a's hand-back to wait", () =>
        Effect.map(SubscriptionRef.get(inputs.handBacks), (all) => all.includes("a")),
      )
      let waiting = yield* view
      for (let i = 0; i < 50 && waiting.endOfRun === null; i++) waiting = yield* view
      for (let i = 0; i < 10; i++) {
        yield* advance("1 minute")
        yield* Effect.promise(() => Bun.sleep(3))
      }
      const endedThen = fiber.pollUnsafe() !== undefined
      yield* send(UiCommand.OpenWorker({ ticket: "a" }))
      const opened = yield* SubscriptionRef.get(inputs.screen)
      yield* send(UiCommand.CloseWorker())
      yield* finish(send)
      const outcome = yield* Fiber.join(fiber)
      return { outcome, waiting, endedThen, opened } satisfies Seen
    }) as Effect.Effect<Seen, unknown, Env | Scope.Scope>,
  )
}

const seenOf = (ran: Ran<Seen>): Seen => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** What every run sees while a's hand-back waits. */
const expectWaiting = (seen: Seen) => {
  expect(seen.waiting.endOfRun).toEqual([{ ticket: "a", asks: [conflictWaits] }])
  const card = seen.waiting.cards.find((each) => each.ticket === "a")
  expect(card?.worker).toBe(1)
  expect(card?.phase._tag).toBe("Blocked")
  expect(card?.status).toBe(handBackStatus)
  expect(card?.motion).toBe("idle")
  expect(dashboardHint(seen.waiting, false).map((key) => key.keys)).toContain("q")
  expect(seen.endedThen).toBe(false)
  expect(seen.opened).toEqual(Screen.Worker({ ticket: "a" }))
}

describe("with a dashboard, the run waits for a hand-back waiting", () => {
  test("until you hand it over: the worker resolves the conflict and a merges", async () => {
    const ran = await steered((send) =>
      Effect.gen(function* () {
        yield* send(UiCommand.HandBackNow({ ticket: "a" }))
        for (let i = 0; i < 200; i++) {
          const lines = yield* texts
          if (lines.some((each) => each.startsWith("  a closed ("))) break
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(2))
        }
        for (let i = 0; i < 5; i++) {
          yield* advance("1 minute")
          yield* Effect.promise(() => Bun.sleep(3))
        }
      }),
    )
    const seen = seenOf(ran)
    expectWaiting(seen)
    expect(seen.outcome.exitCode).toBe(0)
    expect(seen.outcome.phases.a?._tag).toBe("Done")
  }, 30_000)

  test("until the box's q ends the run, leaving it Blocked", async () => {
    const ran = await steered((send) => send(UiCommand.EndRun()))
    const seen = seenOf(ran)
    expectWaiting(seen)
    expect(seen.outcome.phases.a).toEqual(TicketPhase.Blocked({ why: conflict }))
  }, 30_000)
})
