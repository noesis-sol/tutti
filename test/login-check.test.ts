// The login check (§ 4.13, loginCheck.ts), over whole runs: a worker's turn refused for Claude's
// login holds the run, rather than quit it, while the usage probe's turn checks the login again; a
// check that passes lifts the hold, the refused worker is sent again what its turn was to tell it,
// and the run goes on; a turn refused again soon after a check passed quits the run at once, LOGIN.
// Every check failing quits it as before: test/login-refused.test.ts.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { retellKey } from "../src/run/login.ts"
import { loginBackHead, loginBackText } from "../src/run/loginCheck.ts"
import { run } from "../src/run/run.ts"
import type { Dashboard } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store } from "../src/services/Store.ts"
import {
  claimsAndCloses,
  emit,
  type Sent,
  type SessionScript,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

// Whole runs, some waiting out a hold, take up to a second on an idle machine.
setDefaultTimeout(30_000)

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-login-check-${name}-`)))

const refusal = "Failed to authenticate: OAuth session expired and could not be refreshed"

/** A turn refused for the login, once `before` has run, as login-refused.test.ts has it. */
const refused = (before: Effect.Effect<void> = Effect.void): SessionScript =>
  turn(
    [step(before), emit({ type: "assistant", error: "authentication_failed" })],
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: refusal,
      api_error_status: null,
      terminal_reason: "api_error",
      num_turns: 1,
    }),
  )

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** How many log lines match `pattern`. */
const logged = (pattern: RegExp) =>
  Effect.map(texts, (all) => all.filter((text) => pattern.test(text)).length)

/** Waits, in real time, until `count` log lines match `pattern`. */
const untilLogged = (pattern: RegExp, count = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* logged(pattern)) >= count) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no ${count} log lines matched ${pattern}`)
  })

/** Lets the run go as far as it can, in real time, without the clock moving. */
const settle = Effect.promise(() => Bun.sleep(50))

/** A ticket's metadata in state.json. */
type Metadata = State["tickets"][string]["metadata"] | undefined

/** What state.json says of `ticket`'s metadata now. */
const metadataOf = (ticket: string) =>
  Effect.map(
    Effect.flatMap(Store, (store) => store.state),
    (state: State) => state.tickets[ticket]?.metadata,
  )

/** A whole run on main with a dashboard, each ticket's worktree made in git first. */
const runs = (plan: {
  readonly tickets: ReadonlyArray<string>
  readonly concurrent?: number
  readonly scripts: (world: World, root: string) => Scripts
  readonly during: Effect.Effect<void, unknown, Env>
}) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = { ...appConfig().settings, concurrent: plan.concurrent ?? 1 }
  return scenario(
    {
      config: { repo, settings },
      backlog: plan.tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const dashboard: Dashboard = () => Effect.void
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [], dashboard }),
      )
      yield* plan.during
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The messages tutti sent `ticket`'s worker, by their text. */
const messagesTo = (sent: ReadonlyArray<Sent>, ticket: string): ReadonlyArray<string> =>
  sent.flatMap((each) =>
    each._tag === "Message" && each.ticket === ticket ? [String(each.message.message.content)] : [],
  )

const holds = /^LOGIN_CHECK: t-1's turn was refused for Claude's login/
const lifted = /^LOGIN_CHECK: lifted: /

describe("a turn refused for Claude's login", () => {
  test("holds the run while a probe checks the login, and goes on once it passes", async () => {
    const metadata: Array<Metadata> = []
    const t2Started = Deferred.makeUnsafe<void>()
    const held = Deferred.makeUnsafe<void>()
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      concurrent: 2,
      scripts: (world, root) => {
        // Its prompt, system/init and running: its turn under way.
        const t2 = finishes(world, root, "t-2" as TicketId)
        const [begun, rest] = [t2.slice(0, 3), t2.slice(3)]
        return {
          // Its first turn is refused once t-2 has started, so that both are dispatched before
          // the hold; sent its first message again, it finishes.
          "t-1": [
            [...refused(Deferred.await(t2Started)), ...finishes(world, root, "t-1" as TicketId)],
          ],
          // t-2 runs on through the hold and finishes in it: its slot frees, but t-3 waits.
          "t-2": [
            [
              ...begun,
              step(Effect.asVoid(Deferred.done(t2Started, Exit.void))),
              step(Deferred.await(held)),
              ...rest,
            ],
          ],
          "t-3": [finishes(world, root, "t-3" as TicketId)],
        }
      },
      during: Effect.gen(function* () {
        yield* untilLogged(holds)
        // What the refused turn was to tell its worker is saved as it is refused.
        metadata.push(yield* metadataOf("t-1"))
        yield* Effect.asVoid(Deferred.done(held, Exit.void))
        yield* untilLogged(/^ {2}t-2 closed /)
        yield* settle
        expect(yield* logged(/dispatching: t-3/)).toBe(0)
        // The check, 30s after the hold, passes: the hold lifts.
        yield* advance("30 seconds")
        yield* untilLogged(lifted)
        yield* untilLogged(/^ {2}t-1 closed /)
        metadata.push(yield* metadataOf("t-1"))
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      `LOGIN_CHECK: t-1's turn was refused for Claude's login (${refusal}); no new tickets while tutti checks the login again, in 30s`,
      "LOGIN_CHECK: lifted: Claude's login passed a check 30s after the hold",
      "  t-1: Claude's login passes again; its worker is sent its refused turn's messages again",
      /dispatching: t-3/,
    ])
    expect(ran.log.some((text) => /^LOGIN:|deferred|ENVIRONMENT/.test(text))).toBe(false)
    // The hold's line and its lift, as hold records.
    const records = ran.events.flatMap((event) => (event.kind === "hold" ? [event] : []))
    expect(records.map((event) => event.lifted === true)).toEqual([false, true])
    // Sent its first message again, after the head; its saved texts forgotten as they are.
    const [first, again] = messagesTo(ran.sent, "t-1")
    expect(first).toBeDefined()
    expect(again).toBe(loginBackText([first ?? ""]))
    expect(again).toStartWith(loginBackHead)
    const [saved, after] = metadata
    expect(saved).toEqual({ [retellKey]: [first ?? ""] })
    expect(after?.[retellKey]).toBeUndefined()
  })

  test("refused again soon after a check passed, the run quits LOGIN at once", async () => {
    const metadata: Array<Metadata> = []
    const ran = await runs({
      tickets: ["t-1"],
      scripts: () => ({ "t-1": [[...refused(), ...refused()]] }),
      during: Effect.gen(function* () {
        yield* untilLogged(holds)
        yield* advance("30 seconds")
        yield* untilLogged(lifted)
        yield* untilLogged(/^LOGIN_CHECK: t-1's turn was refused for Claude's login again/)
        metadata.push(yield* metadataOf("t-1"))
      }),
    })
    expectExitCode(ran, 2)
    expect(ran.log).toContain(
      `LOGIN_CHECK: t-1's turn was refused for Claude's login again (${refusal}), within 10m of a check of it passing: the run stops, its workers stopped and their sessions kept for the next run`,
    )
    // Only the one check: the second refusal isn't checked again.
    expect(ran.log.filter((text) => holds.test(text))).toHaveLength(2)
    expect(ran.log.filter((text) => lifted.test(text))).toHaveLength(1)
    // What it saves for the next run is the first message, not the message that sent it again.
    const [first] = messagesTo(ran.sent, "t-1")
    expect(metadata).toEqual([{ [retellKey]: [first ?? ""] }])
  })
})
