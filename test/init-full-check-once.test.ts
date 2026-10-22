// tutti init's full check runs each test once (§ 6.3, § 8.3): a full suite the scout marks as
// covering the fast ones runs alone in scripts/check-full.sh, without check-fast.sh first; a full
// runner the project has is kept unless replacing it is chosen; and build steps found only in CI
// are offered unticked, with what they cost. tutti's own checkout is the case: scripts/check.sh with
// TUTTI_SLOW=1 runs every check, and the host build is CI's.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import {
  type ChecksAnswers,
  type ChecksQuestions,
  choiceScripts,
  chooseFound,
  ciBuild,
  offeredSuites,
  type Scouted,
  scoutSearch,
  settleScout,
  suiteLabel,
  verifierPath,
  verifierText,
} from "../src/init/checks.ts"
import { fullChecklistDescription } from "../src/init/form.ts"
import { type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { fullScript, runnerCommands, type Suite } from "../src/init/runners.ts"
import { stepLine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import { type Scouting, type Suite as ScoutSuite, tidy } from "../src/organs/scout.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const suite = (over: Partial<ScoutSuite> & Pick<ScoutSuite, "name" | "command">): ScoutSuite => ({
  kind: "unit",
  targeted: "",
  found_in: "package.json:7",
  tier: "fast",
  covers_fast: false,
  ci_build: false,
  cost: "",
  parallel_safe: true,
  needs: [],
  ...over,
})

/** What the scout finds in tutti's own checkout. */
const tutti: Scouting = {
  suites: [
    suite({
      name: "check",
      kind: "other",
      command: "scripts/check.sh",
      found_in: "scripts/check-fast.sh:14",
    }),
    suite({
      name: "check with the slow suites",
      kind: "other",
      command: "TUTTI_SLOW=1 scripts/check.sh",
      targeted: "TUTTI_SLOW=1 scripts/test.sh <files>",
      found_in: "scripts/check-full.sh:16",
      tier: "full",
      covers_fast: true,
    }),
    suite({
      name: "host build",
      kind: "build",
      command: "scripts/build.sh --out dist host",
      found_in: ".github/workflows/ci.yml:40",
      tier: "full",
      ci_build: true,
      cost: "a 340 MB compile",
    }),
  ],
  stack: ["TypeScript", "Bun"],
  note: "",
}

/** tutti's own scripts/check-full.sh, one pass, as the maintainer restored it. */
const onePass = `#!/bin/sh
# scripts/check-full.sh: every check in one pass, the slow suites included.
set -e
cd "$(dirname "$0")/.."

# check with the slow suites (real git, marked with test/gates.ts' slow), defined in scripts/check.sh
echo "SUITE: check-slow"
(TUTTI_SLOW=1 scripts/check.sh)
`

/** The choice the checklists' defaults make, with no untested areas filed. */
const defaultChoice = (scouted: Scouted) =>
  chooseFound(scouted, scouted.fast, scouted.fullTicked, false)

