// One more verifier round (§ 4.11, src/run/lastRound.ts): the verifier's hooks show each round, its
// start with the commits its prompt names and its end (src/agent/hooks.ts); a worker that defers its
// ticket after three rounds, with commits on its branch beyond the one the last round checked, is
// told once to run the verifier on its last fix, then settled again. A pass closes the ticket for
// the merge queue, a fail defers it to triage; a deferral with no commit since the last round, or
// before a third round, goes to triage as before.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookInput } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Fiber, type Scope, Stream } from "effect"
import fc from "fast-check"
import {
  hashesIn,
  noRounds,
  roundStep,
  VerifierEvent,
  type VerifierRounds,
  verifierEvent,
} from "../src/agent/hooks.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { lastRoundNote, unverifiedFix } from "../src/run/lastRound.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import type { StartTicket } from "../src/run/start.ts"
import { lastRoundText } from "../src/run/told.ts"
import type { Deferral, Triage } from "../src/run/triage.ts"
import { type Worked, work } from "../src/run/work.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git, givenHash, type Sha } from "../src/services/Git.ts"
import { run, type SessionScript, type Step, tool, turn } from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Env, type Ran, type Scripts, scenario, type World } from "./harness.ts"

const id = "t-1" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }
const line =
  "  t-1 deferred after three verifier rounds with its last fix unverified: one more round"

/** A hook input of `event` for an Agent call `call` with `input`. */
const agentHook = (event: string, call: string, input: unknown): HookInput =>
  ({
    hook_event_name: event,
    session_id: "s",
    transcript_path: "/t",
    cwd: "/w",
    tool_name: "Agent",
    tool_input: input,
    tool_use_id: call,
    ...(event === "PostToolUse" ? { tool_response: { content: [] } } : {}),
    ...(event === "PostToolUseFailure" ? { error: "interrupted" } : {}),
  }) as HookInput

const head = "0123456789abcdef0123456789abcdef01234567"

describe("the verifier's rounds, as its hooks show them", () => {
  test("a PreToolUse of the verifier begins a round, naming the hashes in its prompt", () => {
    const prompt = `Verify t-1 at ${head}. Round 1 (at 89abcde) said FAIL; tutti-1v9 isn't a hash.`
    expect(
      verifierEvent(agentHook("PreToolUse", "toolu_1", { subagent_type: "verifier", prompt })),
    ).toEqual(VerifierEvent.Began({ call: "toolu_1", commits: [head, "89abcde"] }))
  })

  test("its PostToolUse or PostToolUseFailure ends it", () => {
    const input = { subagent_type: "verifier", prompt: "Verify" }
    expect(verifierEvent(agentHook("PostToolUse", "toolu_1", input))).toEqual(
      VerifierEvent.Ended({ call: "toolu_1" }),
    )
    expect(verifierEvent(agentHook("PostToolUseFailure", "toolu_1", input))).toEqual(
      VerifierEvent.Ended({ call: "toolu_1" }),
    )
  })

  test("another subagent, another tool or input it can't read shows none", () => {
    expect(
      verifierEvent(agentHook("PreToolUse", "toolu_1", { subagent_type: "Explore", prompt: head })),
    ).toBeUndefined()
    expect(verifierEvent(agentHook("PreToolUse", "toolu_1", "verifier"))).toBeUndefined()
    expect(
      verifierEvent({
        ...agentHook("PreToolUse", "toolu_1", { subagent_type: "verifier" }),
        tool_name: "Bash",
      } as HookInput),
    ).toBeUndefined()
    expect(
      verifierEvent(agentHook("PreToolUse", "toolu_1", { subagent_type: "verifier" })),
    ).toEqual(VerifierEvent.Began({ call: "toolu_1", commits: [] }))
  })

  test("hashesIn gives only words of 7 to 64 lowercase hex digits that are in the text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const hashes = hashesIn(text)
        expect(new Set(hashes).size).toBe(hashes.length)
        for (const hash of hashes) {
          expect(hash).toMatch(/^[0-9a-f]{7,64}$/)
          expect(text).toContain(hash)
        }
      }),
    )
    expect(hashesIn("abc1234 abc12345x deadbeef0 ABCDEF1 abc1234")).toEqual([
      "abc1234",
      "deadbeef0",
    ])
  })

  test("roundStep adds a round as it begins and marks it as it ends", () => {
    const began = roundStep(noRounds, VerifierEvent.Began({ call: "a", commits: [head] }))
    expect(roundStep(began, VerifierEvent.Began({ call: "a", commits: [] }))).toEqual(began)
    expect(roundStep(began, VerifierEvent.Ended({ call: "a" }))).toEqual({
      rounds: [{ call: "a", commits: [head], ended: true }],
      lastRound: false,
    })
    expect(roundStep(began, VerifierEvent.Ended({ call: "b" }))).toEqual(began)
  })
})

