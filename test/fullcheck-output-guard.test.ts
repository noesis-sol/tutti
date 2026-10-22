// A failed full check's whole output is read from its worktree's .tutti/run/ through the symlink
// guard: a symbolic link the check left in place of its output is refused, not followed into a file
// outside, and a named pipe is refused at once rather than holding the open on the JavaScript thread.
import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { fullCheckLogName } from "../src/run/fullcheck.ts"
import { logFile } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { CheckFailed, type Said, setupLogName } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { runFolder } from "../src/services/Worktrees.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Script, type Scripted } from "../src/testing/Checks.ts"
import { backlog, type Ran, scenario, type World } from "./harness.ts"

const fullCommand = "scripts/check-full.sh"
const setupCommand = "bun install"
const secret = "outside the worktree\n"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-fullcheck-guard-${name}-`)))

const mkfifo = (path: string) => {
  const made = Bun.spawnSync(["mkfifo", path])
  if (made.exitCode !== 0) throw new Error(`mkfifo ${path}: ${made.stderr.toString()}`)
}

const rescuers: Array<number> = []

afterEach(() => {
  for (const pid of rescuers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
})

/**
 * Opens the named pipe at `path` for reading and writing after two seconds, which ends an open of
 * it that waits for its other end: an open that waits fails its test on the time it took, rather
 * than holding the test run for good.
 */
const rescue = (path: string) => {
  const rescuer = Bun.spawn(["sh", "-c", 'sleep 2; exec 3<>"$1"; sleep 5', "rescuer", path], {
    stdout: "ignore",
    stderr: "ignore",
  })
  rescuers.push(rescuer.pid)
}

/** The settings with a full check, and a setup when `setup` is set. */
const config = (setup: boolean): Partial<AppConfigValue> => {
  const { settings } = appConfig()
  return {
    settings: {
      ...settings,
      checks: {
        ...settings.checks,
        full: { command: fullCommand, timeout: Duration.minutes(60) },
        setup: { ...settings.checks.setup, command: setup ? setupCommand : null },
      },
    },
  }
}

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: string) =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** A whole run on main in which t-1 merges and the full check runs; the main checkout's folder. */
const runs = async (
  checks: Script,
  setup = false,
): Promise<{ readonly ran: Ran<unknown>; readonly repo: string }> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const ran = await scenario(
    {
      config: { ...config(setup), repo },
      git: { dir: repo },
      worktrees: { root },
      backlog: backlog().ticket("t-1").seeds,
      checks,
      scripts: (world) => ({ "t-1": [finishes(world, root, "t-1")] }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
      return yield* Fiber.join(
        yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main" })),
      )
    }),
  )
  return { ran, repo }
}

const said = (suite: string | null): Said => ({
  failingLines: [],
  lastLines: ["FAIL: it broke"],
  suites: suite === null ? [] : [suite],
  suite,
  flaky: [],
  flakyCount: 0,
})

/**
 * A check of `kind` that prints its output to its file, then puts `swap(path)` in that file's place,
 * and fails.
 */
const failsLeaving =
  (kind: "setup" | "full", swap: (path: string) => void): Scripted =>
  (ran: CheckRun) =>
    Effect.suspend(() => {
      if (ran.outputFd !== undefined) writeSync(ran.outputFd, "SUITE: e2e\nFAIL: it broke\n")
      const path = join(ran.cwd, runFolder, kind === "full" ? fullCheckLogName : setupLogName)
      rmSync(path, { force: true })
      swap(path)
      return Effect.fail(
        new CheckFailed({
          check: kind,
          command: kind === "full" ? fullCommand : setupCommand,
          exitCode: 1,
          outputFile: ran.outputFile,
          ...said(kind === "full" ? "e2e" : null),
        }),
      )
    })

/** Puts a symbolic link to a file outside the worktree at `path`. */
const linkOutside = (path: string) => {
  const target = join(folder("outside"), "secret")
  writeFileSync(target, secret)
  symlinkSync(target, path)
}

/** The output the full_check record names. */
const outputOf = (ran: Ran<unknown>): string | undefined => {
  const record = ran.events.find((each) => each.kind === "full_check")
  return record?.kind === "full_check" ? record.output : undefined
}

describe("the full check's whole output, kept from its worktree", () => {
  test("a symbolic link in place of check-full.log is refused, not followed", async () => {
    const { ran, repo } = await runs({ full: [failsLeaving("full", linkOutside)] })
    const kept = join(repo, runFolder, fullCheckLogName)
    expect(existsSync(kept) ? readFileSync(kept, "utf8") : "").not.toContain(secret)
    expect(outputOf(ran)).toBe(join(repo, logFile))
    expect(ran.log.join("\n")).toMatch(
      /the full check's whole output can't be kept in .*check-full\.log: .*check-full\.log can't be read/,
    )
    expect(ran.issues.some((issue) => issue.title === "Full check fails: e2e")).toBe(true)
  })

  test("a named pipe in place of check-full.log is refused at once", async () => {
    const started = performance.now()
    const { ran, repo } = await runs({
      full: [
        failsLeaving("full", (path) => {
          mkfifo(path)
          rescue(path)
        }),
      ],
    })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(outputOf(ran)).toBe(join(repo, logFile))
    expect(ran.log.join("\n")).toMatch(/check-full\.log can't be read: .*named pipe/)
  })

  test("a symbolic link in place of the setup's output is refused, not followed", async () => {
    const { ran, repo } = await runs(
      // The setup in t-1's new worktree passes; the one before the full check fails.
      { setup: [passed("setup"), failsLeaving("setup", linkOutside)] },
      true,
    )
    const kept = join(repo, runFolder, fullCheckLogName)
    expect(existsSync(kept) ? readFileSync(kept, "utf8") : "").not.toContain(secret)
    expect(outputOf(ran)).toBe(join(repo, logFile))
    expect(ran.log.join("\n")).toMatch(/setup\.log can't be read/)
  })
})
