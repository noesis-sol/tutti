// Contract tests against a real Linear team (§ 13; the epic tutti-qatu's "Tests and documents"),
// run only with TUTTI_LIVE_LINEAR=1 and LINEAR_API_KEY in the environment (test/gates.ts'
// linearLive): TUTTI_LIVE_LINEAR=1 scripts/test.sh test/contract/linear.test.ts. The team is
// TUTTI_TEST_LINEAR_TEAM's key (NOE), or the key's only team. They check, through tutti's own code
// (the setup, the Beads service's bd linear calls, LinearIssues' listing) and the machine's bd, the
// six points spike 09 confirmed (docs/spikes/09-linear-sync.md), so that a bd bump is checked
// against them:
//
//   1. an issue in Backlog is pulled as a deferred ticket, and moved to Todo the next pull opens it;
//   2. a pull by key changes only the issues it names, never a held ticket it doesn't;
//   3. a push by ticket ID moves the Linear issue to the state set up for its status, the local
//      version winning over Linear's edits;
//   4. a ticket's acceptance criteria, design and notes reach the Linear issue as sections;
//   5. a pull and a push each take less than their time limit (LinearTimeLimit), printed;
//   6. bd is 1.3.0 or later, the first with linear.outbound_state_map, which point 3 uses.
//
// What stands for the maintainer in Linear (filing, moving and editing an issue) is Linear's GraphQL
// API through tutti's askLinear. Every issue they make has a title starting with this run's marker,
// THROWAWAY tutti contract <hex>, and is deleted for good at the end, those a push made too; the
// end then checks the team holds none, archived ones included. bd runs in a scratch repository and
// Beads database, so no linear.* key or pulled ticket reaches the project's; the end checks the
// project's linear.* configuration is as it was. No unscoped pull or push is run.

import { afterAll, beforeAll, expect } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { applyLinear, planLinear, statesOfType, unasked } from "../../src/init/linear.ts"
import { settingsFile } from "../../src/project/settings.ts"
import { minimumBd, versionWarning } from "../../src/run/linearCheck.ts"
import { Beads, type Issue, LinearTimeLimit, type TicketId } from "../../src/services/Beads.ts"
import { askLinear, LinearApi, type LinearState } from "../../src/services/LinearApi.ts"
import { liveLinearIssues } from "../../src/services/LinearIssues.ts"
import { type LinearKey, type LinearSync, linearKey } from "../../src/services/linearSync.ts"
import { compareVersions } from "../../src/text/version.ts"
import { machineWhich, testEnv } from "../env.ts"
import { linearLive } from "../gates.ts"

/** How long a test has: a handful of bd linear calls, each a second or two. */
const testLimit = 180_000

const key = testEnv.LINEAR_API_KEY ?? ""
const teamWanted = testEnv.TUTTI_TEST_LINEAR_TEAM
const bd = machineWhich("bd") ?? "bd"
const marker = `THROWAWAY tutti contract ${randomBytes(3).toString("hex")}`
const project = resolve(import.meta.dir, "../..")

/** Linear's answer to `query`, asked with the key as the maintainer would, read with `schema`. */
const ask = <A>(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  schema: Schema.Decoder<A>,
): Promise<A> =>
  Effect.runPromise(
    askLinear(key, query, variables, schema).pipe(Effect.provide(FetchHttpClient.layer)),
  )

const Made = Schema.Struct({
  data: Schema.Struct({
    issueCreate: Schema.Struct({
      success: Schema.Boolean,
      issue: Schema.Struct({ id: Schema.String, identifier: Schema.String }),
    }),
  }),
})
/** A mutation's answer: its one field's success. */
const Done = Schema.Struct({
  data: Schema.Record(Schema.String, Schema.Struct({ success: Schema.Boolean })),
})
const Read = Schema.Struct({
  data: Schema.Struct({
    issue: Schema.Struct({
      id: Schema.String,
      identifier: Schema.String,
      title: Schema.String,
      description: Schema.NullOr(Schema.String),
      state: Schema.Struct({ name: Schema.String, type: Schema.String }),
    }),
  }),
})
const Found = Schema.Struct({
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ id: Schema.String, identifier: Schema.String })),
    }),
  }),
})

