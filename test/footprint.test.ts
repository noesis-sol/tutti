import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import fc from "fast-check"
import {
  emptyFootprint,
  type Footprint,
  type FootprintTicket,
  mentionsIn,
  overlaps,
  readMentions,
  repoFiles,
  repoPath,
  shared,
  showFootprint,
  ticketFootprint,
  withChanges,
  worktreeChanges,
} from "../src/run/footprint.ts"
import { metadataList } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"

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
    notes: "",
    labels: [],
    ...fields,
    metadata,
    files: metadataList(metadata, "files"),
    predictedFiles: metadataList(metadata, "predicted_files"),
  }
}

const trackedHere = [
  "README.md",
  "CHANGELOG.md",
  "src/run/loop.ts",
  "src/run/run.ts",
  "src/run/merge.ts",
  "src/agent/claude.ts",
  "src/ui/run.ts",
  ".tutti/settings.json",
]

const here = repoFiles(trackedHere)
const unknown = repoFiles(undefined)

const footprintOf = (fields: Parameters<typeof ticket>[0], repo = here) =>
  ticketFootprint(ticket(fields), repo)

const fp = (fields: Partial<Footprint>): Footprint => ({ ...emptyFootprint, ...fields })

describe("a ticket's text", () => {
  test("names files and functions, as orchestra's docs have it", () => {
    const named = footprintOf({
      title: "Hand a conflict back from Loop.merge",
      description:
        "When `Loop.merge` (src/run/loop.ts:1125) aborts, call `o.agentName(id)` and `deliverPrompt`, " +
        "then refreshBranch() and `os.WriteFile(p, b, 0o644)`. The hooks write .tutti/run/activity.json " +
        "(src/agent/claude.ts). See https://github.com/gastownhall/beads/blob/main/README.md, " +
        "e.g. `bun test ./...` and v0.2.0.",
      notes:
        "Moved to run/merge.ts; update settings.json and README.md. Add src/run/handback.ts. " +
        "Not /Users/me/Projects/x/y.ts, nor src/nowhere/z.ts, nor (`solo`, `RESOLVING`).",
      acceptance: "Tests in a new file(s).",
    })
    expect(named.files).toEqual([
      ".tutti/settings.json",
      "README.md",
      "src/agent/claude.ts",
      "src/run/handback.ts",
      "src/run/loop.ts",
      "src/run/merge.ts",
    ])
    expect(named.funcs).toEqual(["Loop.merge", "agentName", "deliverPrompt", "refreshBranch"])
    expect(showFootprint(named)).toBe(
      "Loop.merge, agentName, deliverPrompt, refreshBranch, .tutti/settings.json, README.md, " +
        "src/agent/claude.ts, src/run/handback.ts, src/run/loop.ts, src/run/merge.ts",
    )
  })

  test("a bare name means every file of that name, and a partial path the files it ends", () => {
    expect(footprintOf({ description: "Picking lives in run.ts." }).files).toEqual([
      "src/run/run.ts",
      "src/ui/run.ts",
    ])
    expect(footprintOf({ description: "See run/run.ts." }).files).toEqual(["src/run/run.ts"])
    expect(footprintOf({ description: "Sort ./README.md" }).files).toEqual(["README.md"])
  })

  test("without the repository's files, a name with a folder or a source extension is kept", () => {
    const named = footprintOf(
      {
        description:
          "Fix src/nowhere/z.ts, settings.json, run/merge.ts and Loop.merge; the .tsx files",
      },
      unknown,
    )
    expect(named.files).toEqual(["run/merge.ts", "settings.json", "src/nowhere/z.ts"])
    expect(named.funcs).toEqual(["Loop.merge"])
  })

  test("a ticket naming nothing has an empty footprint", () => {
    const named = footprintOf({
      title: "Say hello",
      description: "Nothing in particular, e.g. hi.",
    })
    expect(named).toEqual(emptyFootprint)
    expect(showFootprint(named)).toBe("nothing named")
  })

  test("names no folder or glob", () => {
    expect(footprintOf({ description: "Look in src/run/ and *.md." })).toEqual(emptyFootprint)
  })

  test("leaves out keywords, builtins, standard packages and a test's methods", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      [
        "`synctest.Test(t, func(t *testing.T){…})` runs a test; use synctest.Wait() instead of " +
          "`eventually(…)`, and drop the 13 `orDefault(o.wait…)` calls. Run them with func().",
        ["eventually", "orDefault"],
      ],
      ["Wrap it in go func() and defer func(); `return f(x)`, `if (ok)`, `switch(v)`.", ["f"]],
      ["Grow it with append(), check len() and cap(), make() the map, new() the struct.", []],
      ["`string(out)`, `[]byte(s)`, `int64(n)`, `error(nil)`, `any(v)`.", []],
      ["`atomic.AddInt64(&n, 1)`, signal.Notify(), `maps.Keys(m)`, cmp.Or(), log.Printf().", []],
      ["Have `o.close()` and l.len() say so.", ["close", "len"]],
      ["Fix Queue.len() and `Pool.close()`.", ["Pool.close", "Queue.len"]],
      ["Wrap it in t.Run() and `t.Run(name, fn)`, with b.Loop() and `t.Helper()`.", []],
      ["Like `GitHub` does on `iOS` and `macOS`, `waitSettled`.", ["waitSettled"]],
      ["Log it with o.log.Raw() and `o.json.Decode(v)`, not log.Printf().", ["Decode", "Raw"]],
      ["Write to os.Stdout.Write() and `http.DefaultClient.Do(req)`.", []],
      ["Call h.Loop.merge().", ["Loop.merge"]],
      ["Call `w.Run(ctx)` and o.Fatal().", ["Fatal", "Run"]],
    ]
    for (const [description, funcs] of cases) {
      expect([description, footprintOf({ description }).funcs]).toEqual([description, funcs])
    }
  })

  test("drops paths outside the repository, whether its files are known or not", () => {
    for (const repo of [here, unknown]) {
      const named = footprintOf(
        { description: "Read ../x.ts and src/../../y.ts, then .//z.ts and /etc/passwd." },
        repo,
      )
      expect(named).toEqual(emptyFootprint)
    }
  })

  test("finds paths outside ASCII, in either Unicode form, and in text without spaces", () => {
    const nfcName = "docs/résumé.md"
    const nfdName = "docs/résumé.md"
    const tracked = [
      ...trackedHere,
      "docs/café.md",
      "docs/日本語.md",
      "docs/中文README.md",
      nfcName,
    ]
    const repo = repoFiles(tracked)
    const files = (description: string) => footprintOf({ description }, repo).files
    expect(files("Fix the typo in docs/café.md.")).toEqual(["docs/café.md"])
    expect(files("Shorten 日本語.md")).toEqual(["docs/日本語.md"])
    expect(files("Translate docs/中文README.md")).toEqual(["docs/中文README.md"])
    expect(files(`Rewrite ${nfdName}`)).toEqual([nfcName])
    expect(files("loop.tsを直す")).toEqual(["src/run/loop.ts"])
    expect(files("merge.tsとclaude.tsを直す")).toEqual(["src/agent/claude.ts", "src/run/merge.ts"])
    expect(footprintOf({ description: "Loop.mergeを直す" }, repo).funcs).toEqual(["Loop.merge"])
    // A new file is given in NFC, whichever form names it, so two tickets naming it meet.
    expect(files("Add docs/né.md")).toEqual(["docs/né.md"])
  })
})

