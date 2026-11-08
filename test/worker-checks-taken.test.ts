// The checks a merge changes reach the workers (AgentHost's takeChecks, src/run/setup.ts's
// takeSettings): a worker started after is told the check the run has now in its standing rules
// (checkNote), and gets Bash's timeouts for the merge check's time limit now (bashTimeouts); one
// resumed after is told the new note in its resume's message (tutti-2hr4).

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import type { WorkerState } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { workerCheckLog } from "../src/project/prompt.ts"
import type { WorkerChecks } from "../src/project/settings.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, Recording, result, turn } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { Repository } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { backlog, expectExitCode, scenario } from "./harness.ts"
import { workersIn } from "./workerEnv.ts"

// Each test starts the fake Claude Code as a process, up to a second on an idle machine.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

const prompt = { text: "Work on TICKET_ID.", file: null }

/** The run's checks as it starts: a merge check of 30 minutes, no worker's own check. */
const startup: WorkerChecks = {
  own: { command: null },
  fast: { command: "scripts/check-fast.sh", timeout: Duration.minutes(30) },
  full: defaultSettings.checks.full,
}

/** The checks a merge gave it: a worker's own check, and a merge check of 7 minutes. */
const taken: WorkerChecks = {
  own: { command: "scripts/check-own.sh" },
  fast: { command: "scripts/check-fast.sh", timeout: Duration.minutes(7) },
  full: defaultSettings.checks.full,
}

/** The lines the fake wrote to `file`, parsed. */
const linesIn = (file: string): ReadonlyArray<Record<string, unknown>> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : []

/** What each of the fake's sessions was started with: its environment and its appended rules. */
const startsIn = (file: string) => {
  const starts: Array<{ timeout: unknown; rules: unknown }> = []
  for (const entry of linesIn(file)) {
    if (entry.env !== undefined) {
      const env = entry.env as Record<string, unknown>
      starts.push({ timeout: env.BASH_DEFAULT_TIMEOUT_MS, rules: undefined })
    }
    const request = (entry.stdin as { request?: Record<string, unknown> } | undefined)?.request
    const last = starts.at(-1)
    if (request?.subtype === "initialize" && last !== undefined) {
      last.rules = request.appendSystemPrompt ?? request.append_system_prompt
    }
  }
  return starts
}

/** The contents of the user messages the fake read, in order. */
const usersIn = (file: string): ReadonlyArray<unknown> =>
  linesIn(file).flatMap((e) => {
    const stdin = e.stdin as { type?: string; message?: { content: unknown } } | undefined
    return stdin?.type === "user" ? [stdin.message?.content] : []
  })

/** Runs `effect` with the live host over the fake, in a fresh folder, the run's checks `startup`. */
const withHost = <A, E>(
  effect: (where: { dir: string; log: string }) => Effect.Effect<A, E, AgentHost>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-worker-checks-taken-"))
  const log = join(dir, "fake.jsonl")
  const settings = { ...defaultSettings, checks: { ...defaultSettings.checks, ...startup } }
  const host = liveLayer({
    prompt,
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false } },
  })
  return Effect.runPromise(
    effect({ dir, log }).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(waitForTest),
              transcriptsLayer(),
              ClaudeCode.layer.pipe(
                Layer.provide(
                  workersIn({
                    ...testEnv,
                    FAKE_CLAUDE_SCENARIO: JSON.stringify({ log, env: ["BASH_DEFAULT_TIMEOUT_MS"] }),
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              logLayer(),
              eventsLayer(),
              configLayer(appConfig({ claude: fake, settings }, dir)),
              BunServices.layer,
            ),
          ),
        ),
      ),
    ),
  )
}

/** Waits, at most 10 s, for the ticket's worker to be Idle. */
const idle = (ticket: TicketId) =>
  Effect.gen(function* () {
    const found = yield* (yield* AgentHost).state(ticket).pipe(
      Stream.filter((state: WorkerState) => state._tag === "Idle"),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die(`${ticket} never became Idle`),
      }),
    )
    return Option.getOrThrow(found)
  })

/** Starts the ticket's worker in `dir`, has it take `text` and closes it once its turn is over. */
const works = (ticket: string, dir: string, text: string, how: "start" | "resume") =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const id = ticket as TicketId
    const session = { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir }
    const message = { text, from: "clientComposed" } as const
    if (how === "start") {
      yield* host.start(id, session)
      yield* host.send(id, message)
    } else {
      yield* host.resume(id, session, message)
    }
    yield* idle(id)
    yield* host.close(id)
  })