/** Files an issue in the team, in `state`, as the maintainer would: its ID and key. */
const fileIssue = async (title: string, state: LinearState) => {
  const answer = await ask(
    "mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }",
    {
      input: {
        teamId: team.id,
        title: `${marker}: ${title} (delete me)`,
        description:
          "Made by tutti's contract test, test/contract/linear.test.ts; deleted as it ends.",
        stateId: state.id,
      },
    },
    Made,
  )
  expect(answer.data.issueCreate.success).toBe(true)
  const issue = answer.data.issueCreate.issue
  const at = linearKey(issue.identifier)
  if (at === undefined) throw new Error(`Linear's key ${issue.identifier} isn't one tutti reads`)
  return { id: issue.id, key: at }
}

/** Edits the issue in Linear, as the maintainer would. */
const editIssue = async (id: string, input: Readonly<Record<string, unknown>>) => {
  const answer = await ask(
    "mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
    { id, input },
    Done,
  )
  expect(answer.data.issueUpdate?.success).toBe(true)
}

/** The issue as Linear has it, by its ID or key. */
const readIssue = async (id: string) =>
  (
    await ask(
      "query Issue($id: String!) { issue(id: $id) { id identifier title description state { name type } } }",
      { id },
      Read,
    )
  ).data.issue

/** The team's issues whose title holds this run's marker, archived ones included. */
const leftIssues = async () =>
  (
    await ask(
      "query Left($filter: IssueFilter) { issues(filter: $filter, first: 100, includeArchived: true) { nodes { id identifier } } }",
      { filter: { team: { id: { eq: team.id } }, title: { contains: marker } } },
      Found,
    )
  ).data.issues.nodes

let dir = ""
let team = { id: "", key: "" }
let states: ReadonlyArray<LinearState> = []
/** The Linear state each Beads status is pushed as, by the setup. */
let pushedAs: Readonly<Record<string, string>> = {}
let projectLinear: Readonly<Record<string, string>> = {}

/** bd's linear.* configuration in the Beads database of `cwd`. */
const linearConfiguration = (cwd: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const beads = yield* Beads
      const all = yield* beads.configuration()
      return Object.fromEntries(Object.entries(all).filter(([name]) => name.startsWith("linear.")))
    }).pipe(
      Effect.provide(Beads.layer({ cwd, command: bd }).pipe(Layer.provide(BunServices.layer))),
    ),
  )

/** What `body` does with the Beads service over the scratch database, bd linear given the key. */
const beads = <A, E>(body: (beads: Beads["Service"]) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Beads)
    }).pipe(
      Effect.provide(
        Beads.layer({ cwd: dir, command: bd, environment: testEnv }).pipe(
          Layer.provide(BunServices.layer),
        ),
      ),
    ),
  )

/** How long each pull and push took, in ms (point 5). */
const took: { pull: Array<number>; push: Array<number> } = { pull: [], push: [] }

const timed = async <E>(
  kind: "pull" | "push",
  sync: (beads: Beads["Service"]) => Effect.Effect<LinearSync, E>,
) => {
  const started = performance.now()
  const result = await beads(sync)
  took[kind].push(performance.now() - started)
  return result
}

const pull = (...keys: [LinearKey, ...Array<LinearKey>]) => timed("pull", (b) => b.linearPull(keys))

const push = (...ids: [TicketId, ...Array<TicketId>]) => timed("push", (b) => b.linearPush(ids))

/** The scratch database's one ticket linked to the Linear issue `at`. */
const ticketOf = async (at: LinearKey): Promise<Issue> => {
  const linked = (await beads((b) => b.list({ all: true }))).filter(
    (issue) => issue.linearKey === at,
  )
  expect(linked).toHaveLength(1)
  return linked[0] as Issue
}

