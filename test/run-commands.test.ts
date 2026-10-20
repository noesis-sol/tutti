// The screen's commands the run takes (§ 3.5), as whole runs with a dashboard under TestClock:
// each is resolved against the ledger and the open requests as it is taken, and one that no longer
// names anything is dropped. OpenWorker and CloseWorker move the screen, Answer answers the open
// request, Drain and Undrain wind the run down and back up, and Quit now quits.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Queue, SubscriptionRef } from "effect"
import { Attention } from "../src/agent/Attention.ts"
import { UiCommand } from "../src/run/commands.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { type Dashboard, Screen, type ScreenInputs } from "../src/run/screen.ts"
import { Git } from "../src/services/Git.ts"
import { bash, canUseTool, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-commands-${name}-`)))

/** Claims its ticket, asks to run `rm -rf build`, commits and closes it, as a worker does. */
const finishes = (world: World, root: string, id: string): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      canUseTool("Bash", { command: "rm -rf build" }),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** Moves TestClock on by `total`, a minute at a time, letting the run catch up after each. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const minutes = Duration.toMinutes(Duration.fromInputUnsafe(total))
    for (let i = 0; i < minutes; i++) {
      yield* advance("1 minute")
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

/** Waits, in real time, until `found` holds. */
const until = <R>(what: string, found: Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if (yield* found) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`waited in vain for ${what}: ${(yield* texts).join("\n")}`)
  })

const untilLogged = (pattern: RegExp) =>
  until(
    `a line matching ${pattern}`,
    Effect.map(texts, (all) => all.some((text) => pattern.test(text))),
  )

/** The ID of the request `ticket`'s worker has open, once it has one. */
const requestOf = (ticket: string) =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const open = () =>
      Effect.map(attention.current, (all) => all.find((request) => request.ticket === ticket))
    yield* until(
      `a request from ${ticket}`,
      Effect.map(open(), (request) => request !== undefined),
    )
    return ((yield* open()) as { readonly id: string }).id
  })

/** What the scenario's `during` does beside the run, given the dashboard's inputs. */
type During = (inputs: ScreenInputs) => Effect.Effect<void, unknown, Env>

/** Puts `command` in the queue and waits, in real time, for the run to take it. */
const send = (inputs: ScreenInputs, command: UiCommand) =>
  Effect.gen(function* () {
    yield* Queue.offer(inputs.commands, command)
    yield* until(
      "the command to be taken",
      Effect.map(Queue.size(inputs.commands), (n) => n === 0),
    )
    yield* Effect.promise(() => Bun.sleep(10))
  })

/** A whole run on main with a dashboard, each ticket's worktree made in git first. */
const runs = (
  tickets: ReadonlyArray<string>,
  concurrent: number,
  during: During,
): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = { ...appConfig().settings, concurrent }
  return scenario(
    {
      config: { repo, settings },
      backlog: tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      scripts: (world: World): Scripts =>
        Object.fromEntries(tickets.map((id) => [id, [finishes(world, root, id)]])),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
        }),
      )
      yield* until(
        "the dashboard",
        Effect.sync(() => shown !== undefined),
      )
      yield* during(shown as ScreenInputs)
      return yield* Fiber.join(fiber)
    }),
  )
}

/** Answers `ticket`'s open request through the screen, with Allow. */
const allow = (inputs: ScreenInputs, ticket: string) =>
  Effect.flatMap(requestOf(ticket), (requestId) =>
    send(inputs, UiCommand.Answer({ requestId, answer: { _tag: "Allow" } })),
  )

describe("the run takes the screen's commands (§ 3.5)", () => {
  test("OpenWorker and CloseWorker move the screen; a stale one is dropped", async () => {
    const screens: Array<Screen> = []
    const ran = await runs(["a"], 1, (inputs) =>
      Effect.gen(function* () {
        yield* passes("1 minute")
        yield* requestOf("a")
        const now = Effect.flatMap(SubscriptionRef.get(inputs.screen), (screen) =>
          Effect.sync(() => screens.push(screen)),
        )
        yield* send(inputs, UiCommand.OpenWorker({ worker: 1 }))
        yield* now
        yield* send(inputs, UiCommand.CloseWorker())
        yield* now
        // No worker 2: the command is dropped, and the screen stays as it is.
        yield* send(inputs, UiCommand.OpenWorker({ worker: 2 }))
        yield* now
        yield* send(inputs, UiCommand.OpenWorker({ worker: 1 }))
        yield* allow(inputs, "a")
        yield* passes("2 minutes")
      }),
    )
    expectExitCode(ran, 0)
    expect(screens).toEqual([Screen.Worker({ worker: 1 }), Screen.Dashboard(), Screen.Dashboard()])
  }, 30_000)

  test("Answer answers the open request; one no longer open is dropped", async () => {
    const ran = await runs(["a"], 1, (inputs) =>
      Effect.gen(function* () {
        yield* passes("1 minute")
        const requestId = yield* requestOf("a")
        yield* send(inputs, UiCommand.Answer({ requestId, answer: { _tag: "Allow" } }))
        // Answered already: dropped, and the run goes on.
        yield* send(inputs, UiCommand.Answer({ requestId, answer: { _tag: "Deny" } }))
        yield* passes("2 minutes")
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done" })
    expectLog(ran, [
      /^ {2}PERMISSION: a's worker: Bash\(rm -rf build\) allowed$/,
      /^ {2}a closed .*; merged into main/,
    ])
    expect(ran.log.some((text) => text.includes("denied"))).toBe(false)
  }, 30_000)

  test("Drain winds the run down, from the dashboard", async () => {
    const ran = await runs(["a", "b"], 1, (inputs) =>
      Effect.gen(function* () {
        yield* passes("1 minute")
        yield* requestOf("a")
        yield* send(inputs, UiCommand.Drain())
        yield* untilLogged(/^DRAIN: /)
        yield* allow(inputs, "a")
        yield* passes("2 minutes")
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Queued" })
    expectLog(ran, [
      "DRAIN: stopping after a finishes: no new tickets will start, asked from the dashboard",
      /^ {2}a closed .*; merged into main/,
      "DRAINED after 1 tickets",
    ])
  }, 30_000)

  test("Undrain takes tickets again", async () => {
    const ran = await runs(["a", "b"], 1, (inputs) =>
      Effect.gen(function* () {
        yield* passes("1 minute")
        yield* requestOf("a")
        yield* send(inputs, UiCommand.Drain())
        yield* send(inputs, UiCommand.Undrain())
        yield* untilLogged(/^DRAIN cancelled/)
        yield* allow(inputs, "a")
        yield* passes("1 minute")
        yield* allow(inputs, "b")
        yield* passes("2 minutes")
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expectLog(ran, [
      /^DRAIN: /,
      "DRAIN cancelled: taking new tickets again, asked from the dashboard",
      "READY_EMPTY after 2 tickets",
    ])
  }, 30_000)

  test("Quit now quits from the dashboard; without now it leaves it to the quit box", async () => {
    const ran = await runs(["a"], 1, (inputs) =>
      Effect.gen(function* () {
        yield* passes("1 minute")
        yield* requestOf("a")
        yield* send(inputs, UiCommand.Quit({ now: false }))
        expect((yield* texts).some((text) => text.startsWith("QUIT"))).toBe(false)
        yield* send(inputs, UiCommand.Quit({ now: true }))
        yield* untilLogged(/^QUIT from the dashboard/)
        yield* passes("1 minute")
      }),
    )
    expectExitCode(ran, 130)
    expectLog(ran, [/^QUIT from the dashboard: no new tickets; interrupting the workers of a/])
  }, 30_000)
})