describe("labels and metadata", () => {
  test("area labels and the files metadata, in each of its forms", () => {
    for (const files of [
      ["src/ui/run.ts", "docs/new.md"],
      "src/ui/run.ts, docs/new.md",
      '["src/ui/run.ts","docs/new.md"]',
    ]) {
      const named = footprintOf({
        labels: ["scheduling", "area:ui", "area:"],
        metadata: { files, team: "x" },
      })
      expect(named.files).toEqual(["docs/new.md", "src/ui/run.ts"])
      expect(named.areas).toEqual(["area:ui"])
    }
    expect(footprintOf({ metadata: { files: 3 } })).toEqual(emptyFootprint)
  })

  test("a folder or a glob in the files metadata means the files under it or matching it", () => {
    const repo = repoFiles([
      "run.ts",
      "README.md",
      "docs/running.md",
      "src/run/run.ts",
      "src/run/loop.ts",
      "src/run/loop.test.ts",
      "src/ui/run.ts",
      "src/ui/view/view.ts",
    ])
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["src/run/", ["src/run/", "src/run/loop.test.ts", "src/run/loop.ts", "src/run/run.ts"]],
      ["src/ui", ["src/ui/", "src/ui/run.ts", "src/ui/view/view.ts"]],
      ["run/", ["src/run/", "src/run/loop.test.ts", "src/run/loop.ts", "src/run/run.ts"]],
      ["*.md", ["README.md", "docs/running.md"]],
      ["src/run/*.test.ts", ["src/run/loop.test.ts"]],
      ["src/**/view.ts", ["src/ui/view/view.ts"]],
      ["src/[ru]?/*.ts", ["src/ui/run.ts"]],
      ["src/[!", []], // a malformed glob matches nothing
      ["*.swift", []],
      ["src/new/", ["src/new/"]], // a folder the ticket adds
      ["src/new.ts", ["src/new.ts"]], // a file the ticket adds
      ["run.ts", ["run.ts", "src/run/run.ts", "src/ui/run.ts"]],
    ]
    for (const [files, want] of cases) {
      expect([files, footprintOf({ metadata: { files: [files] } }, repo).files]).toEqual([
        files,
        want,
      ])
    }
  })

  test("entries that can't be paths in the repository are dropped", () => {
    for (const entry of [
      "",
      "./",
      ".",
      "./.",
      "a/..",
      "/etc/passwd",
      "../x.ts",
      "src/../../x.ts",
    ]) {
      for (const repo of [here, unknown]) {
        expect(footprintOf({ metadata: { files: [entry] } }, repo)).toEqual(emptyFootprint)
        expect(footprintOf({ metadata: { files: [entry, "src/ui/run.ts"] } }, repo).files).toEqual([
          "src/ui/run.ts",
        ])
      }
    }
  })

  test("the predicted files count only for a ticket naming nothing else", () => {
    const metadata = { predicted_files: "src/run/run.ts,src/nowhere/z.ts", files: [] }
    const predicted = footprintOf({ title: "Say hello", metadata })
    expect(predicted).toEqual(fp({ files: ["src/run/run.ts"], predicted: true }))
    expect(showFootprint(predicted)).toBe("src/run/run.ts (predicted)")
    expect(footprintOf({ description: "Change README.md.", metadata })).toEqual(
      fp({ files: ["README.md"] }),
    )
    expect(footprintOf({ labels: ["area:ui"], metadata })).toEqual(fp({ areas: ["area:ui"] }))
  })
})

