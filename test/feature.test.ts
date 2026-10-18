import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Option, Result } from "effect"
import fc from "fast-check"
import { renderInput } from "../src/organs/evidence.ts"
import { Organs } from "../src/organs/Organs.ts"
import { gatherFeature, namedPaths, planInput } from "../src/organs/plan.ts"
import { makePrinter } from "../src/print/organLine.ts"
import {
  checkFiles,
  FilingFailed,
  filingFailedLines,
  maxPlanned,
  validatePlan,
} from "../src/project/planFile.ts"
import { type FeatureOutcome, planAndFile, scopedTo } from "../src/run/feature.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { type Answers, layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { FormCancelled, type Plan } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { backlog, expectExitCode, expectPhases, scenario } from "./harness.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

/** A new folder, its real path. */
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-feature-${name}-`)))

/** The main checkout's files, on disk and in git. */
const repoFiles: Readonly<Record<string, string>> = {
  "README.md": "# demo\n\nA demo command line.\n",
  "CLAUDE.md": "Run the tests with bun test.\n",
  "src/list.ts": "export const list = () => []\n",
  "src/main.ts": "import { list } from './list.ts'\nlist()\n",
}

/** A checkout holding `files`, on disk. */
const checkout = (files: Readonly<Record<string, string>> = repoFiles): string => {
  const repo = folder("repo")
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  return repo
}

const ticket = (fields: Record<string, unknown>) => ({
  title: `Ticket ${String(fields.key)}`,
  type: "task",
  priority: 2,
  description: "Why and what.",
  acceptance: "The tests pass.",
  files: [],
  blocked_by: [],
  solo: false,
  ...fields,
})

/** The plan organ's answer: two tickets, the second after the first and solo. */
const twoTickets = {
  epic_title: "A --json flag for list",
  epic_description: "list prints JSON with --json; the docs say so.",
  tickets: [
    ticket({
      key: "t1",
      title: "JSON output for list",
      type: "feature",
      files: ["src/list.ts", "./src/json.ts", "nowhere/x.ts"],
    }),
    ticket({
      key: "t2",
      title: "Document --json",
      priority: 1,
      files: ["README.md"],
      blocked_by: ["t1"],
      solo: true,
    }),
  ],
  questions: [],
}

const ok = { verdict: "ok", reason: "" }

interface Feature {
  readonly answers: Answers
  readonly seeds?: ReadonlyArray<Seed>
  readonly yes?: boolean
  /** The answer to the confirmation; none when there is no terminal to ask on. */
  readonly confirm?: boolean | "cancel" | "none"
  readonly request?: string
}

/** planAndFile over the in-memory backlog and canned organs, in a checkout on disk. */
const feature = async (options: Feature) => {
  const repo = checkout()
  const calls: Array<OrganCallRecord> = []
  const out: Array<string> = []
  const errors: Array<string> = []
  const asked: Array<{ plan: Plan; question: string }> = []
  const confirm = options.confirm ?? true
  const layers = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer(options.answers, calls),
        configLayer(appConfig({ repo })),
        logLayer(),
        beadsLayer(options.seeds ?? []),
        memoryGit({ dir: repo, files: repoFiles }),
        BunServices.layer,
      ),
    ),
  )
  const { outcome, log, issues } = await Effect.runPromise(
    Effect.gen(function* () {
      const outcome: FeatureOutcome = yield* planAndFile(
        {
          request: options.request ?? "Add a --json flag to list in src/list.ts",
          repo,
          yes: options.yes ?? false,
        },
        {
          printer: makePrinter(
            { write: (text) => void out.push(text), columns: () => 100, tty: false },
            theme,
          ),
          theme,
          error: (text) => Effect.sync(() => void errors.push(text)),
          confirm:
            confirm === "none"
              ? Option.none()
              : Option.some((plan, question) =>
                  Effect.suspend(() => {
                    asked.push({ plan, question })
                    return confirm === "cancel"
                      ? Effect.fail(new FormCancelled())
                      : Effect.succeed(confirm)
                  }),
                ),
        },
      )
      return { outcome, log: yield* texts, issues: yield* (yield* Backlog).issues }
    }).pipe(Effect.provide(layers)),
  )
  return { outcome, log, issues, calls, out: Bun.stripANSI(out.join("")), errors, asked, repo }
}

describe("--feature", () => {
  test("screens, plans, confirms and files the epic with its tickets, files, solo and links", async () => {
    const ran = await feature({ answers: { screen: ok, plan: twoTickets } })
    expect(ran.calls.map((call) => call.call.organ)).toEqual(["screen", "plan"])
    expect(ran.outcome).toEqual(
      expect.objectContaining({ _tag: "Filed", epic: "test-1", tickets: 2 }),
    )

    expect(ran.asked).toHaveLength(1)
    expect(ran.asked[0]?.question).toBe("File these 2 tickets and start the run?")
    expect(ran.asked[0]?.plan.tickets.map((t) => [t.key, t.files, t.after])).toEqual([
      ["t1", ["src/list.ts", "src/json.ts"], []],
      ["t2", ["README.md"], ["t1"]],
    ])
    expect(ran.asked[0]?.plan.notes).toEqual([
      `dropped "nowhere/x.ts" from t1's files: not in the repository, and its directory nowhere/ doesn't exist`,
    ])

    const [epic, t1, t2] = ran.issues
    expect(epic).toEqual(
      expect.objectContaining({
        id: "test-1",
        type: "epic",
        title: "A --json flag for list",
        priority: 1,
      }),
    )
    expect(t1).toEqual(
      expect.objectContaining({
        id: "test-1.1",
        parent: "test-1",
        type: "feature",
        priority: 2,
        title: "JSON output for list",
        description: "Why and what.",
        acceptance: "The tests pass.",
        files: ["src/list.ts", "src/json.ts"],
        labels: [],
      }),
    )
    expect(t2).toEqual(
      expect.objectContaining({
        id: "test-1.2",
        parent: "test-1",
        priority: 1,
        labels: ["solo"],
        files: ["README.md"],
      }),
    )
    expect(t2?.dependencies).toContainEqual(
      expect.objectContaining({ id: "test-1.1", type: "blocks" }),
    )
    expect(ran.out).toContain("Filed epic test-1 with 2 tickets")
    expect(ran.log).toContain(
      "FEATURE filed epic test-1 with 2 tickets: Add a --json flag to list in src/list.ts",
    )
    expect(ran.errors).toEqual([])
  })

  test("the plan organ reads the request, the README, the guide, the files, the tickets and named files", async () => {
    const ran = await feature({
      answers: { screen: ok, plan: twoTickets },
      seeds: [{ id: "old-1", title: "Something open", status: "in_progress" }],
    })
    const [screen, plan] = ran.calls
    expect(screen?.input).toContain("Add a --json flag to list in src/list.ts")
    expect(screen?.input).toContain("A demo command line.")
    expect(screen?.input).toMatch(
      /Screen the feature request above for the repository tutti-feature-repo-/,
    )
    expect(plan?.call.effort).toBe("high")
    expect(plan?.input).toContain("Run the tests with bun test.")
    expect(plan?.input).toContain("src/main.ts  2")
    expect(plan?.input).toContain("old-1  in_progress  Something open")
    expect(plan?.input).toContain("## File named in the request: src/list.ts")
    expect(plan?.input).toMatch(
      /Plan the feature request above for the repository .* as an epic and its tickets\.\n$/,
    )
    expect(plan?.system).toContain("Plan 1 to 12 tickets")
  })

  test("an invalid plan is rejected with its reasons, and nothing is filed", async () => {
    const cycle = {
      ...twoTickets,
      tickets: [
        ticket({ key: "t1", blocked_by: ["t2"] }),
        ticket({ key: "t2", blocked_by: ["t1"] }),
      ],
    }
    const ran = await feature({ answers: { screen: ok, plan: cycle } })
    expect(ran.outcome).toEqual(expect.objectContaining({ _tag: "Stopped", exitCode: 2 }))
    expect(ran.errors).toEqual([
      "tutti couldn't plan the request: the plan doesn't hold: the plan's tickets block each other in a cycle: t1 → t2 → t1",
    ])
    expect(ran.asked).toEqual([])
    expect(ran.issues).toEqual([])
    expect(ran.log).toContain(
      "FEATURE not planned: the plan doesn't hold: the plan's tickets block each other in a cycle: t1 → t2 → t1",
    )
  })

  test("declining files nothing and ends with 0", async () => {
    const ran = await feature({ answers: { screen: ok, plan: twoTickets }, confirm: false })
    expect(ran.outcome).toEqual(expect.objectContaining({ _tag: "Stopped", exitCode: 0 }))
    expect(ran.issues).toEqual([])
    expect(ran.out).toContain("Nothing was filed.")
  })

  test("Esc or the end of input at the confirmation stops with 130, nothing filed", async () => {
    const ran = await feature({ answers: { screen: ok, plan: twoTickets }, confirm: "cancel" })
    expect(ran.outcome).toEqual(expect.objectContaining({ _tag: "Stopped", exitCode: 130 }))
    expect(ran.errors).toEqual(["tutti: stopped before filing; nothing was filed."])
    expect(ran.issues).toEqual([])
  })

  test("--yes files without asking, the plan shown", async () => {
    const ran = await feature({
      answers: { screen: ok, plan: twoTickets },
      yes: true,
      confirm: "none",
    })
    expect(ran.outcome).toEqual(expect.objectContaining({ _tag: "Filed", epic: "test-1" }))
    expect(ran.asked).toEqual([])
    expect(ran.out).toContain("Epic: A --json flag for list")
    expect(ran.issues).toHaveLength(3)
  })

  test("without a terminal to ask on and without --yes, nothing is filed", async () => {
    const ran = await feature({ answers: { screen: ok, plan: twoTickets }, confirm: "none" })
    expect(ran.outcome).toEqual(expect.objectContaining({ _tag: "Stopped", exitCode: 2 }))
    expect(ran.errors).toEqual([
      "tutti has no terminal to ask on: nothing was filed. Pass --yes to file the plan without asking.",
    ])
    expect(ran.issues).toEqual([])
  })

  test("a rejected or unclear request stops before the plan, saying why", async () => {
    const rejected = await feature({
      answers: { screen: { verdict: "reject", reason: "It sends passwords away." } },
    })
    expect(rejected.outcome).toEqual(expect.objectContaining({ _tag: "Stopped", exitCode: 2 }))
    expect(rejected.errors).toEqual(["tutti won't plan this request: It sends passwords away."])
    expect(rejected.calls.map((call) => call.call.organ)).toEqual(["screen"])
    expect(rejected.log).toContain("FEATURE rejected: It sends passwords away.")

    const unclear = await feature({
      answers: { screen: { verdict: "unclear", reason: "Say what." } },
    })
    expect(unclear.errors).toEqual(["tutti can't plan this request yet: Say what."])

    const silent = await feature({ answers: { screen: { verdict: "reject", reason: " " } } })
    expect(silent.errors).toEqual([
      "tutti couldn't screen the request: the screen's verdict reject gives no reason",
    ])
  })

  test("a plan that needs answers lists its questions and files nothing", async () => {
    const ran = await feature({
      answers: {
        screen: ok,
        plan: {
          epic_title: "",
          epic_description: "",
          tickets: [],
          questions: ["Which format?", " "],
        },
      },
    })
    expect(ran.outcome).toEqual(expect.objectContaining({ _tag: "Stopped", exitCode: 2 }))
    expect(ran.errors).toEqual([
      "tutti needs answers before it can plan this request:",
      "  - Which format?",
      'Nothing was filed. Run it again with the answers in the request: tutti --feature "<the request, and the answers>"',
    ])
    expect(ran.issues).toEqual([])
  })
})

describe("validatePlan", () => {
  const tracked = Object.keys(repoFiles)

  test("never throws, whatever it is given", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        validatePlan(input, tracked)
      }),
    )
    const field = fc.oneof(
      fc.anything(),
      fc.string(),
      fc.integer({ min: -1, max: 5 }),
      fc.array(fc.string()),
    )
    fc.assert(
      fc.property(
        fc.record(
          {
            epic_title: field,
            epic_description: field,
            questions: fc.oneof(field, fc.array(fc.string())),
            tickets: fc.oneof(
              field,
              fc.array(
                fc.record(
                  {
                    key: fc.oneof(field, fc.constantFrom("t1", "t2", "t3")),
                    title: field,
                    type: fc.oneof(field, fc.constantFrom("task", "bug", "epic")),
                    priority: field,
                    description: field,
                    acceptance: field,
                    files: fc.oneof(field, fc.array(fc.string())),
                    blocked_by: fc.oneof(field, fc.array(fc.constantFrom("t1", "t2", "t3", ""))),
                    solo: fc.oneof(field, fc.boolean()),
                  },
                  { requiredKeys: [] },
                ),
                { maxLength: 14 },
              ),
            ),
          },
          { requiredKeys: [] },
        ),
        (input) => {
          const checked = validatePlan(input, tracked)
          if (Result.isFailure(checked)) expect(checked.failure.length).toBeGreaterThan(0)
        },
      ),
    )
  })

  test("a valid plan's tickets keep only files that can be the repository's", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 6 }), (files) => {
        const checked = checkFiles([{ key: "t1", files }], tracked)
        for (const f of checked.files[0] ?? []) {
          expect(f.startsWith("/") || f.startsWith("../") || f === "..").toBe(false)
          expect(f.includes("\\")).toBe(false)
        }
      }),
    )
  })

  const reasonsOf = (input: unknown) => {
    const checked = validatePlan(input, tracked)
    return Result.isFailure(checked) ? checked.failure : []
  }

  test("rejects an invalid plan with every reason", () => {
    expect(reasonsOf("a plan")).toEqual(['the plan is "a plan", not an object'])
    expect(reasonsOf({ tickets: [], questions: [] })).toEqual([
      "the plan has no tickets and no questions",
    ])
    expect(
      reasonsOf({
        epic_title: " ",
        tickets: [
          ticket({ key: "t1", type: "epic", priority: 7 }),
          ticket({ key: "t1", title: "" }),
          { key: "t3", title: "No priority", type: "task" },
          ticket({ key: "t4", blocked_by: ["t4", "t9"], solo: "yes" }),
          "t5",
        ],
      }),
    ).toEqual([
      "the plan's epic has no title",
      'ticket t1 of the plan has the unknown type "epic", not task, feature, bug, chore',
      "ticket t1 of the plan has the priority 7, not 0 to 4",
      'the plan has two tickets keyed "t1"',
      "ticket t1 of the plan has no title",
      "ticket t3 of the plan has no priority",
      `ticket t4 of the plan's solo is "yes", not true or false`,
      'ticket 5 of the plan is "t5", not an object',
      "ticket t4 of the plan is blocked by itself",
      'ticket t4 of the plan is blocked by "t9", which isn\'t in the plan',
    ])
    const many = Array.from({ length: maxPlanned + 1 }, (_, i) => ticket({ key: `t${i}` }))
    expect(reasonsOf({ epic_title: "Big", tickets: many })).toEqual([
      `the plan has ${maxPlanned + 1} tickets, more than ${maxPlanned}`,
    ])
  })

  test("takes a plan with questions and no tickets, and trims and dedupes what it keeps", () => {
    expect(validatePlan({ questions: ["Which?"] }, tracked)).toEqual(
      Result.succeed({
        epic: { title: "", description: "" },
        tickets: [],
        questions: ["Which?"],
        notes: [],
      }),
    )
    const checked = validatePlan(
      {
        epic_title: " Epic ",
        epic_description: " Why. ",
        tickets: [
          ticket({
            key: " t1 ",
            title: " One ",
            files: ["src", "src/list.ts", "src/list.ts", "/etc/passwd"],
          }),
          ticket({ key: "t2", blocked_by: ["t1", " t1 ", ""] }),
        ],
      },
      tracked,
    )
    expect(Result.isSuccess(checked)).toBe(true)
    if (Result.isFailure(checked)) return
    expect(checked.success.epic).toEqual({ title: "Epic", description: "Why." })
    expect(checked.success.tickets.map((t) => [t.key, t.title, t.files, t.blockedBy])).toEqual([
      ["t1", "One", ["src/list.ts"], []],
      ["t2", "Ticket t2", [], ["t1"]],
    ])
    expect(checked.success.notes).toEqual([
      `dropped "src" from t1's files: a directory, not a file`,
      `dropped "/etc/passwd" from t1's files: not a path inside the repository`,
    ])
  })
})

