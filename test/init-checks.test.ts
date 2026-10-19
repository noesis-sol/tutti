// tutti init's Checks step (§ 8.3, § 6.3): the scout, with canned answers through the Organs test
// layer; the three choices of checks; the setup command, the ticket prefix and the verifier; and
// the test-work tickets, filed labelled tutti-tests in the in-memory backlog. Each runs init in a
// temp repository with a scripted form and a scripted machine, as test/init.test.ts does.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import {
  type ChecksAnswers,
  type ChecksQuestions,
  chooseFound,
  mapUntestedTitle,
  offeredSuites,
  passRunnersTitle,
  type Scouted,
  scoutSearch,
  scoutSkipped,
  settleScout,
  setUpTestsTitle,
  skillPath,
  skillText,
  suiteLabel,
  testsEpicTitle,
  testWorkLabel,
  verifierPath,
  verifierSection,
} from "../src/init/checks.ts"
import {
  cancelledLine,
  type InitFlags,
  type InitForm,
  type InitSummary,
  init,
  summaryLines,
} from "../src/init/init.ts"
import { lineForm, readTicked } from "../src/init/lineForm.ts"
import { fastScript, runnerCommands } from "../src/init/runners.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import { Organs } from "../src/organs/Organs.ts"
import type { Scouting, Suite as ScoutSuite } from "../src/organs/scout.ts"
import type { Issue } from "../src/services/Beads.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { FormCancelled } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

/** A temp repository (its top and git folder) and a home folder. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-checks-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** A scripted machine: bd on the PATH, each command answered by `answer` ("" by default). */
const scriptedMachine = (
  project: Project,
  answer: (command: string, args: ReadonlyArray<string>) => string | undefined = () => undefined,
) => {
  const ran: Array<string> = []
  const machine: Machine = {
    run: (command, args) =>
      Effect.sync(() => {
        ran.push([command, ...args].join(" "))
        return answer(command, args) ?? ""
      }),
    which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
    env: (name) => (name === "HOME" ? project.home : undefined),
    platform: "darwin",
    executable: () => false,
  }
  return { machine, ran }
}

const suite = (over: Partial<ScoutSuite> & Pick<ScoutSuite, "name" | "command">): ScoutSuite => ({
  kind: "unit",
  found_in: "package.json:7",
  tier: "fast",
  parallel_safe: true,
  needs: [],
  ...over,
})

const scouting = (over: Partial<Scouting> = {}): Scouting => ({
  suites: [],
  stack: [],
  note: "",
  ...over,
})

/** The suites a canned scout finds in the tests below. */
const twoSuites = scouting({
  suites: [
    suite({ name: "unit tests", command: "npm test" }),
    suite({
      name: "e2e",
      kind: "e2e",
      command: "npx playwright test",
      found_in: "playwright.config.ts:1",
      tier: "full",
      parallel_safe: false,
      needs: ["a browser"],
    }),
  ],
  stack: ["TypeScript 5.9", "Playwright"],
})