describe("the check's own files and the ticket's spec", () => {
  const tracked = [...trackedHere, "scripts/check-fast.sh", ".orchestra/specs/tutti-spec.md"]

  test("are left out of the text's files and the predicted ones, but not the files metadata", () => {
    const text = {
      description: "Say hello in src/ui/run.ts, as .orchestra/specs/tutti-spec.md § 7 has it.",
      acceptance: "scripts/check-fast.sh passes.",
      metadata: { spec: ".orchestra/specs/tutti-spec.md" },
    }
    for (const check of [
      "scripts/check-fast.sh",
      "./scripts/check-fast.sh --quick",
      "bun install && sh scripts/check-fast.sh",
      "bash check-fast.sh",
    ]) {
      expect(footprintOf(text, repoFiles(tracked, [check])).files).toEqual(["src/ui/run.ts"])
    }
    // A check command that doesn't name the script leaves it in.
    expect(footprintOf(text, repoFiles(tracked, ["bun test"])).files).toContain(
      "scripts/check-fast.sh",
    )
    // Without the spec metadata, the spec counts like any file.
    expect(
      footprintOf({ description: text.description }, repoFiles(tracked, ["scripts/check-fast.sh"]))
        .files,
    ).toEqual([".orchestra/specs/tutti-spec.md", "src/ui/run.ts"])

    const repo = repoFiles(tracked, ["scripts/check-fast.sh", "scripts/check-full.sh"])
    const only = { title: "Say hello", acceptance: "`scripts/check-fast.sh` passes" }
    expect(footprintOf(only, repo)).toEqual(emptyFootprint)
    expect(
      footprintOf({ ...only, metadata: { files: "scripts/check-fast.sh" } }, repo).files,
    ).toEqual(["scripts/check-fast.sh"])
    expect(
      footprintOf(
        { ...only, metadata: { predicted_files: "scripts/check-fast.sh,README.md" } },
        repo,
      ),
    ).toEqual(fp({ files: ["README.md"], predicted: true }))
  })

  test("two tickets asking only for the check to pass don't overlap; two listing it do", () => {
    const repo = repoFiles(tracked, ["scripts/check-fast.sh"])
    const a = footprintOf({ description: "Say hello. scripts/check-fast.sh passes." }, repo)
    const b = footprintOf({ description: "Say bye. `scripts/check-fast.sh` passes." }, repo)
    expect(overlaps(a, b)).toBe(false)
    const listing = footprintOf({ metadata: { files: ["scripts/check-fast.sh"] } }, repo)
    expect(shared(listing, listing)).toBe("scripts/check-fast.sh")
  })
})

