// tutti linear setup (tutti-qatu.5): with a key, it reads the teams and the chosen team's states
// from Linear's API (its test layer here), asks the team and, where a type has more than one state,
// which one a status takes, shows the mapping and writes bd's linear.* keys and the settings' linear
// block; run again, it changes nothing and says so. Without a key it writes nothing and says how to
// get one. The key reaches no bd config, no file and no output. LinearApi's live layer sends it to
// api.linear.app alone.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Console, Effect, Exit, Layer, Result } from "effect"
import { Command } from "effect/cli"
import { tuttiWith } from "../src/cli/commands.ts"
import { linearSetup, lineQuestions, unaskedQuestions } from "../src/cli/linear.ts"
import { apiKeyKey, inbound, outboundKey, teamIdKey } from "../src/init/linear.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { readSettings, settingsFile } from "../src/project/settings.ts"
import { stateMapKey } from "../src/run/linearCheck.ts"
import { check, startBlock } from "../src/run/startup.ts"
import { Beads } from "../src/services/Beads.ts"
import { LinearApi, linearEndpoint } from "../src/services/LinearApi.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"
import * as TestHttp from "../src/testing/HttpClient.ts"
import * as TestLinear from "../src/testing/LinearApi.ts"
import { layer as lockLayer } from "../src/testing/RunLock.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme } from "../src/ui/theme.ts"
import { withVariable } from "./env.ts"

const key = "lin_api_SECRETsecret0123456789"

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "256", noColor: true })

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
      TestLinear.state("In Review", "started", 3),
      TestLinear.state("In Progress", "started", 2),
      TestLinear.state("Done", "completed", 4),
      TestLinear.state("Canceled", "canceled", 5),
      TestLinear.state("Duplicate", "duplicate", 6),
    ],
  },
]

const eng = teams[0] as TestLinear.TestLinear["teams"][number]

const settingsText = '{\n  "concurrent": 2,\n  "workers": { "model": "opus" }\n}\n'

/** A project tutti init has set up, its settings `settings`. */
const project = (settings: string | null = settingsText) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-linear-setup-")))
  const repo = join(dir, "repo")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  mkdirSync(join(repo, ".beads"))
  if (settings !== null) writeFileSync(join(repo, settingsFile), settings)
  writeFileSync(join(repo, ".tutti", "worker-prompt.md"), builtInWorkerPrompt)
  return repo
}

/** The settings' text in `repo`, or null without one. */
const settingsIn = (repo: string): string | null => {
  try {
    return readFileSync(join(repo, settingsFile), "utf8")
  } catch {
    return null
  }
}

interface Setup {
  /** The environment's LINEAR_API_KEY: `key` unless given. */
  readonly key?: string | undefined
  readonly linear?: TestLinear.TestLinear
  /** bd's configuration before. */
  readonly configuration?: Readonly<Record<string, string>>
  /** What is typed at the questions, input ending after it; null: no terminal, nothing asked. */
  readonly typed?: string | null
  readonly team?: string
}

/**
 * tutti linear setup in `repo`: its exit code, what it said and asked, the calls to Linear's API
 * and bd config set, and bd's configuration after.
 */
const setup = async (repo: string, given: Setup = {}) => {
  const asked: Array<TestLinear.Asked> = []
  const sets: Array<string> = []
  const out: Array<string> = []
  const errors: Array<string> = []
  let questions = ""
  const stream = new PassThrough()
  stream.end(given.typed ?? "")
  const counted = Layer.effect(
    Beads,
    Effect.map(Beads, (beads) =>
      Beads.of({
        ...beads,
        setConfiguration: (name, value) =>
          Effect.andThen(
            Effect.sync(() => sets.push(`${name}=${value}`)),
            beads.setConfiguration(name, value),
          ),
      }),
    ),
  )
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const ask =
        given.typed === null
          ? unaskedQuestions
          : lineQuestions({
              input: yield* streamInput(stream),
              write: (text) => {
                questions += text
              },
              theme,
            })
      const code = yield* linearSetup(
        repo,
        "key" in given ? given.key : key,
        ask,
        given.team,
        { out: (line) => out.push(line), error: (line) => errors.push(line) },
        () => TestLinear.layer(given.linear ?? { teams }, asked),
      ).pipe(Effect.provide(counted))
      const configuration = yield* (yield* TestBeads.Backlog).configuration
      return { code, configuration }
    }).pipe(
      Effect.scoped,
      Effect.provide(TestBeads.layer([], { configuration: given.configuration ?? {} })),
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return {
    ...exit.value,
    asked,
    sets,
    out: out.join("\n"),
    errors: errors.join("\n"),
    questions,
    settings: settingsIn(repo),
  }
}