/** A scripted Checks step: runs the scout as the form does, then answers with `pick`. */
const checksForm = (
  pick: (scouted: Scouted | null, questions: ChecksQuestions) => ChecksAnswers,
) => {
  const asked: Array<ChecksQuestions> = []
  const scouted: Array<Scouted> = []
  const form: InitForm = {
    workers: () => Effect.succeed({}),
    checks: (questions) =>
      Effect.gen(function* () {
        asked.push(questions)
        let settled: Scouted | null = null
        if (questions.checks !== null) {
          const result = yield* questions.checks.scout.pipe(
            Effect.match({
              onSuccess: (found) => ({ found }),
              onFailure: (failed) => ({ failed }),
            }),
          )
          settled = settleScout(result, questions.checks.checkScript)
          scouted.push(settled)
        }
        return pick(settled, questions)
      }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  }
  return { form, asked, scouted }
}

/** The answers that take what the scout's outcome selects, the defaults ticked. */
const defaults =
  (over: ChecksAnswers & { readonly fileUntested?: boolean } = {}) =>
  (scouted: Scouted | null): ChecksAnswers => {
    const { fileUntested, ...rest } = over
    const checks: ChecksAnswers["checks"] =
      scouted === null
        ? undefined
        : scouted.picked === "found"
          ? chooseFound(scouted, scouted.fast, scouted.full, fileUntested ?? false)
          : scouted.picked === "scratch"
            ? { kind: "scratch" }
            : { kind: "manual", command: "" }
    return {
      ...(checks === undefined ? {} : { checks }),
      stack: scouted?.stack ?? [],
      verifier: false,
      ...rest,
    }
  }

const noFlags: InitFlags = { force: false }

/**
 * Runs init in `project` with the scout's canned `answer` (none: it fails), and gives its exit,
 * the backlog afterwards and the organ calls made.
 */
const runInit = async (
  project: Project,
  over: {
    readonly flags?: InitFlags
    readonly form?: InitForm | null
    readonly machine?: Machine
    readonly scout?: Scouting | null
    readonly beads?: ReadonlyArray<TestBeads.Seed>
    readonly branch?: string
  } = {},
) => {
  const calls: Array<OrganCallRecord> = []
  const organs = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer(
          over.scout === null || over.scout === undefined ? {} : { scout: { ...over.scout } },
          calls,
        ),
        TestAppConfig.layer(TestAppConfig.appConfig({})),
        logLayer(),
      ),
    ),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        init({
          repo: project.repo,
          commonDir: project.commonDir,
          branch: over.branch ?? "main",
          version: "0.1.0",
          flags: over.flags ?? noFlags,
          form: over.form ?? null,
          scout: scoutSearch(project.repo).pipe(Effect.provide(organs)),
          machine: over.machine ?? scriptedMachine(project).machine,
          configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
          account: TestAccount.layer(),
          claudeConfig: join(project.home, ".claude.json"),
        }),
      )
      const issues = yield* (yield* TestBeads.Backlog).issues
      return { exit, issues }
    }).pipe(
      Effect.provide(RunLock.layer),
      Effect.provide(TestBeads.layer(over.beads ?? [])),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
  return { ...result, calls }
}

const summaryOf = (exit: Exit.Exit<InitSummary, unknown>): InitSummary => {
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return exit.value
}

const lines = (summary: InitSummary) => summary.steps.map(stepLine)

const read = (project: Project, path: string) => readFileSync(join(project.repo, path), "utf8")

const write = (project: Project, path: string, text: string) => {
  mkdirSync(join(project.repo, path, ".."), { recursive: true })
  writeFileSync(join(project.repo, path), text)
}

const titled = (issues: ReadonlyArray<Issue>, title: string) => {
  const found = issues.find((issue) => issue.title === title)
  if (found === undefined) throw new Error(`no ticket titled ${title}`)
  return found
}