describe("overlaps", () => {
  // merge.ts and run.ts, for the functions they mention.
  const sources = mentionsIn(
    new Map([
      ["merge.ts", "class Loop { merge() { this.runCheck() } runCheck() {} }"],
      ["run.ts", "const pickNext = () => {}"],
      ["loop.ts", "class Loop { merge() { pickNext() } wait() {} }"],
    ]),
  )
  const merge = fp({ files: ["merge.ts"], funcs: ["Loop.merge"] })

  test("a shared area", () => {
    expect(shared(fp({ areas: ["area:ui"] }), fp({ areas: ["area:ui"] }))).toBe("area:ui")
    expect(overlaps(fp({ areas: ["area:ui"] }), fp({ areas: ["area:run"] }))).toBe(false)
  })

  test("a shared function, by name and by type when both give one", () => {
    expect(shared(fp({ funcs: ["merge"] }), merge, sources)).toBe("merge")
    expect(overlaps(fp({ funcs: ["Git.merge"] }), merge, sources)).toBe(false)
    expect(shared(fp({ funcs: ["Loop.merge"] }), fp({ funcs: ["Loop.merge"] }))).toBe("Loop.merge")
  })

  test("a shared file, unless both name functions it mentions and none is the same", () => {
    expect(shared(fp({ files: ["merge.ts"] }), merge, sources)).toBe("merge.ts")
    expect(overlaps(fp({ files: ["run.ts"] }), merge, sources)).toBe(false)
    expect(overlaps(fp({ files: ["merge.ts"], funcs: ["runCheck"] }), merge, sources)).toBe(false)
    // A function the file doesn't mention, named in passing, doesn't keep them apart.
    expect(shared(fp({ files: ["merge.ts"], funcs: ["Run"] }), merge, sources)).toBe("merge.ts")
  })

  test("a function against the file it is in", () => {
    expect(shared(fp({ funcs: ["Loop.merge"] }), fp({ files: ["loop.ts"] }), sources)).toBe(
      "loop.ts",
    )
    expect(shared(fp({ files: ["loop.ts"] }), fp({ funcs: ["wait"] }), sources)).toBe("loop.ts")
    expect(overlaps(fp({ funcs: ["Loop.merge"] }), fp({ files: ["run.ts"] }), sources)).toBe(false)
    // A file whose contents aren't known mentions nothing.
    expect(overlaps(fp({ funcs: ["merge"] }), fp({ files: ["new.ts"] }), sources)).toBe(false)
    expect(overlaps(fp({ funcs: ["Loop.merge"] }), fp({ files: ["loop.ts"] }))).toBe(false)
  })

  test("a folder: the files under it, those another ticket adds included", () => {
    const repo = repoFiles(["src/run/loop.ts", "src/run/run.ts", "src/ui/run.ts"])
    const folder = footprintOf({ metadata: { files: "src/run/" } }, repo)
    const file = footprintOf({ description: "Fix src/run/loop.ts." }, repo)
    const added = footprintOf({ metadata: { files: "src/run/cart.ts" } }, repo)
    const elsewhere = footprintOf({ description: "Fix src/ui/run.ts." }, repo)
    expect(shared(file, folder)).toBe("src/run/loop.ts")
    expect(shared(added, folder)).toBe("src/run/cart.ts")
    expect(overlaps(elsewhere, folder)).toBe(false)
    // Two tickets listing a folder neither names a file in: the folder itself.
    const web = footprintOf({ metadata: { files: "web/src/" } }, repo)
    expect(shared(web, web)).toBe("web/src/")
    expect(shared(footprintOf({ metadata: { files: "web/src/cart.ts" } }, repo), web)).toBe(
      "web/src/cart.ts",
    )
    expect(overlaps(footprintOf({ metadata: { files: "web/srcx/a.ts" } }, repo), web)).toBe(false)
  })

  test("a glob: the files it matches", () => {
    const repo = repoFiles(["src/run/loop.ts", "src/run/loop.test.ts", "test/x.test.ts"])
    const tests = footprintOf({ metadata: { files: "**/*.test.ts" } }, repo)
    expect(shared(footprintOf({ description: "Fix x.test.ts" }, repo), tests)).toBe(
      "test/x.test.ts",
    )
    expect(overlaps(footprintOf({ description: "Fix src/run/loop.ts" }, repo), tests)).toBe(false)
  })

  test("a file one ticket's worktree changed", () => {
    expect(
      shared(
        fp({ files: ["run.ts"], funcs: ["pickNext"] }),
        fp({ ...merge, changed: ["run.ts"] }),
        sources,
      ),
    ).toBe("run.ts")
    // A file both name, compared by function, stays so when the worktree changes it.
    expect(
      overlaps(
        fp({ files: ["merge.ts"], funcs: ["runCheck"] }),
        fp({ ...merge, changed: ["merge.ts"] }),
        sources,
      ),
    ).toBe(false)
    expect(overlaps(emptyFootprint, fp({ ...merge, changed: ["merge.ts"] }), sources)).toBe(false)
    // Two worktrees changing one file.
    expect(shared(fp({ changed: ["a.ts"] }), fp({ changed: ["a.ts"] }))).toBe("a.ts")
  })

  test("a footprint naming nothing overlaps nothing", () => {
    expect(overlaps(emptyFootprint, emptyFootprint)).toBe(false)
    expect(overlaps(emptyFootprint, merge, sources)).toBe(false)
  })
})

