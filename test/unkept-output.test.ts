// A check's or setup's whole output that can't be kept in its worktree's .tutti/run/ (a symbolic
// link stands there) goes to /dev/null, and what the run says of where it is names /dev/null, not
// the log file: CHECKS_FAILED, SETUP_FAILED, the report and the fix prompt don't point at a file
// that doesn't hold it, nor at a link a worker planted.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { checkOnce } from "../src/run/check.ts"
import { Ledger } from "../src/run/ledger.ts"
import { makeSetUps, setUp, setUpWorktree } from "../src/run/setup.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckFailed, type CheckKind, checkLogName, setupLogName } from "../src/services/Checks.ts"
import type { Sha } from "../src/services/Git.ts"
import { nothingEarlier, runFolder } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { CheckRun } from "../src/testing/Checks.ts"
import { scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-unkept-output-${name}-`)))

const setup = "bun install --frozen-lockfile"
const defaults = appConfig().settings
const settings = {
  ...defaults,
  checks: { ...defaults.checks, setup: { ...defaults.checks.setup, command: setup } },
}

/** A run that fails, saying its output is where it was asked to write it. */
const fails = (check: CheckKind) => (run: CheckRun) =>
  Effect.fail(
    new CheckFailed({
      check,
      command: check === "setup" ? setup : "scripts/check-fast.sh",
      exitCode: 1,
      outputFile: run.outputFile,
      failingLines: [],
      lastLines: [],
      suites: [],
      suite: null,
      flaky: [],
      flakyCount: 0,
    }),
  )

/** A worktree with a symbolic link to a file outside it standing at .tutti/run/`name`, or none. */
const worktreeWith = (name: string, linked: boolean) => {
  const worktree = folder("worktree")
  if (linked) {
    const outside = join(folder("outside"), name)
    writeFileSync(outside, "untouched\n")
    mkdirSync(join(worktree, runFolder), { recursive: true })
    symlinkSync(outside, join(worktree, runFolder, name))
  }
  return worktree
}

for (const linked of [false, true]) {
  const where = linked ? "names /dev/null when a link stands" : "names its log file"
  describe(`a failed run's output ${where} in its place`, () => {
    test("the merge check (checkOnce)", async () => {
      const worktree = worktreeWith(checkLogName, linked)
      const ran = await scenario(
        { checks: { fast: [fails("fast")] } },
        checkOnce({ id: "a" as TicketId, worktree }),
      )
      const output = linked ? "/dev/null" : join(worktree, runFolder, checkLogName)
      expect(ran.exit).toMatchObject({ _tag: "Success", value: { _tag: "Failed", output } })
      expect(ran.checkRuns.map((each) => each.outputFile)).toEqual([output])
    })

    test("the setup before the merge check (setUp)", async () => {
      const worktree = worktreeWith(setupLogName, linked)
      const ran = await scenario(
        { config: { settings }, checks: { setup: [fails("setup")] } },
        Effect.gen(function* () {
          const setUps = yield* makeSetUps
          yield* setUps.offBase("a" as TicketId, "it was set up on top of b")
          return yield* setUp(
            { id: "a" as TicketId, title: "a", branch: "tutti/a", worktree },
            { repo: folder("repo"), base: "main" },
            setUps,
            { fork: "fork" as Sha, onto: "onto" as Sha },
          )
        }).pipe(Effect.provide(Ledger.layer)),
      )
      const output = linked ? "/dev/null" : join(worktree, runFolder, setupLogName)
      expect(ran.exit).toMatchObject({ _tag: "Success", value: { _tag: "Failed", output } })
      expect(ran.checkRuns.map((each) => each.outputFile)).toEqual([output])
    })

    test("the setup in a new worktree (setUpWorktree)", async () => {
      const path = worktreeWith(setupLogName, linked)
      const ran = await scenario(
        { config: { settings }, checks: { setup: [fails("setup")] } },
        Effect.gen(function* () {
          const setUps = yield* makeSetUps
          return yield* setUpWorktree(
            {
              id: "a" as TicketId,
              branch: "tutti/a",
              path,
              reused: false,
              fresh: true,
              earlier: nothingEarlier,
            },
            setUps,
            folder("repo"),
          )
        }),
      )
      const output = linked ? "/dev/null" : join(path, runFolder, setupLogName)
      expect(ran.exit).toMatchObject({ _tag: "Success", value: { _tag: "Failed", output } })
      expect(ran.checkRuns.map((each) => each.outputFile)).toEqual([output])
    })
  })
}
