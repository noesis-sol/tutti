// Messages held while their ticket merges (held.ts, § 4.3, § 7.5): a message you send the worker of
// a ticket waiting to merge or merging steers it and is held, so its branch doesn't move under its
// check; once the merge is over it is sent if the ticket keeps its card, and dropped with a line
// saying so if its worker has finished.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, type Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { heldLine, makeHeld, notSentLine } from "../src/run/held.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import { Tag } from "../src/run/log.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  init,
  result,
  run,
  type SessionScript,
  sessionState,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed, type Scripted } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, type Setup, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** The default settings with a check command, which a hand-back needs. */
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: {
        ...defaults.checks,
        fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
      },
    },
  },
} satisfies Setup

const yours = "11111111-2222-4333-8444-555555555555"
const words = "Also cover the empty case 🙂"

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Waits until the ledger's state satisfies `ready`. */
const until = (ready: (state: State) => boolean) =>
  Effect.gen(function* () {
    yield* (yield* Ledger).changes.pipe(Stream.filter(ready), Stream.runHead)
  })

const checking = (id: string) => (state: State) => {
  const phase = state.tickets.get(id)?.phase
  return phase?._tag === "Merging" && phase.step === "check"
}

/** The worker's first session: it finished its ticket and is idle; then it plays `then`. */
const finishedSession = (then: SessionScript = []): SessionScript => [
  init(),
  sessionState("running"),
  result(),
  sessionState("idle"),
  ...then,
]

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in
 * Beads, Working in the ledger; with `session`, its worker's session started and settled.
 */
const finished = (id: string, files: Files, session: boolean) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
    if (session) {
      yield* (yield* Store).saveSession(id, {
        session: `session-${id}`,
        worktree: worktree.path,
        branch: worktree.branch,
      })
      yield* (yield* AgentHost).start(id, { sessionId: `session-${id}`, cwd: worktree.path })
      yield* untilSettled(id)
    }
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** What a's worker was sent of yours: the messages' uuids and texts. */
const yoursTo = (ran: Ran<unknown>, id = "a") =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id && sent.message.client_composed !== true
      ? [{ uuid: sent.message.uuid, text: sent.message.message.content }]
      : [],
  )

const provided = <A>(effect: Effect.Effect<A, unknown, Env | Ledger | Scope.Scope>) =>
  effect.pipe(Effect.provide(Ledger.layer)) as Effect.Effect<A, unknown, Env | Scope.Scope>

describe("a message to the worker of a ticket that merges", () => {
  test("is held while it merges, steering it, and not sent once it has merged", async () => {
    const gate = Deferred.makeUnsafe<void>()
    const gated: Scripted = Effect.as(Deferred.await(gate), passed("fast"))
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").seeds,
        checks: { fast: [gated] },
        scripts: { a: [finishedSession()] },
      },
      provided(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const queue = yield* makeQueue(options)
          const a = yield* finished("a", { "a.txt": "a\n" }, true)
          const repository = yield* Repository
          yield* repository.commit(repository.dir, "Land something else", { "b.txt": "b\n" })
          yield* queue.offer(a)
          yield* until(checking("a"))
          expect(yield* queue.held.hold("a", words, yours)).toBe(true)
          expect((yield* ledger.current).tickets.get("a")?.steered).toBe(true)
          expect((yield* queue.held.messages).get("a")).toEqual([{ text: words, uuid: yours }])
          yield* Deferred.succeed(gate, undefined)
          yield* queue.settled
          return {
            phase: (yield* ledger.current).tickets.get("a")?.phase,
            held: yield* queue.held.messages,
          }
        }),
      ),
    )
    const ended = resultOf(ran)
    expect(ended.phase?._tag).toBe("Done")
    expect(ended.held.size).toBe(0)
    expect(yoursTo(ran)).toEqual([])
    expectLog(ran, [
      `  ${Tag.steered}: a`,
      heldLine("a", words, TicketPhase.Merging({ step: "check" })),
      notSentLine("a", 1),
    ])
    expect(ran.log.some((each) => each.startsWith(`  ${Tag.message}:`))).toBe(false)
    // Its length, never its text.
    expect(ran.log.some((each) => each.includes(words))).toBe(false)
    expect(heldLine("a", words, TicketPhase.Merging({ step: "check" }))).toContain(
      "(27 characters) is held, as a is merging",
    )
  })

  test("waiting to merge, is sent once its merge is over and its conflict waits for you", async () => {
    const gate = Deferred.makeUnsafe<void>()
    const gated: Scripted = Effect.as(Deferred.await(gate), passed("fast"))
    const second = "00000000-0000-4000-8000-0000000000a2"
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck,
        checks: { fast: [gated] },
        scripts: { a: [finishedSession(turn([]))] },
      },
      provided(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const queue = yield* makeQueue(options)
          const a = yield* finished("a", { "a.txt": "a\n" }, true)
          const b = yield* finished("b", { "b.txt": "b\n" }, false)
          const repository = yield* Repository
          // Main changes a.txt too: a's rebase stops on the conflict.
          yield* repository.commit(repository.dir, "Land something else", {
            "a.txt": "main's a\n",
          })
          yield* queue.offer(b)
          yield* until(checking("b"))
          // Behind b, not checked ahead of its turn.
          yield* queue.offer(a, undefined, false)
          expect((yield* ledger.current).tickets.get("a")?.phase._tag).toBe("ToMerge")
          expect(yield* queue.held.hold("a", words, yours)).toBe(true)
          expect(yield* queue.held.hold("a", "and two", second)).toBe(true)
          yield* Deferred.succeed(gate, undefined)
          yield* queue.settled
          return {
            a: (yield* ledger.current).tickets.get("a"),
            b: (yield* ledger.current).tickets.get("b")?.phase,
            held: yield* queue.held.messages,
          }
        }),
      ),
    )
    const ended = resultOf(ran)
    expect(ended.b?._tag).toBe("Done")
    // Steered by your message, its conflict waits for you, and its session stays open for it.
    expect(ended.a?.phase).toEqual(TicketPhase.Blocked({ why: Tag.mergeConflict }))
    expect(ended.a?.handBack).toBe(true)
    expect(ended.held.size).toBe(0)
    expect(yoursTo(ran)).toEqual([
      { uuid: yours, text: words },
      { uuid: second, text: "and two" },
    ])
    expectLog(ran, [
      heldLine("a", words, TicketPhase.ToMerge({ place: 1 })),
      heldLine("a", "and two", TicketPhase.ToMerge({ place: 1 })),
      `  ${Tag.message}: you → a (27 characters)`,
      `  ${Tag.message}: you → a (7 characters)`,
    ])
    expect(ran.log.filter((each) => each === `  ${Tag.steered}: a`)).toHaveLength(1)
    expect(ended.a?.tallies.messages).toBe(2)
  })
})