describe("worktree changes", () => {
  test("grow a running ticket's footprint with what it committed and what it hasn't", async () => {
    const program = Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      const worktree = "/repo-tutti/t-1"
      yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/t-1", base: "main" })
      yield* repository.commit(worktree, "work", { "src/run/loop.ts": "changed" })
      yield* repository.write(worktree, { "src/ui/new.ts": "new", "README.md": "edited" })
      // The base moving on changes nothing the worktree did.
      yield* repository.commit(repository.dir, "elsewhere", { "src/agent/claude.ts": "other" })
      return yield* worktreeChanges(worktree, "main")
    })
    const changed = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          memoryGit({
            files: Object.fromEntries(trackedHere.map((f) => [f, "x"])),
          }),
        ),
      ),
    )
    expect(changed).toEqual(["README.md", "src/run/loop.ts", "src/ui/new.ts"])

    const running = withChanges(footprintOf({ title: "Say hello" }), changed, here)
    expect(running.changed).toEqual(changed)
    expect(shared(footprintOf({ description: "Fix src/run/loop.ts" }), running)).toBe(
      "src/run/loop.ts",
    )
    expect(overlaps(footprintOf({ description: "Fix src/ui/run.ts" }), running)).toBe(false)
  })

  test("are compared in the form git lists the file in", () => {
    const tracked = repoFiles(["docs/résumé.md"])
    const running = withChanges(emptyFootprint, ["docs/résumé.md", "../out.ts"], tracked)
    expect(running.changed).toEqual(["docs/résumé.md"])
    expect(shared(footprintOf({ description: "Fix docs/résumé.md" }, tracked), running)).toBe(
      "docs/résumé.md",
    )
  })
})

