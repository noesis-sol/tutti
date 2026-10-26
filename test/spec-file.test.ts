// The spec's file (§ 4.14), with real git: readSpec, a startup check, refuses a spec that isn't
// there, is empty, isn't text, is a folder, is in .git or where git ignores it, and one from another
// folder with the name of a copy committed already; commitSpec commits a spec in the repository
// where it is and one outside it as a copy in .tutti/specs/, recording its source, alone, or with
// the files a spec run's setup wrote, and leaves one committed already as it is.
import { describe, expect } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { commitSpec, readSpec, type Spec, sourceOf, tildePath } from "../src/run/spec.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

const layer = Git.layer().pipe(
  Layer.provideMerge(GitWriter.layer),
  Layer.provideMerge(BunServices.layer),
)

const read = (repo: Repo, given: string, cwd = repo.dir) =>
  Effect.runPromise(readSpec(given, "--spec", cwd, repo.dir).pipe(Effect.provide(layer)))

const spec = async (repo: Repo, given: string, cwd = repo.dir): Promise<Spec> => {
  const result = await read(repo, given, cwd)
  if (Result.isFailure(result)) throw new Error(result.failure)
  return result.success
}

const problem = async (repo: Repo, given: string, cwd = repo.dir): Promise<string> => {
  const result = await read(repo, given, cwd)
  if (Result.isSuccess(result)) throw new Error(`expected a problem with ${given}`)
  return result.failure
}

const commit = (repo: Repo, s: Spec, setup: ReadonlyArray<string> = []) =>
  Effect.runPromise(commitSpec(s, repo.dir, setup).pipe(Effect.provide(layer)))

/** A folder outside the repository, with `files` in it. */
const outside = (files: Readonly<Record<string, string>>): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-specs-")))
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
  return dir
}

describe("sourceOf and tildePath", () => {
  slow.test("read a copy's source from its commit, and write a path under home with ~", () => {
    expect(sourceOf("tutti: add spec shop.md\n\nsha256 ab\n\nSpec-Source: ~/specs/shop.md\n")).toBe(
      "~/specs/shop.md",
    )
    expect(sourceOf("add the spec by hand")).toBeUndefined()
    expect(tildePath("/home/me/specs/shop.md", "/home/me")).toBe("~/specs/shop.md")
    expect(tildePath("/srv/specs/shop.md", "/home/me")).toBe("/srv/specs/shop.md")
  })
})

