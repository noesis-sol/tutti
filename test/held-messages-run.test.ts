// Messages held while their ticket merges, through the run's one consumer (held.ts, § 4.3): the
// screen's SendMessage to the worker of a ticket whose check runs is held, not sent; Interrupt
// cancels what is held; and once the ticket has merged, what is still held is not sent.

import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Queue, type Scope } from "effect"
import type { MessageUuid } from "../src/agent/AgentHost.ts"
import { UiCommand } from "../src/run/commands.ts"
import { cancelledLine, heldLine, notSentLine } from "../src/run/held.ts"
import { line, Tag } from "../src/run/log.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { init, result, run, sessionState, wait } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed, type Scripted } from "../src/testing/Checks.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-held-${name}-`)))

const first = "Also cover the empty case"
const second = "And the other one 🙂"

/** What a's worker was sent of yours: not client_composed. */
const yoursTo = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === "a" && sent.message.client_composed !== true
      ? [sent.message.uuid]
      : [],
  )

test("SendMessage during a merge is held, Interrupt cancels it, and once merged none is sent", async () => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const checking = Deferred.makeUnsafe<void>()
  const gate = Deferred.makeUnsafe<void>()
  const gated: Scripted = Effect.andThen(
    Deferred.succeed(checking, undefined),
    Effect.as(Deferred.await(gate), passed("fast")),
  )
  const ran = await scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
      backlog: backlog().ticket("a").seeds,
      git: { dir: repo },
      worktrees: { root },
      checks: { fast: [gated] },
      scripts: (world: World): Scripts => ({
        a: [
          [
            wait,
            init(),
            sessionState("running"),
            run(Effect.asVoid(Effect.orDie(world.beads.update("a" as TicketId, { claim: true })))),
            run(
              Effect.asVoid(
                Effect.orDie(
                  world.repository.commit(join(root, "a"), "Change (a)", { "a.txt": "a\n" }),
                ),
              ),
            ),
            // Main moves on meanwhile, so a is rebased and checked as it merges.
            run(
              Effect.asVoid(
                Effect.orDie(
                  world.repository.commit(repo, "Land something else", { "b.txt": "b\n" }),
                ),
              ),
            ),
            run(Effect.asVoid(Effect.orDie(world.beads.close("a" as TicketId, "done")))),
            result("Closed a."),
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
      const until = (what: string, found: () => Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          for (let i = 0; i < 2000; i++) {
            if (yield* found()) return
            yield* advance("1 second")
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
      yield* until("a's check", () => Deferred.isDone(checking))
      yield* send(
        UiCommand.SendMessage({ ticket: "a" as TicketId, text: first, uuid: "u-1" as MessageUuid }),
      )
      yield* send(UiCommand.Interrupt({ ticket: "a" as TicketId }))
      yield* send(
        UiCommand.SendMessage({
          ticket: "a" as TicketId,
          text: second,
          uuid: "u-2" as MessageUuid,
        }),
      )
      yield* Deferred.succeed(gate, undefined)
      for (let i = 0; i < 3; i++) {
        yield* advance("1 minute")
        yield* Effect.promise(() => Bun.sleep(3))
      }
      return yield* Fiber.join(fiber)
    }) as Effect.Effect<Outcome, unknown, Env | Scope.Scope>,
  )
  expectExitCode(ran, 0)
  expect(yoursTo(ran)).toEqual([])
  const merging = TicketPhase.Merging({ step: "check" })
  expectLog(ran, [
    `  ${Tag.steered}: a`,
    heldLine("a" as TicketId, first, merging),
    cancelledLine("a" as TicketId, 1),
    heldLine("a" as TicketId, second, merging),
    notSentLine("a" as TicketId, 1),
  ])
  expect(ran.log.some((each) => each.startsWith(`  ${Tag.message}:`))).toBe(false)
  expect(ran.log.some((each) => each.includes(first) || each.includes(second))).toBe(false)
}, 30_000)
