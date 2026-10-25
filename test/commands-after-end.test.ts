// The screen's commands after the run's end: a whole run with its screen ends, by the end-of-run
// box's `q`, with a's conflict handed back and waiting for its steered worker (Blocked); HandBackNow
// sent after the end is dropped, so nothing merges or steers after the end record's phases are read.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Queue, type Scope, SubscriptionRef } from "effect"
import type { MessageUuid } from "../src/agent/AgentHost.ts"
import { Attention } from "../src/agent/Attention.ts"
import { UiCommand } from "../src/run/commands.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
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
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-commands-after-end-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/**
 * a's worker: it asks to run a command (you steer it meanwhile), lands a conflicting change on main
 * as it works, commits its own and closes the ticket; your message then has a turn of its own.
 * Resumed for a hand-back, it would resolve the conflict.
 */
const scripts = (world: World, repo: string, root: string) => {
  const worktree = join(root, "a")
  const first: SessionScript = [
    wait,
    init(),
    sessionState("running"),
    run(orDie(world.beads.update("a" as TicketId, { claim: true }))),
    canUseTool("Bash", { command: "ls" }),
    run(orDie(world.repository.commit(repo, "Land something else", { "a.txt": "main's a\n" }))),
    run(orDie(world.repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" }))),
    run(orDie(world.beads.close("a" as TicketId, "done"))),
    result("Closed a."),
    wait,
    init(),
    result(),
    sessionState("idle"),
  ]
  const resumed: SessionScript = turn([
    run(orDie(world.repository.continueRebase(worktree, { "a.txt": "both\n" }))),
  ])
  return { a: [first, resumed] }
}

interface Seen {
  readonly outcome: Outcome
  /** The log's lines once the run had ended. */
  readonly atEnd: ReadonlyArray<string>
  /** The log's lines after HandBackNow, sent after the end, and some time. */
  readonly after: ReadonlyArray<string>
  /** The screen's hand-backs then. */
  readonly handBacks: ReadonlyArray<string>
}

describe("the screen's commands after the run's end", () => {
  test("HandBackNow sent after the end is dropped: nothing merges after the summary", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const ran: Ran<Seen> = await scenario(
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
        let outcome: Outcome | undefined
        const fiber = yield* Effect.forkChild(
          runTutti({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard,
          }).pipe(
            Effect.tap((ended) =>
              Effect.sync(() => {
                outcome = ended
              }),
            ),
          ),
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
        const requestOf = Effect.map(attention.current, (all) =>
          all.find((request) => request.ticket === "a"),
        )
        for (let i = 0; i < 60; i++) {
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(1))
          if ((yield* attention.current).length > 0) break
        }
        yield* until("a's request", () => Effect.map(requestOf, (request) => request !== undefined))
        yield* send(
          UiCommand.SendMessage({
            ticket: "a" as TicketId,
            text: "Keep it small",
            uuid: "11111111-2222-4333-8444-555555555555" as MessageUuid,
          }),
        )
        const request = yield* requestOf
        if (request === undefined) throw new Error("a has no request open")
        yield* send(UiCommand.Answer({ requestId: request.id, answer: { _tag: "Allow" } }))
        // a's conflict waits for its steered worker; nothing else is left, so the run waits for it
        // (§ 4.3) until the end-of-run box's `q` ends it.
        for (let i = 0; i < 400; i++) {
          if ((yield* SubscriptionRef.get(inputs.handBacks)).includes("a")) break
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(2))
        }
        yield* send(UiCommand.EndRun())
        for (let i = 0; i < 400 && outcome === undefined; i++) {
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(2))
        }
        const ended = yield* Fiber.join(fiber)
        const atEnd = yield* texts
        yield* send(UiCommand.HandBackNow({ ticket: "a" as TicketId }))
        for (let i = 0; i < 30; i++) {
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(2))
        }
        return {
          outcome: ended,
          atEnd,
          after: yield* texts,
          handBacks: yield* SubscriptionRef.get(inputs.handBacks),
        } satisfies Seen
      }) as Effect.Effect<Seen, unknown, Env | Scope.Scope>,
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const { outcome, atEnd, after, handBacks } = ran.exit.value
    expect(outcome.phases.a?._tag).toBe("Blocked")
    expect(atEnd.some((each) => each.startsWith("READY_EMPTY after 1 tickets"))).toBe(true)
    expect(after).toEqual(atEnd)
    expect(handBacks).toEqual(["a"])
  }, 30_000)
})
