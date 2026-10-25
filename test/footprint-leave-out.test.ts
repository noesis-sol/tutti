// What footprints leave out since orchestra 0.9.0 (tutti-kkb.16): a ticket's notes, the files git
// merges by union, a file two tickets share that neither is to change, a reopened or carried-over
// ticket's text (its branch says where it works), and nothing of a path's brackets or its +.
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Deferred, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { type Link, plan, planLinks } from "../src/plan/plan.ts"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import {
  branchFootprint,
  emptyFootprint,
  type FootprintTicket,
  showFootprint,
  ticketFootprint,
  withChanges,
} from "../src/run/footprint.ts"
import { overlaps, shared } from "../src/run/overlap.ts"
import { footprintOf } from "../src/run/predict.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Footprints, footprintsOf, make } from "../src/run/schedule.ts"
import { asksChange } from "../src/run/text.ts"
import { type Issue, metadataList, type TicketId } from "../src/services/Beads.ts"
import { Git, GitWriter, parseUnion } from "../src/services/Git.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as lockLayer } from "../src/testing/RunLock.ts"
import { slow } from "./gates.ts"

/** A ticket with these fields, its files and predicted files read from its metadata as bd's are. */
const ticket = (
  fields: Partial<Omit<FootprintTicket, "files" | "predictedFiles">> = {},
): FootprintTicket => {
  const metadata = fields.metadata ?? {}
  return {
    title: "",
    description: "",
    design: "",
    acceptance: "",
    labels: [],
    ...fields,
    metadata,
    files: metadataList(metadata, "files"),
    predictedFiles: metadataList(metadata, "predicted_files"),
  }
}

/** An open issue with this description and more. */
const issue = (id: TicketId, priority: number, description: string, more: Partial<Issue> = {}) =>
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

const tracked = [
  "CHANGELOG.md",
  "CLAUDE.md",
  "docs/guide.md",
  "src/run/loop.ts",
  "src/run/merge.ts",
  "src/ui/view.ts",
]
const union = repoFiles(tracked, [], ["CHANGELOG.md"])
const plain = repoFiles(tracked)

const footprint = (fields: Parameters<typeof ticket>[0], repo = plain) =>
  ticketFootprint(ticket(fields), repo)

const shown = (links: ReadonlyArray<Link>) => links.map((l) => `${l.blocker}>${l.blocked}:${l.why}`)

describe("a ticket's notes", () => {
  test("name nothing of where it works", () => {
    const noted = issue("t-1" as TicketId, 2, "Say hello.", {
      notes: "Reopened: src/run/loop.ts fails in `Loop.merge`; see refreshBranch().",
    })
    expect(ticketFootprint(noted, plain)).toEqual(emptyFootprint)
    // Two tickets whose notes name one file and one function run side by side.
    const other = issue("t-2" as TicketId, 2, "Say goodbye.", { notes: noted.notes })
    expect(overlaps(ticketFootprint(noted, plain), ticketFootprint(other, plain))).toBe(false)
    // What the text names still counts.
    expect(ticketFootprint({ ...noted, design: "Fix src/run/loop.ts." }, plain).files).toEqual([
      "src/run/loop.ts",
    ])
  })

  test("link nothing in tutti plan", () => {
    const notes = "Worked on src/run/loop.ts and Loop.merge()."
    const open = [
      issue("a" as TicketId, 1, "Say hello.", { notes }),
      issue("b" as TicketId, 2, "Say goodbye.", { notes }),
    ]
    expect(planLinks(open, [], plain, () => "\n")).toEqual([])
  })
})