describe("a full suite covering the fast ones", () => {
  test("check-full.sh runs it alone, without check-fast.sh first, and says so", () => {
    const slow: Suite = {
      name: "slow",
      command: "TUTTI_SLOW=1 scripts/check.sh",
      foundIn: "scripts/check-full.sh:16",
      serial: false,
      coversFast: true,
    }
    const e2e: Suite = { name: "e2e", command: "npx playwright test", foundIn: "x", serial: true }
    const script = fullScript([e2e, slow], false)
    // The covering suite first, then the rest; never check-fast.sh.
    expect(runnerCommands(script)).toEqual(["TUTTI_SLOW=1 scripts/check.sh", "npx playwright test"])
    expect(script).not.toContain("SUITE: scripts/check-fast.sh")
    expect(script).toStartWith("#!/bin/sh\n# scripts/check-full.sh: every check, each test once.")
    expect(script).toContain("so check-fast.sh doesn't run first")
    expect(script).toContain(
      "# slow, from scripts/check-full.sh:16, runs all scripts/check-fast.sh does, and more\n",
    )
    // The rest of the template's header stays.
    expect(script).toContain("# tutti init wrote it; it is the project's to edit.")

    // Without one, check-fast.sh runs first, as before.
    expect(runnerCommands(fullScript([e2e], false))).toEqual([
      "scripts/check-fast.sh",
      "npx playwright test",
    ])
  })

  test("tutti's case: check-full.sh is TUTTI_SLOW=1 scripts/check.sh alone, each test once", () => {
    const scouted = settleScout({ found: tutti }, true)
    // scripts/check.sh is the fast suite; the covering one that runs it stays a full suite.
    expect(scouted.suites.map((each) => each.command)).toEqual([
      "scripts/check.sh",
      "TUTTI_SLOW=1 scripts/check.sh",
      "scripts/build.sh --out dist host",
    ])
    expect(scouted.fast).toEqual([0])
    expect(scouted.full).toEqual([1, 2])
    // The CI build is offered, unticked.
    expect(scouted.fullTicked).toEqual([1])

    const scripts = choiceScripts(defaultChoice(scouted))
    expect(scripts).not.toBeNull()
    expect(runnerCommands(scripts?.fast ?? "")).toEqual(["scripts/check.sh"])
    expect(runnerCommands(scripts?.full ?? "")).toEqual(["TUTTI_SLOW=1 scripts/check.sh"])
  })

  test("a covering suite running scripts/check.sh isn't taken for the project's own check", () => {
    const offered = offeredSuites([tutti.suites[1] as ScoutSuite], true)
    expect(offered.map((each) => [each.command, each.tier])).toEqual([
      ["scripts/check.sh", "fast"],
      ["TUTTI_SLOW=1 scripts/check.sh", "full"],
    ])
  })

  test("the scout's covers_fast holds only on a full suite", () => {
    const tidied = tidy({
      ...tutti,
      suites: [suite({ name: "unit", command: "npm test", covers_fast: true })],
    })
    expect(typeof tidied === "string" ? tidied : tidied.suites[0]?.covers_fast).toBe(false)
  })

  test("the verifier says check-full.sh runs its suites alone", () => {
    const alone = verifierText([], ["scripts/check.sh"], ["TUTTI_SLOW=1 scripts/check.sh"], true)
    expect(alone).toContain(
      "which tutti runs at the end of a run: these, each test once:\n  - `TUTTI_SLOW=1 scripts/check.sh`\n",
    )
    expect(alone).not.toContain("`scripts/check-fast.sh`, then:")
    const after = verifierText([], ["scripts/check.sh"], ["npx playwright test"])
    expect(after).toContain("which tutti runs at the end of a run: `scripts/check-fast.sh`, then:")
  })
})

describe("build steps found only in CI", () => {
  test("are offered unticked, saying what they cost", () => {
    const scouted = settleScout({ found: tutti }, true)
    const build = scouted.suites[2] as ScoutSuite
    expect(suiteLabel(build)).toBe(
      "scripts/build.sh --out dist host  · host build · .github/workflows/ci.yml:40 · CI only: a 340 MB compile",
    )
    expect(suiteLabel(scouted.suites[1] as ScoutSuite)).toContain("runs all check-fast does")
    const description = fullChecklistDescription(scouted)
    expect(description).toContain(
      "One that runs all check-fast does runs instead of scripts/check-fast.sh, so each test runs once.",
    )
    expect(description).toContain(
      "Build steps found only in CI start unticked: CI runs them already, and a full check runs at the end of every run.",
    )
  })

  test("a build found in a CI file counts as one even where the scout doesn't say so", () => {
    const build = suite({
      name: "docker",
      kind: "build",
      command: "docker build .",
      found_in: ".github/workflows/release.yml:12",
      tier: "fast",
    })
    expect(ciBuild(build)).toBe(true)
    expect(suiteLabel(build)).toContain("CI only, which runs it already")
    // A fast one goes to check-full's checklist, unticked.
    const scouted = settleScout({ found: { ...tutti, suites: [build] } }, false)
    expect(scouted).toMatchObject({ fast: [], full: [0], fullTicked: [] })
    // A build the project defines itself isn't.
    expect(ciBuild({ ...build, found_in: "package.json:9" })).toBe(false)
  })
})