describe("the plan's evidence", () => {
  test("names the tracked files the request names, line references and punctuation off", () => {
    expect(
      namedPaths(
        "Fix src/list.ts:12 and (./src/main.ts#L3-L9), not src/other.ts.",
        Object.keys(repoFiles),
      ),
    ).toEqual(["src/list.ts", "src/main.ts"])
  })

  test("reads nothing through a link out of the checkout, and the imports of a CLAUDE.md of imports", async () => {
    const outside = folder("outside")
    writeFileSync(join(outside, "secret.md"), "a secret\n")
    const repo = checkout({
      "CLAUDE.md": "@AGENTS.md @~/x.md @../y.md\n",
      "AGENTS.md": "Agents' rules.\n",
    })
    symlinkSync(join(outside, "secret.md"), join(repo, "README.md"))
    const tracked = { "CLAUDE.md": "", "AGENTS.md": "", "README.md": "" }
    const ev = await Effect.runPromise(
      gatherFeature(repo, "Read README.md").pipe(
        Effect.provide(
          Layer.mergeAll(
            beadsLayer([]),
            memoryGit({ dir: repo, files: tracked }),
            BunServices.layer,
          ),
        ),
      ),
    )
    expect(ev.readme).toBe("")
    expect(ev.named).toEqual([])
    expect([ev.guide, ev.guideName]).toEqual(["Agents' rules.\n", "AGENTS.md"])
    expect(ev.files).toEqual([
      { path: "AGENTS.md", lines: 1 },
      { path: "CLAUDE.md", lines: 1 },
      { path: "README.md" },
    ])
    const input = renderInput("id", planInput(ev))
    expect(input).toContain("## Agent instructions (AGENTS.md)")
    expect(input).not.toContain("a secret")
  })
})

