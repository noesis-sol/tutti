// tutti init's question Sync tickets with Linear? (tutti-qatu.6, § 8.3): asked in the Workers step
// with No selected, whether or not LINEAR_API_KEY is there; No writes no block, Yes with a key asks
// the team and the states and writes bd's linear.* keys and the block once the setup is written, Yes
// without one says how to get a key and writes nothing, init going on. --linear <team> and
// --linear=false answer it; without a terminal it is left off and the summary says so; settings
// that hold the block aren't asked, the block kept. The line form over a stream, and init whole in a
// temp repository with a scripted form and machine, bd's test layer and Linear's.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, type Layer, Option, Result } from "effect"
import {
  type InitFlagTexts,
  initFlags,
  readInitFlags,
  specSetupFlags,
} from "../src/cli/commands.ts"
import { linearKeyVariable } from "../src/core/env.ts"
import { type InitFlags, type InitForm, type InitSummary, init } from "../src/init/init.ts"
import { inbound, outboundKey, teamIdKey } from "../src/init/linear.ts"
import type { LinearAnswer } from "../src/init/linearQuestion.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { type Machine, stepLine } from "../src/init/steps.ts"
import type { WorkersAnswers, WorkersQuestions } from "../src/init/workers.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { settingsFile } from "../src/project/settings.ts"
import { stateMapKey } from "../src/run/linearCheck.ts"
import { type LinearApi, linearKeysPage } from "../src/services/LinearApi.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestLinear from "../src/testing/LinearApi.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme } from "../src/ui/theme.ts"

const key = "lin_api_SECRETsecret0123456789"

/** Two teams the key reaches: Engineering's states one of each type, Noesis' two started. */
const teams: TestLinear.TestLinear["teams"] = [
  { id: "team-eng", key: "ENG", name: "Engineering", states: TestLinear.defaultStates },
  {
    id: "team-noe",
    key: "NOE",
    name: "Noesis",
    states: [
      TestLinear.state("Backlog", "backlog", 0),
      TestLinear.state("Todo", "unstarted", 1),
      TestLinear.state("In Progress", "started", 2),
      TestLinear.state("In Review", "started", 3),
      TestLinear.state("Done", "completed", 4),
      TestLinear.state("Canceled", "canceled", 5),
    ],
  },
]

const eng = teams[0] as TestLinear.TestLinear["teams"][number]

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: true })

/** Bold and faint, which NO_COLOR keeps, left out, to read the output as text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the output's escape sequences
const unstyled = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "")

/** The Workers step asking the Linear question alone. */
const linearOnly = (api: Layer.Layer<LinearApi> | null): WorkersQuestions => ({
  installBeads: null,
  concurrent: null,
  model: false,
  effort: false,
  mcp: null,
  changelogUnion: false,
  linear: { api },
})

/** The Workers step in the line form over `typed`, which then ends: its answers and its output. */
const workers = async (typed: string, questions: WorkersQuestions) => {
  const stream = new PassThrough()
  stream.end(typed)
  let output = ""
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const form = lineForm({
          input: yield* streamInput(stream),
          write: (text) => {
            output += text
          },
          theme,
        })
        return yield* form.workers(questions)
      }),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`the form failed: ${exit.cause}`)
  return { answers: exit.value, output: unstyled(output) }
}