describe("the scout's outcome", () => {
  test("suites found select 'use them as they are', the fast ones ticked for check-fast", () => {
    const scouted = settleScout({ found: twoSuites }, false)
    expect(scouted.picked).toBe("found")
    expect(scouted.why).toBe("The scout found 2 suites.")
    expect(scouted.fast).toEqual([0])
    expect(scouted.full).toEqual([1])
    expect(scouted.stack).toEqual(["TypeScript 5.9", "Playwright"])
  })

  test("no suites select 'create from scratch', with the scout's note", () => {
    const scouted = settleScout({ found: scouting({ note: "No manifests at all." }) }, false)
    expect(scouted.picked).toBe("scratch")
    expect(scouted.why).toBe("The scout found no suites. No manifests at all.")
  })

  test("a failed or skipped scout selects 'manual', saying why", () => {
    expect(settleScout({ failed: scoutSkipped }, false)).toMatchObject({
      picked: "manual",
      why: "The search was skipped with Esc.",
      suites: [],
    })
    expect(settleScout({ failed: "the scout failed: no answer" }, false).why).toBe(
      "The scout failed: no answer.",
    )
  })

  test("scripts/check.sh comes first, as a fast suite; a suite running a runner is left out", () => {
    const offered = offeredSuites(
      [
        suite({ name: "lint", command: "npm run lint" }),
        suite({ name: "all", command: "./scripts/check-fast.sh", tier: "full" }),
        suite({ name: "check", command: "./scripts/check.sh", tier: "full" }),
      ],
      true,
    )
    expect(offered.map((each) => [each.command, each.tier])).toEqual([
      ["./scripts/check.sh", "fast"],
      ["npm run lint", "fast"],
    ])
    // A scout that left it out has it added, taking turns.
    const added = offeredSuites([], true)
    expect(added).toMatchObject([{ command: "scripts/check.sh", parallel_safe: false }])
  })

  test("a suite ticked in both checklists runs in check-fast only", () => {
    const scouted = settleScout({ found: twoSuites }, false)
    const chosen = chooseFound(scouted, [0, 1], [1], false)
    expect(chosen).toMatchObject({
      kind: "found",
      fast: [{ command: "npm test" }, { command: "npx playwright test", serial: true }],
      full: [],
    })
  })

  test("the scout's words are shown on one line, without control characters", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (name, command, note) => {
        const found = scouting({
          suites: [suite({ name, command: `x${command}`, needs: [note] })],
          note,
        })
        const scouted = settleScout({ found }, false)
        const shown = [scouted.why, ...scouted.suites.map(suiteLabel)]
        for (const line of shown) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: what the lines must not hold
          expect(/[\u0000-\u001f\u007f]/.test(line)).toBe(false)
        }
      }),
    )
  })

  test("the line form reads a checklist's numbers", () => {
    expect(readTicked("", 3, [0, 2])).toEqual({ ok: [0, 2] })
    expect(readTicked("-", 3, [0])).toEqual({ ok: [] })
    expect(readTicked("3, 1 3", 3, [])).toEqual({ ok: [0, 2] })
    expect(readTicked("4", 3, [])).toEqual({
      error: "Enter numbers from 1 to 3, comma-separated; - for none.",
    })
  })

  test("a runner's commands are its suites' lines, whatever they say", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.string(),
            command: fc
              .string({ minLength: 1 })
              .filter((text) => !text.includes("\n") && text.trim() !== "")
              // Not one of the lines the runner's format writes around a suite.
              .filter((text) => {
                const line = text.trim()
                return !(
                  ["(", ")", "unlock", "set -e", `cd "$(dirname "$0")/.."`].includes(line) ||
                  /^(#|lock |printf )/.test(line)
                )
              }),
            serial: fc.boolean(),
          }),
          { maxLength: 4 },
        ),
        (suites) => {
          const kept = suites.map((each) => ({ ...each, foundIn: "x" }))
          const script = fastScript(kept)
          const expected = kept
            .map((each) => each.command.trim())
            .filter((command) => !/scripts\/check-f(ast|ull)\.sh/.test(command))
          const commands = runnerCommands(script)
          expect(commands.length === 0 ? [] : commands).toEqual(
            expected.length === 0 ? ["exit 0"] : expected,
          )
        },
      ),
    )
  })
})

