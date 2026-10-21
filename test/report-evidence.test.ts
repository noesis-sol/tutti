import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { Organs } from "../src/organs/Organs.ts"
import { makePrinter } from "../src/print/organLine.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Outcome, TicketPhase } from "../src/run/phase.ts"
import {
  type FailedCheck,
  failedCheckSaid,
  failedChecksSection,
  filedOutside,
  followUpSaid,
  followUpWidth,
} from "../src/run/reportEvidence.ts"
import { finish, run } from "../src/run/run.ts"
import type { Issue } from "../src/services/Beads.ts"
import { CheckFailed, CheckNotRun, CheckTimedOut } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { type Script as ChecksScript, passed } from "../src/testing/Checks.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { advance, backlog, type Ran, type Scripts, scenario, type World } from "./harness.ts"

const check = "scripts/check-fast.sh"

const failed = (failingLines: ReadonlyArray<string>, lastLines: ReadonlyArray<string> = []) =>
  new CheckFailed({
    check: "fast",
    command: check,
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines,
    lastLines,
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

const failure = (over: Partial<FailedCheck> = {}): FailedCheck => ({
  id: "t-1",
  branch: "tutti/t-1",
  base: "main",
  onto: "abcdef0123456789",
  error: failed(["error: a.test.ts: expected 1"]),
  output: "/wt/t-1/.tutti/run/check.log",
  folders: ["src/run"],
  ...over,
})

describe("what the check said of a ticket set aside after its check failed", () => {
  test("how it failed, on what, where its output is, the lines saying what failed, its folders", () => {
    expect(failedCheckSaid(failure())).toBe(
      [
        "t-1: 'scripts/check-fast.sh' fails on tutti/t-1 rebased onto main at abcdef0; its output is in /wt/t-1/.tutti/run/check.log.",
        "The lines of its output that say what failed:",
        "    error: a.test.ts: expected 1",
        "Folders that t-1's own commits change (abcdef0..tutti/t-1): src/run",
      ].join("\n"),
    )
  })

  test("without a line saying what failed, its last lines; without output, that it printed nothing", () => {
    const last = failedCheckSaid(failure({ error: failed([], ["ok 1", "exit 2"]) }))
    expect(last).toContain(
      "No line of its output says what failed; its last lines:\n    ok 1\n    exit 2\n",
    )
    expect(failedCheckSaid(failure({ error: failed([]) }))).toContain("\nIt printed nothing.\n")
  })

  test("a setup that failed says the check did not run; a check that couldn't run has no output", () => {
    const setup = new CheckTimedOut({
      check: "setup",
      command: "bun install",
      timeLimit: Duration.minutes(5),
      outputFile: "/dev/fd/9",
      failingLines: [],
      lastLines: ["resolving"],
      suites: [],
      suite: null,
      flaky: [],
      flakyCount: 0,
    })
    expect(failedCheckSaid(failure({ error: setup }))).toStartWith(
      "t-1: the setup 'bun install', run before the check, did not finish within 5m on tutti/t-1 " +
        "rebased onto main at abcdef0, so the check did not run; its output is in ",
    )
    const notRun = new CheckNotRun({ check: "fast", command: check, reason: "no such file" })
    expect(failedCheckSaid(failure({ error: notRun }))).toBe(
      "t-1: 'scripts/check-fast.sh' could not be run (no such file) on tutti/t-1 rebased onto main at abcdef0.\n" +
        "Folders that t-1's own commits change (abcdef0..tutti/t-1): src/run",
    )
  })

  test("the folders: the top level named, at most 20, none when git couldn't list them", () => {
    const many = [".", ...Array.from({ length: 24 }, (_, i) => `d${String(i).padStart(2, "0")}`)]
    const said = failedCheckSaid(failure({ folders: many }))
    expect(said).toEndWith(
      ": the top level (.), d00, d01, d02, d03, d04, d05, d06, d07, d08, d09, d10, d11, d12, d13, d14, d15, d16, d17, d18 and 5 more",
    )
    expect(failedCheckSaid(failure({ folders: null }))).toEndWith(": none that git could list")
    expect(failedCheckSaid(failure({ folders: [] }))).toEndWith(": none that git could list")
  })

  test("every line its output says what failed with is given, indented, whatever it says", () => {
    const text = fc.string().map((s) => s.replaceAll("\n", " "))
    fc.assert(
      fc.property(fc.array(text, { minLength: 1, maxLength: 30 }), (lines) => {
        const said = failedCheckSaid(failure({ error: failed(lines) })).split("\n")
        expect(said.slice(2, 2 + lines.length)).toEqual(lines.map((each) => `    ${each}`))
      }),
    )
  })
})

const entry = (ticket: string, phase: TicketPhase): Entry => ({
  ticket,
  title: ticket,
  phase,
  since: 0,
  worker: null,
  row: null,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

describe("the failed checks' section", () => {
  test("names the tickets still set aside for their check, in the order they were set aside", () => {
    const entries = new Map([
      ["a", entry("a", TicketPhase.Review({ why: "CHECKS_FAILED" }))],
      ["b", entry("b", TicketPhase.Done({ outcome: Outcome.Merged({ commit: "abc" }) }))],
      ["c", entry("c", TicketPhase.Review({ why: "CHECKS_FAILED" }))],
      ["d", entry("d", TicketPhase.Review({ why: "DIRTY_WORKTREE" }))],
    ])
    const failures = new Map([
      ["c", "c: failed"],
      ["b", "b: failed, merged on its recheck"],
      ["a", "a: failed"],
      ["d", "d: failed, set aside since for another reason"],
    ])
    expect(failedChecksSection(entries, failures)).toEqual([
      {
        _tag: "Section",
        title: "What the check said of each ticket set aside after its check failed",
        body: "c: failed\n\na: failed",
      },
    ])
  })

  test("is left out when no ticket is set aside for its check", () => {
    const entries = new Map([["a", entry("a", TicketPhase.Review({ why: "OFF_BRANCH" }))]])
    expect(failedChecksSection(entries, new Map([["a", "a: failed"]]))).toEqual([])
    expect(failedChecksSection(new Map(), new Map())).toEqual([])
  })
})

const issue = (over: Partial<Issue>): Issue => ({
  id: "x-1",
  title: "A follow-up",
  description: "",
  design: "",
  acceptance: "",
  notes: "",
  status: "open",
  type: "task",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "2026-10-20T09:00:00Z",
  closeReason: "",
  ...over,
})

describe("the follow-ups filed outside a scoped run", () => {
  const started = Date.parse("2026-10-20T09:00:00.700Z")

  test("are those created since the second the run started, outside its scope, and no question", () => {
    const open = [
      issue({ id: "x-1" }),
      issue({ id: "x-2", createdAt: "2026-10-20T08:59:59Z" }),
      issue({ id: "e-1.2", createdAt: "2026-10-20T09:10:00Z" }),
      issue({ id: "x-3", labels: ["human"], createdAt: "2026-10-20T09:10:00Z" }),
      issue({ id: "x-4", createdAt: "yesterday" }),
      issue({ id: "x-5", createdAt: "2026-10-20T09:30:00+00:00" }),
    ]
    const filed = filedOutside(open, new Set(["e-1", "e-1.2"]), started)
    expect(filed.map((each) => each.id)).toEqual(["x-1", "x-5"])
  })

  test("each is said with its title, type, status, links and description", () => {
    const said = followUpSaid(
      issue({
        id: "x-5",
        title: "Cache the parse",
        type: "bug",
        status: "open",
        description: "The parse runs\ntwice.",
        dependencies: [{ id: "e-1.1", type: "discovered-from" }],
      }),
    )
    expect(said).toBe(
      "x-5: Cache the parse\nbug, open; links: discovered-from e-1.1\nDescription: The parse runs twice.",
    )
    expect(followUpSaid(issue({}))).toBe("x-1: A follow-up\ntask, open")
  })

  test("a description of any text is one line, cut short", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (description) => {
        const lines = followUpSaid(issue({ description })).split("\n")
        expect(lines.slice(0, 2)).toEqual(["x-1: A follow-up", "task, open"])
        expect(lines.length).toBeLessThanOrEqual(3)
        const said = lines[2]?.slice("Description: ".length) ?? ""
        expect([...said].length).toBeLessThanOrEqual(followUpWidth)
      }),
    )
  })
})

// Whole runs, with organs: what the reviewer is given.

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-evidence-${name}-`)))
const report = "The run ended.\n"

interface Plan {
  readonly config?: Partial<AppConfigValue>
  readonly backlog: ReadonlyArray<Seed>
  /** The tickets given a worktree. */
  readonly tickets: ReadonlyArray<string>
  readonly checks?: ChecksScript
  readonly scripts: (world: World, root: string) => Scripts
  /** Runs beside the run, before it is joined. */
  readonly during?: Effect.Effect<void>
}

/**
 * A whole run on main, started 5 seconds after its backlog was seeded, then its report: the
 * reviewer's input.
 */
const reviewed = async (plan: Plan): Promise<Ran<string>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const calls: Array<OrganCallRecord> = []
  const organs = Layer.mergeAll(Organs.layer, OrganCost.layer).pipe(
    Layer.provide(
      cannedLayer(
        {
          reviewer: { report },
          triage: { cause: "problem", confidence: "medium", summary: "Its check fails." },
        },
        calls,
      ),
    ),
  )
  const ran = await scenario(
    {
      config: { ...plan.config, repo },
      git: { dir: repo },
      worktrees: { root },
      backlog: plan.backlog,
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      yield* TestClock.adjust("5 seconds")
      const running = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", endLater: true }),
      )
      yield* plan.during ?? Effect.void
      const outcome = yield* Fiber.join(running)
      const out = { write: () => {}, columns: () => 100, tty: false }
      yield* finish(
        outcome,
        Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }),
        false,
      )
      return calls.find((each) => each.call.organ === "reviewer")?.input ?? "(no reviewer call)"
    }).pipe(Effect.provide(organs)),
  )
  return ran
}

const inputOf = (ran: Ran<string>): string => {
  if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
  return ran.exit.value
}

/** The body of the reviewer's section titled `title`, or undefined when it has none. */
const sectionOf = (input: string, title: string): string | undefined => {
  const at = input.indexOf(`## ${title}\n\n`)
  if (at === -1) return undefined
  const body = input.slice(at).split("\n").slice(3).join("\n")
  return body.slice(0, body.indexOf("\n</evidence id="))
}

