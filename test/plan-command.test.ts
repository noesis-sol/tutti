// tutti plan (§ 8.1): blocks links between the open tickets that touch the same code, proposed from
// their footprints and, with --apply, added with bd; run against the in-memory backlog and git.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Context, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import fc from "fast-check"
import { tuttiWith } from "../src/cli/commands.ts"
import { compareIds, type Link, planLinks } from "../src/plan/plan.ts"
import { repoFiles } from "../src/run/footprint.ts"
import { Beads, BeadsFailed, type Issue } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"

const ticket = (id: string, priority: number, description: string, more: Partial<Issue> = {}) =>
  ({
    id,
    title: id,
    description,
    design: "",
    acceptance: "",
    notes: "",
    status: "open",
    priority,
    type: "task",
    assignee: "",
    labels: [],
    dependencies: [],
    metadata: {},
    files: [],
    predictedFiles: [],
    createdAt: "2026-10-01T00:00:00Z",
    closeReason: "",
    ...more,
  }) satisfies Issue

const shown = (links: ReadonlyArray<Link>) => links.map((l) => `${l.blocker}>${l.blocked}:${l.why}`)

const tracked = ["src/run/merge.ts", "src/run/loop.ts", "src/plan/plan.ts", "README.md"]

const lines = (n: number) => "\n".repeat(n)

/** Every file has 50 lines but those given, which have their contents. */
const sourceOf =
  (files: Readonly<Record<string, string>>) =>
  (file: string): string | undefined =>
    files[file] ?? lines(50)

describe("planLinks", () => {
  test("links tickets naming one function, the higher-priority one first", () => {
    const open = [
      ticket("low", 3, "Retry in `Loop.merge` (src/run/merge.ts)."),
      ticket("high", 1, "Log each rebase in Loop.merge()."),
      ticket("other", 0, "Change refreshBranch() in src/run/merge.ts."),
    ]
    // low and other work in merge.ts on different functions it mentions.
    const merge = sourceOf({
      "src/run/merge.ts": "class Loop { merge() { this.refreshBranch() } }\n",
    })
    expect(shown(planLinks(open, [], repoFiles(tracked), merge))).toEqual(["high>low:Loop.merge"])
  })

  test("at the same priority the older ticket goes first, then the lower ID", () => {
    const open = [
      ticket("b", 2, "Change `Loop.merge`.", { createdAt: "2026-10-02T00:00:00Z" }),
      ticket("a", 2, "Change `Loop.merge`.", { createdAt: "2026-10-03T00:00:00Z" }),
      ticket("e.10", 2, "Change `Loop.merge`.", { createdAt: "2026-10-01T00:00:00Z" }),
      ticket("e.2", 2, "Change `Loop.merge`.", { createdAt: "2026-10-01T00:00:00Z" }),
    ]
    expect(shown(planLinks(open, [], repoFiles(tracked), sourceOf({})))).toEqual([
      "e.2>e.10:Loop.merge",
      "e.10>b:Loop.merge",
      "b>a:Loop.merge",
    ])
  })

  test("independent tickets get no link", () => {
    const open = [
      ticket("a", 1, "Reword README.md."),
      ticket("b", 1, "Tidy src/run/loop.ts."),
      ticket("c", 1, "Change `waitSettled`."),
    ]
    expect(planLinks(open, [], repoFiles(tracked), sourceOf({}))).toEqual([])
  })

  test("only a small file links tickets; one not written yet is small", () => {
    const open = [
      ticket("a", 1, "Reword the intro in README.md."),
      ticket("b", 2, "Add a section to README.md and src/run/loop.ts."),
      ticket("c", 2, "Tidy src/run/loop.ts."),
      ticket("d", 2, "Add src/plan/plan.ts."),
      ticket("e", 3, "Test src/plan/plan.ts."),
    ]
    const source = (file: string) =>
      file === "src/run/loop.ts" ? lines(900) : file === "src/plan/plan.ts" ? undefined : lines(50)
    expect(shown(planLinks(open, [], repoFiles(tracked), source))).toEqual([
      "a>b:README.md",
      "d>e:src/plan/plan.ts",
    ])
  })

  test("tickets naming different functions of one file aren't linked", () => {
    const open = [
      ticket("a", 1, "Change `waitSettled` in README.md."),
      ticket("b", 2, "Change refreshBranch() in README.md."),
      ticket("c", 2, "Reword README.md."),
    ]
    const readme = sourceOf({ "README.md": "Call waitSettled, then refreshBranch.\n" })
    // c names no function, so the file decides for it: it waits for b, the nearest ticket before
    // it, and for a, which b doesn't.
    expect(shown(planLinks(open, [], repoFiles(tracked), readme))).toEqual([
      "b>c:README.md",
      "a>c:README.md",
    ])
  })

  test("tickets on one function form a chain, and ordered pairs get none", () => {
    const open = [
      ticket("a", 1, "Change `Loop.merge`."),
      ticket("b", 2, "Change `Loop.merge`."),
      ticket("c", 3, "Change `Loop.merge`."),
    ]
    expect(shown(planLinks(open, [], repoFiles(tracked), sourceOf({})))).toEqual([
      "a>b:Loop.merge",
      "b>c:Loop.merge",
    ])
    // Already ordered, either way round or through another ticket: nothing to add.
    const existing = [
      { blocker: "c", blocked: "x", why: "" },
      { blocker: "x", blocked: "b", why: "" },
      { blocker: "a", blocked: "c", why: "" },
    ]
    expect(planLinks(open, existing, repoFiles(tracked), sourceOf({}))).toEqual([])
  })

  test("area labels and predicted files don't link tickets", () => {
    const open = [
      ticket("a", 1, "Make it faster.", { labels: ["area:tui"] }),
      ticket("b", 2, "Make it nicer.", { labels: ["area:tui"] }),
      ticket("c", 2, "Make it calmer.", { predictedFiles: ["src/run/loop.ts"] }),
      ticket("d", 3, "Change src/run/loop.ts."),
    ]
    expect(planLinks(open, [], repoFiles(tracked), sourceOf({}))).toEqual([])
  })

  test("the files the check command names link nobody", () => {
    const open = [
      ticket("a", 1, "Make README.md pass the check."),
      ticket("b", 2, "Make README.md pass the check too."),
    ]
    expect(planLinks(open, [], repoFiles(tracked, ["cat README.md"]), sourceOf({}))).toEqual([])
  })
})

