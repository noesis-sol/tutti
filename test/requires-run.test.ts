// A run checks the project's requires list as it starts (src/run/requires.ts), as orchestra 0.9.1's:
// before its first ticket and any worker it carries over. What is met is said on a REQUIRES line
// under the START block; what is still missing stops the run with REQUIREMENTS_MISSING, exit 2,
// nothing started.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Queue } from "effect"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { Requirement } from "../src/project/settings.ts"
import { line } from "../src/run/log.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { type State, Store } from "../src/services/Store.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-requires-run-")))

/** A whole run on main with `requires`, its one ticket ready to start. */
const runs = (repo: string, requires: ReadonlyArray<Requirement>): Promise<Ran<Outcome>> =>
  scenario(
    {
      config: { repo, settings: { ...defaultSettings, requires } },
      backlog: backlog().ticket("t-1").seeds,
      git: { dir: repo },
    },
    run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
  )

const exitCode = (ran: Ran<Outcome>): number | undefined =>
  ran.exit._tag === "Success" ? ran.exit.value.exitCode : undefined

describe("the requires list at a run's start", () => {
  test("a missing requirement stops the run before its first ticket: REQUIREMENTS_MISSING, exit 2", async () => {
    const repo = folder()
    const ran = await runs(repo, [
      { name: "met-one", check: "true", install: "false" },
      { name: "license", check: "false", manual: "accept the licence in the app" },
    ])
    expect(exitCode(ran)).toBe(2)
    expectLog(ran, [
      "START tutti 0.1.0-test",
      "  REQUIRES: checking 2 requirements",
      "  REQUIRES: met-one met",
      /^REQUIREMENTS_MISSING: license \(accept the licence in the app\); meet it \(each entry of 'requires' in \.tutti\/settings\.json says how\), then run again$/,
    ])
    expect(ran.sent).toEqual([])
    expect(ran.log.some((each) => /\bt-1\b/.test(each))).toBe(false)
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "stop", detail: "REQUIREMENTS_MISSING" }),
    )
  })

  test("an install that meets its requirement lets the run go on, its output kept", async () => {
    const repo = folder()
    const marker = join(repo, "installed")
    const ran = await runs(repo, [
      { name: "tool", check: `test -f ${marker}`, install: `echo installing; touch ${marker}` },
    ])
    expect(ran.log).toContain(`  REQUIRES: installing tool: echo installing; touch ${marker}`)
    expect(ran.log).toContain(
      `  REQUIRES: tool (installed with 'echo installing; touch ${marker}') installed`,
    )
    expect(ran.log.some((each) => each.startsWith("REQUIREMENTS_MISSING"))).toBe(false)
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(join(repo, ".tutti", "run", "requires-tool.log"), "utf8")).toBe(
      "installing\n",
    )
  })

  test("an install that fails says why and where its output is", async () => {
    const repo = folder()
    const ran = await runs(repo, [
      { name: "tool", check: "false", install: "echo nope >&2; exit 3" },
    ])
    expect(exitCode(ran)).toBe(2)
    const log = join(repo, ".tutti", "run", "requires-tool.log")
    expect(ran.log).toContain(
      `REQUIREMENTS_MISSING: tool ('echo nope >&2; exit 3' failed: exit status 3; its output is in ${log}); meet it (each entry of 'requires' in .tutti/settings.json says how), then run again`,
    )
    expect(readFileSync(log, "utf8")).toBe("nope\n")
  })

  test("a worker the last run left isn't resumed while a requirement is missing, and stays saved", async () => {
    const repo = folder()
    const saved: State = {
      version: 1,
      tickets: {
        "t-1": {
          session: "session-t-1",
          worktree: join(repo, "wt", "t-1"),
          branch: "tutti/t-1",
          suspended: "quit",
          phase: "Stopped",
          resumes: 0,
          metadata: {},
        },
      },
    }
    let after: State | undefined
    const ran = await scenario(
      {
        config: {
          repo,
          settings: { ...defaultSettings, requires: [{ name: "x", check: "false", manual: "m" }] },
        },
        backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
        git: { dir: repo },
        state: saved,
      },
      Effect.gen(function* () {
        const outcome = yield* run({ version: "0.1.0-test", base: "main" })
        after = yield* (yield* Store).state
        return outcome
      }),
    )
    expect(exitCode(ran)).toBe(2)
    expect(ran.sent).toEqual([])
    expect(after?.tickets["t-1"]).toEqual(saved.tickets["t-1"])
  })

  test("a quit during an install stops it, and the run quits with nothing started", async () => {
    const repo = folder()
    const started = join(repo, "started")
    const quits = Effect.runSync(Queue.unbounded<QuitRequest>())
    const ran = await scenario(
      {
        config: {
          repo,
          settings: {
            ...defaultSettings,
            requires: [{ name: "slow", check: "false", install: `touch ${started}; sleep 60` }],
          },
        },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
      },
      Effect.gen(function* () {
        // Asked once the install has begun.
        yield* Effect.forkChild(
          Effect.gen(function* () {
            while (!existsSync(started)) yield* Effect.promise(() => Bun.sleep(10))
            yield* Queue.offer(quits, quitBy("SIGINT"))
          }),
        )
        return yield* run({ version: "0.1.0-test", base: "main", quits })
      }),
    )
    expect(exitCode(ran)).toBe(130)
    expect(ran.log.some((each) => each.startsWith("REQUIREMENTS_MISSING"))).toBe(false)
    expect(ran.log.at(-1)).toStartWith("INTERRUPTED: quit with Ctrl+C")
    expect(ran.sent).toEqual([])
  })

  test("a run with no requirements says nothing of them", async () => {
    const ran = await runs(folder(), [])
    expect(ran.log.some((each) => each.includes("REQUIRES"))).toBe(false)
  })
})
