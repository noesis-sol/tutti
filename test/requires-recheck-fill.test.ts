// A merge that changes the requires list while a look fills the free slots (src/run/run.ts's
// requiresChecked): the list is checked before that fill starts another ticket, not at the next
// look only, as § 5 item 7 has it ("before the next ticket starts").

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import type { Requirement } from "../src/project/settings.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readAgainAfter } from "../src/run/schedule.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, run as step, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed } from "../src/testing/Checks.ts"
import { texts } from "../src/testing/Log.ts"
import { advance, backlog, expectExitCode, expectLog, type Ran, scenario } from "./harness.ts"

const settingsFile = ".tutti/settings.json"
const defaults = appConfig().settings

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-requires-recheck-fill-${name}-`)))

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

const license: Requirement = {
  name: "license",
  check: "false",
  manual: "accept the licence in the app",
}

const startedTickets = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.sent.flatMap((sent) => (sent._tag === "Started" ? [sent.ticket] : []))

describe("the requires list a merge changes during a look's fill", () => {
  test("is checked before the fill starts the next ticket", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    // a's merge waits in its check until the look's fill, its read of bd ready failing, waits to
    // read it again: the merge changes the list after the look began, before the fill starts b.
    const merging = Effect.runSync(Deferred.make<void>())
    const ran = await scenario(
      {
        config: {
          repo,
          settings: {
            ...defaults,
            concurrent: 1,
            requires: [],
            checks: {
              ...defaults.checks,
              setup: { ...defaults.checks.setup, command: null },
              fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
            },
          },
        },
        backlog: backlog().ticket("a").ticket("b").seeds,
        git: { dir: repo },
        worktrees: { root },
        checks: { fast: [Effect.as(Deferred.await(merging), passed("fast"))] },
        scripts: (world) => ({
          a: [
            turn(
              [
                ...bash(
                  "bd update a --claim",
                  Effect.asVoid(Effect.orDie(world.beads.update("a" as TicketId, { claim: true }))),
                ),
                ...bash(
                  'git commit -am "Change (a)"',
                  Effect.asVoid(
                    Effect.orDie(
                      world.repository.commit(join(root, "a"), "Change (a)", {
                        [settingsFile]: JSON.stringify({
                          checks: { setup: { command: null } },
                          requires: [license],
                        }),
                      }),
                    ),
                  ),
                ),
                ...bash(
                  "bd close a",
                  Effect.asVoid(Effect.orDie(world.beads.close("a" as TicketId, "done"))),
                ),
                // The next fill's read of bd ready fails, and the fill reads it again later.
                step(world.backlog.fail("ready")),
              ],
              result("Closed a."),
            ),
          ],
          b: [turn([], result("Done."))],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["a", "b"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        yield* untilLogged(/could not read the queue \(try 1 /)
        yield* Deferred.succeed(merging, undefined)
        yield* untilLogged(/a's merge changed the requirements/)
        yield* advance(readAgainAfter)
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran as Ran<Outcome>, 2)
    expectLog(ran, [
      /could not read the queue \(try 1 /,
      /^ {2}REQUIRES: a's merge changed the requirements/,
      "  REQUIRES: checking 1 requirement",
      `REQUIREMENTS_MISSING: license (accept the licence in the app); meet it (each entry of 'requires' in ${settingsFile} says how), then run again`,
    ])
    expect(startedTickets(ran)).toEqual(["a"])
  })
})