describe("the question in init's form", () => {
  test("is asked with No selected; Enter answers no and asks nothing more", async () => {
    const asked: Array<TestLinear.Asked> = []
    const { answers, output } = await workers("\n", linearOnly(TestLinear.layer({ teams }, asked)))
    expect(answers).toEqual({ linear: { kind: "no" } })
    expect(output).toContain("Sync tickets with Linear? [y/N] ")
    expect(asked).toEqual([])
  })

  test("Yes without a key says where to create one and how to export it", async () => {
    const { answers, output } = await workers("y\n", linearOnly(null))
    expect(answers).toEqual({ linear: { kind: "noKey" } })
    expect(output).toContain(`No ${linearKeyVariable} in the environment`)
    expect(output).toContain(linearKeysPage)
    expect(output).toContain(`export ${linearKeyVariable}=lin_api_...`)
    expect(output).toContain("tutti linear setup")
  })

  test("Yes with a key asks the team and the state where a type has more than one, then the mapping", async () => {
    const asked: Array<TestLinear.Asked> = []
    // NOE, the second team; In Review, the second started state; the mapping confirmed on Enter.
    const { answers, output } = await workers(
      "y\n2\n2\n\n",
      linearOnly(TestLinear.layer({ teams }, asked)),
    )
    const answer = answers.linear
    if (answer?.kind !== "chosen") throw new Error(`not chosen: ${JSON.stringify(answer)}`)
    expect(answer.choice.team.key).toBe("NOE")
    expect(answer.choice.pushed.map(([status, state]) => [status, state.name])).toEqual([
      ["open", "Todo"],
      ["in_progress", "In Review"],
      ["deferred", "Backlog"],
      ["closed", "Done"],
    ])
    expect(output).toContain("Which Linear team should tutti sync with?")
    expect(output).toContain("Which Linear state is a ticket in progress?")
    expect(output).toContain(
      "Beads to Linear: open Todo, in_progress In Review, deferred Backlog, closed Done",
    )
    expect(output).toContain("Sync with team NOE this way? [Y/n] ")
    expect(output).not.toContain(key)
    expect(asked).toEqual([{ call: "teams" }, { call: "states", team: "team-noe" }])
  })

  test("the mapping declined answers no", async () => {
    const { answers } = await workers("y\nn\n", linearOnly(TestLinear.layer({ teams: [eng] })))
    expect(answers).toEqual({ linear: { kind: "no" } })
  })

  test("Linear refusing the key says why, and init goes on", async () => {
    const { answers, output } = await workers(
      "y\n",
      linearOnly(TestLinear.layer({ teams, fails: "Linear refused the key" })),
    )
    expect(answers).toEqual({ linear: { kind: "failed", why: "Linear refused the key" } })
    expect(output).toContain("Linear: Linear refused the key. init goes on without the sync.")
  })
})

/** A temp repository (its top and git folder) and a home folder. */
const newProject = (settings?: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-linear-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  if (settings !== undefined) {
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(join(repo, settingsFile), settings)
  }
  return { repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

/** A machine with bd on the PATH, every command answering "". */
const machineOf = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

/** A form answering the Workers step with `linear`, and what it was asked. */
const scriptedForm = (linear?: LinearAnswer) => {
  const asked: Array<WorkersQuestions> = []
  const form: InitForm = {
    workers: (questions) =>
      Effect.sync(() => {
        asked.push(questions)
        return (linear === undefined ? {} : { linear }) satisfies WorkersAnswers
      }),
    checks: () => Effect.succeed({ verifier: false }),
    trust: () => Effect.succeed(false),
    import: () => Effect.succeed(false),
  }
  return { form, asked }
}

/** init in `project`: its summary, bd's configuration after, and the calls to Linear's API. */
const runInit = async (
  project: Project,
  over: {
    readonly form?: InitForm | null
    readonly flags?: InitFlags
    readonly key?: string | undefined
    readonly bd?: { readonly linear?: boolean }
  } = {},
) => {
  const asked: Array<TestLinear.Asked> = []
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const summary = yield* init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags: over.flags ?? { force: false },
        form: over.form ?? null,
        scout: Effect.fail("there is no scout in these tests"),
        machine: machineOf(project),
        configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
        account: TestAccount.layer(),
        claudeConfig: join(project.home, ".claude.json"),
        linear: {
          key: "key" in over ? over.key : key,
          api: () => TestLinear.layer({ teams }, asked),
        },
      })
      const configuration = yield* (yield* TestBeads.Backlog).configuration
      return { summary, configuration }
    }).pipe(
      Effect.provide(RunLock.layer),
      Effect.provide(TestBeads.layer([], over.bd?.linear === false ? { linear: false } : {})),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } }))),
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`init failed: ${String(exit.cause)}`)
  return { ...exit.value, asked }
}

const linearLines = (summary: InitSummary) =>
  summary.steps.filter((each) => each.label === "linear").map(stepLine)

const settingsJson = (project: Project) =>
  JSON.parse(readFileSync(join(project.repo, settingsFile), "utf8")) as Record<string, unknown>

/** The form's answer for team ENG, its states one of each type. */
const engChosen = (): LinearAnswer => {
  const [backlog, todo, progress, done] = eng.states
  if (backlog === undefined || todo === undefined || progress === undefined || done === undefined) {
    throw new Error("ENG lacks a state")
  }
  return {
    kind: "chosen",
    choice: {
      team: { id: eng.id, key: eng.key, name: eng.name },
      pushed: [
        ["open", todo],
        ["in_progress", progress],
        ["deferred", backlog],
        ["closed", done],
      ],
    },
  }
}

