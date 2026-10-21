// tutti init installing bd where brew is missing (§ 8.3): with the Beads install script, and bd
// landing off the PATH, where init says how to put it on. A temp repository, a scripted form and a
// scripted machine without brew, as test/init.test.ts has them.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import { type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import { findBeadsInstall, type WorkersQuestions } from "../src/init/workers.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"

const script =
  "curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash"

/** A temp repository (its top and git folder) and a home folder. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-beads-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/**
 * A Linux machine without brew or bd, whose Beads install script puts bd in ~/.local/bin, off the
 * PATH (`onPath` false), or on it; `installed` says bd is there from the start, off the PATH.
 */
const linuxMachine = (
  project: Project,
  options: { readonly onPath: boolean; readonly installed?: boolean },
) => {
  const ran: Array<string> = []
  const local = join(project.home, ".local", "bin", "bd")
  const state = { installed: options.installed ?? false }
  const machine: Machine = {
    run: (command, args) =>
      Effect.sync(() => {
        ran.push([command, ...args].join(" "))
        if (command === "bash") state.installed = true
        return ""
      }),
    which: (command) => (command === "bd" && state.installed && options.onPath ? local : null),
    env: (name) => (name === "HOME" ? project.home : undefined),
    platform: "linux",
    executable: (path) => state.installed && path === local,
  }
  return { machine, ran, local }
}

/** A form that installs Beads when it is offered, and what it was asked. */
const installingForm = () => {
  const asked: Array<WorkersQuestions> = []
  const form: InitForm = {
    workers: (questions) =>
      Effect.sync(() => {
        asked.push(questions)
        return questions.installBeads === null ? {} : { installBeads: true }
      }),
    checks: () => Effect.succeed({ verifier: false }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  }
  return { form, asked }
}

const runInit = (project: Project, machine: Machine, form: InitForm) =>
  Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags: { force: false },
        form,
        scout: Effect.fail("there is no scout in these tests"),
        machine,
        configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
        account: TestAccount.layer(),
        claudeConfig: join(project.home, ".claude.json"),
      }).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer([])),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
        ),
        Effect.provide(BunServices.layer),
      ),
    ),
  )

const summaryOf = (exit: Exit.Exit<InitSummary, unknown>): InitSummary => {
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

const lines = (summary: InitSummary) => summary.steps.map(stepLine)

describe("installing bd where brew is missing", () => {
  test("the Beads install script on Linux, macOS and FreeBSD; nothing elsewhere", () => {
    const project = newProject()
    const { machine } = linuxMachine(project, { onPath: true })
    for (const platform of ["linux", "darwin", "freebsd"]) {
      expect(findBeadsInstall({ ...machine, platform })).toEqual({
        method: "the Beads install script",
        command: script,
        manual: "",
      })
    }
    expect(findBeadsInstall({ ...machine, platform: "win32" }).command).toBeNull()
  })

  test("offered in the form, run with bash, and bd on the PATH: bd init sets Beads up", async () => {
    const project = newProject()
    const { machine, ran } = linuxMachine(project, { onPath: true })
    const { form, asked } = installingForm()
    const summary = summaryOf(await runInit(project, machine, form))
    expect(asked[0]?.installBeads).toEqual({ method: "the Beads install script", command: script })
    expect(ran).toContain(`bash -c set -o pipefail; ${script}`)
    expect(ran.some((command) => command.startsWith("brew"))).toBe(false)
    expect(lines(summary)).toContain(`✓ bd  installed with the Beads install script (${script})`)
    expect(ran).toContain("bd init --non-interactive --role maintainer --init-if-missing")
  })

  test("bd landing off the PATH: where it is, and how to put it on, and bd init doesn't run", async () => {
    const project = newProject()
    const { machine, ran } = linuxMachine(project, { onPath: false })
    const { form } = installingForm()
    const summary = summaryOf(await runInit(project, machine, form))
    const bin = join(project.home, ".local", "bin")
    const advice = `it is in ${bin}, which isn't on your PATH: add it in your shell's profile (export PATH="$PATH":${bin}) and open a new terminal`
    expect(ran).toContain(`bash -c set -o pipefail; ${script}`)
    expect(lines(summary)).toContain(`✗ bd  installed with the Beads install script, but ${advice}`)
    // The prerequisites say it again, and it is the first thing to fix.
    expect(lines(summary)).toContain(`✗ bd  ${advice}`)
    expect(summary.next[0]).toBe(
      `Fix what's missing above (bd: installed with the Beads install script, but ${advice}).`,
    )
    expect(ran.some((command) => command.startsWith("bd "))).toBe(false)
    expect(summary.ready).toBe(false)
  })

  test("bd already off the PATH: not offered again, and the advice given", async () => {
    const project = newProject()
    const { machine, ran } = linuxMachine(project, { onPath: false, installed: true })
    const { form, asked } = installingForm()
    const summary = summaryOf(await runInit(project, machine, form))
    const bin = join(project.home, ".local", "bin")
    expect(asked[0]?.installBeads).toBeNull()
    expect(ran.some((command) => command.startsWith("bash"))).toBe(false)
    expect(lines(summary)).toContain(
      `✗ bd  it is in ${bin}, which isn't on your PATH: add it in your shell's profile (export PATH="$PATH":${bin}) and open a new terminal`,
    )
  })
})
