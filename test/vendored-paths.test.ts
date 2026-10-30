// Vendored paths (§ 5 item 5, § 8.4): a subtree of another project's files, marked linguist-vendored
// in .gitattributes or matched by the settings' `vendored` globs, is no part of the project's own
// files. The predictor doesn't list them, a footprint drops those a ticket names or the predictor
// answers, and the START block names the globs.
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { noServersNote } from "../src/agent/mcp.ts"
import { OrganHold, Organs } from "../src/organs/Organs.ts"
import { readSettings } from "../src/project/settings.ts"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { type FootprintTicket, ticketFootprint } from "../src/run/footprint.ts"
import { make as makePredictor } from "../src/run/predict.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { footprintsOf } from "../src/run/schedule.ts"
import { type Started, startBlock } from "../src/run/startup.ts"
import {
  noneVendored,
  readVendored,
  readVendoredNote,
  type Vendored,
  vendoredNote,
  vendoredPatterns,
} from "../src/run/vendored.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git, GitWriter, parseVendored } from "../src/services/Git.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { slow } from "./gates.ts"

const vendoredFile = "repos/pi/packages/coding-agent/src/cli/setup.ts"

/** The repository's files: the project's own, and a subtree of Pi's under repos/. */
const tracked = [
  "README.md",
  "src/cli/setup.ts",
  "src/a.ts",
  "src/b.ts",
  vendoredFile,
  "repos/pi/README.md",
  "repos/effect/src/Effect.ts",
]

const attributes = "repos/** linguist-vendored\n"

/** A ticket with this description and files metadata. */
const ticket = (
  description: string,
  files: ReadonlyArray<string> = [],
  predictedFiles: ReadonlyArray<string> = [],
): FootprintTicket => ({
  title: "",
  description,
  design: "",
  acceptance: "",
  labels: [],
  metadata: {},
  files,
  predictedFiles,
})

/** The vendored paths .gitattributes gives, as the test layer's git check-attr reads them. */
const fromAttributes = (gitattributes: string, globs: ReadonlyArray<string> = []) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* Repository
      return yield* readVendored(repository.dir, tracked, globs)
    }).pipe(
      Effect.provide(
        memoryGit({
          files: {
            ".gitattributes": gitattributes,
            ...Object.fromEntries(tracked.map((f) => [f, `// ${f}\n`])),
          },
        }),
      ),
    ),
  )

const fromSettings: Vendored = { ...noneVendored, globs: ["repos/**"] }

/** Each way a project marks repos/ vendored, by name. */
const sources = async (): Promise<ReadonlyArray<readonly [string, Vendored]>> => [
  [".gitattributes", await fromAttributes(attributes)],
  ["the settings", fromSettings],
]

describe("a vendored path", () => {
  test("is what git check-attr says is linguist-vendored, set or true", async () => {
    const marked = await fromAttributes(
      "repos/** linguist-vendored\nrepos/effect/** -linguist-vendored\n/README.md linguist-vendored=false\n",
    )
    expect([...marked.files].sort()).toEqual(["repos/pi/README.md", vendoredFile])
    const truly = await fromAttributes("repos/pi/** linguist-vendored=true\n")
    expect([...truly.files].sort()).toEqual(["repos/pi/README.md", vendoredFile])
    expect(
      parseVendored(
        "a.ts\0linguist-vendored\0set\0b.ts\0linguist-vendored\0unspecified\0c d.ts\0linguist-vendored\0true\0e.ts\0linguist-vendored\0unset\0",
      ),
    ).toEqual(["a.ts", "c d.ts"])
  })

  test("is what the settings' globs match, besides the attribute", async () => {
    const both = await fromAttributes("repos/pi/** linguist-vendored\n", ["repos/effect/**"])
    expect([...both.files].sort()).toEqual([
      "repos/effect/src/Effect.ts",
      "repos/pi/README.md",
      vendoredFile,
    ])
  })

  test("is a file, a folder, or a path git doesn't track under a folder all vendored", async () => {
    for (const [source, vendored] of await sources()) {
      const repo = repoFiles(tracked, [], [], [], undefined, vendored)
      const said = [
        vendoredFile,
        "repos/pi/",
        "repos/",
        "repos/pi/new.ts",
        "repos/other/new.ts",
        "repos/**/*.ts",
        "src/a.ts",
        "src/",
        "src/new.ts",
        "new.ts",
      ].map((p) => [p, repo.vendored(p)])
      expect([source, ...said]).toEqual([
        source,
        [vendoredFile, true],
        ["repos/pi/", true],
        ["repos/", true],
        ["repos/pi/new.ts", true],
        ["repos/other/new.ts", true],
        ["repos/**/*.ts", true],
        ["src/a.ts", false],
        ["src/", false],
        ["src/new.ts", false],
        ["new.ts", false],
      ])
    }
  })

  test("in a folder with files of the project's own is not, unless itself marked", () => {
    const files = [...tracked, "lib/vendor.js", "lib/own.ts"]
    const repo = repoFiles(files, [], [], [], undefined, {
      ...noneVendored,
      files: new Set(["lib/vendor.js"]),
    })
    expect([
      repo.vendored("lib/vendor.js"),
      repo.vendored("lib/own.ts"),
      repo.vendored("lib/"),
      repo.vendored("lib/new.ts"),
    ]).toEqual([true, false, false, false])
  })
})

