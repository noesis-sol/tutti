// tutti init run again over settings whose check is set to null (§ 8.3): null is the project's
// choice to merge without that check (src/run/merge.ts), so init keeps it, filling in the runner
// only where the key is absent, and leaves the file as it is where it changes nothing. Each runs
// init in a temp repository without a form, as test/init.test.ts does.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import { type InitFlags, type InitSummary, init } from "../src/init/init.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"

/**
 * A temp repository whose .tutti/settings.json is `text`, with a worker prompt of its own (so init
 * records no template's version), and a home folder.
 */
const projectWith = (text: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-null-check-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(join(repo, ".tutti"))
  mkdirSync(home)
  writeFileSync(join(repo, ".tutti/settings.json"), text)
  writeFileSync(join(repo, ".tutti/worker-prompt.md"), "Ours: TICKET_ID\n")
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof projectWith>

const machineFor = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

const runInit = async (project: Project, flags: InitFlags) => {
  const exit = await Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags,
        form: null,
        scout: Effect.fail("there is no scout in these tests"),
        machine: machineFor(project),
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
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

const settingsLine = (summary: InitSummary) =>
  summary.steps.map(stepLine).find((line) => line.includes(" settings  "))

const read = (project: Project) => readFileSync(join(project.repo, ".tutti/settings.json"), "utf8")

/** Settings with both checks off, in the project's own formatting (not init's). */
const checksOff = `{
    "concurrent": 1,
    "checks": {
        "fast": { "command": null, "timeout": "30m" },
        "full": { "command": null, "timeout": "60m" }
    },
    "workers": { "mcp_servers": [] }
}
`

const quiet: InitFlags = { force: false, mcp: [], changelogUnion: false }

describe("init over a check set to null", () => {
  test("changing the concurrency keeps both checks off", async () => {
    const project = projectWith(checksOff)
    const summary = await runInit(project, { ...quiet, concurrent: 3 })

    const written = JSON.parse(read(project))
    expect(written.concurrent).toBe(3)
    expect(written.checks.fast.command).toBeNull()
    expect(written.checks.full.command).toBeNull()
    expect(settingsLine(summary)).toBe("✓ settings  updated .tutti/settings.json: concurrent")
  })

  test("changing nothing leaves the file as it is, its formatting included", async () => {
    const project = projectWith(checksOff)
    const summary = await runInit(project, quiet)

    expect(read(project)).toBe(checksOff)
    expect(settingsLine(summary)).toBe("• settings  .tutti/settings.json is there; left as it is")
  })

  test("a check whose command is absent still gets the runner", async () => {
    const project = projectWith(
      JSON.stringify({ concurrent: 1, checks: { fast: { command: null }, full: {} } }),
    )
    const summary = await runInit(project, quiet)

    const written = JSON.parse(read(project))
    expect(written.checks.fast.command).toBeNull()
    expect(written.checks.full.command).toBe("scripts/check-full.sh")
    expect(settingsLine(summary)).toContain("checks.full.command")
    expect(settingsLine(summary)).not.toContain("checks.fast.command")
  })

  test("--check-fast turns a check set to null back on", async () => {
    const project = projectWith(checksOff)
    await runInit(project, { ...quiet, checkFast: "echo checked" })

    const written = JSON.parse(read(project))
    expect(written.checks.fast.command).toBe("scripts/check-fast.sh")
    expect(written.checks.full.command).toBeNull()
  })
})
