// An overnight run doesn't wait on a steered worker's conflict (§ 4.3, tutti-epza.9): with a
// dashboard, a conflict hand-back waiting for its steered worker keeps a run open on the end-of-run
// box, until you hand it over or `q` ends the run; overnight nobody is there to, so the run leaves
// the ticket Blocked, as a plain run does, and ends. decide's cases, then a whole run under TestClock.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Queue, type Scope } from "effect"
import type { MessageUuid } from "../src/agent/AgentHost.ts"
import { Attention } from "../src/agent/Attention.ts"
import { line, Tag } from "../src/core/log.ts"
import { UiCommand } from "../src/run/commands.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import { decide, End, endOfRunBox, type Snapshot } from "../src/run/runEnd.ts"
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
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

const c = "c" as TicketId

/** Everything else done, c Blocked on a conflict whose hand-back waits for its steered worker. */
const snapshot = (more: Partial<Snapshot> = {}): Snapshot => ({
  mergedBefore: true,
  running: new Set(),
  tickets: new Map([
    [c, { ticket: c, phase: TicketPhase.Blocked({ why: Tag.mergeConflict }), handBack: true }],
  ]),
  overLimit: new Set(),
  asking: [],
  canTake: true,
  resuming: false,
  answering: false,
  settled: true,
  triagePending: 0,
  dashboard: true,
  held: false,
  usageHeld: false,
  endAsked: false,
  ...more,
})

describe("a steered worker's conflict in an overnight run", () => {
  test("doesn't wait on you: the run ends, no end-of-run box", () => {
    expect(decide(snapshot({ overnight: true }))).toEqual(End.Done({ asked: false }))
    expect(endOfRunBox(snapshot({ overnight: true }))).toBeNull()
  })

  test("waits on you in a run that isn't overnight, with a dashboard", () => {
    expect(decide(snapshot())).toEqual(End.WaitOnYou({ tickets: [c] }))
    expect(decide(snapshot({ overnight: false }))).toEqual(End.WaitOnYou({ tickets: [c] }))
  })

  test("an open request still waits on you overnight", () => {
    const a = "a" as TicketId
    const asking = snapshot({
      overnight: true,
      running: new Set([a]),
      tickets: new Map([
        [a, { ticket: a, phase: TicketPhase.Working() }],
        [c, { ticket: c, phase: TicketPhase.Blocked({ why: Tag.mergeConflict }), handBack: true }],
      ]),
      asking: [a],
    })
    expect(decide(asking)).toEqual(End.WaitOnYou({ tickets: [a] }))
  })
})

// A whole overnight run with its screen: a's worker, steered by your message, finishes with a
// conflict with main, whose hand-back waits in its view; nothing else is left, and the run ends on
// its own, a Blocked.

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-overnight-steered-conflict-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/**
 * a's worker: it asks to run a command (you steer it meanwhile), lands a conflicting change on main
 * as it works, commits its own and closes the ticket; your message then has a turn of its own.
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
  return { a: [first] }
}

describe("an overnight run with a steered worker's conflict", () => {
  test("ends on its own, the ticket Blocked MERGE_CONFLICT", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const ran: Ran<Outcome> = await scenario(
      {
        config: {
          repo,
          overnight: true,
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
        const requestOf = () =>
          Effect.map(attention.current, (all) => all.find((request) => request.ticket === "a"))
        for (let i = 0; i < 60; i++) {
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(1))
          if ((yield* requestOf()) !== undefined) break
        }
        yield* until("a's request", () => Effect.map(requestOf(), (open) => open !== undefined))
        yield* send(
          UiCommand.SendMessage({
            ticket: "a" as TicketId,
            text: "Keep it small",
            uuid: "11111111-2222-4333-8444-555555555555" as MessageUuid,
          }),
        )
        const request = yield* requestOf()
        if (request === undefined) throw new Error("a has no request open")
        yield* send(UiCommand.Answer({ requestId: request.id, answer: { _tag: "Allow" } }))
        // Nothing hands the conflict over nor presses `q`: the run ends by itself.
        for (let i = 0; i < 30; i++) {
          if (fiber.pollUnsafe() !== undefined) break
          yield* advance("1 minute")
          yield* Effect.promise(() => Bun.sleep(3))
        }
        if (fiber.pollUnsafe() === undefined) {
          throw new Error(`the run still waits after 30m: ${(yield* texts).join("\n")}`)
        }
        return yield* Fiber.join(fiber)
      }) as Effect.Effect<Outcome, unknown, Env | Scope.Scope>,
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const outcome = ran.exit.value
    expect(outcome.phases.a).toEqual(TicketPhase.Blocked({ why: Tag.mergeConflict }))
    expect(
      ran.log.some((text) =>
        /MERGE_CONFLICT: a closed, .*not handed back to its worker: you have steered its worker/.test(
          text,
        ),
      ),
    ).toBe(true)
  }, 30_000)
})