describe("the files git merges by union", () => {
  test("are left out of what a ticket's text names and its metadata lists", () => {
    const named = footprint(
      { description: "Add an entry to CHANGELOG.md and fix src/run/loop.ts." },
      union,
    )
    expect(named.files).toEqual(["src/run/loop.ts"])
    const listed = footprint({ metadata: { files: ["CHANGELOG.md", "src/ui/view.ts"] } }, union)
    expect(listed.files).toEqual(["src/ui/view.ts"])
    // Not merged by union, the changelog counts as before.
    expect(footprint({ description: "Add an entry to CHANGELOG.md." }).files).toEqual([
      "CHANGELOG.md",
    ])
  })

  test("leave a ticket naming only them to its prediction, which leaves them out too", () => {
    const only = footprint({ description: "Add an entry to CHANGELOG.md." }, union)
    expect(only).toEqual(emptyFootprint)
    const predicted = footprint(
      {
        description: "Add an entry to CHANGELOG.md.",
        metadata: { predicted_files: ["CHANGELOG.md", "src/run/merge.ts"] },
      },
      union,
    )
    expect(predicted.files).toEqual(["src/run/merge.ts"])
    expect(predicted.predicted).toBe(true)
  })

  test("are left out of a worktree's changes: two tickets adding entries run side by side", () => {
    const a = withChanges(emptyFootprint, ["CHANGELOG.md", "src/run/loop.ts"], union)
    const b = withChanges(emptyFootprint, ["CHANGELOG.md"], union)
    expect(a.changed).toEqual(["src/run/loop.ts"])
    expect(overlaps(a, b)).toBe(false)
    expect(overlaps(footprint({ description: "Add to CHANGELOG.md." }, union), a)).toBe(false)
  })

  test("link nothing in tutti plan", () => {
    const open = [
      issue("a" as TicketId, 1, "Add an entry to CHANGELOG.md."),
      issue("b" as TicketId, 2, "Add an entry to CHANGELOG.md."),
    ]
    expect(planLinks(open, [], union, () => "\n")).toEqual([])
    expect(shown(planLinks(open, [], plain, () => "\n"))).toEqual(["a>b:CHANGELOG.md"])
  })

  test("are what git check-attr says, in the test layer as in git", async () => {
    const said = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        return yield* git.mergedByUnion(repository.dir, [
          "CHANGELOG.md",
          "docs/CHANGELOG.md",
          "src/run/loop.ts",
          "notes/a.log",
          "keep.log",
          "new.md",
        ])
      }).pipe(
        Effect.provide(
          memoryGit({
            files: {
              ".gitattributes": "CHANGELOG.md merge=union\n*.log merge=union\n/keep.log -merge\n",
              "CHANGELOG.md": "",
            },
          }),
        ),
      ),
    )
    expect(said).toEqual(["CHANGELOG.md", "docs/CHANGELOG.md", "notes/a.log"])
    expect(
      parseUnion("a.md\0merge\0union\0b.ts\0merge\0unspecified\0c d.md\0merge\0union\0"),
    ).toEqual(["a.md", "c d.md"])
  })

  slow.test("are what git check-attr says", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-union-")))
    execFileSync("git", ["init", "-q", dir])
    writeFileSync(join(dir, ".gitattributes"), "CHANGELOG.md merge=union\n")
    const said = await Effect.runPromise(
      Effect.flatMap(Git, (git) =>
        git.mergedByUnion(dir, ["CHANGELOG.md", "src/a b.ts", "docs/CHANGELOG.md"]),
      ).pipe(
        Effect.provide(
          Git.layer().pipe(
            Layer.provideMerge(GitWriter.layer),
            Layer.provideMerge(BunServices.layer),
          ),
        ),
      ),
    )
    expect(said).toEqual(["CHANGELOG.md", "docs/CHANGELOG.md"])
  })
})