/** bd's linear.* keys the setup writes for ENG. */
const engConfiguration = {
  [teamIdKey]: "team-eng",
  ...Object.fromEntries(inbound.map(([type, status]) => [stateMapKey(type), status])),
  [outboundKey("open")]: "Todo",
  [outboundKey("in_progress")]: "In Progress",
  [outboundKey("deferred")]: "Backlog",
  [outboundKey("closed")]: "Done",
}

describe("init in a new project", () => {
  test("asks the question whether or not there is a key", async () => {
    const withKey = scriptedForm()
    await runInit(newProject(), { form: withKey.form })
    expect(withKey.asked[0]?.linear).not.toBeNull()
    expect(withKey.asked[0]?.linear?.api).not.toBeNull()
    const without = scriptedForm()
    await runInit(newProject(), { form: without.form, key: undefined })
    expect(without.asked[0]?.linear).toEqual({ api: null })
    const empty = scriptedForm()
    await runInit(newProject(), { form: empty.form, key: "  " })
    expect(empty.asked[0]?.linear).toEqual({ api: null })
  })

  test("No leaves the settings without a linear block", async () => {
    const project = newProject()
    const { form } = scriptedForm({ kind: "no" })
    const { summary, configuration } = await runInit(project, { form })
    expect(settingsJson(project).linear).toBeUndefined()
    expect(configuration).toEqual({})
    expect(linearLines(summary)).toEqual([
      "• linear  the sync is off: tutti linear setup turns it on",
    ])
    expect(
      summary.steps.filter((each) => each.kind === "missing").map((each) => each.label),
    ).not.toContain("linear")
  })

  test("Yes with a key sets bd's keys and writes the block", async () => {
    const project = newProject()
    const { form } = scriptedForm(engChosen())
    const { summary, configuration, asked } = await runInit(project, { form })
    expect(settingsJson(project).linear).toEqual({ team: "ENG" })
    expect(configuration).toEqual(engConfiguration)
    expect(linearLines(summary)).toEqual([
      `✓ linear  syncs with team ENG as a run starts, with ${linearKeyVariable} in its environment; Beads to Linear: open Todo, in_progress In Progress, deferred Backlog, closed Done`,
    ])
    // The form read Linear; the step only writes what it chose.
    expect(asked).toEqual([])
    expect(JSON.stringify(configuration)).not.toContain(key)
    expect(readFileSync(join(project.repo, settingsFile), "utf8")).not.toContain(key)
  })

  test("Yes without a key writes nothing, says how to get one, and init completes", async () => {
    const project = newProject()
    const { form } = scriptedForm({ kind: "noKey" })
    const { summary, configuration } = await runInit(project, { form, key: undefined })
    expect(settingsJson(project).linear).toBeUndefined()
    expect(configuration).toEqual({})
    const [line] = linearLines(summary)
    expect(line).toStartWith(`! linear  no ${linearKeyVariable} in the environment`)
    expect(line).toContain(linearKeysPage)
    expect(line).toContain("tutti linear setup")
    expect(
      summary.steps.filter((each) => each.kind === "missing").map((each) => each.label),
    ).not.toContain("linear")
  })

  test("a setup that fails says why, writes no block, and init completes", async () => {
    const project = newProject()
    const { form } = scriptedForm(engChosen())
    const { summary } = await runInit(project, { form, bd: { linear: false } })
    expect(settingsJson(project).linear).toBeUndefined()
    expect(linearLines(summary)).toEqual([
      "! linear  the installed bd has no bd linear; update Beads; the sync is off and its block not written: tutti linear setup turns it on",
    ])
    expect(
      summary.steps.filter((each) => each.kind === "missing").map((each) => each.label),
    ).not.toContain("linear")
  })
})

