// The probe runs the setup (§ 4.9): once its session has run its command, the run's setup command
// runs in a new worktree of the base's head, as a ticket's new worktree has it, the worktree removed
// after. A setup that fails there ends the run ENVIRONMENT, exit 7, rather than let the run take
// tickets whose setups fail again; one that passes has the run take tickets again.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { line } from "../src/core/log.ts"
import {
  probeFile,
  probeFolderPrefix,
  probeSetupLogName,
  probeWorker,
} from "../src/run/environment.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { runFolder, writeRunFile } from "../src/services/Worktrees.ts"
import {
  bash,
  claimsAndCloses,
  result,
  type SessionScript,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Script as ChecksScript } from "../src/testing/Checks.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-probe-setup-${name}-`)))

const setup = "bun install --frozen-lockfile"

/** A worker its environment fails: it ends its turn at once, without claiming or changing anything. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** The probe's session running its command, which writes `.tutti/run/probe` in `repo`. */
const probeRuns = (repo: string): SessionScript =>
  turn(bash("echo ok > .tutti/run/probe", Effect.orDie(writeRunFile(repo, probeFile, "ok\n"))))

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** The setup failing, saying bun's error. */
const setupFails = new CheckFailed({
  check: "setup",
  command: setup,
  exitCode: 1,
  outputFile: "/dev/null",
  failingLines: ["error: lockfile had changes, but lockfile is frozen"],
  lastLines: ["error: lockfile had changes, but lockfile is frozen"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

interface Places {
  readonly repo: string
  readonly root: string
}

/** A run of t-1, t-2 and t-3 on main, one at a time, with the setup `setup`, probed once. */
const runs = (
  checks: ChecksScript,
  scripts: (world: World, places: Places) => Scripts,
): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const defaults = appConfig().settings
  return scenario(
    {
      config: {
        repo: places.repo,
        settings: {
          ...defaults,
          concurrent: 1,
          checks: { ...defaults.checks, setup: { ...defaults.checks.setup, command: setup } },
        },
      },
      backlog: backlog().ticket("t-1").ticket("t-2").ticket("t-3", { priority: 3 }).seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      checks,
      scripts: (world: World) => scripts(world, places),
    },
    Effect.gen(function* () {
      const git = yield* Git
      mkdirSync(join(places.repo, runFolder), { recursive: true })
      for (const id of ["t-1", "t-2", "t-3"]) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* untilLogged(/^PROBE: /)
      yield* advance("10 minutes")
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

/** The setups the run ran in the probe's worktrees. */
const probeSetups = (ran: Ran<Outcome> & Places) =>
  ran.checkRuns.filter(
    (each) => each.check === "setup" && each.cwd.startsWith(join(ran.root, probeFolderPrefix)),
  )

/** The probe's worktrees, as the run added and removed them. */
const probeWorktrees = (ran: Ran<Outcome> & Places) =>
  ran.worktreeCalls.flatMap((call) =>
    (call.op === "addDetached" || call.op === "removeDetached") &&
    call.path.startsWith(join(ran.root, probeFolderPrefix))
      ? [[call.op, call.path] as const]
      : [],
  )

describe("the probe's setup", () => {
  test("failing in a new worktree of the base ends the run ENVIRONMENT, exit 7", async () => {
    // t-1's and t-2's setups pass, then the probe's fails.
    const ran = await runs(
      { setup: [{ exitCode: 0, output: "" }, { exitCode: 0, output: "" }, setupFails] },
      (_, places) => ({
        "t-1": [givesUp],
        "t-2": [givesUp],
        [probeWorker]: [probeRuns(places.repo)],
      }),
    )
    expectExitCode(ran, 7)
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Waiting", "t-3": "Queued" })
    const output = join(ran.repo, runFolder, probeSetupLogName)
    const [made] = probeWorktrees(ran)
    const path = made?.[1] ?? ""
    expectLog(ran, [
      `PROBE: the run holds for the environment; in 10m a session without a ticket runs a command in the main checkout, and '${setup}' runs in a new worktree of main; if both work, the run takes tickets again`,
      `  probe session started in ${ran.repo}`,
      `  probe: running '${setup}' in a new worktree of main (${path})`,
      `ENVIRONMENT: the last 2 tickets (t-1, t-2) each settled within 2m of starting without being claimed or changed; a session probing the machine 10m later ran its command, but the setup '${setup}' fails in a new worktree of main (the whole output is in ${output}); check the machine, then restart`,
    ])
    expect(probeSetups(ran).map((each) => [each.cwd, each.command, each.outputFile])).toEqual([
      [path, setup, output],
    ])
    // The worktree is removed once the setup has run.
    expect(probeWorktrees(ran)).toEqual([
      ["addDetached", path],
      ["removeDetached", path],
    ])
    expect(ran.log.some((text) => text.startsWith("PROBE_OK: "))).toBe(false)
  })

  test("passing has the run take tickets again", async () => {
    const ran = await runs({}, (world, places) => ({
      "t-1": [givesUp, finishes(world, places.root, "t-1" as TicketId)],
      "t-2": [givesUp, finishes(world, places.root, "t-2" as TicketId)],
      "t-3": [finishes(world, places.root, "t-3" as TicketId)],
      [probeWorker]: [probeRuns(places.repo)],
    }))
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      /^PROBE: the run holds for the environment; in 10m .* and 'bun install --frozen-lockfile' runs in a new worktree of main; /,
      /^ {2}probe: running 'bun install --frozen-lockfile' in a new worktree of main /,
      "PROBE_OK: a session without a ticket ran a command 10m after the hold; taking tickets again",
    ])
    expect(probeSetups(ran)).toHaveLength(1)
    expect(probeWorktrees(ran).map(([op]) => op)).toEqual(["addDetached", "removeDetached"])
  })
})