/** bd's linear.* keys the setup writes for a team of one state per type, ENG's. */
const engConfiguration = {
  [teamIdKey]: "team-eng",
  [stateMapKey("backlog")]: "deferred",
  [stateMapKey("unstarted")]: "open",
  [stateMapKey("started")]: "in_progress",
  [stateMapKey("completed")]: "closed",
  [stateMapKey("canceled")]: "closed",
  [outboundKey("open")]: "Todo",
  [outboundKey("in_progress")]: "In Progress",
  [outboundKey("deferred")]: "Backlog",
  [outboundKey("closed")]: "Done",
}

/** The startup checks of a run in `repo` with `configuration` as bd's: its START block's notes. */
const startNotes = async (repo: string, configuration: Readonly<Record<string, string>>) => {
  const exit = await Effect.runPromise(
    Effect.exit(
      Effect.gen(function* () {
        const settings = yield* readSettings(repo)
        return yield* check({
          cwd: repo,
          env: { LINEAR_API_KEY: key },
          config: (top) => Effect.succeed(TestAppConfig.appConfig({ settings }, top)),
          beads: () => TestBeads.layer([], { configuration }),
          claude: (path) => Effect.succeed({ path, warnings: [], problems: [] }),
          account: TestAccount.layer(),
        })
      }),
    ).pipe(
      Effect.scoped,
      Effect.provide(TestGit.layer({ dir: repo })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..", "home") } })),
      ),
      Effect.provide(BunServices.layer),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`the checks failed: ${Cause.pretty(exit.cause)}`)
  const notes: ReadonlyArray<string> = startBlock(exit.value, "0.1.0").slice(1)
  return { warnings: exit.value.warnings, notes }
}

describe("tutti linear setup in a project without the block", () => {
  test("lists the teams, takes the choice, shows the mapping and writes bd's keys and the block", async () => {
    const repo = project()
    const done = await setup(repo, { typed: "1\n" })
    expect(done.code).toBe(0)
    expect(done.questions).toContain("Which Linear team should tutti sync with?")
    expect(done.questions).toContain("1. ENG: Engineering")
    expect(done.questions).toContain("2. NOE: Noesis")
    expect(done.asked).toEqual([{ call: "teams" }, { call: "states", team: "team-eng" }])
    expect(done.out).toContain("Linear team ENG (Engineering)")
    expect(done.out).toContain(
      "Linear to Beads: backlog deferred, unstarted open, started in_progress, completed closed, canceled closed; an issue in Backlog waits, deferred, until it is moved to Todo",
    )
    expect(done.out).toContain(
      "Beads to Linear: open Todo, in_progress In Progress, deferred Backlog, closed Done",
    )
    expect(done.configuration).toEqual(engConfiguration)
    expect(done.out).toContain("- set linear.team_id to team-eng")
    expect(done.out).toContain(`- wrote the linear block to ${settingsFile}: team ENG`)
    // The block is added, the rest of the settings as they were.
    expect(done.settings).toBe(
      '{\n  "concurrent": 2,\n  "workers": { "model": "opus" },\n  "linear": {\n    "team": "ENG"\n  }\n}\n',
    )
    expect(done.errors).toBe("")
  })

  test("a run then starts with the sync named in its START block, and no warning of it", async () => {
    const repo = project()
    const done = await setup(repo, { typed: "1\n" })
    const started = await startNotes(repo, done.configuration)
    expect(started.warnings).toEqual([])
    expect(started.notes.filter((line) => line.includes("linear"))).toEqual([
      "  linear: ENG, pull at start and every 10m",
    ])
  })

  test("run again, it changes nothing and says so", async () => {
    const repo = project()
    const first = await setup(repo, { typed: "1\n" })
    const again = await setup(repo, { typed: "\n", configuration: first.configuration })
    expect(again.code).toBe(0)
    // The team question offers the block's team first: Enter keeps it.
    expect(again.asked).toEqual([{ call: "teams" }, { call: "states", team: "team-eng" }])
    expect(again.sets).toEqual([])
    expect(again.settings).toBe(first.settings)
    expect(again.configuration).toEqual(first.configuration)
    expect(again.out).toContain("Nothing changed: bd and the settings already sync with team ENG.")
    expect(again.out).not.toContain("- set")
  })

  test("a team with two started states asks which is in progress, by position", async () => {
    const repo = project()
    const done = await setup(repo, { typed: "2\n2\n" })
    expect(done.code).toBe(0)
    expect(done.questions).toContain("Which Linear state is a ticket in progress?")
    expect(done.questions).toContain(
      "The team has 2 states of type started; tutti moves the Linear issue of a ticket in progress to the one chosen.",
    )
    // In Progress is first by position, though Linear listed In Review first.
    expect(done.questions).toContain("1. In Progress\n2. In Review")
    // One question a type with more than one state: no other is asked.
    expect(done.questions.match(/Which Linear state/g)?.length).toBe(1)
    expect(done.configuration[outboundKey("in_progress")]).toBe("In Review")
    expect(done.configuration[outboundKey("open")]).toBe("Todo")
    expect(done.configuration[teamIdKey]).toBe("team-noe")
    expect(done.out).toContain("in_progress In Review")
  })

  test("run again on that team, it offers the state chosen before first", async () => {
    const repo = project()
    const first = await setup(repo, { typed: "2\n2\n" })
    const again = await setup(repo, { typed: "\n\n", configuration: first.configuration })
    expect(again.sets).toEqual([])
    expect(again.configuration[outboundKey("in_progress")]).toBe("In Review")
    expect(again.out).toContain("Nothing changed")
  })

  test("--team answers the team's question, its key in any case", async () => {
    const repo = project()
    const done = await setup(repo, { typed: "\n", team: "noe" })
    expect(done.code).toBe(0)
    expect(done.questions).not.toContain("Which Linear team")
    expect(done.configuration[teamIdKey]).toBe("team-noe")
    expect(done.settings).toContain('"team": "NOE"')
  })

  test("a team the key doesn't reach is refused, and nothing is written", async () => {
    const repo = project()
    const done = await setup(repo, { typed: "", team: "OPS" })
    expect(done.code).toBe(2)
    expect(done.errors).toBe("tutti linear setup: the key reaches no team OPS; it reaches ENG, NOE")
    expect(done.configuration).toEqual({})
    expect(done.settings).toBe(settingsText)
  })

  test("one team the key reaches is taken without asking", async () => {
    const repo = project()
    const done = await setup(repo, { typed: "", linear: { teams: [eng] } })
    expect(done.code).toBe(0)
    expect(done.questions).toBe("")
    expect(done.configuration).toEqual(engConfiguration)
  })

  test("without a terminal it asks nothing: each state is the first of its type", async () => {
    const repo = project()
    const done = await setup(repo, { typed: null, team: "NOE" })
    expect(done.code).toBe(0)
    expect(done.configuration[outboundKey("in_progress")]).toBe("In Progress")
  })

  test("without a terminal or --team, several teams are refused, and nothing is written", async () => {
    const repo = project()
    const done = await setup(repo, { typed: null })
    expect(done.code).toBe(2)
    expect(done.errors).toContain("there is no terminal to ask which: name one with --team")
    expect(done.configuration).toEqual({})
    expect(done.settings).toBe(settingsText)
  })

  test("a question cancelled with Ctrl+D writes nothing", async () => {
    const repo = project()
    const done = await setup(repo, { typed: "" })
    expect(done.code).toBe(130)
    expect(done.errors).toBe("tutti linear setup: cancelled; nothing written")
    expect(done.configuration).toEqual({})
    expect(done.settings).toBe(settingsText)
  })
})

describe("tutti linear setup without a key", () => {
  for (const [name, value] of [
    ["unset", undefined],
    ["empty", ""],
  ] as const) {
    test(`(${name}) writes nothing, asks Linear nothing, and says where to create one and how to export it`, async () => {
      const repo = project()
      const done = await setup(repo, { key: value, typed: "1\n" })
      expect(done.code).toBe(2)
      expect(done.asked).toEqual([])
      expect(done.configuration).toEqual({})
      expect(done.settings).toBe(settingsText)
      expect(done.errors).toContain(
        "tutti linear setup: no LINEAR_API_KEY in the environment; nothing written.",
      )
      expect(done.errors).toContain("https://linear.app/settings/account/security")
      expect(done.errors).toContain("export LINEAR_API_KEY=")
      expect(done.out).toBe("")
    })
  }

  test("through tutti's command line too", async () => {
    const repo = project()
    const errors: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: () => {},
      error: (...each: ReadonlyArray<unknown>) => errors.push(each.join(" ")),
    })
    const services = () =>
      Layer.mergeAll(TestBeads.layer([]), TestGit.layer({ dir: repo }), lockLayer())
    const written: Array<string> = []
    const write = process.stderr.write
    process.stderr.write = ((chunk: string) => written.push(chunk) > 0) as typeof write
    const previous = process.exitCode
    try {
      await withVariable("LINEAR_API_KEY", undefined, () =>
        Effect.runPromise(
          Command.runWith(tuttiWith(Effect.succeed(repo), services), {
            version: "test",
            renderErrors: false,
          })(["linear", "setup"]).pipe(
            Effect.provide(BunServices.layer),
            Effect.provideService(Console.Console, console),
          ),
        ),
      )
      expect(process.exitCode).toBe(2)
    } finally {
      process.stderr.write = write
      process.exitCode = previous ?? 0
    }
    expect(written.join("")).toContain("no LINEAR_API_KEY in the environment; nothing written.")
    expect(settingsIn(repo)).toBe(settingsText)
  })
})

