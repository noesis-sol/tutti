// A glob in the files metadata holds the files other tickets add where it matches, as orchestra
// 0.8.0's does (tutti-kkb.40): one that matches files is kept anchored at each folder it matched in,
// one that matches none is kept as it is, from the repository's root, and a name with a [ is that
// file or folder as well as the glob. The run's scheduler and tutti plan read them alike.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { type Link, planLinks } from "../src/plan/plan.ts"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import {
  emptyFootprint,
  type FootprintTicket,
  showFootprint,
  ticketFootprint,
  withChanges,
} from "../src/run/footprint.ts"
import { globHolds, globsMeet } from "../src/run/glob.ts"
import { shared } from "../src/run/overlap.ts"
import { type RepoFiles, repoFiles } from "../src/run/repoFiles.ts"
import { type Footprints, make } from "../src/run/schedule.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

const nested = [
  "README.md",
  "docs/running.md",
  "internal/dispatch/loop.go",
  "internal/dispatch/loop_test.go",
  "internal/dispatch/run.go",
  "internal/tui/run.go",
  "internal/tui/view/view.go",
]
const dispatchGo = [
  "internal/dispatch/loop.go",
  "internal/dispatch/loop_test.go",
  "internal/dispatch/run.go",
]

/** A ticket whose files metadata lists these. */
const listing = (...files: ReadonlyArray<string>): FootprintTicket => ({
  title: "",
  description: "",
  design: "",
  acceptance: "",
  labels: [],
  metadata: { files },
  files,
  predictedFiles: [],
})

const listed = (repo: RepoFiles, ...files: ReadonlyArray<string>) =>
  ticketFootprint(listing(...files), repo)

