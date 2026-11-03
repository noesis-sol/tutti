// BLOCKED and --auto-answer with a time (tutti-epza.8): a question tutti will answer once it has
// waited doesn't hold the run past blockedAfter, so an overnight run doesn't set its ticket aside
// and a plain one doesn't end with it, before the answer comes; a permission request still does.
// BLOCKED counts the time the machine is awake, as the other limits do (Wake.ts).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Fiber, Layer, Scope, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { Attention, type AutoAnswerOptions, blockedAfter } from "../src/agent/Attention.ts"
import { make as makeBlockedWatch } from "../src/run/blockedWatch.ts"
import { blockedTickets } from "../src/run/holds.ts"
import { make as makeHoldsGate } from "../src/run/holdsGate.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { emptyStatus, type Status } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  result,
  type SessionScript,
  sleep,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { Asleep, layer as asleepLayer } from "../src/testing/Wake.ts"
import { openFibers } from "./fibers.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  scenario,
  type World,
} from "./harness.ts"

const tenMinutes = Duration.minutes(10)

const question = {
  questions: [
    {
      question: "Which store?",
      header: "Store",
      options: [{ label: "Postgres" }, { label: "SQLite (Recommended)" }],
      multiSelect: false,
    },
  ],
}

const sdkOptions = (): Parameters<CanUseTool>[2] => ({
  signal: new AbortController().signal,
  toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
  requestId: "req",
})

/** Gives the fibers a moment, the clock still. */
const moment = Effect.promise(() => Bun.sleep(5))

/** Moves TestClock on by `n` minutes, a minute at a time, the fibers given a moment after each. */
const minutes = (n: number) =>
  Effect.forEach(
    Array.from({ length: n }),
    () => Effect.andThen(TestClock.adjust(Duration.minutes(1)), moment),
    { discard: true },
  )