/** Ended rounds, each naming the hash given. */
const roundsNaming = (...hashes: ReadonlyArray<string>): VerifierRounds => ({
  rounds: hashes.map((hash, n) => ({ call: `toolu_${n}`, commits: [hash], ended: true })),
  lastRound: false,
})

const commitsOf = (...hashes: ReadonlyArray<string>) =>
  hashes.map((hash) => ({ hash: hash as Sha }))

describe("unverifiedFix", () => {
  const hash = (digit: string) => digit.repeat(40) as Sha
  const [c1, c2, c3, c4] = [hash("1"), hash("2"), hash("3"), hash("4")] as const
  const branch = commitsOf(c4, c3, c2, c1)

  test("after three rounds, the head when the last round checked an older commit", () => {
    expect(unverifiedFix(roundsNaming(c1, c2, c3), branch)).toBe(c4)
    // An abbreviated hash names it as well.
    expect(unverifiedFix(roundsNaming(c1, c2, c2.slice(0, 7)), branch)).toBe(c4)
  })

  test("none when the last round checked the head", () => {
    expect(unverifiedFix(roundsNaming(c1, c2, c4), branch)).toBeUndefined()
  })

  test("none before a third round has ended", () => {
    expect(unverifiedFix(roundsNaming(c1, c2), branch)).toBeUndefined()
    const going = roundsNaming(c1, c2, c3)
    const unended = {
      ...going,
      rounds: going.rounds.map((round, n) => (n === 2 ? { ...round, ended: false } : round)),
    }
    expect(unverifiedFix(unended, branch)).toBeUndefined()
  })

  test("none once given its last round, or when the last round names no commit of the branch", () => {
    expect(unverifiedFix({ ...roundsNaming(c1, c2, c3), lastRound: true }, branch)).toBeUndefined()
    expect(unverifiedFix(roundsNaming(c1, c2, "abcdef0"), branch)).toBeUndefined()
  })
})

/** A merge queue that only puts the ticket in line. */
const lineOnly = (offered: Array<string>): Effect.Effect<MergeQueue, never, Ledger> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    return {
      offer: (finished: FinishedTicket, cause = (place: number) => Move.Verified({ place })) =>
        Effect.andThen(
          Effect.sync(() => void offered.push(finished.id)),
          ledger.transition(finished.id, cause(1)),
        ),
      state: Effect.succeed(emptyQueue),
      changes: undefined as never,
      settled: Effect.succeed(emptyQueue),
      rechecks: yield* makeRechecks,
      handBacks: yield* makeHandBacks,
      held: yield* makeHeld,
      checksAhead: undefined as never,
      recheck: Effect.succeed([]),
      mergedByHand: Effect.succeed([]),
      hold: Effect.void,
      stopMerges: Effect.void,
    } satisfies MergeQueue
  })

/** A triage that notes each ticket handed to it. */
const noting = (handed: Array<Deferral>): Triage => ({
  deferred: (deferral) => Effect.sync(() => void handed.push(deferral)),
  pending: Effect.succeed(0),
  verdicts: Stream.succeed(new Map()),
  interrupt: Effect.void,
})

interface Seen {
  readonly ran: Ran<Worked>
  readonly offered: ReadonlyArray<string>
  readonly handed: ReadonlyArray<Deferral>
  /** The commits the worker made, oldest first. */
  readonly commits: ReadonlyArray<Sha>
}

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What a worker does, in steps made from what its commands do to the in-memory Beads and git. */
interface Doing {
  readonly world: World
  readonly path: string
  readonly commits: Array<Sha>
}

/** Commits a fix naming the ticket. */
const fix = (doing: Doing): Step =>
  run(
    Effect.gen(function* () {
      const n = doing.commits.length + 1
      const hash = yield* Effect.orDie(
        doing.world.repository.commit(doing.path, `Fix ${n} (${id})`, { "a.txt": `${n}\n` }),
      )
      doing.commits.push(hash)
    }),
  )

/** A verifier round on the last commit, as the worker gives it the verifier. */
const round = (doing: Doing): ReadonlyArray<Step> => {
  const call: Record<string, unknown> = { description: "Verify", subagent_type: "verifier" }
  return [
    run(
      Effect.sync(() => {
        call.prompt = `Verify ${id} at ${doing.commits.at(-1) ?? ""}; checks passed there.`
      }),
    ),
    ...tool("Agent", call),
  ]
}

