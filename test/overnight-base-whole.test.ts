// --overnight's pre-flight checks the whole of the base (§ 5 item 2; tutti-3hp3): it runs the merge
// check on the base's head with TUTTI_CHECK_WHOLE=1 (wholeCheckVariable), as the change since main
// is empty there and tutti's own merge check, scripts/check-own.sh on that change, skipped every
// step and passed a broken main. scripts/check-fast.sh runs scripts/check.sh whole under it. On the
// test layers, the variable the check is run with; in a real git repository with tutti's check
// scripts, a real tsc and a real bun test, the base check failing on a type error and on a failing
// test, naming each, and passing on a sound main having run every step.
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { noServersNote } from "../src/agent/mcp.ts"
import type { AppConfigValue } from "../src/core/AppConfig.ts"
import { BranchEnv, wholeCheckVariable } from "../src/core/env.ts"
import { makePrinter } from "../src/print/organLine.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { baseCheck, baseCheckLogName } from "../src/run/overnight.ts"
import type { Started } from "../src/run/startup.ts"
import { Checks } from "../src/services/Checks.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { runFolder, Worktrees } from "../src/services/Worktrees.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestChecks from "../src/testing/Checks.ts"
import * as TestGit from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import * as TestWorktrees from "../src/testing/Worktrees.ts"
import { makeTheme } from "../src/ui/theme.ts"
import { testEnv, which } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const theme = makeTheme(tuttiScheme, {
  appearance: "dark",
  depth: "256",
  noColor: true,
  styled: false,
})

/** The configuration with `fast` as the merge check and `setup` as the setup. */
const configOf = (repo: string, fast: string, setup: string | null = null): AppConfigValue => {
  const base = TestAppConfig.appConfig({}, repo)
  return {
    ...base,
    overnight: true,
    settings: {
      ...base.settings,
      checks: {
        ...base.settings.checks,
        fast: { command: fast, timeout: Duration.minutes(2) },
        setup: { ...base.settings.checks.setup, command: setup },
      },
    },
  }
}

const startedOf = (config: AppConfigValue): Started => ({
  config,
  base: "main",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  account: {
    ...TestAccount.accountProbe(config),
    permissionMode: {
      requested: config.settings.workers.permission_mode,
      inEffect: config.settings.workers.permission_mode,
    },
  },
  organs: { _tag: "AgentSdk" },
  warnings: [],
})

const sayer = () => ({
  ...makePrinter({ write: () => {}, columns: () => 400, tty: false }, theme),
  theme,
})

describe("the pre-flight's merge check on the base", () => {
  test("runs with TUTTI_CHECK_WHOLE=1, and its setup without it", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-base-whole-")))
    const config = configOf(repo, "scripts/check-fast.sh", "bun install")
    const runs: Array<TestChecks.CheckRun> = []
    const found = await Effect.runPromise(
      baseCheck(startedOf(config), sayer()).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestGit.layer({ dir: repo }),
            TestWorktrees.layer(),
            TestChecks.layer({}, runs),
          ).pipe(
            Layer.provideMerge(logLayer()),
            Layer.provideMerge(TestAppConfig.layer(config)),
            Layer.provideMerge(BunServices.layer),
          ),
        ),
      ),
    )
    expect(found.verdict).toBe("passed")
    expect(wholeCheckVariable).toBe("TUTTI_CHECK_WHOLE")
    expect(runs.map((run) => [run.check, run.env])).toEqual([
      ["setup", undefined],
      ["fast", { TUTTI_CHECK_WHOLE: "1" }],
    ])
  })
})

const stub = (file: string, body: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

const checkout = resolve(import.meta.dir, "..")

/**
 * Tools outside the repository, made once: bunx runs the checkout's real tsc and stands in for
 * Biome, and shellcheck says what it was given.
 */
const tools = (() => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "tutti-base-whole-bin-")))
  stub(
    join(bin, "bunx"),
    `case "$1" in
tsc) shift; exec bun ${join(checkout, "node_modules", "typescript", "bin", "tsc")} "$@" ;;
*) echo "bunx $*" ;;
esac`,
  )
  stub(join(bin, "shellcheck"), 'echo "shellcheck $*"')
  return bin
})()

const typeError = 'export const a: number = "one"\n'
const failingTest = `import { expect, test } from "bun:test"
import { a } from "../src/a.ts"

test("a is one", () => {
  expect(a).toBe(1)
})
`

/**
 * A repository whose main holds tutti's merge check scripts, scripts/check.sh among them, with
 * scripts/test.sh a bare bun test and fetch-shellcheck.sh naming the stub, and src/a.ts with a type
 * error, which test/a.test.ts fails on.
 */