describe("a glob that matches files", () => {
  const repo = repoFiles(nested)

  test("means them, and is kept anchored at each folder it matched in", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, ReadonlyArray<string>]> = [
      ["internal/dispatch/*.go", dispatchGo, ["internal/dispatch/*.go"]],
      ["./internal//dispatch/*.go", dispatchGo, ["internal/dispatch/*.go"]],
      ["dispatch/*.go", dispatchGo, ["internal/dispatch/*.go"]],
      ["*.md", ["README.md", "docs/running.md"], ["*.md", "docs/*.md"]],
      ["**/view.go", ["internal/tui/view/view.go"], ["**/view.go"]],
      ["internal/**/view.go", ["internal/tui/view/view.go"], ["internal/**/view.go"]],
      [
        "internal/*/",
        [...dispatchGo, "internal/tui/run.go", "internal/tui/view/view.go"],
        ["internal/*"],
      ],
    ]
    for (const [entry, files, globs] of cases) {
      const fp = listed(repo, entry)
      expect([entry, fp.files, fp.globs]).toEqual([entry, files, globs])
    }
    expect(showFootprint(listed(repo, "internal/dispatch/*.go"))).toBe(
      `${dispatchGo.join(", ")}, internal/dispatch/*.go`,
    )
  })

  test("holds the new files another ticket adds there that it would match", () => {
    for (const entry of ["internal/dispatch/*.go", "dispatch/*.go"]) {
      const glob = listed(repo, entry)
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["internal/dispatch/cart.go", "internal/dispatch/cart.go"],
        ["internal/dispatch/loop.go", "internal/dispatch/loop.go"],
        ["internal/dispatch/", "internal/dispatch/loop.go"],
        // A glob matching none yet, which can match a file this one does.
        ["internal/dispatch/c*.go", "internal/dispatch/c*.go"],
        ["internal/dispatch/cart.ts", ""],
        ["internal/dispatch/*.ts", ""],
        ["internal/dispatch/web/a.go", ""],
        ["internal/tui/cart.go", ""],
        ["internal/cart.go", ""],
        ["cmd/dispatch/cart.go", ""],
      ]
      for (const [other, want] of cases) {
        const fp = listed(repo, other)
        expect([entry, other, shared(glob, fp)]).toEqual([entry, other, want])
        expect([other, entry, shared(fp, glob)]).toEqual([other, entry, want])
      }
      // A running ticket naming nothing whose worktree adds a file the glob would match, and the
      // reverse: a ticket naming nothing beside a running one listing the glob.
      const adding = withChanges(emptyFootprint, ["internal/dispatch/cart.go"], repo)
      expect(shared(glob, adding)).toBe("internal/dispatch/cart.go")
      expect(shared(emptyFootprint, withChanges(glob, ["internal/dispatch/cart.go"], repo))).toBe(
        "",
      )
    }
  })

  test("is anchored at every folder it matched in and at none other", () => {
    const tracked = repoFiles([
      "cmd/dispatch/main.go",
      "internal/dispatch/loop.go",
      "internal/tui/run.go",
    ])
    const glob = listed(tracked, "dispatch/*.go")
    expect(glob.globs).toEqual(["cmd/dispatch/*.go", "internal/dispatch/*.go"])
    for (const [other, want] of [
      ["cmd/dispatch/flags.go", "cmd/dispatch/flags.go"],
      ["internal/dispatch/cart.go", "internal/dispatch/cart.go"],
      ["web/dispatch/cart.go", ""],
      ["internal/tui/cart.go", ""],
    ] as const) {
      expect([other, shared(listed(tracked, other), glob)]).toEqual([other, want])
    }

    // A folder's name with brackets (a SvelteKit route) is a part of the anchored glob as it is.
    const routes = repoFiles([
      "src/routes/[slug]/+page.svelte",
      "src/routes/other/+page.svelte",
      "src/app.ts",
    ])
    const svelte = listed(routes, "*.svelte")
    expect(svelte.globs).toEqual(["src/routes/[slug]/*.svelte", "src/routes/other/*.svelte"])
    for (const [other, want] of [
      ["src/routes/[slug]/+layout.svelte", "src/routes/[slug]/+layout.svelte"],
      ["src/routes/other/+layout.svelte", "src/routes/other/+layout.svelte"],
      ["src/routes/new/+page.svelte", ""],
      ["src/routes/[slug]/+page.ts", ""],
    ] as const) {
      expect([other, shared(listed(routes, other), svelte)]).toEqual([other, want])
    }
  })

  test("keeps comparing its files by function", () => {
    const tracked = repoFiles(["README.md", "pkg/x.ts"])
    const mentions = (file: string, fn: string) =>
      file === "pkg/x.ts" && ["Foo", "Bar"].includes(fn)
    const naming = (fn: string, ...files: ReadonlyArray<string>) =>
      ticketFootprint({ ...listing(...files), description: `Change ${fn}().` }, tracked)
    const cases: ReadonlyArray<readonly [string, string, ReadonlyArray<string>, string]> = [
      ["both list the glob", "Bar", ["pkg/*.ts"], ""],
      ["one lists the file", "Bar", ["pkg/x.ts"], ""],
      ["one lists the folder", "Bar", ["pkg/"], ""],
      ["one adds a file", "Bar", ["pkg/y.ts"], "pkg/y.ts"],
      ["one adds a file of another kind", "Bar", ["pkg/y.go"], ""],
      ["the same function", "Foo", ["pkg/*.ts"], "Foo"],
      ["a function the file doesn't mention", "Baz", ["pkg/*.ts"], "pkg/x.ts"],
    ]
    const glob = naming("Foo", "pkg/*.ts")
    for (const [name, fn, files, want] of cases) {
      const other = naming(fn, ...files)
      expect([name, shared(glob, other, mentions)]).toEqual([name, want])
      expect([name, shared(other, glob, mentions)]).toEqual([name, want])
    }
  })
})

