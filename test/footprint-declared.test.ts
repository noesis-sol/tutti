// A function counts toward overlap only when the repository declares it (tutti-ejkt.3): footprints
// pick up library and everyday names (Effect.fn, JSON.stringify), which held tickets apart that
// share no file. Such a name stays in the footprint's line, but holds nothing apart.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import fc from "fast-check"
import { declaredIn, readDeclared } from "../src/run/declared.ts"
import { type FootprintTicket, showFootprint, ticketFootprint } from "../src/run/footprint.ts"
import { overlapHold } from "../src/run/holds.ts"
import { mentionsIn, overlaps, shared } from "../src/run/overlap.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { footprintsOf } from "../src/run/schedule.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"

const ticket = (fields: Partial<FootprintTicket>): FootprintTicket => ({
  title: "",
  description: "",
  design: "",
  acceptance: "",
  labels: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  ...fields,
})

// The repository's sources, as tutti's are written.
const sources: Record<string, string> = {
  "src/run/loop.ts": [
    'import { Effect, type Data } from "effect"',
    "export interface Loop {",
    "  readonly merge: (id: string) => Effect.Effect<void>",
    "}",
    "export const refreshBranch = (repo: string): string => JSON.stringify(repo)",
    "class Git {",
    "  rebase(branch: string): void {",
    "    Object.is(branch, branch)",
    "  }",
    "}",
  ].join("\n"),
  "src/run/other.ts": "export function waitSettled() {\n  return Effect.fn('x')\n}\n",
  "docs/guide.md": "function stringify is not code\n",
}

// What readDeclared reads: the source files, not the document.
const declared = new Set(
  Object.entries(sources).flatMap(([path, text]) => (path.endsWith(".ts") ? declaredIn(text) : [])),
)
const repo = repoFiles(Object.keys(sources), [], [], [], declared)

describe("the names a source declares", () => {
  test("are its functions, types, constants, methods and fields", () => {
    const ts = [
      "export function merge() {}",
      "async function* walk() {}",
      "export const Loop = {}",
      "let count = 0",
      "export default class Git {}",
      "export interface RepoFiles {",
      "  readonly files: ReadonlyArray<string>",
      "  resolve(name: string, explicit: boolean): ReadonlyArray<string>",
      "  listed?: boolean",
      "}",
      "type Footprint = {}",
      "export type Mentions<T> = T",
      "enum Phase {}",
      "class Run {",
      "  private async rebase(branch: string): Promise<void> {",
      "  static of(x) {",
      "}",
    ].join("\n")
    expect([...declaredIn(ts)].sort()).toEqual(
      [
        "merge",
        "walk",
        "Loop",
        "count",
        "Git",
        "RepoFiles",
        "files",
        "resolve",
        "listed",
        "Footprint",
        "Mentions",
        "Phase",
        "Run",
        "rebase",
        "of",
      ].sort(),
    )
  })

  test("are read in Go, Python, Rust and shell too", () => {
    const go = "func Merge(a int) {}\nfunc (r *Repo) Rebase() error {\ntype Repo struct {}\n"
    expect([...declaredIn(go)].sort()).toEqual(["Merge", "Rebase", "Repo"])
    const py = "MAX_SIZE = 10\nclass Loop:\n    async def merge(self):\n    def self_test():\n"
    expect([...declaredIn(py)].sort()).toEqual(["Loop", "MAX_SIZE", "merge", "self_test"])
    const rs = "pub fn run() {}\npub(crate) struct Ledger {}\npub const fn size() {}\n"
    expect([...declaredIn(rs)].sort()).toEqual(["Ledger", "run", "size"])
    expect([...declaredIn("check() {\n  echo\n}\nfunction lint {\n")].sort()).toEqual([
      "check",
      "lint",
    ])
  })

  test("are not a call, an import or a comment", () => {
    const text = [
      "import {",
      "  type Effect,",
      "  type Data as D,",
      "} from 'effect'",
      "  doSomething(x)",
      "  JSON.stringify(x)",
      "// a function is often named",
      "  if (x) {",
      "x == y",
    ].join("\n")
    expect(declaredIn(text)).toEqual([])
  })

  test("are read at once from a long line that looks like a call", () => {
    const started = performance.now()
    declaredIn(`define(${"a?f(b):g(c),".repeat(40_000)}`)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("are names written in the text, whatever it holds", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const words = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])
        for (const name of declaredIn(text)) expect(words.has(name)).toBe(true)
      }),
    )
  })
})

describe("whether the repository declares a function", () => {
  test("a name when a source declares it, Type.method when both are declared", () => {
    expect(repo.declares("refreshBranch")).toBe(true)
    expect(repo.declares("Loop.merge")).toBe(true)
    expect(repo.declares("Git.rebase")).toBe(true)
    expect(repo.declares("Effect.fn")).toBe(false)
    expect(repo.declares("JSON.stringify")).toBe(false)
    expect(repo.declares("Object.is")).toBe(false)
    expect(repo.declares("Data.TaggedEnum")).toBe(false)
    // A document's words declare nothing.
    expect(repo.declares("stringify")).toBe(false)
  })

  test("every function, the declarations unknown", () => {
    expect(repoFiles(Object.keys(sources)).declares("JSON.stringify")).toBe(true)
    expect(repoFiles(undefined).declares("Effect.fn")).toBe(true)
  })
})

