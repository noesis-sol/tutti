// The worker view's ticket through the run (§ 7.5, tutti-cxgo.1): the run keeps the issue bd gave
// as it took the ticket up on its ledger entry, so the view's card has its description at once, and
// ReadTicket, which the view offers as its whole ticket opens, reads it again with bd show, so the
// notes added during the run reach the card. Ticket text is sanitised as it enters RunView.
import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Queue, type Scope, SubscriptionRef } from "effect"
import { UiCommand } from "../src/run/commands.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import type { TicketText } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { init, result, run, sessionState, wait } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, type Env, type Scripts, scenario, type World } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-read-${name}-`)))

test("the card has the issue from the start, and ReadTicket brings the notes added since", async () => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const working = Deferred.makeUnsafe<void>()
  const gate = Deferred.makeUnsafe<void>()
  const ran = await scenario(
    {
      config: { repo, settings: { ...appConfig().settings, concurrent: 1 }, limit: 1 },
      backlog: backlog().ticket("a", {
        description: "Read the second file \x1b]0;title\x07too.",
        acceptance: "- Both files read",
        type: "bug",
        priority: 1,
      }).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World): Scripts => ({
        a: [
          [
            wait,
            init(),
            sessionState("running"),
            run(Deferred.succeed(working, undefined)),
            run(Deferred.await(gate)),
            run(Effect.asVoid(Effect.orDie(world.beads.close("a", "nothing to do")))),
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
      const issueOf = Effect.map(
        SubscriptionRef.get(inputs.view),
        (view) => view.cards.find((card) => card.ticket === "a")?.issue,
      )
      yield* until("a's worker", () => Deferred.isDone(working))
      yield* until("a's card", () => Effect.map(issueOf, (issue) => issue !== undefined))
      const first = (yield* issueOf) as TicketText
      yield* Effect.orDie((yield* Beads).update("a", { appendNotes: "Found the second file." }))
      yield* Queue.offer(inputs.commands, UiCommand.ReadTicket({ ticket: "a" }))
      yield* until("the notes", () =>
        Effect.map(issueOf, (issue) => issue?.notes.includes("Found the second file.") === true),
      )
      const again = (yield* issueOf) as TicketText
      yield* Deferred.succeed(gate, undefined)
      for (let i = 0; i < 3; i++) {
        yield* advance("1 minute")
        yield* Effect.promise(() => Bun.sleep(3))
      }
      return { outcome: yield* Fiber.join(fiber), first, again }
    }) as Effect.Effect<
      { readonly outcome: Outcome; readonly first: TicketText; readonly again: TicketText },
      unknown,
      Env | Scope.Scope
    >,
  )
  expect(ran.exit._tag).toBe("Success")
  if (ran.exit._tag !== "Success") return
  const { first, again } = ran.exit.value
  expect(first).toMatchObject({
    type: "bug",
    priority: 1,
    description: "Read the second file too.",
    acceptance: "- Both files read",
    notes: "",
  })
  expect(again.notes).toContain("Found the second file.")
  expect(again.description).toBe("Read the second file too.")
}, 30_000)