describe("a glob that matches no file yet", () => {
  test("is kept as it is, and holds the files and folders it would match from the root", () => {
    for (const repo of [
      repoFiles(["README.md", "internal/dispatch/loop.go"]),
      repoFiles([]),
      repoFiles(undefined),
    ]) {
      for (const entry of [
        "web/src/*.ts",
        "./web/src/*.ts",
        "web//src/*.ts",
        "web/lib/../src/*.ts",
      ]) {
        const fp = listed(repo, entry)
        expect([entry, fp.files, fp.globs]).toEqual([entry, [], ["web/src/*.ts"]])
      }
      const glob = listed(repo, "web/src/*.ts")
      expect(showFootprint(glob)).toBe("web/src/*.ts")
      for (const [other, want] of [
        ["web/src/cart.ts", "web/src/cart.ts"],
        ["web/src/", "web/src/"],
        ["web/", "web/"],
        ["web/src/*.ts", "web/src/*.ts"],
        ["web/lib/a.ts", ""],
        ["web/src/cart.go", ""],
        ["web/src/ui/button.ts", ""],
        ["web/src/ui/", ""],
        ["web/srcx/a.ts", ""],
        ["app/web/src/a.ts", ""],
        ["internal/dispatch/", ""],
        ["web/src/*.go", ""],
        ["web/src/*.tsx", ""],
        ["web/lib/*.ts", ""],
        ["src/*.ts", ""],
      ] as const) {
        const fp = listed(repo, other)
        expect([other, shared(glob, fp)]).toEqual([other, want])
        expect([other, shared(fp, glob)]).toEqual([other, want])
      }

      // Two globs that can match one file overlap, whichever way round, on the first's glob.
      for (const other of [
        "web/**/*.ts",
        "web/src/c*.ts",
        "web/*/cart.ts",
        "**/src/*.ts",
        "web/src/*",
        "web/src/[a-c]*.ts",
      ]) {
        const fp = listed(repo, other)
        expect([other, shared(glob, fp)]).toEqual([other, "web/src/*.ts"])
        expect([other, fp.globs]).toEqual([other, [other]])
        expect([other, shared(fp, glob)]).toEqual([other, other])
      }

      // A worktree adding a file the glob matches, beside it and the other way round.
      const adding = withChanges(emptyFootprint, ["web/src/cart.ts"], repo)
      expect(shared(glob, adding)).toBe("web/src/cart.ts")
      expect(shared(emptyFootprint, withChanges(glob, ["web/src/cart.ts"], repo))).toBe("")
    }
  })

  test("in a folder that exists holds a file another ticket adds there", () => {
    const repo = repoFiles(["internal/dispatch/loop.go"])
    const glob = listed(repo, "internal/dispatch/*.rs")
    expect(glob.globs).toEqual(["internal/dispatch/*.rs"])
    expect(shared(listed(repo, "internal/dispatch/cart.rs"), glob)).toBe(
      "internal/dispatch/cart.rs",
    )
  })
})

describe("a name with a [", () => {
  const repo = repoFiles(["pages/index.tsx", "src/routes/+layout.svelte"])

  test("is that file as well as the glob", () => {
    const route = listed(repo, "pages/[id].tsx")
    expect(route.files).toEqual(["pages/[id].tsx"])
    expect(route.globs).toEqual(["pages/[id].tsx"])
    expect(showFootprint(route)).toBe("pages/[id].tsx")
    for (const [other, want] of [
      ["pages/[id].tsx", "pages/[id].tsx"],
      ["pages/d.tsx", "pages/d.tsx"],
      ["pages/[slug].tsx", ""],
      ["pages/index.tsx", ""],
    ] as const) {
      const fp = listed(repo, other)
      expect([other, shared(route, fp)]).toEqual([other, want])
      expect([other, shared(fp, route)]).toEqual([other, want])
    }
    const named = ticketFootprint({ ...listing(), description: "Fix pages/[id].tsx" }, repo)
    expect(shared(named, route)).toBe("pages/[id].tsx")
  })

  test("is that folder as well as the glob", () => {
    const route = listed(repo, "src/routes/[slug]/")
    expect(route.files).toEqual(["src/routes/[slug]/"])
    expect(route.globs).toEqual(["src/routes/[slug]"])
    expect(showFootprint(route)).toBe("src/routes/[slug]/")
    for (const [other, want] of [
      ["src/routes/[slug]/+page.svelte", "src/routes/[slug]/+page.svelte"],
      ["src/routes/s/+page.svelte", "src/routes/s/+page.svelte"],
      ["src/routes/other/+page.svelte", ""],
      ["src/routes/+layout.svelte", ""],
    ] as const) {
      const fp = listed(repo, other)
      expect([other, shared(route, fp)]).toEqual([other, want])
      expect([other, shared(fp, route)]).toEqual([other, want])
    }
  })
})