describe("the key", () => {
  test("reaches no bd config, no file and no output", async () => {
    const repo = project()
    const done = await setup(repo, { typed: "2\n1\n" })
    expect(done.code).toBe(0)
    const everything = [
      done.out,
      done.errors,
      done.questions,
      done.settings,
      ...done.sets,
      JSON.stringify(done.configuration),
    ].join("\n")
    expect(everything).not.toContain(key)
    expect(Object.hasOwn(done.configuration, apiKeyKey)).toBe(false)
  })

  test("one stored in bd's configuration is warned of, and left as it is", async () => {
    const repo = project()
    const done = await setup(repo, {
      typed: "1\n",
      configuration: { [apiKeyKey]: "lin_api_stored" },
    })
    expect(done.code).toBe(0)
    expect(done.errors).toContain(
      "tutti linear setup: warning: bd's configuration holds linear.api_key, which the Beads database syncs to its git remote: remove it with bd config unset linear.api_key",
    )
    expect(done.errors).not.toContain("lin_api_stored")
    expect(done.configuration[apiKeyKey]).toBe("lin_api_stored")
  })
})

describe("tutti linear setup in a project already syncing", () => {
  test("another team replaces the block's, its pull_every kept", async () => {
    const repo = project('{\n  "linear": { "team": "ENG", "pull_every": "5m" }\n}\n')
    const done = await setup(repo, {
      typed: "2\n\n",
      configuration: engConfiguration,
    })
    expect(done.code).toBe(0)
    expect(done.settings).toBe('{\n  "linear": { "team": "NOE", "pull_every": "5m" }\n}\n')
    expect(done.sets.toSorted()).toEqual(["linear.team_id=team-noe"])
    expect(done.out).toContain("- set linear.team_id to team-noe")
  })

  test("a state map of bd's that differs is set, and only it", async () => {
    const repo = project('{\n  "linear": { "team": "ENG" }\n}\n')
    const done = await setup(repo, {
      typed: "\n",
      configuration: { ...engConfiguration, [stateMapKey("backlog")]: "open" },
    })
    expect(done.sets).toEqual(["linear.state_map.backlog=deferred"])
    expect(done.out).toContain("- set linear.state_map.backlog to deferred")
    expect(done.out).not.toContain("wrote the linear block")
  })
})