describe("filing", () => {
  test("a step that fails says what was filed before it and how to carry on", () => {
    expect(
      filingFailedLines(
        new FilingFailed({
          what: "the link test-1.2 (t2) after test-1.1 (t1)",
          reason: "bd: database locked",
          mayHaveFiled: false,
          epic: "test-1",
          filed: [
            { id: "test-1", key: null, title: "Epic" },
            { id: "test-1.1", key: "t1", title: "One" },
            { id: "test-1.2", key: "t2", title: "Two" },
          ],
          unlinked: [
            { blocked: "test-1.2", blocker: "test-1.1", blockedKey: "t2", blockerKey: "t1" },
          ],
        }),
      ),
    ).toEqual([
      "tutti couldn't file the link test-1.2 (t2) after test-1.1 (t1): bd: database locked",
      "Filed before it:",
      "  test-1 (epic) Epic",
      "  test-1.1 (t1) One",
      "  test-1.2 (t2) Two",
      "Remove them with: bd delete test-1.2 test-1.1 test-1 --force",
      "Or add the links that are missing and carry on:",
      "  bd dep add test-1.2 test-1.1",
      "  tutti --ticket test-1",
    ])
    expect(
      filingFailedLines(
        new FilingFailed({
          what: "the epic",
          reason: "exit code 1",
          mayHaveFiled: false,
          epic: null,
          filed: [],
          unlinked: null,
        }),
      ),
    ).toEqual(["tutti couldn't file the epic: exit code 1", "Nothing was filed."])
  })
})