/** Claims its ticket, does `between`, commits a change if `files` are given, and closes it. */
const works = (
  world: World,
  root: string,
  id: string,
  options: { readonly between?: SessionScript; readonly files?: Record<string, string> } = {},
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...(options.between ?? []),
      ...(options.files === undefined
        ? []
        : bash(
            `git commit -am "Change (${id})"`,
            Effect.asVoid(
              Effect.orDie(
                world.repository.commit(join(root, id), `Change (${id})`, options.files),
              ),
            ),
          )),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

describe("the reviewer of a whole run", () => {
  test("is told what the check said of a ticket set aside after its check failed", async () => {
    const defaults = appConfig().settings
    const ran = await reviewed({
      config: {
        settings: {
          ...defaults,
          concurrent: 2,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
          merge: { ...defaults.merge, check_hand_backs: 0 },
        },
      },
      backlog: backlog().ticket("a").ticket("b").seeds,
      tickets: ["a", "b"],
      // a, on top of main, passes; b, rebased onto it, fails.
      checks: { fast: [passed("fast"), failed(["src/b/b.test.ts:3: expected 1"])] },
      scripts: (world, root) => ({
        a: [works(world, root, "a", { files: { "a.txt": "a\n" } })],
        b: [
          works(world, root, "b", { between: [sleep("1 minute")], files: { "src/b/b.ts": "b\n" } }),
        ],
      }),
      during: Effect.gen(function* () {
        for (let i = 0; i < 2; i++) {
          yield* advance("1 minute")
          yield* Effect.promise(() => Bun.sleep(3))
        }
      }),
    })
    const said = sectionOf(
      inputOf(ran),
      "What the check said of each ticket set aside after its check failed",
    )
    expect(said).toMatch(
      new RegExp(
        `^b: '${check}' fails on tutti/b rebased onto main at [0-9a-f]{7}; its output is in .*\\.\n` +
          "The lines of its output that say what failed:\n" +
          " {4}src/b/b\\.test\\.ts:3: expected 1\n" +
          "Folders that b's own commits change \\([0-9a-f]{7}\\.\\.tutti/b\\): src/b$",
      ),
    )
  })

  test("of a scoped run is told the follow-ups filed in it outside its scope", async () => {
    const ran = await reviewed({
      config: { ticket: "e-1" },
      backlog: backlog().epic("e-1", ["e-1.1"]).ticket("x-1", { title: "Filed before the run" })
        .seeds,
      tickets: ["e-1.1"],
      scripts: (world, root) => ({
        "e-1.1": [
          works(world, root, "e-1.1", {
            between: [
              ...bash(
                'bd create --title "Cache the parse" --deps discovered-from:e-1.1',
                Effect.asVoid(
                  Effect.orDie(
                    world.beads.create({
                      title: "Cache the parse",
                      description: "Found while parsing.",
                      discoveredFrom: ["e-1.1"],
                    }),
                  ),
                ),
              ),
              ...bash(
                'bd create --labels human --title "Which way?"',
                Effect.asVoid(
                  Effect.orDie(world.beads.create({ title: "Which way?", labels: ["human"] })),
                ),
              ),
            ],
          }),
        ],
      }),
    })
    const said = sectionOf(
      inputOf(ran),
      "Follow-ups filed in this run outside the scope of e-1, left for a later run",
    )
    expect(said).toMatch(
      /^\S+: Cache the parse\ntask, open; links: discovered-from e-1\.1\nDescription: Found while parsing\.$/,
    )
  })

  test("of a run of the whole queue has neither section without a failed check", async () => {
    const ran = await reviewed({
      backlog: backlog().ticket("t-1").seeds,
      tickets: ["t-1"],
      scripts: (world, root) => ({ "t-1": [works(world, root, "t-1")] }),
    })
    const input = inputOf(ran)
    expect(input).toContain("## Tickets still ready")
    expect(input).not.toContain("What the check said")
    expect(input).not.toContain("Follow-ups filed")
  })
})