/** The first of the team's states of `type`, by position. */
const stateOf = (type: string): LinearState => {
  const state = statesOfType(states, type)[0]
  if (state === undefined) throw new Error(`team ${team.key} has no state of type ${type}`)
  return state
}

const sh = (cwd: string, ...cmd: Array<string>) => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

linearLive.describe("against a real Linear team", () => {
  beforeAll(async () => {
    projectLinear = await linearConfiguration(project)
    dir = mkdtempSync(join(realpathSync(tmpdir()), "tutti-linear-contract-"))
    sh(dir, "git", "init", "-q")
    sh(dir, bd, "init", "--quiet", "--prefix", "lin", "--skip-hooks", "--skip-agents")
    mkdirSync(join(dir, ".tutti"), { recursive: true })
    writeFileSync(
      join(dir, settingsFile),
      readFileSync(resolve(project, "src/project/templates/settings.json"), "utf8"),
    )
    // tutti linear setup, as it runs without a terminal: bd's linear.* keys and the settings' block.
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* planLinear(dir, unasked("TUTTI_TEST_LINEAR_TEAM"), teamWanted)
        yield* applyLinear(dir, plan)
        states = yield* (yield* LinearApi).states(plan.team.id)
        return plan
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Beads.layer({ cwd: dir, command: bd }), LinearApi.live(key)).pipe(
            Layer.provideMerge(BunServices.layer),
          ),
        ),
      ),
    )
    team = { id: plan.team.id, key: plan.team.key }
    pushedAs = Object.fromEntries(plan.pushed.map(([status, state]) => [status, state.name]))
  }, testLimit)

  afterAll(async () => {
    // Every issue this run made, by its marker, deleted for good; then none is left.
    if (team.id !== "") {
      for (const issue of await leftIssues()) {
        await ask(
          "mutation Delete($id: String!) { issueDelete(id: $id, permanentlyDelete: true) { success } }",
          { id: issue.id },
          Done,
        )
      }
      expect(await leftIssues()).toEqual([])
    }
    if (dir !== "") rmSync(dir, { recursive: true, force: true })
    expect(await linearConfiguration(project)).toEqual(projectLinear)
  }, testLimit)

  // Shared by the points that follow: the issue the gate hands over, then held and pushed.
  let gated: { id: string; key: LinearKey } = { id: "", key: "" as LinearKey }
  let gatedTicket = "" as TicketId

  linearLive.test(
    "1. an issue in Backlog is pulled deferred, and moved to Todo the next pull opens it",
    async () => {
      gated = await fileIssue("backlog gate", stateOf("backlog"))
      const listing = liveLinearIssues(testEnv)
      const notDone = await Effect.runPromise(listing.list(team.key, null))
      expect(notDone).toContainEqual({ key: gated.key, state: "backlog" })

      const first = await pull(gated.key)
      expect(first.items).toEqual([{ name: gated.key, outcome: "created" }])
      const held = await ticketOf(gated.key)
      expect(held.status).toBe("deferred")
      gatedTicket = held.id

      const since = Date.now() - Duration.toMillis(Duration.minutes(2))
      await editIssue(gated.id, { stateId: stateOf("unstarted").id })
      const changed = await Effect.runPromise(listing.list(team.key, since))
      expect(changed).toContainEqual({ key: gated.key, state: "unstarted" })

      const second = await pull(gated.key)
      expect(second.items).toEqual([{ name: gated.key, outcome: "updated" }])
      const handed = await ticketOf(gated.key)
      expect([handed.id, handed.status]).toEqual([gatedTicket, "open"])
    },
    testLimit,
  )

  linearLive.test(
    "2. a pull by key changes only the issues it names, never a held ticket it doesn't",
    async () => {
      await beads((b) => b.update(gatedTicket, { claim: true }))
      const local = await ticketOf(gated.key)
      expect(local.status).toBe("in_progress")
      await editIssue(gated.id, { title: `${marker}: edited in Linear while held (delete me)` })

      const fresh = await fileIssue("new issue", stateOf("unstarted"))
      const result = await pull(fresh.key)
      expect(result.items).toEqual([{ name: fresh.key, outcome: "created" }])
      expect((await ticketOf(fresh.key)).status).toBe("open")

      const after = await ticketOf(gated.key)
      expect([after.status, after.title]).toEqual(["in_progress", local.title])
    },
    testLimit,
  )

  linearLive.test(
    "3. a push by ID moves the Linear issue to the state set up, the local version winning",
    async () => {
      const local = await ticketOf(gated.key)
      const started = await push(gatedTicket)
      expect(started.items).toEqual([{ name: gatedTicket, outcome: "updated" }])
      const working = await readIssue(gated.id)
      expect([working.state.type, working.state.name, working.title]).toEqual([
        "started",
        pushedAs.in_progress ?? "none set up",
        local.title,
      ])

      await editIssue(gated.id, { title: `${marker}: edited in Linear again (delete me)` })
      await beads((b) => b.close(gatedTicket, "done"))
      const closed = await push(gatedTicket)
      expect(closed.items).toEqual([{ name: gatedTicket, outcome: "updated" }])
      const done = await readIssue(gated.id)
      expect([done.state.type, done.state.name, done.title]).toEqual([
        "completed",
        pushedAs.closed ?? "none set up",
        local.title,
      ])
    },
    testLimit,
  )

  linearLive.test(
    "4. a ticket's acceptance criteria, design and notes reach the Linear issue as sections",
    async () => {
      const filed = await beads((b) =>
        Effect.gen(function* () {
          const made = yield* b.create({
            title: `${marker}: fields pushed (delete me)`,
            description: "DESC-MARK the description.",
            acceptance: "AC-MARK the acceptance criteria.",
          })
          yield* b.update(made.id, { design: "DESIGN-MARK the design." })
          yield* b.update(made.id, { appendNotes: "NOTES-MARK the notes." })
          return made
        }),
      )
      const result = await push(filed.id)
      expect(result.items).toEqual([{ name: filed.id, outcome: "created" }])
      const linked = await beads((b) => b.show(filed.id))
      expect(linked.linearKey).toBeDefined()
      const issue = await readIssue(linked.linearKey ?? "")
      const description = issue.description ?? ""
      for (const [heading, mark] of [
        ["", "DESC-MARK"],
        ["## Acceptance Criteria", "AC-MARK"],
        ["## Design", "DESIGN-MARK"],
        ["## Notes", "NOTES-MARK"],
      ] as const) {
        expect(description).toContain(`${heading}${heading === "" ? "" : "\n\n"}${mark}`)
      }
    },
    testLimit,
  )

  linearLive.test("5. each pull and push took less than its time limit", () => {
    const seconds = (ms: ReadonlyArray<number>) => ms.map((each) => (each / 1000).toFixed(2))
    console.log(
      `bd linear pull by key: ${seconds(took.pull).join(", ")} s; push by ID: ${seconds(took.push).join(", ")} s`,
    )
    expect(took.pull.length).toBeGreaterThan(0)
    expect(took.push.length).toBeGreaterThan(0)
    expect(Math.max(...took.pull)).toBeLessThan(Duration.toMillis(LinearTimeLimit.pull))
    expect(Math.max(...took.push)).toBeLessThan(Duration.toMillis(LinearTimeLimit.push))
  })

  linearLive.test("6. bd is 1.3.0 or later, and has bd linear", async () => {
    // Through the service, as the startup check reads it: its decode meets the real bd's output.
    const version = await beads((b) => b.version())
    expect(compareVersions(version, minimumBd)).not.toEqual(Option.none())
    expect(versionWarning(version)).toBeUndefined()
    expect(await beads((b) => b.hasLinear())).toBe(true)
  })
})