describe("a message held for a worker you released meanwhile", () => {
  test("is sent as its merge hands its conflict back, before the hand-back", async () => {
    const gate = Deferred.makeUnsafe<void>()
    const gated: Scripted = Effect.as(Deferred.await(gate), passed("fast"))
    const worktrees = new Map<string, string>()
    const ran = await scenario(
      {
        backlog: backlog().ticket("a").ticket("b").seeds,
        ...withCheck,
        checks: { fast: [gated, passed("fast"), passed("fast")] },
        scripts: (world) => ({
          a: [
            finishedSession([
              // The hand-back's turn: it resolves the conflict.
              ...turn([
                run(
                  Effect.suspend(() =>
                    Effect.asVoid(
                      world.repository.continueRebase(worktrees.get("a") ?? "", {
                        "a.txt": "both\n",
                      }),
                    ),
                  ),
                ),
              ]),
              // Your message's.
              ...turn([]),
            ]),
          ],
        }),
      },
      provided(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const queue = yield* makeQueue(options)
          const a = yield* finished("a", { "a.txt": "a\n" }, true)
          worktrees.set("a", a.worktree)
          const b = yield* finished("b", { "b.txt": "b\n" }, false)
          const repository = yield* Repository
          yield* repository.commit(repository.dir, "Land something else", {
            "a.txt": "main's a\n",
          })
          yield* queue.offer(b)
          yield* until(checking("b"))
          yield* queue.offer(a, undefined, false)
          expect(yield* queue.held.hold("a", words, yours)).toBe(true)
          // Released, its worker takes the conflict its merge stops on.
          yield* ledger.release("a")
          yield* Deferred.succeed(gate, undefined)
          yield* queue.settled
          return {
            a: (yield* ledger.current).tickets.get("a")?.phase,
            held: yield* queue.held.messages,
          }
        }),
      ),
    )
    const ended = resultOf(ran)
    expect(ended.held.size).toBe(0)
    expect(ended.a?._tag).toBe("Done")
    const toA = ran.sent.flatMap((sent) =>
      sent._tag === "Message" && sent.ticket === "a" ? [sent.message] : [],
    )
    // Yours first, written before its merge stopped, then the hand-back, tutti's.
    expect(toA.map((message) => message.client_composed === true)).toEqual([false, true])
    expect(toA[0]).toMatchObject({ uuid: yours, message: { content: words } })
    expectLog(ran, [
      heldLine("a", words, TicketPhase.ToMerge({ place: 1 })),
      /^ {2}RESOLVING: /,
      `  ${Tag.message}: you → a (27 characters)`,
    ])
  })
})

describe("the held messages", () => {
  test("are none outside a merge: a Working ticket's message is for steer.ts to send", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      provided(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const held = yield* makeHeld
          yield* ledger.transition("a", Move.Ready(), { title: "Ticket a" })
          yield* ledger.transition("a", Move.Dispatched())
          expect(yield* held.hold("a", words, yours)).toBe(false)
          expect(yield* held.hold("nobody", words, yours)).toBe(false)
          return { steered: (yield* ledger.current).tickets.get("a")?.steered, held }
        }),
      ),
    )
    const ended = resultOf(ran)
    expect(ended.steered).toBe(false)
    expect(ran.log).toEqual([])
  })

  test("stay held when the merge goes back in line, and go once it is over", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      provided(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const held = yield* makeHeld
          yield* ledger.transition("a", Move.Ready(), { title: "Ticket a" })
          yield* ledger.transition("a", Move.Dispatched())
          yield* ledger.transition("a", Move.Verified({ place: 1 }))
          expect(yield* held.hold("a", words, yours)).toBe(true)
          yield* held.over("a")
          const kept = (yield* held.messages).get("a")
          yield* ledger.transition("a", Move.ItsTurn())
          yield* ledger.transition("a", Move.Aside({ why: Tag.checksFailed }))
          yield* held.over("a")
          return { kept, after: yield* held.messages }
        }),
      ),
    )
    const ended = resultOf(ran)
    expect(ended.kept).toEqual([{ text: words, uuid: yours }])
    expect(ended.after.size).toBe(0)
    expect(ran.log).toContain(notSentLine("a", 1))
    expect(String(notSentLine("a", 2))).toBe(
      "  your 2 messages held for a's worker were not sent: its merge is over, and its worker has finished",
    )
  })
})