describe("the choice of checks", () => {
  test("use them as they are: the runners run the suites, and the solo ticket gets them passing", async () => {
    const project = newProject()
    const { form, asked, scouted } = checksForm(defaults())
    const { exit, issues, calls } = await runInit(project, { form, scout: twoSuites })
    const summary = summaryOf(exit)

    expect(calls.map((call) => call.call.organ)).toEqual(["scout"])
    expect(asked[0]?.checks).not.toBeNull()
    expect(scouted[0]?.picked).toBe("found")
    const fast = read(project, "scripts/check-fast.sh")
    expect(runnerCommands(fast)).toEqual(["npm test"])
    const full = read(project, "scripts/check-full.sh")
    expect(runnerCommands(full)).toEqual(["scripts/check-fast.sh", "npx playwright test"])
    // Not safe in two worktrees at once: it takes turns.
    expect(full).toContain("lock e2e\n(\nnpx playwright test\n)\nunlock\n")
    expect(statSync(join(project.repo, "scripts/check-full.sh")).mode & 0o777).toBe(0o755)

    const pass = titled(issues, passRunnersTitle("main"))
    expect(pass).toMatchObject({ priority: 1, type: "task" })
    expect(pass.labels).toEqual([testWorkLabel, "solo"])
    expect(pass.parent).toBeUndefined()
    expect(issues).toHaveLength(1)
    expect(lines(summary)).toContain(
      `✓ ticket  filed ${pass.id} (P1, solo): ${passRunnersTitle("main")}`,
    )
    // No test work needs the skill.
    expect(existsSync(join(project.repo, skillPath))).toBe(false)
  })

  test("with the untested areas: an epic, the solo ticket under it, and the map waiting for it", async () => {
    const project = newProject()
    const { form } = checksForm(defaults({ fileUntested: true }))
    const { exit, issues } = await runInit(project, { form, scout: twoSuites, branch: "trunk" })
    const summary = summaryOf(exit)

    const epic = titled(issues, testsEpicTitle)
    const pass = titled(issues, passRunnersTitle("trunk"))
    const map = titled(issues, mapUntestedTitle)
    expect(epic).toMatchObject({ type: "epic", labels: [testWorkLabel] })
    expect(pass).toMatchObject({ parent: epic.id, priority: 1, labels: [testWorkLabel, "solo"] })
    expect(map).toMatchObject({ parent: epic.id, priority: 2, labels: [testWorkLabel] })
    expect(
      map.dependencies.filter((link) => link.type === "blocks").map((link) => link.id),
    ).toEqual([pass.id])
    expect(map.description).toContain(skillPath)
    expect(read(project, skillPath)).toBe(skillText)
    expect(lines(summary)).toContain(
      "✓ skill  wrote .claude/skills/create-check-suite/, for the tickets that set up the project's tests",
    )
  })

  test("create from scratch: runners that check nothing, an epic and its solo P1 ticket", async () => {
    const project = newProject()
    const { form, scouted } = checksForm(defaults())
    const { exit, issues } = await runInit(project, {
      form,
      scout: scouting({ note: "No tests here." }),
    })
    const summary = summaryOf(exit)

    expect(scouted[0]?.picked).toBe("scratch")
    expect(read(project, "scripts/check-fast.sh")).toEndWith("\nexit 0\n")
    expect(read(project, "scripts/check-full.sh")).toEndWith("\nexit 0\n")
    const epic = titled(issues, testsEpicTitle)
    const setUp = titled(issues, setUpTestsTitle)
    expect(setUp).toMatchObject({ parent: epic.id, priority: 1, labels: [testWorkLabel, "solo"] })
    expect(setUp.description).toContain("get both runners passing on main")
    expect(read(project, skillPath)).toBe(skillText)
    expect(read(project, skillPath)).toStartWith("---\nname: create-check-suite\n")
    expect(lines(summary).filter((line) => line.startsWith("✓ ticket"))).toHaveLength(2)
  })

  test("manual, after a scout that failed: check-fast.sh runs the command typed, and no ticket is filed", async () => {
    const project = newProject()
    const { form, scouted } = checksForm((settled) => ({
      ...defaults()(settled),
      checks: { kind: "manual", command: "make check" },
    }))
    const { exit, issues } = await runInit(project, { form, scout: null })
    summaryOf(exit)

    expect(scouted[0]?.picked).toBe("manual")
    expect(scouted[0]?.why).toStartWith("The scout failed:")
    expect(runnerCommands(read(project, "scripts/check-fast.sh"))).toEqual(["make check"])
    expect(issues).toEqual([])
    expect(existsSync(join(project.repo, skillPath))).toBe(false)
  })

  test("a runner there that differs is kept unless replacing it is chosen", async () => {
    for (const replace of [false, true]) {
      const project = newProject()
      write(project, "scripts/check-fast.sh", "#!/bin/sh\nmake ours\n")
      const { form, asked } = checksForm(defaults({ replaceFast: replace }))
      const { exit } = await runInit(project, { form, scout: twoSuites })
      const summary = summaryOf(exit)

      expect(asked[0]?.checks?.runners.fast).toBe("#!/bin/sh\nmake ours\n")
      if (replace) {
        expect(runnerCommands(read(project, "scripts/check-fast.sh"))).toEqual(["npm test"])
        expect(lines(summary)).toContain("✓ check-fast  replaced scripts/check-fast.sh")
      } else {
        expect(read(project, "scripts/check-fast.sh")).toBe("#!/bin/sh\nmake ours\n")
        expect(lines(summary)).toContain(
          `! check-fast  scripts/check-fast.sh differs from what init would write; kept (tutti init --check-fast "<command>" replaces it)`,
        )
      }
    }
  })

  test("a flag giving the checks asks no choice and runs no scout", async () => {
    const project = newProject()
    const { form, asked } = checksForm(defaults())
    const { exit, calls } = await runInit(project, {
      form,
      flags: { force: false, checkFast: "make lint" },
      scout: twoSuites,
    })
    summaryOf(exit)
    expect(asked[0]?.checks).toBeNull()
    expect(calls).toEqual([])
    expect(runnerCommands(read(project, "scripts/check-fast.sh"))).toEqual(["make lint"])
  })

  test("without a terminal there is no scout, and nothing is filed", async () => {
    const project = newProject()
    const { exit, issues, calls } = await runInit(project, { scout: twoSuites })
    const summary = summaryOf(exit)
    expect(calls).toEqual([])
    expect(issues).toEqual([])
    expect(lines(summary)).toContain(
      "• verifier  not asked (no terminal): --verifier writes .claude/agents/verifier.md, a subagent that checks each ticket's change in a fresh context",
    )
  })

  test("run again, init files only the test work that isn't open", async () => {
    const project = newProject()
    const seeds: ReadonlyArray<TestBeads.Seed> = [
      { id: "app-1", title: testsEpicTitle, type: "epic", labels: [testWorkLabel] },
      {
        id: "app-2",
        title: setUpTestsTitle,
        labels: [testWorkLabel, "solo"],
        status: "closed",
      },
    ]
    const { form } = checksForm(defaults())
    const { exit, issues } = await runInit(project, { form, scout: scouting(), beads: seeds })
    const summary = summaryOf(exit)

    expect(lines(summary)).toContain(`• ticket  app-1 is open: ${testsEpicTitle}; not filed again`)
    const again = issues.filter((issue) => issue.title === setUpTestsTitle)
    expect(again.map((issue) => issue.status)).toEqual(["closed", "open"])
    expect(again[1]?.parent).toBe("app-1")
    expect(issues.filter((issue) => issue.title === testsEpicTitle)).toHaveLength(1)
  })

  test("a cancelled Checks step changes nothing", async () => {
    const project = newProject()
    const form: InitForm = {
      ...checksForm(defaults()).form,
      checks: () => Effect.fail(new FormCancelled()),
    }
    const { exit, issues } = await runInit(project, { form, scout: twoSuites })
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("FormCancelled")
    expect(existsSync(join(project.repo, ".tutti"))).toBe(false)
    expect(existsSync(join(project.repo, "scripts"))).toBe(false)
    expect(issues).toEqual([])
    expect(cancelledLine).toBe("Cancelled; nothing was changed.")
  })
})