describe("a footprint", () => {
  test("drops the vendored paths a ticket names, in its text and its files metadata", async () => {
    for (const [source, vendored] of await sources()) {
      const repo = repoFiles(tracked, [], [], [], undefined, vendored)
      const named = ticketFootprint(
        ticket(`Fix ${vendoredFile} and src/a.ts, as setup.ts does.`),
        repo,
      )
      expect([source, named.files]).toEqual([source, ["src/a.ts", "src/cli/setup.ts"]])
      const listed = ticketFootprint(
        ticket("", ["repos/pi/", "repos/**/*.ts", "repos/pi/new.ts", "src/b.ts"]),
        repo,
      )
      expect([source, listed.files, listed.globs]).toEqual([source, ["src/b.ts"], []])
    }
  })

  test("drops the vendored files the predictor answered", async () => {
    for (const [source, vendored] of await sources()) {
      const repo = repoFiles(tracked, [], [], [], undefined, vendored)
      const fp = ticketFootprint(ticket("", [], [vendoredFile, "src/b.ts"]), repo)
      expect([source, fp.files, fp.predicted]).toEqual([source, ["src/b.ts"], true])
      const only = ticketFootprint(ticket("", [], [vendoredFile]), repo)
      expect([source, only.files, only.predicted]).toEqual([source, [], false])
    }
  })

  test("without either source, keeps them as before", () => {
    const repo = repoFiles(tracked)
    expect(ticketFootprint(ticket(`Fix ${vendoredFile}.`), repo).files).toEqual([vendoredFile])
    expect(ticketFootprint(ticket("", ["repos/pi/"]), repo).files).toEqual([
      "repos/pi/",
      "repos/pi/README.md",
      vendoredFile,
    ])
    expect(ticketFootprint(ticket("", [], [vendoredFile]), repo).files).toEqual([vendoredFile])
  })

  test("whatever a ticket says, never holds a vendored path", () => {
    const repo = repoFiles(tracked, [], [], [], undefined, fromSettings)
    const word = fc.constantFrom(
      ...tracked,
      "setup.ts",
      "repos/pi/",
      "repos/",
      "cli/setup.ts",
      "Effect.ts",
      "fix",
      "and",
    )
    fc.assert(
      fc.property(fc.array(word), fc.array(word, { maxLength: 4 }), (words, files) => {
        const fp = ticketFootprint(ticket(words.join(" "), files), repo)
        return [...fp.files, ...fp.globs].every((f) => !f.startsWith("repos/"))
      }),
    )
  })

  test("is read from the checkout with its .gitattributes and the settings' globs", async () => {
    const [files, globbed] = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository
        const read = (vendored: ReadonlyArray<string>) =>
          Effect.flatMap(
            footprintsOf({
              repo: repo.dir,
              base: "main",
              checkCommands: [],
              vendored,
              worktree: (id) => Effect.succeed(`/repo-tutti/${id}`),
            }),
            (source) => source.repo,
          )
        return [yield* read([]), yield* read(["src/b.ts"])] as const
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            memoryGit({
              files: {
                ".gitattributes": attributes,
                ...Object.fromEntries(tracked.map((f) => [f, `// ${f}\n`])),
              },
            }),
            BunServices.layer,
          ),
        ),
      ),
    )
    expect(ticketFootprint(ticket(`Fix ${vendoredFile} and src/b.ts.`), files).files).toEqual([
      "src/b.ts",
    ])
    expect(ticketFootprint(ticket(`Fix ${vendoredFile} and src/b.ts.`), globbed).files).toEqual([])
  })
})

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 200; i++) yield* Effect.yieldNow
})

/** The predictor's calls for one ticket naming nothing, over the repository with `files`. */
const predictorCalls = async (
  files: Readonly<Record<string, string>>,
  vendored: ReadonlyArray<string>,
  answer: ReadonlyArray<string>,
) => {
  const calls: Array<OrganCallRecord> = []
  const seeds: ReadonlyArray<Seed> = [{ id: "t-1", title: "Make the greeting friendlier" }]
  const organs = Organs.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        cannedLayer({ predictor: { files: answer } }, calls),
        TestAppConfig.layer(TestAppConfig.appConfig({})),
        Layer.succeed(OrganHold, { held: Effect.succeed(false) }),
      ),
    ),
  )
  const base = Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer)
  const layers = Layer.mergeAll(organs, memoryGit({ files })).pipe(
    Layer.provideMerge(base),
    Layer.provideMerge(TestClock.layer()),
  )
  const predicted = await Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* Repository
      const predictor = yield* makePredictor({ repo: repo.dir, vendored })
      const issue = yield* Effect.flatMap(Backlog, (backlog) => backlog.get("t-1"))
      yield* predictor.queue(issue === undefined ? [] : [issue], repoFiles(tracked), () =>
        Effect.succeed([]),
      )
      yield* flush
      return yield* predictor.predicted
    }).pipe(Effect.scoped, Effect.provide(layers)),
  )
  return { calls, predicted: predicted.get("t-1" as TicketId) }
}

