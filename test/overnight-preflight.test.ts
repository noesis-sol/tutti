// --overnight's pre-flight whole (src/run/overnight.ts; tutti-kkb.46), on the test layers: the
// machine's readings, bd's backlog, the usage probe and the merge check on the base scripted. Its
// checklist, printed and logged; each fix offered, yes first, and those taken made once every answer
// is in; the start-anyway question while a failed check is left; the refusal; --force-overnight; a
// cancel that changes nothing; and the plain run, which asks nothing.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option } from "effect"
import { noServersNote } from "../src/agent/mcp.ts"
import { ProbeAnswer } from "../src/agent/UsageProbe.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { makePrinter } from "../src/print/organLine.ts"
import { unknownKernel } from "../src/run/load.ts"
import {
  type Ask,
  baseCheckLogName,
  type Cleared,
  type Night,
  preflight,
  refusal,
} from "../src/run/overnight.ts"
import { gb } from "../src/run/processes.ts"
import type { Started } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestChecks from "../src/testing/Checks.ts"
import * as TestGit from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { Probed, layer as probeLayer, type Scripted } from "../src/testing/UsageProbe.ts"
import * as TestWorktrees from "../src/testing/Worktrees.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, {
  appearance: "dark",
  depth: "256",
  noColor: true,
  styled: false,
})

/** A project in a folder of its own, the merge check's output kept in its .tutti/run/. */
const project = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-overnight-")))

/** A configuration that passes every check but those `overrides` change. */
const goodConfig = (repo: string, overrides: Partial<AppConfigValue> = {}): AppConfigValue => {
  const base = TestAppConfig.appConfig({}, repo)
  return {
    ...base,
    overnight: true,
    keepAwake: true,
    autoAnswer: Duration.zero,
    settings: {
      ...base.settings,
      concurrent: 2,
      workers: { ...base.settings.workers, ticket_limit: Duration.hours(2) },
    },
    ...overrides,
  }
}

const startedOf = (config: AppConfigValue): Started => ({
  config,
  base: "main",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  // Claude Code reports the mode asked for in effect.
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

/** A machine with nothing to warn of. */
const quietNight: Night = {
  platform: "darwin",
  cores: 12,
  awake: { _tag: "Command", command: { command: "caffeinate", args: ["-i"] } },
  battery: null,
  kernel: Effect.succeed({ ...unknownKernel, cores: 10, load1: 1, pressure: "normal" }),
  processes: Effect.succeed([]),
  disk: () => Effect.succeed({ free: 100 * gb, where: "/work" }),
  otherRuns: Effect.succeed([]),
  // Claude Code puts the mode asked for in effect.
  probeAccount: (config) =>
    Effect.succeed({
      ...TestAccount.accountProbe(config),
      permissionMode: {
        requested: config.settings.workers.permission_mode,
        inEffect: config.settings.workers.permission_mode,
      },
    }),
}

interface Scenario {
  readonly config: AppConfigValue
  readonly night?: Partial<Night>
  readonly tickets?: ReadonlyArray<TestBeads.Seed>
  readonly probe?: ReadonlyArray<Scripted>
  readonly fast?: ReadonlyArray<TestChecks.Scripted>
  /** The answers to the questions, in order; undefined cancels. Without them, nothing is asked. */
  readonly answers?: ReadonlyArray<boolean | undefined>
  readonly force?: boolean
}

/** Runs the pre-flight of `scenario`: how it ended, what it printed, logged and asked. */
const runPreflight = async (scenario: Scenario) => {
  const printed: Array<string> = []
  const asked: Array<readonly [string, boolean]> = []
  const runs: Array<TestChecks.CheckRun> = []
  const left = [...(scenario.answers ?? [])]
  const ask: Ask = (question, initial) =>
    Effect.suspend(() => {
      asked.push([question, initial])
      const answer = left.shift()
      return answer === undefined
        ? Effect.fail({ _tag: "FormCancelled" } as const)
        : Effect.succeed(answer)
    })
  const printer = makePrinter(
    { write: (text) => printed.push(text), columns: () => 400, tty: false },
    theme,
  )
  const { config } = scenario
  const layers = Layer.mergeAll(
    TestBeads.layer(scenario.tickets ?? [{ id: "tut-1", title: "Ready work" }]),
    probeLayer(scenario.probe ?? []),
    TestGit.layer({ dir: config.repo }),
    TestWorktrees.layer(),
    TestChecks.layer({ fast: scenario.fast ?? [] }, runs),
  ).pipe(
    Layer.provideMerge(logLayer()),
    Layer.provideMerge(TestAppConfig.layer(config)),
    Layer.provideMerge(BunServices.layer),
  )
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const cleared: Cleared = yield* preflight({
        started: startedOf(config),
        night: { ...quietNight, ...scenario.night },
        say: { ...printer, theme },
        ask: scenario.answers === undefined ? Option.none() : Option.some(ask),
        force: scenario.force ?? false,
      })
      const probed = yield* Probed
      return {
        cleared,
        logged: yield* texts,
        models: yield* probed.models,
      }
    }).pipe(Effect.provide(layers)),
  )
  return { ...outcome, printed: printed.join("").split("\n"), asked, runs }
}