describe("the verifier", () => {
  test("chosen, it is written with the stack and the runners' commands, and the worker prompt runs it", async () => {
    const project = newProject()
    const { form, asked } = checksForm(defaults({ verifier: true }))
    const { exit } = await runInit(project, { form, scout: twoSuites })
    const summary = summaryOf(exit)

    expect(asked[0]?.verifier).toBe(true)
    const verifier = read(project, verifierPath)
    expect(verifier).toStartWith("---\nname: verifier\n")
    expect(verifier).toContain("- TypeScript 5.9\n- Playwright\n")
    expect(verifier).toContain(
      "- `scripts/check-fast.sh`, the check tutti runs on each ticket before it merges it, runs:\n  - `npm test`\n",
    )
    expect(verifier).toContain("runs `scripts/check-fast.sh`, then:\n  - `npx playwright test`\n")
    expect(verifier).not.toContain("{{")
    expect(read(project, ".tutti/worker-prompt.md")).toEndWith(verifierSection)
    expect(lines(summary)).toContain(
      "✓ verifier  wrote .claude/agents/verifier.md; the worker prompt has workers run it before they close a ticket",
    )
    expect(summary.next.join("\n")).toContain(".claude/agents/verifier.md")

    // Run again, it isn't asked, and the section isn't appended twice.
    const second = checksForm(defaults())
    summaryOf((await runInit(project, { form: second.form, scout: twoSuites })).exit)
    expect(second.asked[0]?.verifier).toBe(false)
    const prompt = read(project, ".tutti/worker-prompt.md")
    expect(prompt.indexOf("## Verify")).toBe(prompt.lastIndexOf("## Verify"))
  })

  test("--verifier writes it without asking, telling it the scout described no stack", async () => {
    const project = newProject()
    const { exit } = await runInit(project, { flags: { force: false, verifier: true } })
    summaryOf(exit)
    const verifier = read(project, verifierPath)
    expect(verifier).toContain("tutti init's scout didn't describe the stack")
    expect(verifier).toContain("runs:\n  - nothing yet.\n")
  })

  test("declined, nothing is written", async () => {
    const project = newProject()
    const { form } = checksForm(defaults({ verifier: false }))
    summaryOf((await runInit(project, { form, scout: twoSuites })).exit)
    expect(existsSync(join(project.repo, verifierPath))).toBe(false)
    expect(read(project, ".tutti/worker-prompt.md")).not.toContain("## Verify")
  })
})