describe("two footprints", () => {
  const a = ticketFootprint(
    ticket({ description: "Wrap it in `Effect.fn()`. Fix src/a.ts." }),
    repo,
  )
  const b = ticketFootprint(
    ticket({ description: "Use `Effect.fn()` and `JSON.stringify()`." }),
    repo,
  )

  test("sharing only a library function don't overlap", () => {
    expect(a.funcs).toEqual([])
    expect(a.undeclared).toEqual(["Effect.fn"])
    expect(overlaps(a, b)).toBe(false)
    const json = ticketFootprint(ticket({ description: "Call JSON.stringify() there." }), repo)
    expect(overlaps(json, b)).toBe(false)
  })

  test("keep the function in the footprint's line", () => {
    expect(showFootprint(b)).toBe("Effect.fn, JSON.stringify")
    expect(showFootprint(a)).toBe("Effect.fn, src/a.ts")
  })

  test("sharing a function the repository declares still overlap", () => {
    const one = ticketFootprint(ticket({ description: "Change `refreshBranch()`." }), repo)
    const two = ticketFootprint(ticket({ description: "Call refreshBranch() twice." }), repo)
    expect(shared(one, two)).toBe("refreshBranch")
  })

  test("sharing a method declared here still overlap", () => {
    const one = ticketFootprint(ticket({ description: "Change Loop.merge()." }), repo)
    const two = ticketFootprint(ticket({ description: "Retry in `merge()`." }), repo)
    expect(shared(one, two)).toBe("Loop.merge")
    const rebase = ticketFootprint(ticket({ description: "Make Git.rebase() quiet." }), repo)
    expect(shared(rebase, ticketFootprint(ticket({ description: "See `rebase()`." }), repo))).toBe(
      "Git.rebase",
    )
  })

  test("don't meet over a file that mentions a library function", () => {
    const mentions = mentionsIn(new Map(Object.entries(sources)))
    const named = ticketFootprint(ticket({ description: "Use JSON.stringify() there." }), repo)
    const file = ticketFootprint(ticket({ description: "Tidy src/run/loop.ts." }), repo)
    expect(overlaps(named, file, mentions)).toBe(false)
    const declaredOne = ticketFootprint(ticket({ description: "Change refreshBranch()." }), repo)
    expect(shared(declaredOne, file, mentions)).toBe("src/run/loop.ts")
  })
})

/** A checkout on disk with these files, as the repository's tracked ones. */
const checkout = (files: Record<string, string>): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-declared-")))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const readIn = (dir: string, files: ReadonlyArray<string>) =>
  Effect.runPromise(readDeclared(dir, files).pipe(Effect.provide(BunServices.layer)))

describe("readDeclared", () => {
  test("reads the source files' declarations, not a document's", async () => {
    const dir = checkout(sources)
    const names = await readIn(dir, Object.keys(sources))
    expect(names?.has("refreshBranch")).toBe(true)
    expect(names?.has("waitSettled")).toBe(true)
    expect(names?.has("stringify")).toBe(false)
  })

  test("never reads a file that resolves outside the checkout", async () => {
    const outside = checkout({ "lib.ts": "export const secret = 1\n" })
    const dir = checkout({ "src/a.ts": "export const own = 1\n" })
    symlinkSync(join(outside, "lib.ts"), join(dir, "src/lib.ts"))
    const names = await readIn(dir, ["src/a.ts", "src/lib.ts"])
    expect(names?.has("own")).toBe(true)
    expect(names?.has("secret")).toBe(false)
  })

  test("knows nothing when no source could be read, and none are declared without sources", async () => {
    expect(await readIn(join(tmpdir(), "tutti-declared-none"), ["src/a.ts"])).toBeUndefined()
    expect([...((await readIn(checkout({}), ["README.md"])) ?? ["unknown"])]).toEqual([])
  })
})

describe("the scheduler's footprints", () => {
  test("hold no ticket back for a function the checkout doesn't declare", async () => {
    const dir = checkout(sources)
    const [held, kept] = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Repository
        const source = yield* footprintsOf({
          repo: git.dir,
          base: "main",
          checkCommands: [],
          worktree: (id) => Effect.succeed(`/repo-tutti/${id}`),
        })
        const files = yield* source.repo
        const running = new Map([
          [
            "t-1" as TicketId,
            ticketFootprint(
              ticket({ description: "Use JSON.stringify() in refreshBranch()." }),
              files,
            ),
          ],
        ])
        const library = ticketFootprint(ticket({ description: "Call JSON.stringify()." }), files)
        const own = ticketFootprint(ticket({ description: "Rename refreshBranch()." }), files)
        return [overlapHold(own, running), overlapHold(library, running)] as const
      }).pipe(
        Effect.provide(Layer.mergeAll(memoryGit({ dir, files: sources }), BunServices.layer)),
      ),
    )
    expect(held?.text).toBe("after t-1: both touch refreshBranch")
    expect(kept).toBeUndefined()
  })
})