const defer = (doing: Doing): Step => run(orDie(doing.world.beads.defer(id)))
const close = (doing: Doing): Step => run(orDie(doing.world.beads.close(id)))

/**
 * Dispatches the ticket and runs its fiber on main, its worker's turns made by `turns`: the first
 * claims the ticket, each a turn of the one session.
 */
const working = (turns: (doing: Doing) => ReadonlyArray<ReadonlyArray<Step>>): Promise<Seen> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-last-round-")))
  const offered: Array<string> = []
  const handed: Array<Deferral> = []
  const commits: Array<Sha> = []
  const scripts = (world: World): Scripts => {
    const doing = { world, path: join(root, id), commits }
    const [first = [], ...rest] = turns(doing)
    const claim = run(orDie(world.beads.update(id, { claim: true })))
    return {
      [id]: [
        [...turn([claim, ...first]), ...rest.flatMap((steps) => turn(steps))] as SessionScript,
      ],
    }
  }
  return scenario(
    {
      backlog: backlog().ticket(id, { title: ticket.title }).seeds,
      worktrees: { root },
      scripts,
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      const queue = yield* lineOnly(offered)
      const fiber = yield* Effect.forkChild(
        work(ticket, { base: "main", queue, triage: noting(handed) }),
      )
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  ).then((ran) => ({ ran, offered, handed, commits }))
}

const workedOf = (ran: Ran<Worked>): Worked => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The messages the ticket's worker was sent, as text. */
const sentTexts = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id ? [String(sent.message.message.content)] : [],
  )

const notesOf = (ran: Ran<unknown>) => ran.issues.find((issue) => issue.id === id)?.notes ?? ""

/** Three rounds that fail, each on a fix, then a fix the last didn't see, and the deferral. */
const threeRoundsThenFix = (doing: Doing): ReadonlyArray<Step> => [
  fix(doing),
  ...round(doing),
  fix(doing),
  ...round(doing),
  fix(doing),
  ...round(doing),
  fix(doing),
  defer(doing),
]

describe("a ticket deferred after three verifier rounds with its last fix unverified", () => {
  test("its worker is told once to verify the fix; a pass closes it for the merge queue", async () => {
    const { ran, offered, handed, commits } = await working((doing) => [
      threeRoundsThenFix(doing),
      [...round(doing), close(doing)],
    ])
    const worked = workedOf(ran)
    const last = commits.at(-1) ?? ""
    expect(commits).toHaveLength(4)
    expect(sentTexts(ran).slice(1)).toEqual([lastRoundText(givenHash(last))])
    expect(lastRoundText(givenHash(last))).toBe(
      `tutti: your last fix, ${givenHash(last)}, hasn't been verified: run the verifier once more on it, with the earlier rounds' findings. Close the ticket if it passes; defer it if it fails.`,
    )
    expect(ran.log).toContain(line)
    expect(notesOf(ran)).toContain(lastRoundNote(last as Sha))
    expect(worked.phase?._tag).toBe("ToMerge")
    expect(offered).toEqual([id])
    expect(handed).toEqual([])
  })

  test("a fail defers it to triage, with no second round", async () => {
    const { ran, offered, handed } = await working((doing) => [
      threeRoundsThenFix(doing),
      [...round(doing), fix(doing), defer(doing)],
    ])
    const worked = workedOf(ran)
    expect(sentTexts(ran)).toHaveLength(2)
    expect(ran.log.filter((each) => each === line)).toHaveLength(1)
    expect(worked.phase?._tag).toBe("Deferred")
    expect(offered).toEqual([])
    expect(handed).toEqual([expect.objectContaining({ ticket: id, how: "the worker deferred it" })])
  })
})

describe("a deferral handled as before", () => {
  test("with no commit since the last round", async () => {
    const { ran, handed } = await working((doing) => [
      [
        fix(doing),
        ...round(doing),
        fix(doing),
        ...round(doing),
        fix(doing),
        ...round(doing),
      ].concat(defer(doing)),
    ])
    expect(workedOf(ran).phase?._tag).toBe("Deferred")
    expect(sentTexts(ran)).toHaveLength(1)
    expect(ran.log).not.toContain(line)
    expect(handed).toHaveLength(1)
  })

  test("before a third round", async () => {
    const { ran, handed } = await working((doing) => [
      [fix(doing), ...round(doing), fix(doing), ...round(doing), fix(doing), defer(doing)],
    ])
    expect(workedOf(ran).phase?._tag).toBe("Deferred")
    expect(sentTexts(ran)).toHaveLength(1)
    expect(ran.log).not.toContain(line)
    expect(handed).toHaveLength(1)
  })
})