describe("the setup command and the ticket prefix", () => {
  test("a lockfile offers its setup command, which the answer sets", async () => {
    const project = newProject()
    write(project, "package-lock.json", "{}")
    write(project, "Gemfile.lock", "")
    const { form, asked } = checksForm(defaults({ setup: "npm ci && bundle install" }))
    const summary = summaryOf((await runInit(project, { form, scout: twoSuites })).exit)

    expect(asked[0]?.setup).toEqual({
      offer: "npm ci && bundle install",
      lockfiles: ["package-lock.json", "Gemfile.lock"],
    })
    const settings = JSON.parse(read(project, ".tutti/settings.json"))
    expect(settings.checks.setup.command).toBe("npm ci && bundle install")
    expect(lines(summary)).toContain(
      "✓ setup  'npm ci && bundle install' runs before check-fast on a ticket whose rebase changes a dependency file",
    )
  })

  test("without a terminal, the setup command isn't asked, and the summary names the flag", async () => {
    const project = newProject()
    write(project, "uv.lock", "")
    const summary = summaryOf((await runInit(project)).exit)
    expect(lines(summary).find((line) => line.startsWith("! setup"))).toContain(
      "--setup 'uv sync' sets the command that installs them",
    )
  })

  test("a new Beads takes the prefix asked, prefilled with the folder's name", async () => {
    const project = newProject()
    const { machine, ran } = scriptedMachine(project)
    const { form, asked } = checksForm(defaults({ prefix: "app" }))
    const summary = summaryOf((await runInit(project, { form, machine, scout: twoSuites })).exit)

    expect(asked[0]?.prefix).toEqual({
      current: basename(project.repo),
      isNew: true,
      tickets: 0,
      example: null,
      refusal: null,
    })
    expect(ran).toContain(
      "bd init --non-interactive --role maintainer --init-if-missing --prefix app",
    )
    expect(lines(summary)).toContain("✓ ticket prefix  app, for the new Beads")
  })

  test("an existing Beads has its tickets renamed to the prefix asked", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, ".beads"))
    const { machine, ran } = scriptedMachine(project, (command, args) =>
      command === "bd" && args[0] === "config" ? JSON.stringify({ value: "old" }) : undefined,
    )
    const { form, asked } = checksForm(defaults({ prefix: "new" }))
    const summary = summaryOf(
      (
        await runInit(project, {
          form,
          machine,
          scout: twoSuites,
          beads: [{ id: "old-1" }, { id: "old-2" }],
        })
      ).exit,
    )

    expect(asked[0]?.prefix).toEqual({
      current: "old",
      isNew: false,
      tickets: 2,
      example: expect.stringMatching(/^old-\d$/),
      refusal: null,
    })
    expect(ran).toContain("bd rename-prefix new-")
    expect(lines(summary)).toContain("✓ ticket prefix  new (was old), 2 tickets renamed")
  })
})

