// A stop while tutti init takes its steps (orchestra-qa9p): the step runner checks for one after each
// step, writes the setup as one group, and init says `stopped` below what it did, exit 130. In a
// temp repository with a scripted form, machine and Beads, a stop at each step in turn; then, on
// real git, SIGINT to `tutti init` while a git it runs is held in the setup.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Deferred, Effect, Exit } from "effect"
import { stoppedEnding } from "../src/cli/commands.ts"
import type { InitForm } from "../src/init/init.ts"
import { init } from "../src/init/init.ts"
import { InitStopped, type Machine, runSteps, type Step, step } from "../src/init/steps.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { testEnv, which } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// The last test starts tutti as a bun process, which bun's 5 s default fails beside other checks.
setDefaultTimeout(30_000)

describe("runSteps", () => {
  const lines = (label: string): ReadonlyArray<Step> => [step("done", label, "")]
  const fail = <A>(exit: Exit.Exit<A, unknown>) => {
    if (Exit.isSuccess(exit)) throw new Error("expected the steps to stop")
    const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
    if (reason?._tag !== "Fail") throw new Error(`no failure in ${String(exit.cause)}`)
    return reason.error
  }

  test("a stop after each step in turn ends the steps there, with the lines taken so far", async () => {
    const names = ["one", "two", "three"]
    for (const [at, name] of names.entries()) {
      const ran: Array<string> = []
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const stop = yield* Deferred.make<void>()
          const steps = names.map((each) => ({
            name: each,
            whole: false,
            run: Effect.sync(() => {
              ran.push(each)
              if (each === name) Deferred.doneUnsafe(stop, Effect.void)
              return lines(each)
            }),
            stopped: (took: ReadonlyArray<Step> | null) => ` after ${each} (${took?.length})`,
          }))
          return yield* Effect.exit(runSteps(steps, stop))
        }),
      )
      const stopped = fail(exit) as InitStopped
      expect(stopped).toBeInstanceOf(InitStopped)
      expect(stopped.step).toBe(name)
      expect(stopped.words).toBe(` after ${name} (1)`)
      expect(stopped.steps.map((each) => each.label)).toEqual(names.slice(0, at + 1))
      expect(ran).toEqual(names.slice(0, at + 1))
    }
  })

  test("a stop interrupts a step that needn't be whole, and waits for one that must be", async () => {
    const ended: Array<string> = []
    // A step that stops the steps, then takes a while to end.
    const stopThen = (stop: Deferred.Deferred<void>, name: string, whole: boolean) => ({
      name,
      whole,
      run: Effect.gen(function* () {
        yield* Deferred.succeed(stop, undefined)
        yield* Effect.sleep("20 millis")
        ended.push(name)
        return lines(name)
      }),
      stopped: (took: ReadonlyArray<Step> | null) => (took === null ? " cut short" : " whole"),
    })
    const [cut, whole] = await Effect.runPromise(
      Effect.forEach([false, true], (isWhole) =>
        Effect.gen(function* () {
          const stop = yield* Deferred.make<void>()
          const name = isWhole ? "whole" : "cut"
          return fail(yield* Effect.exit(runSteps([stopThen(stop, name, isWhole)], stop)))
        }),
      ),
    )
    expect(cut).toMatchObject({ step: "cut", words: " cut short", steps: [] })
    expect((whole as InitStopped).words).toBe(" whole")
    expect((whole as InitStopped).steps.map((each) => each.label)).toEqual(["whole"])
    expect(ended).toEqual(["whole"])
  })

  test("a step that fails ends the steps with its error; without a stop all are taken", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const stop = yield* Deferred.make<void>()
        const named = (name: string) => ({
          name,
          whole: true,
          run: Effect.succeed(lines(name)),
          stopped: () => "",
        })
        const failing = { ...named("b"), run: Effect.fail("b broke") }
        return {
          failed: yield* Effect.exit(runSteps([named("a"), failing, named("c")], stop)),
          all: yield* runSteps([named("a"), named("b")], stop),
        }
      }),
    )
    expect(fail(outcome.failed)).toBe("b broke")
    expect(outcome.all.map((each) => each.label)).toEqual(["a", "b"])
  })
})