describe("compareIds", () => {
  test("compares the numbers between the dots as numbers", () => {
    const ids = ["e.10", "e", "e.2", "e.a", "e.02", "d.3", "e.2.1"]
    expect([...ids].sort(compareIds)).toEqual(["d.3", "e", "e.02", "e.2", "e.2.1", "e.10", "e.a"])
  })

  test("is a total order", () => {
    const id = fc.stringMatching(/^[a-z0-9]{0,3}(\.[a-z0-9]{0,3}){0,3}$/)
    fc.assert(
      fc.property(id, id, id, (a, b, c) => {
        expect(compareIds(a, b)).toBe(-compareIds(b, a) || 0)
        expect(compareIds(a, b) === 0).toBe(a === b)
        if (compareIds(a, b) <= 0 && compareIds(b, c) <= 0) {
          expect(compareIds(a, c)).toBeLessThanOrEqual(0)
        }
      }),
    )
  })
})

describe("tutti plan", () => {
  /** A checkout holding these files, on disk for their contents and in git for their names. */
  const checkout = (files: Readonly<Record<string, string>>) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-plan-")))
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), content)
    }
    return dir
  }

  const files = {
    "src/run/merge.ts": "export const merge = () => refreshBranch()\n",
    "src/run/loop.ts": lines(900),
    "README.md": "# tutti\n",
  }

  /**
   * Runs `tutti plan` with args in a checkout of `files` with the backlog `seeds`; returns what it
   * printed, whether it failed, and the backlog after.
   */
  const plan = (
    seeds: ReadonlyArray<Seed>,
    args: ReadonlyArray<string> = [],
    refused: ReadonlyArray<string> = [],
    unlisted = false,
  ) => {
    const dir = checkout(files)
    const printed: Array<string> = []
    const errors: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
      error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
    })
    return Effect.runPromise(
      Effect.gen(function* () {
        const beads = yield* Beads
        const locked = (command: string) =>
          new BeadsFailed({
            command,
            exitCode: 1,
            stderr: "database is locked\n",
            noSuchIssue: false,
          })
        // bd refusing to list the tickets, or to add a link to the tickets `refused`.
        const services = Context.add(yield* Effect.context<Beads | Git>(), Beads, {
          ...beads,
          list: (options) =>
            unlisted ? Effect.fail(locked("bd list --json")) : beads.list(options),
          addDependency: (id, dependsOn, type) =>
            refused.includes(id)
              ? Effect.fail(locked(`bd dep add ${id} ${dependsOn}`))
              : beads.addDependency(id, dependsOn, type),
        })
        const exit = yield* Command.runWith(
          tuttiWith(Effect.succeed(dir), () => Layer.succeedContext(services)),
          { version: "test", renderErrors: false },
        )(["plan", ...args]).pipe(Effect.provideService(Console.Console, console), Effect.exit)
        const issues = yield* (yield* Backlog).issues
        const blockers = Object.fromEntries(
          issues.map((issue) => [
            issue.id,
            issue.dependencies.filter((d) => d.type === "blocks").map((d) => d.id),
          ]),
        )
        return { printed, errors, failed: exit._tag === "Failure", blockers }
      }).pipe(
        Effect.provide(Layer.mergeAll(beadsLayer(seeds), gitLayer({ dir, files }))),
        Effect.provide(BunServices.layer),
      ),
    )
  }

  const backlog: ReadonlyArray<Seed> = [
    { id: "t-1", priority: 2, description: "Retry in `Loop.merge`." },
    { id: "t-2", priority: 1, description: "Log each rebase in Loop.merge()." },
    { id: "t-3", priority: 2, description: "Reword README.md." },
    { id: "t-4", priority: 2, description: "Tidy src/run/loop.ts." },
    { id: "t-5", priority: 3, description: "Add a section to src/run/loop.ts." },
    // Neither an epic nor a question for the maintainer is planned.
    { id: "t-6", priority: 0, type: "epic", description: "Rework `Loop.merge`." },
    { id: "t-7", priority: 0, labels: ["human"], description: "Rework `Loop.merge`?" },
  ]

  test("proposes a link between overlapping open tickets, and changes nothing", async () => {
    const result = await plan(backlog)
    expect(result.printed).toEqual([
      "Proposed 1 blocks link between the 5 open tickets:",
      "  t-1 (P2) waits for t-2 (P1): both touch Loop.merge",
      "Nothing changed. Add them with: tutti plan --apply",
    ])
    expect(result.failed).toBe(false)
    expect(result.blockers["t-1"]).toEqual([])
  })

  test("--apply adds the links with bd", async () => {
    const result = await plan(
      [...backlog, { id: "t-8", priority: 3, description: "Fix the title in README.md." }],
      ["--apply"],
    )
    expect(result.printed).toEqual([
      "Adding 2 blocks links between the 6 open tickets:",
      "  t-1 (P2) waits for t-2 (P1): both touch Loop.merge",
      "  t-8 (P3) waits for t-3 (P2): both touch README.md",
      "Added 2 links.",
    ])
    expect(result.failed).toBe(false)
    expect(result.blockers["t-1"]).toEqual(["t-2"])
    expect(result.blockers["t-8"]).toEqual(["t-3"])
    expect(result.blockers["t-2"]).toEqual([])
  })

  test("says when there is nothing to add: independent or already ordered", async () => {
    const result = await plan(
      [
        { id: "t-1", priority: 2, description: "Retry in `Loop.merge`.", blockedBy: ["t-2"] },
        { id: "t-2", priority: 1, description: "Log each rebase in Loop.merge()." },
        { id: "t-3", priority: 2, description: "Reword README.md." },
        { id: "t-4", priority: 2, description: "Tidy src/run/loop.ts." },
      ],
      ["--apply"],
    )
    expect(result.printed).toEqual([
      "No links to add: no two of the 4 open tickets touch the same code without being ordered already.",
    ])
    expect(result.failed).toBe(false)
  })

  test("fails, saying why, when bd can't add a link", async () => {
    const result = await plan(
      [...backlog, { id: "t-8", priority: 3, description: "Fix the title in README.md." }],
      ["--apply"],
      ["t-8"],
    )
    expect(result.printed).toEqual([
      "Adding 2 blocks links between the 6 open tickets:",
      "  t-1 (P2) waits for t-2 (P1): both touch Loop.merge",
      "  t-8 (P3) waits for t-3 (P2): both touch README.md",
      "Added 1 of 2 links.",
    ])
    expect(result.errors).toEqual([
      "tutti plan: bd dep add t-8 t-3: bd dep add t-8 t-3 exited with 1: database is locked",
      "tutti plan: bd didn't add 1 link",
    ])
    expect(result.failed).toBe(true)
    expect(result.blockers["t-1"]).toEqual(["t-2"])
    expect(result.blockers["t-8"]).toEqual([])
  })

  test("fails, saying why, when bd can't list the tickets", async () => {
    const result = await plan(backlog, [], [], true)
    expect(result.printed).toEqual([])
    expect(result.errors).toEqual([
      "tutti plan: cannot read the open tickets: bd list --json exited with 1: database is locked",
    ])
    expect(result.failed).toBe(true)
  })
})