describe("a file two tickets share", () => {
  const sentences = [
    ["Update docs/guide.md with the new flag.", true],
    ["Add the result to docs/guide.md.", true],
    ["docs/guide.md says how to run them.", true],
    ["- docs/guide.md: say how to run them.", true],
    ["Follow the conventions per docs/guide.md.", false],
    ["Reproduce as docs/guide.md says.", false],
    ["Spike 1 (docs/guide.md, item 4) found that it hangs.", false],
    ["The help says it disables docs/guide.md.", false],
  ] as const

  test("a document is to change only where a sentence asks to change it", () => {
    for (const [description, change] of sentences) {
      const fp = footprint({ description })
      expect([description, fp.files, fp.cited]).toEqual([
        description,
        ["docs/guide.md"],
        change ? [] : ["docs/guide.md"],
      ])
    }
  })

  test("holds two tickets apart only when one of them is to change it", () => {
    const cites = footprint({ description: "Keep to the conventions per CLAUDE.md." })
    const alsoCites = footprint({ description: "Write it as CLAUDE.md says: see CLAUDE.md." })
    const changes = footprint({ description: "Update CLAUDE.md with the new rule." })
    expect(overlaps(cites, alsoCites)).toBe(false)
    expect(shared(cites, changes)).toBe("CLAUDE.md")
    expect(shared(changes, cites)).toBe("CLAUDE.md")
    // A source file the text names is one to change.
    expect(
      shared(footprint({ description: "See src/run/loop.ts." }), footprint({ title: "loop.ts" })),
    ).toBe("src/run/loop.ts")
  })

  test("with files metadata, the files the text names are only read", () => {
    const reads = footprint({
      description: "Read src/run/loop.ts and change the view.",
      metadata: { files: ["src/ui/view.ts"] },
    })
    expect(reads.listed).toBe(true)
    expect(reads.files).toEqual(["src/run/loop.ts", "src/ui/view.ts"])
    expect(reads.cited).toEqual(["src/run/loop.ts"])
    const alsoReads = footprint({
      description: "Read src/run/loop.ts.",
      metadata: { files: ["src/run/merge.ts"] },
    })
    expect(overlaps(reads, alsoReads)).toBe(false)
    // One whose text names it without files metadata is to change it.
    expect(shared(reads, footprint({ description: "Fix src/run/loop.ts." }))).toBe(
      "src/run/loop.ts",
    )
    // One listing it is to change it.
    expect(shared(reads, footprint({ metadata: { files: ["src/run/loop.ts"] } }))).toBe(
      "src/run/loop.ts",
    )
  })

  test("a file a running ticket's worktree changed is one it changes", () => {
    const cites = footprint({ description: "Per CLAUDE.md." })
    expect(overlaps(cites, footprint({ description: "As CLAUDE.md says." }))).toBe(false)
    const edited = withChanges(
      footprint({ description: "As CLAUDE.md says." }),
      ["CLAUDE.md"],
      plain,
    )
    expect(shared(cites, edited)).toBe("CLAUDE.md")
  })

  test("a function named in a document holds no ticket there", () => {
    const sources = (file: string, fn: string) =>
      (file === "docs/guide.md" || file === "src/run/merge.ts") && fn === "refreshBranch"
    const fn = footprint({ description: "Make refreshBranch() retry." })
    expect(overlaps(fn, footprint({ description: "Per docs/guide.md." }), sources)).toBe(false)
    expect(shared(fn, footprint({ description: "Tidy src/run/merge.ts." }), sources)).toBe(
      "src/run/merge.ts",
    )
  })

  test("two tickets both only citing a document aren't linked by tutti plan", () => {
    const open = [
      issue("a" as TicketId, 1, "Keep to the conventions per docs/guide.md."),
      issue("b" as TicketId, 2, "Follow docs/guide.md's steps, as docs/guide.md says."),
      issue("c" as TicketId, 3, "Update docs/guide.md with the new step."),
    ]
    expect(shown(planLinks(open, [], plain, () => "\n"))).toEqual([
      "b>c:docs/guide.md",
      "a>c:docs/guide.md",
    ])
  })

  test("asksChange reads any words without failing, and a document starting its sentence asks", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 20 }), fc.nat(), (words, n) => {
        const i = words.length === 0 ? 0 : n % words.length
        expect(typeof asksChange(words, i)).toBe("boolean")
      }),
    )
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 10 }), (rest) => {
        expect(asksChange(["-", "docs/x.md", ...rest], 1)).toBe(true)
      }),
    )
  })

  test("any text gives a footprint whose cited files are among its files", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (description, design) => {
        const fp = footprint({ description: `${description} docs/guide.md ${design}`, design })
        for (const f of fp.cited) expect(fp.files).toContain(f)
      }),
    )
  })
})

describe("a ticket with commits on its branch", () => {
  const reopened = ticket({
    description: "Fix src/run/loop.ts, per docs/guide.md, in `Loop.merge`.",
    labels: ["area:run", "solo"],
    metadata: { files: ["src/ui/"] },
  })

  test("is footprinted from what its branch changes, its files metadata and its areas", () => {
    const fp = branchFootprint(reopened, ["src/run/merge.ts", "CHANGELOG.md"], union)
    expect(fp.files).toEqual(["src/run/merge.ts", "src/ui/", "src/ui/view.ts"])
    expect(fp.funcs).toEqual([])
    expect(fp.areas).toEqual(["area:run"])
    expect(fp.branch).toBe(true)
    expect(showFootprint(fp)).toBe(
      "src/run/merge.ts, src/ui/, src/ui/view.ts, area:run (from its branch)",
    )
    // Not over what only its text names.
    expect(overlaps(fp, footprint({ description: "Fix src/run/loop.ts." }))).toBe(false)
    expect(shared(fp, footprint({ description: "Fix src/run/merge.ts." }))).toBe("src/run/merge.ts")
  })

  test("footprintOf takes the branch's files over its text", () => {
    const asIssue = issue("t-1" as TicketId, 2, reopened.description, {
      labels: reopened.labels,
      metadata: reopened.metadata,
      files: reopened.files,
    })
    expect(footprintOf(asIssue, plain, new Map(), ["src/run/merge.ts"]).branch).toBe(true)
    expect(footprintOf(asIssue, plain, new Map()).files).toContain("src/run/loop.ts")
  })

  test("is footprinted from its branch by tutti plan", () => {
    const open = [
      issue("a" as TicketId, 1, "Fix src/run/loop.ts."),
      issue("b" as TicketId, 2, "Reopened: src/run/loop.ts was wrong."),
      issue("c" as TicketId, 3, "Fix src/run/merge.ts."),
    ]
    const branches = new Map([["b", ["src/run/merge.ts"]]])
    expect(shown(planLinks(open, [], plain, () => "\n"))).toEqual(["a>b:src/run/loop.ts"])
    expect(shown(planLinks(open, [], plain, () => "\n", branches))).toEqual([
      "b>c:src/run/merge.ts",
    ])
  })
})

