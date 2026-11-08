// A spec in the repository whose name starts with `..` (`..spec.md`) is inside it, not outside:
// readSpec takes it where it is, as it does any other spec there, and copies only one that is
// outside (§ 4.14).
import { describe, expect } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { readSpec, type Spec } from "../src/run/spec.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

const layer = Git.layer().pipe(
  Layer.provideMerge(GitWriter.layer),
  Layer.provideMerge(BunServices.layer),
)

const spec = async (repo: Repo, given: string, cwd = repo.dir): Promise<Spec> => {
  const result = await Effect.runPromise(
    readSpec(given, "--spec", cwd, repo.dir).pipe(Effect.provide(layer)),
  )
  if (Result.isFailure(result)) throw new Error(result.failure)
  return result.success
}

describe("readSpec, a spec named ..<name>", () => {
  slow.test(
    "one in the repository is committed where it is, at its top or in a folder",
    async () => {
      const repo = makeRepo()
      repo.write({ "..spec.md": "# Shop\n", "docs/..shop.md": "# Shop\n" })
      expect(await spec(repo, "..spec.md")).toMatchObject({ path: "..spec.md", copy: false })
      expect(await spec(repo, "docs/..shop.md")).toMatchObject({
        path: "docs/..shop.md",
        copy: false,
      })
    },
  )

  slow.test("one outside it is still a copy, named after its file", async () => {
    const repo = makeRepo()
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-specs-")))
    writeFileSync(join(dir, "..spec.md"), "# Shop\n")
    expect(await spec(repo, join(dir, "..spec.md"))).toMatchObject({
      path: ".tutti/specs/..spec.md",
      copy: true,
    })
  })
})