describe("the flags", () => {
  test("--linear <team> sets the sync up without asking, each state the first of its type", async () => {
    const project = newProject()
    const { form, asked: questions } = scriptedForm()
    const { summary, configuration, asked } = await runInit(project, {
      form,
      flags: { force: false, linear: "noe" },
    })
    expect(questions[0]?.linear).toBeNull()
    expect(settingsJson(project).linear).toEqual({ team: "NOE" })
    expect(configuration[outboundKey("in_progress")]).toBe("In Progress")
    expect(asked).toEqual([{ call: "teams" }, { call: "states", team: "team-noe" }])
    expect(linearLines(summary)[0]).toStartWith("✓ linear  syncs with team NOE")
  })

  test("--linear <team> without a key writes nothing and says how to get one", async () => {
    const project = newProject()
    const { summary } = await runInit(project, {
      flags: { force: false, linear: "ENG" },
      key: undefined,
    })
    expect(settingsJson(project).linear).toBeUndefined()
    expect(linearLines(summary)[0]).toStartWith(`! linear  no ${linearKeyVariable}`)
  })

  test("--linear <team> the key doesn't reach says which it reaches", async () => {
    const project = newProject()
    const { summary } = await runInit(project, { flags: { force: false, linear: "OPS" } })
    expect(settingsJson(project).linear).toBeUndefined()
    expect(linearLines(summary)[0]).toContain("the key reaches no team OPS; it reaches ENG, NOE")
  })

  test("--linear=false declines without asking", async () => {
    const project = newProject()
    const { form, asked: questions } = scriptedForm()
    const { summary, asked } = await runInit(project, {
      form,
      flags: { force: false, linear: false },
    })
    expect(questions[0]?.linear).toBeNull()
    expect(settingsJson(project).linear).toBeUndefined()
    expect(asked).toEqual([])
    expect(linearLines(summary)).toEqual([
      "• linear  the sync is off: tutti linear setup turns it on",
    ])
  })

  test("read: a team's key, or false; anything else is a problem", () => {
    const none = Object.fromEntries(
      Object.keys(initFlags)
        .filter((name) => name !== "force" && name !== "update")
        .map((name) => [name, Option.none()]),
    ) as unknown as InitFlagTexts
    const read = (text: string) =>
      readInitFlags({ ...none, force: false, linear: Option.some(text) })
    const flags = (text: string) => {
      const result = read(text)
      return Result.isSuccess(result) ? result.success.linear : result.failure
    }
    expect(flags("NOE")).toBe("NOE")
    expect(flags("false")).toBe(false)
    expect(flags("off")).toBe(false)
    expect(flags("true")).toEqual([
      "--linear must be a Linear team's key, such as NOE, or false (got 'true')",
    ])
    expect(flags("NO E")).toEqual([
      "--linear must be a Linear team's key, such as NOE, or false (got 'NO E')",
    ])
    expect(Result.isSuccess(readInitFlags({ ...none, force: false }))).toBe(true)
  })

  test("a spec run's setup without a terminal declines it", () => {
    expect(specSetupFlags(null).linear).toBe(false)
  })
})

describe("without a terminal", () => {
  test("it is left off, and the summary says so", async () => {
    const project = newProject()
    const { summary, configuration, asked } = await runInit(project, { form: null })
    expect(settingsJson(project).linear).toBeUndefined()
    expect(configuration).toEqual({})
    expect(asked).toEqual([])
    expect(linearLines(summary)).toEqual([
      "• linear  the sync is off; not asked (no terminal): --linear <team> sets it up, or tutti linear setup turns it on",
    ])
  })
})

describe("settings that hold the block", () => {
  const withBlock = '{\n  "concurrent": 2,\n  "linear": { "team": "NOE", "pull_every": "5m" }\n}\n'

  test("aren't asked, and the block is kept", async () => {
    const project = newProject(withBlock)
    const { form, asked: questions } = scriptedForm({ kind: "no" })
    const { summary, asked } = await runInit(project, { form })
    expect(questions[0]?.linear ?? null).toBeNull()
    expect(settingsJson(project).linear).toEqual({ team: "NOE", pull_every: "5m" })
    expect(asked).toEqual([])
    expect(linearLines(summary)).toEqual([
      "• linear  syncs with team NOE: the settings' linear block is kept",
    ])
  })

  test("--linear=false keeps the block too, and says how to turn the sync off", async () => {
    const project = newProject(withBlock)
    const { summary } = await runInit(project, { flags: { force: false, linear: false } })
    expect(settingsJson(project).linear).toEqual({ team: "NOE", pull_every: "5m" })
    expect(linearLines(summary)).toEqual([
      "• linear  syncs with team NOE: the settings' linear block is kept; remove it to turn the sync off",
    ])
  })

  test("--linear <team> sets the sync up with that team", async () => {
    const project = newProject(withBlock)
    const { summary } = await runInit(project, { flags: { force: false, linear: "ENG" } })
    expect(settingsJson(project).linear).toEqual({ team: "ENG", pull_every: "5m" })
    expect(linearLines(summary)[0]).toStartWith("✓ linear  syncs with team ENG")
  })
})