describe("the checkout's footprints", () => {
  test("leave out the files git merges by union, and read a ticket's branch", async () => {
    const [unioned, changed, branch, none] = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repo = yield* Repository
        yield* git.addWorktree(repo.dir, "/repo-tutti/t-1", { branch: "tutti/t-1", base: "main" })
        yield* repo.commit("/repo-tutti/t-1", "work", { "src/b.ts": "b2", "CHANGELOG.md": "x" })
        yield* repo.write("/repo-tutti/t-1", { "docs/CHANGELOG.md": "new" })
        const source = yield* footprintsOf({
          repo: repo.dir,
          base: "main",
          checkCommands: [],
          worktree: (ticket) => Effect.succeed(`/repo-tutti/${ticket}`),
        })
        const files = yield* source.repo
        return [
          [files.unioned("CHANGELOG.md"), files.unioned("src/b.ts")],
          yield* source.changed("t-1" as TicketId),
          yield* source.branch?.("t-1" as TicketId) ?? Effect.succeed(["no branch read"]),
          yield* source.branch?.("t-9" as TicketId) ?? Effect.succeed(["no branch read"]),
        ] as const
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            memoryGit({
              files: {
                ".gitattributes": "CHANGELOG.md merge=union\n",
                "CHANGELOG.md": "",
                "src/b.ts": "b",
              },
            }),
            BunServices.layer,
          ),
        ),
      ),
    )
    expect(unioned).toEqual([true, false])
    expect(changed).toEqual(["src/b.ts"])
    expect(branch).toEqual(["src/b.ts"])
    expect(none).toEqual([])
  })
})

describe("the scheduler", () => {
  const repository = repoFiles(["src/a.ts", "src/b.ts", "CHANGELOG.md"], [], ["CHANGELOG.md"])

  /** Runs two fills of a 2-slot scheduler: the tickets started, and the log. */
  const twoFills = (seeds: ReadonlyArray<Seed>, branches: Record<string, ReadonlyArray<string>>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const started = yield* Ref.make<ReadonlyArray<string>>([])
        const footprints: Footprints = {
          repo: Effect.succeed(repository),
          changed: () => Effect.succeed([]),
          branch: (ticket) => Effect.succeed(branches[ticket] ?? []),
          mentions: () => Effect.succeed(() => false),
        }
        const schedule = yield* make({
          concurrent: 2,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          footprints,
          start: {
            start: (started_: Issue) =>
              Effect.andThen(
                Ref.update(started, (all) => [...all, started_.id]),
                Deferred.await(gate),
              ),
          },
        })
        yield* schedule.fillTrying
        yield* schedule.fillTrying
        return [yield* Ref.get(started), yield* texts] as const
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )

  test("holds a reopened ticket back over what its branch changes, not over its text", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0, description: "Fix src/a.ts." },
      { id: "t-2", priority: 1, description: "Reopened: src/a.ts was wrong." },
    ]
    const [free, freeLines] = await twoFills(seeds, { "t-2": ["src/b.ts"] })
    expect(freeLines).toContain("  t-2 footprint: src/b.ts (from its branch)")
    expect(freeLines.some((line) => line.includes("skipping t-2"))).toBe(false)
    expect(free).toEqual(["t-1", "t-2"])

    const [held, heldLines] = await twoFills(seeds, { "t-2": ["src/a.ts"] })
    expect(held).toEqual(["t-1"])
    expect(heldLines).toContain("  skipping t-2: touches src/a.ts, like running t-1")
  })

  test("runs two tickets adding to a changelog merged by union side by side", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0, description: "Add an entry to CHANGELOG.md for src/a.ts." },
      { id: "t-2", priority: 1, description: "Add an entry to CHANGELOG.md for src/b.ts." },
    ]
    const [started, lines] = await twoFills(seeds, {})
    expect(started).toEqual(["t-1", "t-2"])
    expect(lines.some((line) => line.includes("skipping t-2"))).toBe(false)
    expect(lines).toContain("  t-1 footprint: src/a.ts")
  })
})