describe("readMentions", () => {
  test("reads the files the footprints name, never one outside the repository", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "tutti-footprint-")))
    const repo = join(base, "repo")
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src/loop.ts"), "class Loop { merge() {} }")
    writeFileSync(join(base, "outside.ts"), "class Loop { merge() {} }")
    symlinkSync(join(base, "outside.ts"), join(repo, "src/link.ts"))
    const mentions = await Effect.runPromise(
      readMentions(repo, [
        fp({ files: ["src/loop.ts", "src/"], changed: ["src/link.ts", "gone.ts"] }),
      ]).pipe(Effect.provide(BunServices.layer)),
    )
    expect(mentions("src/loop.ts", "Loop.merge")).toBe(true)
    expect(mentions("src/loop.ts", "Loop.wait")).toBe(false)
    expect(mentions("src/link.ts", "Loop.merge")).toBe(false)
    expect(mentions("gone.ts", "merge")).toBe(false)
  })
})

describe("parsing arbitrary ticket text", () => {
  const word = fc.oneof(
    fc.string(),
    fc.constantFrom(
      "src/run/loop.ts",
      "run.ts",
      "Loop.merge",
      "`waitSettled`",
      "refreshBranch()",
      "o.agentName(id)",
      "../x.ts",
      "/etc/passwd",
      "*.md",
      "src/**/",
      "[a-",
      "\\",
      "résumé.md",
      "日本語.md",
      "area:ui",
      "`",
      "(",
      ".",
    ),
  )
  const text = fc.array(word, { maxLength: 12 }).map((words) => words.join(" "))
  const metadata = fc.oneof(
    fc.dictionary(fc.constantFrom("files", "predicted_files", "spec"), fc.jsonValue()),
    fc.record({ files: text, predicted_files: text, spec: text }),
    fc.record({ files: fc.array(text, { maxLength: 4 }) }),
  )

  test("never throws, and gives sorted repository paths and area labels", () => {
    fc.assert(
      fc.property(
        fc.record({
          title: text,
          description: text,
          design: text,
          acceptance: text,
          notes: text,
          labels: fc.array(text, { maxLength: 4 }),
          metadata,
        }),
        fc.option(fc.array(text, { maxLength: 8 }), { nil: undefined }),
        fc.array(text, { maxLength: 2 }),
        fc.array(text, { maxLength: 4 }),
        (fields, tracked, checks, changed) => {
          const repo = repoFiles(tracked, checks)
          const footprint = withChanges(ticketFootprint(ticket(fields), repo), changed, repo)
          for (const list of [
            footprint.files,
            footprint.funcs,
            footprint.areas,
            footprint.changed,
          ]) {
            expect([...new Set(list)].sort()).toEqual([...list])
          }
          for (const f of [...footprint.files, ...footprint.changed]) expect(repoPath(f)).toBe(true)
          for (const a of footprint.areas) expect(a.startsWith("area:") && a !== "area:").toBe(true)
          showFootprint(footprint)
          shared(footprint, footprint, mentionsIn(new Map([[fields.title, fields.description]])))
        },
      ),
      { numRuns: 300 },
    )
  })
})