describe("what tutti linear setup refuses", () => {
  test("a project with no settings: set it up with tutti init first", async () => {
    const repo = project(null)
    const done = await setup(repo, { typed: "1\n" })
    expect(done.code).toBe(2)
    expect(done.errors).toBe(
      `tutti linear setup: ${settingsFile} isn't there: set the project up with tutti init first`,
    )
    expect(done.asked).toEqual([])
    expect(done.settings).toBeNull()
  })

  test("Linear refusing the key: why, and nothing written", async () => {
    const repo = project()
    const done = await setup(repo, {
      typed: "1\n",
      linear: { teams, fails: "Linear refused the key: Authentication required" },
    })
    expect(done.code).toBe(2)
    expect(done.errors).toBe("tutti linear setup: Linear refused the key: Authentication required")
    expect(done.configuration).toEqual({})
    expect(done.settings).toBe(settingsText)
  })

  test("a team with no state of a type a status is pushed as", async () => {
    const repo = project()
    const noBacklog = TestLinear.defaultStates.filter((state) => state.type !== "backlog")
    const done = await setup(repo, {
      typed: "",
      team: "ENG",
      linear: { teams: [{ ...eng, states: noBacklog }] },
    })
    expect(done.code).toBe(2)
    expect(done.errors).toContain(
      "team ENG has no workflow state of type backlog, which deferred tickets are pushed as",
    )
    expect(done.configuration).toEqual({})
  })

  test("the inbound map holds Backlog as deferred: the gate", () => {
    expect(inbound).toContainEqual(["backlog", "deferred"])
  })
})