describe("the summary's sign-off", () => {
  test("ends with whether a run can start", async () => {
    const project = newProject()
    mkdirSync(join(project.repo, ".beads"))
    const { form } = checksForm(defaults())
    const summary = summaryOf((await runInit(project, { form, scout: twoSuites })).exit)
    expect(summary.ready).toBe(true)
    expect(summaryLines(summary).at(-1)).toBe("♪ tutti is ready.")

    const missing = newProject()
    const unready = summaryOf((await runInit(missing, { form, scout: twoSuites })).exit)
    expect(summaryLines(unready).at(-1)).toBe("♪ Almost ready: fix what's missing above.")
  })
})

describe("the Checks step in lines", () => {
  /** The line form's Checks step over `input`, which then ends: its answers and what it wrote. */
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
    return { exit, output }
  }

  const questions: ChecksQuestions = {
    checks: {
      scout: Effect.succeed(twoSuites),
      checkScript: false,
      command: "",
      keepsRunner: false,
      runners: { fast: null, full: null },
      skill: "missing",
    },
    setup: { offer: "npm ci", lockfiles: ["package-lock.json"] },
    prefix: { current: "old", isNew: false, tickets: 3, example: "old-1", refusal: null },
    verifier: true,
  }

  test("runs the scout, then asks the choice, the checklists, setup, prefix and verifier", async () => {
    // Enter for the choice the scout selects, both checklists' defaults and no untested areas;
    // Enter for npm ci; a new prefix, its rename confirmed; the verifier declined.
    const { exit, output } = await answerChecks("\n\n\nn\n\nnew\ny\nn\n", questions)
    expect(Exit.isSuccess(exit) ? exit.value : String(exit)).toEqual({
      checks: {
        kind: "found",
        fast: [
          { name: "unit tests", command: "npm test", foundIn: "package.json:7", serial: false },
        ],
        full: [
          {
            name: "e2e",
            command: "npx playwright test",
            foundIn: "playwright.config.ts:1",
            serial: true,
          },
        ],
        fileUntested: false,
      },
      stack: ["TypeScript 5.9", "Playwright"],
      setup: "npm ci",
      prefix: "new",
      verifier: false,
    })
    expect(output).toContain("The scout found 2 suites.")
    expect(output).toContain("1. npm test  · unit tests · package.json:7")
    expect(output).toContain("Rename 3 tickets, old-1 → new-1?")
    expect(output).toContain("knowing the project is built with TypeScript 5.9, Playwright")
  })

  test("the end of input cancels it", async () => {
    const { exit } = await answerChecks("", questions)
    expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain("FormCancelled")
  })
})
