// Each hold is probed (§ 4.9): after PROBE_OK, an environment that fails again holds the run a second
// time, and that hold is probed too, twice as long after as the first (probeWait), rather than end
// the run unprobed. The tickets of the second row are reopened, as the first row's were; a second
// probe that fails ends the run ENVIRONMENT, exit 7.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { probeFile, probeWait, probeWorker } from "../src/run/environment.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { writeRunFile } from "../src/services/Worktrees.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-env2-${name}-`)))

/** A worker its environment fails: it ends its turn at once, without claiming or changing anything. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** The probe's session running its command, which writes `.tutti/run/probe` in `repo`. */
const probeRuns = (repo: string): SessionScript =>
  turn(bash("echo ok > .tutti/run/probe", Effect.orDie(writeRunFile(repo, probeFile, "ok\n"))))

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

const endLine =
  "ENVIRONMENT: the last 2 tickets (t-1, t-2) each settled within 2m of starting without being claimed or changed; a session probing the machine 20m later failed too: it stopped without running its command; check the machine, then restart"

describe("the wait before a probe", () => {
  test("doubles with each probe, up to an hour, or environment_hold.probe when it is longer", () => {
    const minutes = (after: Duration.Input, probes: number) =>
      Duration.toMinutes(probeWait(Duration.fromInputUnsafe(after), probes))
    expect([0, 1, 2, 3, 4, 50].map((probes) => minutes("10 minutes", probes))).toEqual([
      10, 20, 40, 60, 60, 60,
    ])
    expect([0, 1, 5].map((probes) => minutes("2 hours", probes))).toEqual([120, 120, 120])
  })
})

describe("the environment hold after PROBE_OK", () => {
  test("a second hold after PROBE_OK is probed 20m after; failing, it ends the run, exit 7", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    // t-3 comes after t-1 and t-2, so the row the second time is theirs again.
    const tickets = ["t-1", "t-2", "t-3"]
    const ran: Ran<Outcome> = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").ticket("t-3", { priority: 3 }).seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: {
          "t-1": [givesUp, givesUp],
          "t-2": [givesUp, givesUp],
          // The first probe runs its command; the second stops without running it.
          [probeWorker]: [probeRuns(repo), turn([])],
        },
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        yield* untilLogged(/^PROBE: /)
        yield* advance("10 minutes")
        yield* untilLogged(/^PROBE_OK: /)
        yield* untilLogged(/^PROBE: the run holds for the environment; in 20m /)
        yield* advance("20 minutes")
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 7)
    // The second row is reopened and waits, open in bd, for the next run; t-3 never started.
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Waiting", "t-3": "Queued" })
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      "[2] t-2 dispatching: t-2",
      "  t-1 reopened: its worker failed at once, like the tickets before it",
      "  t-2 reopened: its worker failed at once, like the tickets before it",
      /^PROBE: the run holds for the environment; in 10m /,
      `  probe session started in ${repo}`,
      "PROBE_OK: a session without a ticket ran a command 10m after the hold; taking tickets again",
      "  t-1: the probe passed; back in the queue",
      "  t-2: the probe passed; back in the queue",
      /^\[\d+\] t-1 dispatching: t-1$/,
      /^\[\d+\] t-2 dispatching: t-2$/,
      "  t-1 reopened: its worker failed at once, like the tickets before it",
      "  t-2 reopened: its worker failed at once, like the tickets before it",
      /^PROBE: the run holds for the environment; in 20m /,
      `  probe session started in ${repo}`,
      endLine,
    ])
    // Each hold is probed: the second 20m after, twice the first's wait.
    expect(ran.log.filter((text) => text.startsWith("PROBE: "))).toHaveLength(2)
    expect(ran.log.filter((text) => text.includes("probe session started"))).toHaveLength(2)
    expect(
      ran.sent.filter((sent) => sent._tag === "Started" && sent.ticket === probeWorker),
    ).toHaveLength(2)
    expect(ran.log.some((text) => text.includes("t-3 dispatching"))).toBe(false)
    expect(ran.events.filter((record) => record.kind === "reopened")).toHaveLength(4)
    expect(ran.events.filter((record) => record.kind === "probed")).toHaveLength(1)
    expect(ran.events.find((record) => record.kind === "end")).toMatchObject({ code: 7 })
    expect(ran.log.at(-1)).toBe(endLine)
    for (const id of ["t-1", "t-2"]) {
      expect(ran.issues.find((each) => each.id === id)?.status).toBe("open")
    }
  })
})