describe("globs read from any text", () => {
  const name = fc.stringMatching(/^[a-z][a-z0-9_-]{0,5}$/)
  const part = fc.oneof(
    name,
    fc.constantFrom("*", "**", "?", "[a-c]", "[slug]", "*.ts", "c*.go", "\\*", "[", "["),
    fc.string({ maxLength: 6 }),
  )
  const glob = fc.array(part, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"))

  test("meet the same whichever way round, and hold a path written as they are", () => {
    fc.assert(
      fc.property(glob, glob, (g, h) => {
        expect(globsMeet(g, h)).toBe(globsMeet(h, g))
        expect(globsMeet(g, g)).toBe(true)
        expect(typeof globHolds(g, h)).toBe("boolean")
      }),
    )
    fc.assert(
      fc.property(fc.array(name, { minLength: 1, maxLength: 4 }), (parts) => {
        const p = parts.join("/")
        expect(globHolds(p, p)).toBe(true)
        expect(globHolds(p, `${p}/`)).toBe(true)
      }),
    )
  })

  test("hold any new file beside those they matched", () => {
    fc.assert(
      fc.property(
        fc.array(name, { minLength: 1, maxLength: 3 }),
        name,
        name,
        fc.constantFrom("ts", "go", "md"),
        (dirs, there, added, ext) => {
          const dir = dirs.join("/")
          const repo = repoFiles([`${dir}/${there}.${ext}`])
          const fp = listed(repo, `${dirs.at(-1)}/*.${ext}`)
          expect(fp.files).toEqual([`${dir}/${there}.${ext}`])
          expect(fp.globs.some((g) => globHolds(g, `${dir}/${added}.${ext}`))).toBe(true)
          expect(fp.globs.some((g) => globHolds(g, `${dir}/${added}.${ext}x`))).toBe(false)
        },
      ),
    )
  })
})

/** An open issue whose files metadata lists these. */
const issue = (id: TicketId, priority: number, ...files: ReadonlyArray<string>): Issue => ({
  id,
  title: id,
  description: "",
  design: "",
  acceptance: "",
  notes: "",
  status: "open",
  priority,
  type: "task",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: { files },
  files,
  predictedFiles: [],
  createdAt: "2026-10-01T00:00:00Z",
  closeReason: "",
})

const shown = (links: ReadonlyArray<Link>) => links.map((l) => `${l.blocker}>${l.blocked}:${l.why}`)

describe("tutti plan", () => {
  test("links a glob to a new file it would match, however large the files there are", () => {
    const open = [
      issue("a" as TicketId, 1, "internal/dispatch/*.go"),
      issue("b" as TicketId, 2, "internal/dispatch/cart.go"),
      issue("c" as TicketId, 3, "internal/dispatch/cart.ts"),
    ]
    for (const lines of [50, 500]) {
      const source = (file: string) => (nested.includes(file) ? "\n".repeat(lines) : undefined)
      expect(shown(planLinks(open, [], repoFiles(nested), source))).toEqual([
        "a>b:internal/dispatch/cart.go",
      ])
    }
  })

  test("links two tickets listing globs in a new folder that can match one file", () => {
    const open = [
      issue("a" as TicketId, 1, "web/src/*.ts"),
      issue("b" as TicketId, 2, "web/**/*.ts"),
      issue("c" as TicketId, 3, "app/*.go"),
    ]
    expect(shown(planLinks(open, [], repoFiles(nested), () => undefined))).toEqual([
      "a>b:web/src/*.ts",
    ])
  })
})

describe("the scheduler", () => {
  /** Runs a fill of a 2-slot scheduler: the tickets started, and the log. */
  const fill = (seeds: ReadonlyArray<Seed>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const started = yield* Ref.make<ReadonlyArray<string>>([])
        const footprints: Footprints = {
          repo: Effect.succeed(repoFiles(nested)),
          changed: () => Effect.succeed([]),
          branch: () => Effect.succeed([]),
          mentions: () => Effect.succeed(() => false),
        }
        const schedule = yield* make({
          concurrent: 2,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          footprints,
          start: {
            start: (issue: Issue) =>
              Effect.andThen(
                Ref.update(started, (all) => [...all, issue.id]),
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

  test("keeps a ticket adding a file a running ticket's glob would match from running beside it", async () => {
    const [started, lines] = await fill([
      { id: "A", priority: 1, metadata: { files: ["internal/dispatch/*.go"] } },
      { id: "B", priority: 2, metadata: { files: ["internal/dispatch/cart.go"] } },
      { id: "C", priority: 3, metadata: { files: ["internal/dispatch/cart.ts"] } },
    ])
    expect(started).toEqual(["A", "C"])
    expect(lines).toContain(`  A footprint: ${dispatchGo.join(", ")}, internal/dispatch/*.go`)
    expect(lines).toContain("  skipping B: touches internal/dispatch/cart.go, like running A")
  })

  test("keeps two tickets listing globs in a new folder that can match one file apart", async () => {
    const [started, lines] = await fill([
      { id: "A", priority: 1, metadata: { files: ["web/src/*.ts"] } },
      { id: "B", priority: 2, metadata: { files: ["web/src/cart.ts"] } },
      { id: "C", priority: 3, metadata: { files: ["web/**/*.ts"] } },
      { id: "D", priority: 4, metadata: { files: ["pages/[id].tsx"] } },
    ])
    expect(started).toEqual(["A", "D"])
    expect(lines).toContain("  skipping B: touches web/src/cart.ts, like running A")
    expect(lines).toContain("  skipping C: touches web/**/*.ts, like running A")
  })
})
