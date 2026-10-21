// The run's notifications (§ 7.9) as whole runs send them, read from the harness's captured
// notices: a stop, a quit, the full check failing, a question, a title cut to 60 characters, and
// none for a run with nothing to run. notices.test.ts has what each record says.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Console, Duration, Effect, Fiber, Queue } from "effect"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { line } from "../src/run/log.ts"
import { endIfNothing } from "../src/run/nothing.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import {
  awaitInterrupt,
  bash,
  claimsAndCloses,
  defers,
  filesQuestion,
  gone,
  interruptedResult,
  type SessionScript,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { type Script as ChecksScript, passed } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, expectExitCode, type Ran, scenario, type World } from "./harness.ts"

setDefaultTimeout(30_000)

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-run-notifications-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What a ticket's worker's commands do to the in-memory Beads and git. */
const commands = (world: World, root: string, id: string) => ({
  claim: orDie(world.beads.update(id, { claim: true })),
  commit: orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x" })),
  close: orDie(world.beads.close(id, "done")),
})

/** How a ticket's worker goes. */
type How = "finishes" | "defers" | "pauses" | "asks" | "quits"

const sessions = (
  world: World,
  root: string,
  id: string,
  how: How,
  quits: Queue.Queue<QuitRequest>,
): ReadonlyArray<SessionScript> => {
  const does = commands(world, root, id)
  switch (how) {
    case "finishes":
      return [claimsAndCloses(id, does)]
    case "defers":
      return [defers(id, { claim: does.claim, defer: orDie(world.beads.defer(id)) })]
    case "pauses":
      // It goes, is resumed once and goes again: PAUSED.
      return [[...turn([step(does.claim)]).slice(0, -2), gone("exit 1")], [gone("exit 1")]]
    case "asks":
      return [
        filesQuestion(id, {
          claim: does.claim,
          file: orDie(
            Effect.andThen(
              world.beads.create({
                title: "Which name should the flag have?",
                labels: ["human"],
                blocks: [id],
              }),
              world.beads.update(id, { status: "open" }),
            ),
          ),
        }),
      ]
    case "quits":
      return [
        turn(
          [
            ...bash(`bd update ${id} --claim`, does.claim),
            step(Effect.asVoid(Queue.offer(quits, quitBy("SIGINT")))),
            awaitInterrupt,
          ],
          interruptedResult,
        ),
      ]
  }
}

interface Plan {
  readonly backlog: ReadonlyArray<Seed>
  readonly workers: Readonly<Record<string, How>>
  readonly config?: Partial<AppConfigValue>
  readonly checks?: ChecksScript
}

/** A whole run on main, one worker at a time, each ticket's worker going as `workers` says. */
const runs = (plan: Plan): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const quits = Effect.runSync(Queue.unbounded<QuitRequest>())
  const config = plan.config ?? {}
  return scenario(
    {
      config: {
        settings: { ...appConfig().settings, concurrent: 1 },
        ...config,
        repo,
      },
      backlog: plan.backlog,
      git: { dir: repo },
      worktrees: { root },
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) =>
        Object.fromEntries(
          Object.entries(plan.workers).map(([id, how]) => [
            id,
            sessions(world, root, id, how, quits),
          ]),
        ),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of Object.keys(plan.workers)) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti`], quits }),
      )
      return yield* Fiber.join(fiber)
    }),
  )
}

const fullCommand = "scripts/check-full.sh"

/** The settings with a full check, and a setup before it. */
const withFullCheck = (): Partial<AppConfigValue> => {
  const { settings } = appConfig()
  return {
    settings: {
      ...settings,
      concurrent: 1,
      checks: {
        ...settings.checks,
        full: { command: fullCommand, timeout: Duration.minutes(60) },
        setup: { ...settings.checks.setup, command: "bun install" },
      },
    },
  }
}

const failed = (check: "full" | "setup", suite: string | null) =>
  new CheckFailed({
    check,
    command: check === "full" ? fullCommand : "bun install",
    exitCode: 1,
    outputFile: "/dev/null",
    failingLines: [],
    lastLines: [],
    suites: suite === null ? [] : [suite],
    suite,
    flaky: [],
    flakyCount: 0,
  })

/** A console that prints nothing. */
const quiet: Console.Console = Object.assign(Object.create(globalThis.console), { log: () => {} })

describe("a whole run notifies", () => {
  test("a stop, with the ticket it is on, and not that it finished", async () => {
    const ran = await runs({
      backlog: backlog().ticket("t-1", { title: "Add a flag" }).ticket("t-2").seeds,
      workers: { "t-1": "finishes", "t-2": "pauses" },
    })
    expectExitCode(ran, 3)
    expect(ran.notices).toEqual(["Closed t-1 · Add a flag", "Stopped: PAUSED on t-2"])
  })

  test("a quit, once, as INTERRUPTED", async () => {
    const ran = await runs({
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "quits" },
    })
    expectExitCode(ran, 130)
    expect(ran.notices).toEqual(["Stopped: INTERRUPTED"])
  })

  test("a question a worker filed, by its title", async () => {
    const ran = await runs({
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "asks" },
    })
    expect(ran.notices).toEqual([
      "t-1 needs your answer · Which name should the flag have?",
      "Finished the run · no tickets closed",
    ])
  })

  test("a title over 60 characters cut with …", async () => {
    const title = `Add ${"a very long ".repeat(8)}flag`
    const ran = await runs({
      backlog: backlog().ticket("t-1", { title }).seeds,
      workers: { "t-1": "finishes" },
    })
    const [closed] = ran.notices
    expect(closed).toStartWith("Closed t-1 · Add a very long")
    expect(closed).toEndWith("…")
    expect([...(closed ?? "").slice("Closed t-1 · ".length)].length).toBeLessThanOrEqual(60)
    expect(ran.notices.at(-1)).toBe("Finished the run · 1 ticket closed")
  })

  test("the full check failing in a suite, after the run finished", async () => {
    const ran = await runs({
      config: withFullCheck(),
      backlog: backlog().ticket("t-1", { title: "One" }).seeds,
      workers: { "t-1": "finishes" },
      checks: { full: [failed("full", "e2e")] },
    })
    expect(ran.notices).toEqual([
      "Closed t-1 · One",
      "Finished the run · 1 ticket closed",
      "Full check failed · e2e",
    ])
  })

  test("the full check's setup failing", async () => {
    const ran = await runs({
      config: withFullCheck(),
      backlog: backlog().ticket("t-1", { title: "One" }).seeds,
      workers: { "t-1": "finishes" },
      // The setup in t-1's new worktree passes; the one before the full check fails.
      checks: { setup: [passed("setup"), failed("setup", null)] },
    })
    expect(ran.notices.at(-1)).toBe("Full check failed · setup")
  })

  test("nothing for a run with nothing to run", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("t-1", { status: "closed" }).ticket("t-2", { status: "closed" })
          .seeds,
      },
      Effect.gen(function* () {
        const repository = yield* Repository
        return yield* endIfNothing(
          {
            scope: null,
            filter: { excludeTypes: [] },
            repo: repository.dir,
            base: "main",
            carried: new Set(),
            unmerged: new Set(),
            held: () => Effect.succeed(undefined),
          },
          { _tag: "Plain" },
        )
      }).pipe(Effect.provideService(Console.Console, quiet)),
    )
    expect(ran.exit._tag === "Success" && ran.exit.value).toBe(0)
    expect(ran.events.map((record) => record.kind)).toEqual(["done", "end"])
    expect(ran.notices).toEqual([])
  })
})