describe("readSpec", () => {
  slow.test("a spec in the repository is committed where it is", async () => {
    const repo = makeRepo()
    repo.write({ "docs/shop.md": "# Shop\n" })
    const s = await spec(repo, "docs/shop.md")
    expect(s).toMatchObject({ path: "docs/shop.md", copy: false, text: "# Shop\n" })
    expect(s.sha256).toBe(new Bun.CryptoHasher("sha256").update("# Shop\n").digest("hex"))
    // A path from the folder tutti was started in.
    expect((await spec(repo, "shop.md", join(repo.dir, "docs"))).path).toBe("docs/shop.md")
  })

  slow.test("one outside it, as a copy in .tutti/specs/ named after its file", async () => {
    const repo = makeRepo()
    const dir = outside({ "shop.md": "# Shop\n" })
    expect(await spec(repo, join(dir, "shop.md"))).toMatchObject({
      path: ".tutti/specs/shop.md",
      copy: true,
      source: join(dir, "shop.md"),
    })
  })

  slow.test("refuses a spec that isn't there, is empty, isn't text or is a folder", async () => {
    const repo = makeRepo()
    repo.write({ "empty.md": " \n\n", "binary.md": "a\0b", "bad.md": "" })
    writeFileSync(join(repo.dir, "bad.md"), Buffer.from([0xc3, 0x28]))
    mkdirSync(join(repo.dir, "specs"))
    expect(await problem(repo, "missing.md")).toBe("Spec not found: missing.md (--spec).")
    expect(await problem(repo, "empty.md")).toBe(
      "The spec empty.md (--spec) is empty: write what to build in it first.",
    )
    for (const file of ["binary.md", "bad.md"]) {
      expect(await problem(repo, file)).toBe(
        `The spec ${file} (--spec) isn't text: give a Markdown or plain-text file, in UTF-8.`,
      )
    }
    expect(await problem(repo, "specs")).toBe(
      "The spec specs (--spec) is a folder: give a Markdown or plain-text file.",
    )
  })

  slow.test("refuses a spec in .git, or where git ignores it", async () => {
    const repo = makeRepo()
    repo.commit("ignore drafts", { ".gitignore": "drafts/\n" })
    repo.write({ "drafts/shop.md": "# Shop\n" })
    writeFileSync(join(repo.dir, ".git", "shop.md"), "# Shop\n")
    expect(await problem(repo, ".git/shop.md")).toBe(
      "The spec .git/shop.md (--spec) is in the repository's .git folder, which git doesn't commit: move it.",
    )
    expect(await problem(repo, "drafts/shop.md")).toBe(
      "git ignores drafts/shop.md, where the spec (--spec) is kept, and workers only see committed files: move the spec, or stop ignoring that path (git check-ignore -v drafts/shop.md says where).",
    )
  })

  slow.test(
    "refuses a spec with the name of another's copy, and takes the same one back",
    async () => {
      const repo = makeRepo()
      const first = outside({ "shop.md": "# Shop\n" })
      await commit(repo, await spec(repo, join(first, "shop.md")))
      // The same file again: its copy, its own.
      expect((await spec(repo, join(first, "shop.md"))).path).toBe(".tutti/specs/shop.md")
      const other = outside({ "shop.md": "# Another shop\n" })
      expect(await problem(repo, join(other, "shop.md"))).toStartWith(
        `The spec ${join(other, "shop.md")} (--spec) has the name of another: .tutti/specs/shop.md holds the copy of another spec, ${tildePath(join(first, "shop.md"))}, and would take its tickets.`,
      )
    },
  )
})

describe("commitSpec", () => {
  slow.test(
    "commits a spec alone, then its change, and leaves one committed as it is",
    async () => {
      const repo = makeRepo()
      repo.write({ "docs/shop.md": "# Shop\n", "notes.txt": "mine\n" })
      const added = await commit(repo, await spec(repo, "docs/shop.md"))
      expect(added.committed).toBe(true)
      expect(added.commit).toBe(repo.head())
      expect(repo.git(["log", "-1", "--format=%B"])).toStartWith(
        "tutti: add spec shop.md\n\nsha256 ",
      )
      expect(repo.git(["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("docs/shop.md")
      // Untouched: not the spec's.
      expect(repo.git(["status", "--porcelain"]).trim()).toBe("?? notes.txt")

      const again = await commit(repo, await spec(repo, "docs/shop.md"))
      expect(again).toEqual({ commit: added.commit, committed: false })

      repo.write({ "docs/shop.md": "# Shop\n\n## Listing\n" })
      const updated = await commit(repo, await spec(repo, "docs/shop.md"))
      expect(updated.committed).toBe(true)
      expect(repo.git(["log", "-1", "--format=%s"]).trim()).toBe("tutti: update spec shop.md")
    },
  )

  slow.test("commits a copy with its source, and the setup with the spec", async () => {
    const repo = makeRepo()
    const dir = outside({ "shop.md": "# Shop\n" })
    repo.write({ ".tutti/settings.json": "{}\n", "scripts/check-fast.sh": "exit 0\n" })
    const s = await spec(repo, join(dir, "shop.md"))
    await commit(repo, s, [".tutti/settings.json", "scripts/check-fast.sh"])
    expect(readFileSync(join(repo.dir, ".tutti/specs/shop.md"), "utf8")).toBe("# Shop\n")
    const message = repo.git(["log", "-1", "--format=%B"])
    expect(message).toStartWith("tutti: set up for spec shop.md\n\nsha256 ")
    expect(sourceOf(message)).toBe(tildePath(join(dir, "shop.md")))
    expect(
      repo.git(["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort(),
    ).toEqual([".tutti/settings.json", ".tutti/specs/shop.md", "scripts/check-fast.sh"])
  })
})
