// What footprints cost a fill is bounded (tutti-crj): a glob with many **s matches each file in time
// linear in its parts and the pattern's, never freezing the dashboard, and the files' contents are
// read only for the footprints compared with one naming a function, each file once a fill.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { emptyFootprint, type Footprint } from "../src/run/footprint.ts"
import { globMatch } from "../src/run/glob.ts"
import { askedFiles, readMentions, type Sources } from "../src/run/overlap.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Footprints, make } from "../src/run/schedule.ts"
import type { Issue } from "../src/services/Beads.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

const fp = (fields: Partial<Footprint>): Footprint => ({ ...emptyFootprint, ...fields })

/** 200 files, each 13 folders deep. */
const deep = Array.from(
  { length: 200 },
  (_, i) => `${Array.from({ length: 13 }, (_, d) => `d${d}${i % 3}`).join("/")}/f${i}.ts`,
)

/** globMatch as it was, trying every split of the parts at each **: the reference it must agree with. */
const naive = (pattern: ReadonlyArray<string>, parts: ReadonlyArray<string>): boolean => {
  const [first, ...rest] = pattern
  if (first === undefined) return parts.length === 0
  if (first === "**") {
    for (let i = 0; i <= parts.length; i++) if (naive(rest, parts.slice(i))) return true
    return false
  }
  const [name, ...others] = parts
  return name !== undefined && globMatch([first], [name]) && naive(rest, others)
}

describe("a glob with many **s", () => {
  test("matches a deep tree's files at once", () => {
    const started = performance.now()
    const many = Array.from({ length: 9 }, () => "**")
    for (const f of deep) {
      expect(globMatch([...many, "*.ts"], f.split("/"))).toBe(true)
      expect(globMatch([...many, "x", ...many, "*.go"], f.split("/"))).toBe(false)
    }
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("lists a deep tree's files at once, kept as one **", () => {
    const repo = repoFiles(deep)
    const started = performance.now()
    const all = repo.listed("**/**/**/**/**/*")
    const none = repo.listed("**/**/**/**/**/**/**/*.go")
    expect(performance.now() - started).toBeLessThan(1000)
    expect(all.files).toEqual([...deep].sort())
    expect(none).toEqual({ files: [], globs: ["**/*.go"] })
    expect(repoFiles(["src/a.ts"]).listed("lib/**/**/x/**/**/**/*.go").globs).toEqual([
      "lib/**/x/**/*.go",
    ])
  })

  test("matches the paths it matched trying every split", () => {
    const part = fc.constantFrom("**", "*", "a", "b", "?", "a*")
    const name = fc.constantFrom("a", "b", "ab", "ba")
    fc.assert(
      fc.property(fc.array(part, { maxLength: 6 }), fc.array(name, { maxLength: 6 }), (p, n) => {
        expect(globMatch(p, n)).toBe(naive(p, n))
      }),
    )
  })
})

describe("the files compared", () => {
  test("are none for footprints naming no function", () => {
    const a = fp({ files: ["src/a.ts"], changed: ["src/b.ts"] })
    expect([...askedFiles([[a, fp({ files: ["src/c.ts"] })]])]).toEqual([])
  })

  test("are both footprints' files, but folders, when one names a function", () => {
    const a = fp({ files: ["src/a.ts", "src/ui/"], changed: ["src/b.ts"] })
    const b = fp({ files: ["src/c.ts"], funcs: ["merge"] })
    expect([...askedFiles([[a, b]])].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
  })

  test("are none when the footprints share an area or a function, which comparing them answers first", () => {
    const a = fp({ files: ["src/a.ts"], funcs: ["merge"], areas: ["ui"] })
    expect([...askedFiles([[a, fp({ files: ["src/b.ts"], areas: ["ui"] })]])]).toEqual([])
    expect([...askedFiles([[a, fp({ files: ["src/b.ts"], funcs: ["Loop.merge"] })]])]).toEqual([])
  })
})

describe("reading the files compared", () => {
  test("reads only those asked about, each once for the sources kept", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-bounded-")))
    mkdirSync(join(repo, "src"))
    writeFileSync(join(repo, "src/loop.ts"), "class Loop { merge() {} }")
    writeFileSync(join(repo, "src/other.ts"), "class Loop { merge() {} }")
    const sources: Sources = new Map()
    const read = (pairs: ReadonlyArray<readonly [Footprint, Footprint]>) =>
      Effect.runPromise(readMentions(repo, pairs, sources).pipe(Effect.provide(BunServices.layer)))
    const plain = fp({ files: ["src/other.ts"] })
    await read([[plain, fp({ files: ["src/x.ts"] })]])
    expect([...sources.keys()]).toEqual([])
    const named = fp({ funcs: ["Loop.merge"] })
    const first = await read([[fp({ files: ["src/loop.ts"] }), named]])
    expect([...sources.keys()]).toEqual(["src/loop.ts"])
    expect(first("src/loop.ts", "Loop.merge")).toBe(true)
    // Read once: gone from the disk, the fill still has what it read.
    rmSync(join(repo, "src/loop.ts"))
    const again = await read([[fp({ files: ["src/loop.ts"] }), named]])
    expect(again("src/loop.ts", "Loop.merge")).toBe(true)
    expect(again("src/other.ts", "Loop.merge")).toBe(false)
  })
})

describe("the scheduler", () => {
  test("keeps the contents it reads for one fill, comparing each ready ticket with the running", async () => {
    const asks = await Effect.runPromise(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const asked: Array<{ pairs: number; sources: Sources }> = []
        const footprints: Footprints = {
          repo: Effect.succeed(repoFiles(["src/a.ts", "src/b.ts", "src/c.ts"])),
          changed: () => Effect.succeed([]),
          branch: () => Effect.succeed([]),
          mentions: (pairs, sources) =>
            Effect.sync(() => {
              asked.push({ pairs: pairs.length, sources })
              return () => false
            }),
        }
        const started = yield* Ref.make<ReadonlyArray<string>>([])
        const schedule = yield* make({
          concurrent: 3,
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
        yield* schedule.fill
        yield* schedule.fill
        expect(yield* Ref.get(started)).toEqual(["A", "B", "C"])
        return asked
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            beadsLayer([
              { id: "A", priority: 1, metadata: { files: ["src/a.ts"] } },
              { id: "B", priority: 2, metadata: { files: ["src/b.ts"] } },
              { id: "C", priority: 3, metadata: { files: ["src/c.ts"] } },
            ]),
            ledgerLayer(),
            runFibersLayer,
          ).pipe(Layer.provideMerge(TestClock.layer())),
        ),
      ),
    )
    // The first fill starts A, then compares B and C with it, then C with A and B.
    expect(asks.map((a) => a.pairs)).toEqual([2, 2])
    expect(asks[0]?.sources).toBe(asks[1]?.sources as Sources)
  })
})
