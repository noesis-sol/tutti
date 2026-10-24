// A worker's share of the cores counts the workers of the machine's other runs (tutti-kkb.37), as
// orchestra 0.9.0's does: the run keeps how many they run as it reads their registrations
// (OtherWorkers), and each session takes its share as it starts, up to --machine-workers.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Fiber, Layer, Ref, Schedule } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { coresVariable } from "../src/agent/env.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { line } from "../src/run/log.ts"
import {
  OtherWorkers,
  type OtherWorkersValue,
  otherWorkers,
  type ProcessCheck,
  Processes,
} from "../src/run/machine.ts"
import { run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { advance, backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

// The live host's test starts the fake Claude Code as a process: up to a second on an idle machine.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** The TUTTI_CORES the fake logged, one for each session it started, in order. */
const loggedShares = (file: string): ReadonlyArray<string | null> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((text) => text !== "")
        .map((text) => JSON.parse(text))
        .flatMap((entry) => (entry.env === undefined ? [] : [entry.env[coresVariable]]))
    : []

/** Waits until the fake has logged `n` sessions' environments. */
const logged = (file: string, n: number) =>
  Effect.sync(() => loggedShares(file)).pipe(
    Effect.repeat({
      until: (found) => found.length >= n,
      schedule: Schedule.spaced(Duration.millis(20)),
    }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(10),
      orElse: () => Effect.die("the fake never logged its environment"),
    }),
  )

/**
 * The TUTTI_CORES of three workers started one after another on 12 cores, in a run of 2 with
 * `machineWorkers` as its cap, the other runs running each of `others` workers as each starts.
 */
const sharesAsOthersRun = (others: readonly [number, number, number], machineWorkers = 0) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-machine-core-share-"))
  const log = join(dir, "fake.jsonl")
  const config = appConfig(
    { claude: fake, machineWorkers, settings: { ...defaultSettings, concurrent: 2 } },
    dir,
  )
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify({ log, env: [coresVariable] }) },
    cores: 12,
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const agents = yield* AgentHost
      const machine = yield* OtherWorkers
      for (const [i, n] of others.entries()) {
        yield* machine.set(n)
        yield* agents.start(`t-${i}`, { sessionId: crypto.randomUUID(), cwd: dir })
        yield* logged(log, i + 1)
      }
      return loggedShares(log)
    }).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(
            Layer.mergeAll(
              logLayer(),
              eventsLayer(),
              configLayer(config),
              otherWorkers,
              BunServices.layer,
            ),
          ),
        ),
      ),
    ),
  )
}

describe("a worker's share of the cores", () => {
  test("counts the other runs' workers as each worker starts, and is kept once taken", async () => {
    // 12 cores among 2 workers, then 2 and 4 of the others', then 2 and 1.
    expect(await sharesAsOthersRun([0, 4, 1])).toEqual(["6", "2", "4"])
  })

  test("counts no more workers than --machine-workers", async () => {
    // 2 and 4 of the others' are 6 workers, capped at 3; 2 and 1 are 3.
    expect(await sharesAsOthersRun([0, 4, 1], 3)).toEqual(["6", "4", "4"])
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-machine-core-share-${name}-`)))

/** The other run, orchestra's, as its registration says, with `running` workers. */
const other = (running: number) =>
  JSON.stringify({
    pid: 4242,
    repo: "/work/other",
    concurrent: 3,
    started: new Date().toISOString(),
    running,
  })

/** Every process runs, its start unknown: the other run is going. */
const everyoneAlive: ProcessCheck = { alive: () => true, start: () => Effect.succeed(null) }

describe("the run", () => {
  test("keeps the other runs' workers as it reads them, before a ticket starts", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const runs = folder("runs")
    writeFileSync(join(runs, "run-4242-1.json"), other(3))
    // What the run set, and how many of its workers had started by then.
    const sets: Array<{ readonly others: number; readonly started: number }> = []
    const ran = await scenario(
      {
        config: { repo, worktrees: root, runs, settings: { ...appConfig().settings } },
        backlog: backlog().ticket("a", { priority: 0 }).seeds,
        git: { dir: repo, files: { "README.md": "tutti\n" } },
        worktrees: { root },
        scripts: (world: World) => ({
          a: [
            turn(
              [
                ...bash(
                  "bd update a --claim",
                  Effect.orDie(world.beads.update("a", { claim: true })),
                ),
                sleep("1 minute"),
                ...bash(
                  'git commit -am "Change (a)"',
                  Effect.orDie(
                    world.repository.commit(join(root, "a"), "Change (a)", { "a.txt": "a\n" }),
                  ),
                ),
                ...bash("bd close a", Effect.orDie(world.beads.close("a", "done"))),
              ],
              result("Closed a."),
            ),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
        const count = yield* Ref.make(0)
        // Done once the run has set its first count, so the file changes only after that read.
        const first = yield* Deferred.make<void>()
        const agents = yield* AgentHost
        const recording: OtherWorkersValue = {
          others: Ref.get(count),
          set: (n) =>
            Effect.gen(function* () {
              const known = yield* Effect.orElseSucceed(agents.current("a"), () => null)
              sets.push({ others: n, started: known === null ? 0 : 1 })
              yield* Ref.set(count, n)
              yield* Deferred.succeed(first, undefined)
            }),
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }).pipe(
            Effect.provideService(Processes, everyoneAlive),
            Effect.provideService(OtherWorkers, recording),
          ),
        )
        yield* Deferred.await(first)
        writeFileSync(join(runs, "run-4242-1.json"), other(1))
        for (let i = 0; i < 20; i++) {
          yield* Effect.promise(() => Bun.sleep(20))
          yield* advance("10 seconds")
        }
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done" })
    expect(sets[0]).toEqual({ others: 3, started: 0 })
    expect(sets.at(-1)?.others).toBe(1)
  })
})