describe("a path's brackets and its +", () => {
  const routes = repoFiles([
    "src/routes/[slug]/+page.svelte",
    "src/routes/[slug]/+layout.ts",
    "pages/[id].tsx",
    "pages/i.tsx",
    "app/[[...slug]]/page.tsx",
    "b.go",
    "README.md",
  ])

  test("are kept in what a ticket's text names, whether the files are known or not", () => {
    for (const repo of [routes, repoFiles(undefined)]) {
      expect(
        footprint(
          { description: "Fix src/routes/[slug]/+page.svelte and app/[[...slug]]/page.tsx." },
          repo,
        ).files,
      ).toEqual(["app/[[...slug]]/page.tsx", "src/routes/[slug]/+page.svelte"])
      expect(footprint({ description: "Fix pages/[id].tsx" }, repo).files).toEqual([
        "pages/[id].tsx",
      ])
    }
    expect(footprint({ description: "Tidy +layout.ts" }, routes).files).toEqual([
      "src/routes/[slug]/+layout.ts",
    ])
  })

  test("a + joining words, a Markdown link and an index expression read as before", () => {
    expect(footprint({ description: "Compute a+b.go in C++ for 1.26+." }, routes).files).toEqual([
      "b.go",
    ])
    expect(footprint({ description: "See [README.md](/README.md)." }, routes).files).toEqual([
      "README.md",
    ])
    const index = footprint({ description: "Read Footprint.files[0] in +b.go" }, routes)
    expect(index.funcs).toEqual(["Footprint.files"])
    expect(index.files).toEqual(["b.go"])
  })

  test("a name with brackets in the files metadata means that file, as well as the glob", () => {
    expect(footprint({ metadata: { files: ["pages/[id].tsx"] } }, routes).files).toEqual([
      "pages/[id].tsx",
      "pages/i.tsx",
    ])
    // A route the ticket adds.
    expect(footprint({ metadata: { files: ["pages/[slug].tsx"] } }, routes).files).toEqual([
      "pages/[slug].tsx",
    ])
    expect(
      shared(
        footprint({ metadata: { files: ["pages/[slug].tsx"] } }, routes),
        footprint({ description: "Add pages/[slug].tsx." }, routes),
      ),
    ).toBe("pages/[slug].tsx")
  })

  test("any route path named in a ticket's text means that file", () => {
    const part = fc.stringMatching(/^[a-z][a-z0-9_-]{0,6}$/)
    const segment = fc.oneof(
      part,
      part.map((p) => `[${p}]`),
      part.map((p) => `[[...${p}]]`),
    )
    fc.assert(
      fc.property(
        part,
        fc.array(segment, { maxLength: 4 }),
        fc.boolean(),
        part,
        (first, dirs, plus, name) => {
          // A word starting with a bracket is a Markdown link's text, not a path.
          const path = `${[first, ...dirs].join("/")}/${plus ? "+" : ""}${name}.ts`
          expect(
            footprint({ description: `Fix ${path} now.` }, repoFiles(undefined)).files,
          ).toEqual([path])
        },
      ),
    )
  })
})

describe("tutti plan", () => {
  test("footprints a ticket with commits on its branch from them, and leaves out union files", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-plan-branch-")))
    const seeds: ReadonlyArray<Seed> = [
      { id: "a", priority: 1, description: "Fix src/a.ts and add to CHANGELOG.md." },
      { id: "b", priority: 2, description: "Reopened: src/a.ts was wrong. Add to CHANGELOG.md." },
      { id: "c", priority: 3, description: "Fix src/b.ts." },
    ]
    const printed: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
      error: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repo = yield* Repository
        yield* git.addWorktree(repo.dir, `${dir}-b`, { branch: "tutti/b", base: "main" })
        yield* repo.commit(`${dir}-b`, "work", { "src/b.ts": "b2", "CHANGELOG.md": "entry" })
        yield* plan(dir, false).pipe(Effect.provideService(Console.Console, console))
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            beadsLayer(seeds),
            memoryGit({
              dir,
              files: {
                ".gitattributes": "CHANGELOG.md merge=union\n",
                "CHANGELOG.md": "",
                "src/a.ts": "a",
                "src/b.ts": "b",
              },
            }),
            lockLayer(),
          ),
        ),
        Effect.provide(BunServices.layer),
      ),
    )
    expect(printed).toContain("  c (P3) waits for b (P2): both touch src/b.ts")
    expect(printed.join("\n")).not.toContain("CHANGELOG.md")
    expect(printed.join("\n")).not.toContain("b (P2) waits for a")
  })
})