/** A temp repository with Beads set up, and a home folder for Claude Code's user config. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-stop-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(join(repo, ".beads"))
  mkdirSync(home)
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** bd on the PATH, whose Beads has the prefix `tutti`; every other command answers "". */
const scriptedMachine = (project: Project) => {
  const ran: Array<string> = []
  const machine: Machine = {
    run: (command, args) =>
      Effect.sync(() => {
        ran.push([command, ...args].join(" "))
        return command === "bd" && args[0] === "config"
          ? JSON.stringify({ schema_version: 1, data: { key: "issue_prefix", value: "tutti" } })
          : ""
      }),
    which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
    env: (name) => (name === "HOME" ? project.home : undefined),
    platform: "darwin",
    executable: () => false,
  }
  return { machine, ran }
}

/** A form that asks nothing of note, choosing runners from scratch, which files the test work. */
const scratchForm: InitForm = {
  workers: () => Effect.succeed({}),
  checks: () => Effect.succeed({ checks: { kind: "scratch" }, verifier: false }),
  trust: () => Effect.succeed(false),
  import: () => Effect.succeed(false),
}

/** init's steps in this scenario, in order. */
const stepNames = ["Beads", "the ticket prefix", "the setup", "the test work", "the login probe"]

/** Runs init in `project`, renaming its tickets to `tt`, with a stop as `stopAt` starts. */
const runInit = (project: Project, stopAt: string | null) => {
  const started: Array<string> = []
  const { machine, ran } = scriptedMachine(project)
  return Effect.runPromise(
    Effect.gen(function* () {
      let stop: (() => void) | null = null
      const exit = yield* Effect.exit(
        init({
          repo: project.repo,
          commonDir: project.commonDir,
          branch: "main",
          version: "0.1.0",
          flags: { force: false, prefix: "tt" },
          form: scratchForm,
          scout: Effect.fail("there is no scout in these tests"),
          machine,
          configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
          account: TestAccount.layer(),
          claudeConfig: join(project.home, ".claude.json"),
          catchStops: (on) =>
            Effect.sync(() => {
              stop = on
            }),
          starting: (name) =>
            Effect.sync(() => {
              started.push(name)
              if (name === stopAt) stop?.()
            }),
        }),
      )
      const issues = yield* (yield* TestBeads.Backlog).issues
      return { exit, issues, started, ran }
    }).pipe(
      Effect.provide(RunLock.layer),
      Effect.provide(TestBeads.layer([{ id: "tutti-1" }])),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
}

const stoppedOf = <A>(exit: Exit.Exit<A, unknown>): InitStopped => {
  if (Exit.isSuccess(exit)) throw new Error("expected init to stop")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason?._tag !== "Fail" || !(reason.error instanceof InitStopped)) {
    throw new Error(`init didn't stop: ${String(exit.cause)}`)
  }
  return reason.error
}

/** The files of the setup, which a run takes together. */
const setupFiles = [
  ".tutti/worker-prompt.md",
  ".tutti/settings.json",
  ".tutti/.gitignore",
  "scripts/check-fast.sh",
  "scripts/check-full.sh",
]

const filed = (issues: ReadonlyArray<{ readonly id: string }>) =>
  issues.filter((issue) => !issue.id.startsWith("tutti-") && !issue.id.startsWith("tt-"))

describe("tutti init stopped", () => {
  test("without a stop, init takes each step in turn", async () => {
    const project = newProject()
    const { exit, started } = await runInit(project, null)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(started).toEqual(stepNames)
  })

  test("a stop at each step in turn: exit 130, the steps taken, then where it stopped", async () => {
    const said: Record<string, string> = {
      Beads: "tutti init: stopped while setting Beads up, before writing .tutti/",
      "the ticket prefix":
        "tutti init: stopped once it had renamed the tickets, before writing .tutti/",
      "the setup":
        "tutti init: stopped once it had written the files above, before filing the test work: tutti init again files it",
      "the test work":
        "tutti init: stopped while filing the test work: tutti init again files what is missing",
      "the login probe":
        "tutti init: stopped during the login probe, once it had written the files above",
    }
    for (const [at, name] of stepNames.entries()) {
      const project = newProject()
      const { exit, started, issues, ran } = await runInit(project, name)
      const stopped = stoppedOf(exit)
      expect(stopped.step).toBe(name)
      expect(started).toEqual(stepNames.slice(0, at + 1))

      const ending = stoppedEnding(stopped, null, 80)
      expect(ending.code).toBe(130)
      expect(ending.stderr).toBe(said[name] ?? "")
      const report = ending.stdout.join("\n")
      // The ticket prefix, a whole step, renames the tickets though the stop came as it started.
      const renamed = at >= 1
      expect(ran.includes("bd rename-prefix tt-")).toBe(renamed)
      expect(report.includes("✓ ticket prefix  tt (was tutti), 1 ticket renamed")).toBe(renamed)
      // The setup is whole: every file of it, or none.
      const written = at >= 2
      for (const path of setupFiles) {
        expect(`${path} ${existsSync(join(project.repo, path))}`).toBe(`${path} ${written}`)
      }
      expect(report.includes("✓ settings  wrote .tutti/settings.json")).toBe(written)
      // The test work, interrupted at its start, is filed only where init got past it.
      expect(filed(issues).length > 0).toBe(at >= 4)
      expect(report.includes("✓ ticket  filed")).toBe(at >= 4)
      expect(report).not.toContain("login")
    }
  })
})

/**
 * A git first on the PATH that, the first time it runs in a checkout with a worker prompt (as the
 * setup's check of the changelog's merge does, once it has written the prompt), waits until
 * `release` is there, having made `stalled`.
 */
const stallingGit = (root: string) => {
  const bin = join(root, "bin")
  mkdirSync(bin)
  const stalled = join(root, "stalled")
  const release = join(root, "release")
  const real = which("git")
  if (real === null) throw new Error("git isn't on the tests' PATH")
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
if [ -e .tutti/worker-prompt.md ] && [ ! -e '${stalled}' ]; then
  : > '${stalled}'
  while [ ! -e '${release}' ]; do sleep 0.01; done
fi
exec '${real}' "$@"
`,
    { mode: 0o755 },
  )
  return { bin, stalled, release }
}

describe("tutti init on real git", () => {
  slow.test("SIGINT while it writes the setup: the whole setup, `stopped`, exit 130", async () => {
    const repo = makeRepo()
    repo.commit("Add a changelog", { "CHANGELOG.md": "# Changelog\n" })
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-sigint-")))
    const home = join(root, "home")
    mkdirSync(home)
    const git = stallingGit(root)
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "init"], {
      cwd: repo.dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...testEnv, PATH: `${git.bin}:${testEnv.PATH ?? ""}`, HOME: home },
    })
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    for (const deadline = Date.now() + 20_000; !existsSync(git.stalled); ) {
      if (Date.now() > deadline) throw new Error("git never stalled in a checkout with a prompt")
      await Bun.sleep(10)
    }
    proc.kill("SIGINT")
    // The signal has to reach tutti before git goes on.
    await Bun.sleep(200)
    writeFileSync(git.release, "")
    const [code, [out, err]] = await Promise.all([proc.exited, output])

    expect(code).toBe(130)
    expect(err).toContain("tutti init: stopped once it had written the files above")
    expect(out).toContain("✓ settings  wrote .tutti/settings.json")
    for (const path of setupFiles) expect(existsSync(join(repo.dir, path))).toBe(true)
    const settings = JSON.parse(readFileSync(join(repo.dir, ".tutti/settings.json"), "utf8"))
    expect(settings.checks.fast.command).toBe("scripts/check-fast.sh")
  })
})