describe("LinearApi's live layer", () => {
  const teamsBody = JSON.stringify({
    data: { teams: { nodes: [{ id: "team-eng", key: "ENG", name: "Engineering" }] } },
  })

  /** What `use` gives over an HttpClient answering Linear's endpoint with `answer`, and what it sent. */
  const call = async <A>(
    answer: TestHttp.Answer,
    use: (api: LinearApi["Service"]) => Effect.Effect<A, unknown>,
  ) => {
    const sent: Array<TestHttp.Sent> = []
    const result = await Effect.runPromise(
      Effect.result(Effect.flatMap(LinearApi, use)).pipe(
        Effect.provide(
          LinearApi.layer(key).pipe(
            Layer.provide(TestHttp.layer({ [linearEndpoint]: answer }, sent)),
          ),
        ),
      ),
    )
    return { result, sent }
  }

  test("sends the key to api.linear.app's GraphQL endpoint alone, and reads the teams", async () => {
    const { result, sent } = await call({ body: teamsBody }, (api) => api.teams())
    expect(result).toEqual(Result.succeed([{ id: "team-eng", key: "ENG", name: "Engineering" }]))
    expect(sent.map((each) => each.url)).toEqual(["https://api.linear.app/graphql"])
    expect(sent[0]?.headers.authorization).toBe(key)
  })

  test("reads a team's states", async () => {
    const body = JSON.stringify({
      data: {
        team: {
          states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted", position: 1.5 }] },
        },
      },
    })
    const { result } = await call({ body }, (api) => api.states("team-eng"))
    expect(result).toEqual(
      Result.succeed([{ id: "s1", name: "Todo", type: "unstarted", position: 1.5 }]),
    )
  })

  for (const [name, answer, why] of [
    [
      "an authentication error",
      {
        status: 400,
        body: JSON.stringify({
          errors: [
            {
              message: "Authentication required, not authenticated",
              extensions: { code: "AUTHENTICATION_ERROR" },
            },
          ],
        }),
      },
      "Linear refused the key: Authentication required, not authenticated",
    ],
    ["a 401 with no body", { status: 401 }, "Linear refused the key (HTTP 401)"],
    ["a 500", { status: 500, body: "oops" }, "Linear answered HTTP 500"],
    ["an answer of another shape", { body: "{}" }, "Linear's answer isn't what tutti reads"],
  ] as const) {
    test(`fails on ${name}, saying why without the key`, async () => {
      const { result } = await call(answer, (api) => api.teams())
      if (Result.isSuccess(result)) throw new Error("it read the teams")
      expect(result.failure).toMatchObject({ _tag: "LinearApiFailed", why })
      expect(JSON.stringify(result.failure)).not.toContain(key)
    })
  }
})
