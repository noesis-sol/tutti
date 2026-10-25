// FileTicket through the run's one consumer (fileTicket.ts, § 7.5, tutti-g0wd): the screen asks to
// file what was written for a's worker as a ticket; the run files it with bd, discovered from a,
// logs FILED and puts it in the screen's filings under the view's uuid. A run limited to one ticket
// doesn't start it.

import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Queue, type Scope, SubscriptionRef } from "effect"
import { UiCommand } from "../src/run/commands.ts"
import { FileOutcome, type TicketFiling } from "../src/run/fileTicket.ts"
import { line, Tag } from "../src/run/log.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { init, result, run, sessionState, wait } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed, type Scripted } from "../src/testing/Checks.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, type Env, type Scripts, scenario, type World } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-filed-${name}-`)))

const followUp = "Also cover the empty case"

test("FileTicket files the text with bd, logs FILED and says so in the filings", async () => {
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
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 }, limit: 1 },
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
      let filings: ReadonlyArray<TicketFiling> = []
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
      yield* send(UiCommand.FileTicket({ from: "a" as TicketId, text: followUp, uuid: "u-1" }))
      yield* until("the filing", () =>
        Effect.map(SubscriptionRef.get(inputs.filings), (now) => {
          filings = now
          return now.length > 0
        }),
      )
      yield* Deferred.succeed(gate, undefined)
      for (let i = 0; i < 3; i++) {
        yield* advance("1 minute")
        yield* Effect.promise(() => Bun.sleep(3))
      }
      return { outcome: yield* Fiber.join(fiber), filings }
    }) as Effect.Effect<
      { readonly outcome: Outcome; readonly filings: ReadonlyArray<TicketFiling> },
      unknown,
      Env | Scope.Scope
    >,
  )
  expect(ran.exit._tag).toBe("Success")
  const made = ran.issues.find((issue) => issue.id !== "a")
  expect(made?.title).toBe(followUp)
  expect(made?.status).toBe("open")
  expect(made?.dependencies.map(({ id, type }) => ({ id, type }))).toEqual([
    { id: "a" as TicketId, type: "discovered-from" },
  ])
  const filings = ran.exit._tag === "Success" ? ran.exit.value.filings : []
  expect(filings).toEqual([
    {
      uuid: "u-1",
      from: "a" as TicketId,
      outcome: FileOutcome.Filed({ id: made?.id ?? ("" as TicketId), title: followUp }),
    },
  ])
  expect(ran.log).toContain(
    `  ${Tag.filed}: ${made?.id ?? ""}, written for a's worker after it had finished`,
  )
  // The log names the ticket, never the text.
  expect(ran.log.some((each) => each.includes(followUp))).toBe(false)
  // Limited to one ticket, the run doesn't start the one filed.
  expect(ran.sent.some((sent) => sent.ticket === made?.id)).toBe(false)
}, 30_000)