const project = () => {
  const repo = makeRepo()
  mkdirSync(join(repo.dir, "scripts"))
  for (const name of ["check-fast.sh", "check-own.sh", "check-own.ts", "check.sh"]) {
    copyFileSync(join(checkout, "scripts", name), join(repo.dir, "scripts", name))
  }
  for (const name of ["check-fast.sh", "check-own.sh", "check.sh"]) {
    chmodSync(join(repo.dir, "scripts", name), 0o755)
  }
  stub(join(repo.dir, "scripts", "test.sh"), 'exec bun test "$@"')
  stub(join(repo.dir, "scripts", "fetch-shellcheck.sh"), `echo ${join(tools, "shellcheck")}`)
  repo.commit("Project", {
    ".gitignore": ".tutti/\n",
    "package.json": "{}\n",
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
      include: ["src"],
    })}\n`,
    "src/a.ts": typeError,
    "src/b.ts": "export const b = 2\n",
    "test/a.test.ts": failingTest,
    "test/b.test.ts":
      'import { expect, test } from "bun:test"\nimport { b } from "../src/b.ts"\n\ntest("b is two", () => {\n  expect(b).toBe(2)\n})\n',
  })
  const path = [
    tools,
    dirname(process.execPath),
    dirname(which("git") ?? "/usr/bin/git"),
    "/usr/bin",
    "/bin",
  ].join(":")
  const env = { HOME: testEnv.HOME ?? "", PATH: path }
  const config = configOf(repo.dir, "scripts/check-fast.sh")
  const root = join(repo.dir, "..", "worktrees")
  /** The pre-flight's merge check on main, with the live layers, and its whole output. */
  const check = async () => {
    const found = await Effect.runPromise(
      baseCheck(startedOf(config), sayer()).pipe(
        Effect.provide(
          Layer.mergeAll(
            Worktrees.layer({ repo: repo.dir, root, base: "main" }),
            Checks.layer,
            Layer.succeed(BranchEnv, env),
          ).pipe(
            Layer.provideMerge(Git.layer()),
            Layer.provideMerge(GitWriter.layer),
            Layer.provideMerge(logLayer()),
            Layer.provideMerge(TestAppConfig.layer(config)),
            Layer.provideMerge(BunServices.layer),
          ),
        ),
      ),
    )
    const output = readFileSync(join(repo.dir, runFolder, baseCheckLogName), "utf8")
    return { found, output }
  }
  /** check-fast.sh run in the main checkout as a ticket's merge check runs, without the variable. */
  const mergeCheck = () => {
    const proc = Bun.spawnSync([join(repo.dir, "scripts", "check-fast.sh")], {
      cwd: repo.dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() }
  }
  return { repo, check, mergeCheck }
}

describe("the pre-flight's merge check on the base, in a real repository", () => {
  slow.test(
    "fails on a type error, then on a failing test, naming each, and passes on a sound main",
    async () => {
      const { repo, check, mergeCheck } = project()

      // A ticket's merge check on main's head sees no change, and checks nothing, as before.
      const merge = mergeCheck()
      expect(merge.out).toContain("tsc: no TypeScript or JSON file changed")
      expect(merge.out).toContain("scripts/check-own.sh: PASS")
      expect(merge.code).toBe(0)

      const typed = await check()
      expect(typed.output).toContain(
        "check-fast: TUTTI_CHECK_WHOLE=1: running scripts/check.sh whole",
      )
      expect(typed.output).toContain("src/a.ts(1,14): error TS2322")
      expect(typed.output).toEndWith("scripts/check.sh: FAIL in tsc (exit 1)\n")
      expect(typed.found.verdict).toBe("failed")
      expect(typed.found.text).toMatch(
        /^the merge check 'scripts\/check-fast\.sh' fails on main at [0-9a-f]{7}, so every ticket's merge would fail: /,
      )
      expect(typed.found.text).toContain("error TS2322")

      repo.commit("Fix the type", { "src/a.ts": 'export const a: string = "one"\n' })
      const tested = await check()
      expect(tested.output).toContain("SUITE: tsc")
      expect(tested.output).toContain("bunx biome check .")
      expect(tested.output).toContain("(fail) a is one")
      expect(tested.output).toEndWith("scripts/check.sh: FAIL in test (exit 1)\n")
      expect(tested.found.verdict).toBe("failed")
      expect(tested.found.text).toContain("a is one")

      repo.commit("Fix the test", {
        "test/a.test.ts": failingTest.replace("toBe(1)", 'toBe("one")'),
      })
      const sound = await check()
      for (const suite of ["tsc", "biome", "test", "shellcheck"]) {
        expect(sound.output).toContain(`SUITE: ${suite}\n`)
      }
      expect(sound.output).toContain("bunx biome check .")
      expect(sound.output).toContain("(pass) a is one")
      expect(sound.output).toContain("(pass) b is two")
      expect(sound.output).toMatch(/shellcheck .*scripts\/check-fast\.sh/)
      expect(sound.output).toEndWith("scripts/check.sh: PASS\n")
      expect(sound.found.verdict).toBe("passed")
      expect(sound.found.text).toMatch(
        /^the merge check 'scripts\/check-fast\.sh' passes on main at [0-9a-f]{7} \(\d+s\)$/,
      )
    },
  )
})