describe("the predictor", () => {
  const files = Object.fromEntries(tracked.map((f) => [f, `// ${f}\n`]))

  test("lists no vendored file, nor keeps one it answers", async () => {
    for (const [source, given, globs] of [
      [".gitattributes", { ...files, ".gitattributes": attributes }, []],
      ["the settings", files, ["repos/**"]],
    ] as const) {
      const { calls, predicted } = await predictorCalls(given, globs, [vendoredFile, "src/a.ts"])
      expect([source, calls.length]).toEqual([source, 1])
      const input = calls[0]?.input ?? ""
      expect([source, input.includes("repos/"), input.includes("src/cli/setup.ts")]).toEqual([
        source,
        false,
        true,
      ])
      expect([source, predicted]).toEqual([source, ["src/a.ts"]])
    }
  })

  test("without either source, lists them as before", async () => {
    const { calls } = await predictorCalls(files, [], ["src/a.ts"])
    expect(calls[0]?.input).toContain(vendoredFile)
  })
})

/** A settings file with `settings` in a fresh folder: the folder. */
const settingsDir = (settings: object): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-vendored-")))
  execFileSync("mkdir", ["-p", join(dir, ".tutti")])
  writeFileSync(join(dir, ".tutti", "settings.json"), JSON.stringify(settings))
  return dir
}

const started = (vendored: string | null): Started => ({
  config: TestAppConfig.appConfig({}, "/work/project"),
  base: "main",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  account: TestAccount.accountProbe(),
  organs: { _tag: "AgentSdk" },
  vendored,
  warnings: [],
})

describe("the START block", () => {
  test("names the vendored globs and where they come from", () => {
    expect(vendoredPatterns("# subtrees\nrepos/** linguist-vendored\n")).toEqual(["repos/**"])
    expect(
      vendoredPatterns(
        "a/** linguist-vendored=true\nb/** -linguist-vendored\nc/** linguist-vendored linguist-vendored=false\nCHANGELOG.md merge=union\n",
      ),
    ).toEqual(["a/**"])
    expect(vendoredNote(["repos/**"], [])).toBe("vendored: repos/** (from .gitattributes)")
    expect(vendoredNote([], ["third_party/**"])).toBe(
      "vendored: third_party/** (from .tutti/settings.json)",
    )
    expect(vendoredNote(["repos/**"], ["a/**", "b/**"])).toBe(
      "vendored: repos/** (from .gitattributes), a/**, b/** (from .tutti/settings.json)",
    )
    expect(vendoredNote([], [])).toBeNull()
    const lines: ReadonlyArray<string> = startBlock(
      started("vendored: repos/** (from .gitattributes)"),
      "0.1.0",
    )
    expect(lines).toContain("  vendored: repos/** (from .gitattributes)")
    expect(startBlock(started(null), "0.1.0").some((l) => l.includes("vendored"))).toBe(false)
  })

  test("reads the project's .gitattributes and the settings' vendored", async () => {
    const dir = settingsDir({ vendored: ["third_party/**"] })
    writeFileSync(join(dir, ".gitattributes"), attributes)
    const settings = await Effect.runPromise(
      readSettings(dir).pipe(Effect.provide(BunServices.layer)),
    )
    expect(settings.vendored).toEqual(["third_party/**"])
    const [both, none] = await Effect.runPromise(
      Effect.all([
        readVendoredNote(dir, settings.vendored),
        readVendoredNote(settingsDir({}), []),
      ]).pipe(Effect.provide(BunServices.layer)),
    )
    expect(both).toBe(
      "vendored: repos/** (from .gitattributes), third_party/** (from .tutti/settings.json)",
    )
    expect(none).toBeNull()
  })
})

describe("git's linguist-vendored", () => {
  slow.test("is what git check-attr says", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-vendored-git-")))
    execFileSync("git", ["init", "-q", dir])
    writeFileSync(
      join(dir, ".gitattributes"),
      "repos/** linguist-vendored\nrepos/own/** -linguist-vendored\n",
    )
    const said = await Effect.runPromise(
      Effect.flatMap(Git, (git) =>
        git.vendoredFiles(dir, [vendoredFile, "repos/own/a.ts", "src/a b.ts", "repos/x y.ts"]),
      ).pipe(
        Effect.provide(
          Git.layer().pipe(
            Layer.provideMerge(GitWriter.layer),
            Layer.provideMerge(BunServices.layer),
          ),
        ),
      ),
    )
    expect(said).toEqual([vendoredFile, "repos/x y.ts"])
  })
})