/** The checklist's lines as printed: a mark and the text. */
const checklist = (printed: ReadonlyArray<string>) =>
  printed.filter((line) => /^ {2}[✓!✗] /.test(line))

describe("an overnight pre-flight", () => {
  test("with nothing to fix, prints its checklist, logs it, and clears the run", async () => {
    const repo = project()
    const { cleared, printed, logged, runs, models } = await runPreflight({
      config: goodConfig(repo),
    })
    expect(cleared._tag).toBe("Cleared")
    expect(printed).toContain("◆ Overnight pre-flight: 16 passed")
    expect(checklist(printed)).toEqual([
      "  ✓ no ticket limit",
      "  ✓ 2 tickets at a time",
      "  ✓ workers start in auto permission mode, which doesn't stop to ask",
      "  ✓ claude is logged in (maintainer@example.com, Claude Max)",
      "  ✓ the account isn't at its usage limit now",
      "  ✓ the run waits up to 6h for the account's usage limit to reset",
      "  ✓ each ticket's worker has 2h",
      "  ✓ the machine is kept awake while the run goes (caffeinate)",
      "  ✓ 100 GB free where the worktrees go, 20 GB wanted",
      "  ✓ no other tutti or orchestra run on the machine",
      "  ✓ the machine isn't busy: a load of 1.0 on 10 cores, memory pressure normal",
      "  ✓ no virtual machine holds more than 4.0 GB of memory",
      "  ✓ the machine has no battery",
      "  ✓ the worker prompt and the verifier are up to date with tutti's templates",
      "  ✓ 1 ticket is ready",
      expect.stringMatching(
        /^ {2}✓ the merge check 'scripts\/check-fast\.sh' passes on main at [0-9a-f]{7} \(0s\)$/,
      ),
    ])
    // The merge check ran once, in a worktree of its own, its output kept in the main checkout.
    expect(runs.map((run) => run.check)).toEqual(["fast"])
    expect(runs[0]?.cwd).not.toBe(repo)
    expect(runs[0]?.outputFile).toBe(join(repo, ".tutti", "run", baseCheckLogName))
    expect(printed).toContain("◆ Ran the merge check on main")
    // The probe asks at the workers' model: Claude Code's own, as the settings give none.
    expect(models).toEqual([null])
    expect(logged).toContain("overnight pre-flight: 16 passed")
    expect(logged).toContain("overnight pre-flight: passed: no ticket limit")
  })

  test("refuses the run on a failed check left, without a terminal asking nothing", async () => {
    const repo = project()
    const { cleared, printed, logged, asked } = await runPreflight({
      config: goodConfig(repo, { limit: 10 }),
      fast: [{ exitCode: 1, output: "FAIL test/a.test.ts\n" }],
    })
    expect(cleared).toEqual({ _tag: "Refused", failed: 2 })
    expect(asked).toEqual([])
    expect(printed).toContain("◆ Overnight pre-flight: 2 failed, 14 passed")
    expect(checklist(printed)).toContain(
      "  ✗ --limit 10 is set: the run would stop after 10 tickets",
    )
    const base = checklist(printed).at(-1) ?? ""
    expect(base).toMatch(/^ {2}✗ the merge check 'scripts\/check-fast\.sh' fails on main at /)
    expect(base).toContain(", so every ticket's merge would fail")
    expect(base).toContain(`(the whole output: ${join(repo, ".tutti", "run", baseCheckLogName)})`)
    expect(base).toEndWith(". Fix it on main first")
    expect(logged.at(-1)).toBe("overnight pre-flight: 2 checks failed: the run doesn't start")
    expect(refusal(2)).toBe(
      "tutti --overnight cannot start: 2 checks failed. Fix what the checklist says, or start anyway with --force-overnight.",
    )
  })

  test("--force-overnight starts it anyway, without asking, and says so", async () => {
    const repo = project()
    const { cleared, printed, logged, asked } = await runPreflight({
      config: goodConfig(repo, { limit: 3 }),
      answers: [false],
      force: true,
    })
    expect(cleared._tag).toBe("Cleared")
    // Its fix is still offered; the start-anyway question isn't.
    expect(asked).toEqual([["Run without a limit?", true]])
    const said = "overnight pre-flight: starting with 1 check failed (--force-overnight)"
    expect(printed).toContain(`◆ ${said}`)
    expect(logged).toContain(said)
  })

  test("offers each fix, yes first, and makes those taken before the run starts", async () => {
    const repo = project()
    const config = goodConfig(repo, {
      limit: 5,
      usageLimitWait: Duration.hours(1),
      settings: {
        ...goodConfig(repo).settings,
        concurrent: 1,
        workers: {
          ...goodConfig(repo).settings.workers,
          ticket_limit: null,
          permission_mode: "default",
        },
      },
    })
    const { cleared, printed, logged, asked } = await runPreflight({
      config,
      night: { cores: 16 },
      answers: [true, true, true, true, true],
    })
    expect(asked).toEqual([
      ["Run without a limit?", true],
      ["Run 4 tickets at a time?", true],
      ["Start workers in auto permission mode?", true],
      ["Wait up to 6h for the usage limit to reset?", true],
      ["Give each ticket's worker 2h?", true],
    ])
    if (cleared._tag !== "Cleared") throw new Error(`expected the run cleared, got ${cleared._tag}`)
    const fixed = cleared.started.config
    expect(fixed.limit).toBeNull()
    expect(fixed.settings.concurrent).toBe(4)
    expect(fixed.settings.workers.permission_mode).toBe("auto")
    expect(cleared.started.account.permissionMode).toEqual({ requested: "auto", inEffect: "auto" })
    expect(fixed.usageLimitWait).toEqual(Duration.hours(6))
    expect(fixed.settings.workers.ticket_limit).toEqual(Duration.hours(2))
    for (const done of [
      "the run has no ticket limit",
      "the run works on 4 tickets at a time",
      "workers start in auto permission mode",
      "the run waits up to 6h for the usage limit to reset",
      "each ticket's worker has 2h",
    ]) {
      expect(printed).toContain(`◆ Fixed: ${done}`)
      expect(logged).toContain(`overnight pre-flight: fixed: ${done}`)
    }
  })

  test("a fix that can't be made leaves its check failed, and the run refused", async () => {
    const repo = project()
    const base = goodConfig(repo)
    const config = {
      ...base,
      settings: {
        ...base.settings,
        workers: { ...base.settings.workers, permission_mode: "default" as const },
      },
    }
    const { cleared, printed, logged, asked } = await runPreflight({
      config,
      // Auto isn't available: Claude Code keeps workers in default mode.
      night: {
        probeAccount: (fixed) =>
          Effect.succeed({
            ...TestAccount.accountProbe(fixed),
            permissionMode: { requested: "auto", inEffect: "default" },
          }),
      },
      answers: [true],
    })
    expect(asked).toEqual([["Start workers in auto permission mode?", true]])
    expect(cleared).toEqual({ _tag: "Refused", failed: 1 })
    const said = printed.find((line) => line.includes("couldn't fix")) ?? ""
    expect(said).toEndWith(
      ": workers would still start in default permission mode: auto mode isn't available here",
    )
    expect(printed.some((line) => line.includes("Fixed:"))).toBe(false)
    expect(logged.some((line) => line.startsWith("overnight pre-flight: couldn't fix "))).toBe(true)
  })

  test("with a failed check left, asks whether to start anyway, no first", async () => {
    const repo = project()
    const refused = await runPreflight({
      config: goodConfig(repo, { limit: 5 }),
      answers: [false, false],
    })
    expect(refused.asked).toEqual([
      ["Run without a limit?", true],
      ["Start the run anyway, with 1 check failed?", false],
    ])
    expect(refused.cleared).toEqual({ _tag: "Refused", failed: 1 })

    const started = await runPreflight({
      config: goodConfig(repo, { limit: 5 }),
      answers: [false, true],
    })
    if (started.cleared._tag !== "Cleared") throw new Error("expected the run cleared")
    expect(started.cleared.started.config.limit).toBe(5)
    expect(started.printed).toContain(
      "◆ overnight pre-flight: starting with 1 check failed (as answered)",
    )
  })

  test("a cancelled question ends it with nothing changed", async () => {
    const repo = project()
    // The first fix taken, then the second question cancelled: no fix is made.
    const { cleared, printed, logged } = await runPreflight({
      config: goodConfig(repo, { limit: 5, usageLimitWait: Duration.zero }),
      answers: [true, undefined],
    })
    expect(cleared).toEqual({ _tag: "Cancelled" })
    expect(printed.some((line) => line.includes("Fixed:"))).toBe(false)
    expect(logged.some((line) => line.includes("fixed:"))).toBe(false)
  })

  test("warns of the account at its usage limit now, and of no ticket ready", async () => {
    const repo = project()
    const resetsAt = Date.now() + 90 * 60_000
    const { cleared, printed } = await runPreflight({
      config: goodConfig(repo, {
        settings: {
          ...goodConfig(repo).settings,
          workers: { ...goodConfig(repo).settings.workers, model: "opus" },
        },
      }),
      probe: [ProbeAnswer.Refused({ limit: "five_hour", resetsAt })],
      tickets: [
        { id: "q-1", title: "Which?", labels: ["human"] },
        { id: "tut-2", title: "Waits", blockedBy: ["q-1"] },
      ],
    })
    expect(cleared._tag).toBe("Cleared")
    const lines = checklist(printed)
    expect(
      lines.find((line) => line.startsWith("  ! the account is at its five-hour limit now")),
    ).toContain(": no ticket starts until it resets, at ")
    expect(lines).toContain(
      "  ! no ticket is ready, and 1 more waits only on questions, to be ready once it is answered: unless they are answered first (tutti answer), the run would end at once",
    )
    expect(printed).toContain("◆ Overnight pre-flight: 2 warnings, 14 passed")
  })

  test("with no ticket ready and none waiting, warns that the run would end at once", async () => {
    const repo = project()
    const { printed } = await runPreflight({ config: goodConfig(repo), tickets: [] })
    expect(checklist(printed)).toContain(
      "  ! no ticket is ready: with nothing to work on, the run would end at once",
    )
  })

  test("fails under the free disk wanted, warns where it can't tell, and 0 doesn't check", async () => {
    const repo = project()
    const low = await runPreflight({
      config: goodConfig(repo),
      night: { disk: () => Effect.succeed({ free: 5 * gb, where: "/work" }) },
    })
    expect(checklist(low.printed)).toContain(
      "  ✗ 5 GB free in /work, where the worktrees go, under the 20 GB an overnight run wants (--overnight-free-disk): each worktree holds its own dependencies, and a full disk would stop the run. Free some space",
    )
    const unknown = await runPreflight({
      config: goodConfig(repo),
      night: { disk: () => Effect.fail({ where: "/work", reason: "statfs failed" }) },
    })
    expect(checklist(unknown.printed)).toContain(
      "  ! tutti couldn't tell how much disk is free in /work: statfs failed",
    )
    const unchecked = await runPreflight({
      config: goodConfig(repo, { overnightFreeDisk: 0 }),
      night: { disk: () => Effect.succeed({ free: 0, where: "/work" }) },
    })
    expect(checklist(unchecked.printed)).toContain(
      "  ✓ free disk isn't checked (--overnight-free-disk 0)",
    )
  })

  test("--keep-awake=false fails it", async () => {
    const repo = project()
    const { cleared, printed } = await runPreflight({
      config: goodConfig(repo, { keepAwake: false }),
      night: { awake: { _tag: "Off" } },
    })
    expect(cleared).toEqual({ _tag: "Refused", failed: 1 })
    expect(checklist(printed).some((line) => line.startsWith("  ✗ --keep-awake is off"))).toBe(true)
  })

  test("a project without a merge check passes that check", async () => {
    const repo = project()
    const base = goodConfig(repo)
    const { printed, runs } = await runPreflight({
      config: {
        ...base,
        settings: {
          ...base.settings,
          checks: {
            ...base.settings.checks,
            fast: { ...base.settings.checks.fast, command: null },
          },
        },
      },
    })
    expect(runs).toEqual([])
    expect(checklist(printed).at(-1)).toBe(
      "  ✓ no merge check (checks.fast.command) to run on main",
    )
  })

  test("offers to bring a worker prompt older than tutti's templates up to date", async () => {
    const repo = project()
    const old = readFileSync(
      join(import.meta.dir, "fixtures", "templates", "worker-prompt-2026-10-17.md"),
      "utf8",
    )
    const file = join(repo, ".tutti", "worker-prompt.md")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, old)
    const { printed, asked } = await runPreflight({
      config: goodConfig(repo),
      answers: [false],
    })
    expect(
      checklist(printed).some((line) =>
        line.startsWith("  ! .tutti/worker-prompt.md is older than tutti's worker prompt template"),
      ),
    ).toBe(true)
    expect(asked).toEqual([
      ["Bring them up to date as tutti init --update does, and commit that on main?", true],
    ])
  })
})