/** Waits, at most 10 s, for the fake to have logged `count` starts. */
const started = (log: string, count: number) =>
  Effect.sync(() => startsIn(log)).pipe(
    Effect.repeat({
      until: (all) => all.length >= count && all.every((each) => each.rules !== undefined),
      schedule: Schedule.spaced(Duration.millis(20)),
    }),
    Effect.timeout(Duration.seconds(10)),
  )

const minutes = (n: number) => String(n * 60_000)

describe("the checks a merge changed, as workers have them", () => {
  test("a worker started after is told the check now and kept to its time limit", async () => {
    const starts = await withHost(({ dir, log }) =>
      Effect.gen(function* () {
        yield* works("t-1", dir, "first", "start")
        yield* (yield* AgentHost).takeChecks(taken)
        yield* works("t-2", dir, "second", "start")
        return yield* started(log, 2)
      }),
    )
    expect(starts.map((each) => each.timeout)).toEqual([minutes(30), minutes(7)])
    expect(starts[0]?.rules).toContain(`'scripts/check-fast.sh > ${workerCheckLog} 2>&1;`)
    expect(starts[1]?.rules).toContain(`'scripts/check-own.sh > ${workerCheckLog} 2>&1;`)
    expect(starts[1]?.rules).not.toContain("'scripts/check-fast.sh >")
  })

  test("a worker resumed after is told the new check in its message", async () => {
    const users = await withHost(({ dir, log }) =>
      Effect.gen(function* () {
        yield* works("t-1", dir, "first", "start")
        yield* (yield* AgentHost).takeChecks(taken)
        yield* works("t-1", dir, "again", "resume")
        return usersIn(log)
      }),
    )
    expect(users[0]).toBe("first")
    expect(users[1]).toContain(`'scripts/check-own.sh > ${workerCheckLog} 2>&1;`)
    expect(String(users[1]).endsWith("again")).toBe(true)
  })
})

const settingsFile = ".tutti/settings.json"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-worker-checks-taken-${name}-`)))

describe("a merge that changes the checks", () => {
  test("hands the workers its own check and the merge check, a flag's time limit kept", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const committed = {
      fast: { command: "scripts/check-fast.sh" },
      own: { command: "scripts/check-own.sh" },
    }
    const ran = await scenario(
      {
        config: {
          repo,
          settings: {
            ...defaultSettings,
            concurrent: 1,
            checks: {
              ...defaultSettings.checks,
              fast: { command: "scripts/check-fast.sh", timeout: Duration.minutes(45) },
            },
          },
        },
        backlog: backlog().chain("a", "b").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => ({
          a: [
            turn(
              [
                ...bash(
                  "bd update a --claim",
                  Effect.asVoid(Effect.orDie(world.beads.update("a" as TicketId, { claim: true }))),
                ),
                ...bash(
                  `git commit -am "Checks (a)"`,
                  Effect.asVoid(
                    Effect.orDie(
                      world.repository.commit(join(root, "a"), "Checks (a)", {
                        [settingsFile]: `${JSON.stringify({ checks: committed })}\n`,
                      }),
                    ),
                  ),
                ),
                ...bash(
                  "bd close a",
                  Effect.asVoid(Effect.orDie(world.beads.close("a" as TicketId, "done"))),
                ),
              ],
              result("Closed a."),
            ),
          ],
          b: [
            turn(
              [
                ...bash(
                  "bd close b",
                  Effect.asVoid(Effect.orDie(world.beads.close("b" as TicketId, "done"))),
                ),
              ],
              result("Closed b."),
            ),
          ],
        }),
      },
      Effect.gen(function* () {
        yield* (yield* Repository).commit(repo, "Settings", {
          [settingsFile]: `${JSON.stringify({ checks: { fast: { command: "scripts/check-fast.sh" } } })}\n`,
        })
        const git = yield* Git
        for (const id of ["a", "b"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const outcome = yield* run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
        })
        return { ...outcome, checks: yield* (yield* Recording).checks }
      }),
    )
    expectExitCode(ran, 0)
    expect(ran.log).toContain(
      `  SETUP: a's merge changed ${settingsFile} on main: checks.own is 'scripts/check-own.sh' from now on`,
    )
    if (ran.exit._tag !== "Success") throw new Error("the run failed")
    expect(
      ran.exit.value.checks.map((each) => ({
        own: each.own.command,
        fast: each.fast.command,
        minutes: Duration.toMinutes(each.fast.timeout),
      })),
    ).toEqual([{ own: "scripts/check-own.sh", fast: "scripts/check-fast.sh", minutes: 45 }])
  })
})