describe("the run after --feature", () => {
  test("runs scoped to the filed epic: its tickets in their order, nothing else", async () => {
    const repo = folder("run-repo")
    const root = folder("run-worktrees")
    const plan = {
      ...twoTickets,
      tickets: [ticket({ key: "t1" }), ticket({ key: "t2", blocked_by: ["t1"] })],
    }
    // "other" is test-1's place in the backlog's numbering; the epic is test-2.
    const ids = ["test-2.1", "test-2.2"]
    const ran = await scenario(
      {
        config: { repo },
        git: { dir: repo },
        worktrees: { root },
        backlog: backlog().ticket("other").seeds,
        scripts: (world) =>
          Object.fromEntries(
            ids.map((id) => [
              id,
              [
                claimsAndCloses(id, {
                  claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
                  commit: Effect.asVoid(
                    world.repository.commit(join(root, id), `Change (${id})`, {
                      [`${id}.txt`]: "x\n",
                    }),
                  ),
                  close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
                }),
              ],
            ]),
          ),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ids) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const featured = yield* planAndFile(
          { request: "Add a --json flag", repo, yes: true },
          {
            printer: makePrinter({ write: () => {}, columns: () => 100, tty: false }, theme),
            theme,
            error: () => Effect.void,
            confirm: Option.none(),
          },
        ).pipe(Effect.provide(Organs.layer.pipe(Layer.provide(cannedLayer({ screen: ok, plan })))))
        if (featured._tag !== "Filed") return yield* Effect.die(featured)
        expect(featured.epic).toBe("test-2")
        const fiber = yield* Effect.forkChild(
          scopedTo(featured.epic)(
            run({ version: "0.1.0-test", base: "main", start: [line`START`] }),
          ),
        )
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "test-2.1": "Done", "test-2.2": "Done" })
    expect(ran.issues.find((issue) => issue.id === "other")?.status).toBe("open")
    expect(ran.log).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^READY_EMPTY after 2 tickets; SCOPE_DONE: test-2/),
      ]),
    )
    const dispatched = ran.log.filter((text) => text.includes("dispatching"))
    expect(dispatched.map((text) => text.replace(/^\[\d+\/\d+\] /, "").split(" ")[0])).toEqual(ids)
  })
})