describe("the form, in lines", () => {
  const answerChecks = async (input: string, questions: ChecksQuestions) => {
    const stream = new PassThrough()
    stream.write(input)
    stream.end()
    let output = ""
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const form = lineForm({
            input: yield* streamInput(stream),
            write: (text) => {
              output += text
            },
            theme: makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true }),
          })
          return yield* form.checks(questions)
        }),
      ),
    )
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    return { answers: exit.value, output }
  }

  const questions = (full: string | null): ChecksQuestions => ({
    checks: {
      scout: Effect.succeed(tutti),
      checkScript: true,
      command: "",
      keepsRunner: true,
      runners: { fast: null, full },
      skill: "missing",
    },
    setup: null,
    prefix: null,
    verifier: false,
  })

  test("the defaults keep the project's own full runner, and tick the covering suite only", async () => {
    // Enter for the choice, both checklists' defaults, no untested areas, and Replace?'s default.
    const { answers, output } = await answerChecks("\n\n\nn\n\n", questions(onePass))
    expect(answers.checks).toMatchObject({
      kind: "found",
      fast: [{ command: "scripts/check.sh" }],
      full: [{ command: "TUTTI_SLOW=1 scripts/check.sh", coversFast: true }],
    })
    expect(output).toContain("Enter keeps 1.")
    expect(output).toContain("Replace scripts/check-full.sh?")
    expect(answers.replaceFull).toBe(false)
  })

  test("replacing it is the user's choice", async () => {
    const { answers } = await answerChecks("\n\n\nn\ny\n", questions(onePass))
    expect(answers.replaceFull).toBe(true)
  })
})

describe("init", () => {
  const newProject = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-full-once-")))
    const repo = join(root, "repo")
    const home = join(root, "home")
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(join(repo, "scripts"))
    mkdirSync(home)
    writeFileSync(join(repo, "scripts/check.sh"), "#!/bin/sh\nexit 0\n")
    return { repo, commonDir: join(repo, ".git"), home }
  }

  /** A form answering the Checks step with the defaults, and `over`. */
  const form = (over: ChecksAnswers = {}): InitForm => ({
    workers: () => Effect.succeed({}),
    checks: (questions) =>
      Effect.gen(function* () {
        if (questions.checks === null) return over
        const found = yield* Effect.orDie(questions.checks.scout)
        const scouted = settleScout({ found }, questions.checks.checkScript)
        return { checks: defaultChoice(scouted), stack: scouted.stack, verifier: true, ...over }
      }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  })

  const runInit = (project: ReturnType<typeof newProject>, answers: ChecksAnswers = {}) => {
    const organs = Organs.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          cannedLayer({ scout: { ...tutti } }, []),
          TestAppConfig.layer(TestAppConfig.appConfig({})),
          logLayer(),
        ),
      ),
    )
    return Effect.runPromise(
      Effect.exit(
        init({
          repo: project.repo,
          commonDir: project.commonDir,
          branch: "main",
          version: "0.1.0",
          flags: { force: false },
          form: form(answers),
          scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
          machine: {
            run: () => Effect.succeed(""),
            which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
            env: (name) => (name === "HOME" ? project.home : undefined),
            platform: "darwin",
            executable: () => false,
          },
          configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
          account: TestAccount.layer(),
          claudeConfig: join(project.home, ".claude.json"),
        }),
      ).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer([])),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
        ),
        Effect.provide(BunServices.layer),
      ),
    )
  }

  const stepsOf = (exit: Exit.Exit<InitSummary, unknown>) => {
    if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
    return exit.value.steps.map(stepLine)
  }

  const read = (project: ReturnType<typeof newProject>, path: string) =>
    readFileSync(join(project.repo, path), "utf8")

  test("writes check-full.sh running the covering suite alone, and the verifier says so", async () => {
    const project = newProject()
    const steps = stepsOf(await runInit(project))
    expect(runnerCommands(read(project, "scripts/check-full.sh"))).toEqual([
      "TUTTI_SLOW=1 scripts/check.sh",
    ])
    expect(steps).toContain(
      "✓ check-full  wrote scripts/check-full.sh: 'TUTTI_SLOW=1 scripts/check.sh' runs all scripts/check-fast.sh does, so scripts/check-fast.sh doesn't run first",
    )
    expect(read(project, verifierPath)).toContain(
      "which tutti runs at the end of a run: these, each test once:\n  - `TUTTI_SLOW=1 scripts/check.sh`\n",
    )
  })

  test("keeps the project's own full runner unless replacing it is chosen", async () => {
    for (const replace of [false, true]) {
      const project = newProject()
      writeFileSync(join(project.repo, "scripts/check-full.sh"), onePass)
      const steps = stepsOf(await runInit(project, { replaceFull: replace }))
      if (replace) {
        expect(runnerCommands(read(project, "scripts/check-full.sh"))).toEqual([
          "TUTTI_SLOW=1 scripts/check.sh",
        ])
      } else {
        expect(read(project, "scripts/check-full.sh")).toBe(onePass)
        expect(steps).toContain(
          `! check-full  scripts/check-full.sh differs from what init would write; kept (tutti init --check-full "<command>" replaces it)`,
        )
      }
    }
  })
})