describe("BLOCKED, as blockedWatch keeps it", () => {
  /**
   * Runs `body` beside a BlockedWatch over Attention, its --auto-answer as `auto` says, under
   * TestClock and the test Wake; `held` gives the tickets BLOCKED holds now.
   */
  const watching = <A>(
    auto: AutoAnswerOptions | undefined,
    body: (
      held: Effect.Effect<ReadonlyArray<string>>,
    ) => Effect.Effect<A, never, Attention | Asleep>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const status = yield* SubscriptionRef.make<Status>(emptyStatus)
        const holds = yield* makeHoldsGate({ status, notices: [], wakeUp: Effect.void })
        yield* makeBlockedWatch({
          holds,
          ended: Effect.succeed(false),
          wakeUp: () => Effect.void,
          watch: (effect) => Effect.forkIn(effect, scope),
        })
        return yield* body(
          Effect.map(holds.now, (now) => [...blockedTickets(now)] as ReadonlyArray<string>),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(
          attentionLayer(waitForTest, auto).pipe(
            Layer.provideMerge(ledgerLayer()),
            Layer.provideMerge(Layer.merge(TestClock.layer(), asleepLayer)),
          ),
        ),
      ),
    )

  /** `ticket`'s worker calls `tool` with `input`; its result, as a promise. */
  const asks = (ticket: string, tool: string, input: Record<string, unknown>) =>
    Effect.gen(function* () {
      const canUse = yield* (yield* Attention).request(ticket as TicketId, openFibers())
      const answered = canUse(tool, input, sdkOptions())
      yield* moment
      return answered
    })

  test("a question --auto-answer takes after a time holds nothing; a permission request does", async () => {
    const seen = await watching({ after: tenMinutes }, (held) =>
      Effect.gen(function* () {
        const answered = yield* asks("q-1", "AskUserQuestion", question)
        yield* asks("p-1", "Bash", { command: "rm -rf build" })
        yield* minutes(Duration.toMinutes(blockedAfter))
        const atBlockedAfter = yield* held
        yield* minutes(5)
        const before = yield* held
        const open = (yield* (yield* Attention).current).map((request): string => request.ticket)
        yield* minutes(1)
        return {
          atBlockedAfter,
          before,
          open,
          after: yield* held,
          result: yield* Effect.promise(() => answered),
        }
      }),
    )
    expect(seen.atBlockedAfter).toEqual(["p-1"])
    // At 9 minutes the question is still open, and holds nothing.
    expect(seen.open).toEqual(["q-1", "p-1"])
    expect(seen.before).toEqual(["p-1"])
    expect(seen.after).toEqual(["p-1"])
    expect(seen.result).toMatchObject({ behavior: "allow" })
  })

  test("a question --auto-answer leaves to you holds the run after blockedAfter", async () => {
    const seen = await watching(
      { after: tenMinutes, answers: (ticket) => ticket !== "q-1" },
      (held) =>
        Effect.gen(function* () {
          yield* asks("q-1", "AskUserQuestion", question)
          yield* minutes(Duration.toMinutes(blockedAfter) - 1)
          const before = yield* held
          yield* minutes(1)
          return { before, after: yield* held }
        }),
    )
    expect(seen).toEqual({ before: [], after: ["q-1"] })
  })

  test("the time the machine sleeps isn't counted, so a request doesn't trip at the wake", async () => {
    const seen = await watching(undefined, (held) =>
      Effect.gen(function* () {
        yield* asks("p-1", "Bash", { command: "rm -rf build" })
        yield* minutes(1)
        yield* (yield* Asleep).asleep(Duration.minutes(30))
        yield* moment
        const atWake = yield* held
        yield* minutes(Duration.toMinutes(blockedAfter) - 2)
        const before = yield* held
        yield* minutes(1)
        return { atWake, before, after: yield* held }
      }),
    )
    expect(seen).toEqual({ atWake: [], before: [], after: ["p-1"] })
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-blocked-auto-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket, asks `question`, then commits and closes it, as a worker does. */
const asksThenFinishes = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      canUseTool("AskUserQuestion", question),
      sleep("1 minute"),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}: ${(yield* texts).join("\n")}`)
  })

/** Moves TestClock on by `n` minutes, a minute at a time, letting the run catch up after each. */
const passes = (n: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < n; i++) {
      yield* advance("1 minute")
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

/** A whole run of t-1, plain or overnight, whose worker asks a question, with --auto-answer=10m. */
const runs = (overnight: boolean) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: { repo, settings: appConfig().settings, overnight, autoAnswer: tenMinutes },
      backlog: backlog().ticket("t-1").seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      scripts: (world: World) => ({ "t-1": [asksThenFinishes(world, root, "t-1" as TicketId)] }),
    },
    Effect.gen(function* () {
      yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
        branch: "tutti/t-1",
        base: "main",
      })
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* untilLogged(/QUESTION: t-1's worker asks: Which store\?/)
      yield* passes(9)
      const open = fiber.pollUnsafe() === undefined
      yield* passes(1)
      yield* untilLogged(/by --auto-answer$/)
      yield* passes(3)
      const outcome = yield* Fiber.join(fiber)
      return { ...outcome, open }
    }),
  )
}

describe("a run with --auto-answer=10m and a worker's question", () => {
  for (const overnight of [false, true]) {
    test(`${overnight ? "overnight" : "plain"}: waits for the answer, and the ticket merges`, async () => {
      const ran = await runs(overnight)
      expectExitCode(ran, 0)
      expectPhases(ran, { "t-1": "Done" })
      if (ran.exit._tag === "Success") expect(ran.exit.value.open).toBe(true)
      expectLog(ran, [
        /^ {2}QUESTION: t-1's worker: Which store\? answered \(SQLite \(Recommended\)\), the recommended option, by --auto-answer$/,
        /^ {2}t-1 closed .*; merged into main/,
      ])
      expect(ran.log.some((text) => /BLOCKED|set aside|deferred/.test(text))).toBe(false)
    })
  }
})
