// `tutti requires` in a ticket's worktree (§ 8.1): it reads the list and writes the README of the
// checkout it is started in, the worktree's own, and leaves the main checkout as it was.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { checkoutOf } from "../src/cli/commands.ts"
import { withRequires } from "../src/project/requires.ts"
import type { Requirement } from "../src/project/settings.ts"
import { Git } from "../src/services/Git.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Each test starts tutti as a bun process, which bun's 5 s default fails when other checks run
// beside this one.
setDefaultTimeout(30_000)

const main = join(import.meta.dir, "..", "src", "main.ts")

/** `bun src/main.ts requires …args` started in `cwd`: its exit code and output. */
const tuttiRequires = async (cwd: string, args: ReadonlyArray<string>) => {
  const proc = Bun.spawn(["bun", main, "requires", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, error }
}

const old: Requirement = { name: "old", check: "true", install: "false" }
const added: Requirement = { name: "added", check: "test -f marker", install: "touch marker" }

const settings = (requires: ReadonlyArray<Requirement>) =>
  `${JSON.stringify({ requires }, null, 2)}\n`

describe("the checkout tutti requires works in", () => {
  test("is a worktree's own folder, not the main checkout's", () => {
    const found = Effect.runSync(
      Effect.gen(function* () {
        const repository = yield* Repository
        const git = yield* Git
        yield* git.addWorktree(repository.dir, "/memory-top/wt", { branch: "wt/a", base: "HEAD" })
        return [
          yield* git.topLevel("/memory-top/wt/src"),
          yield* git.topLevel(`${repository.dir}/src`),
        ]
      }).pipe(Effect.provide(memoryLayer({ dir: "/memory-top/repo" }))),
    )
    expect(found).toEqual(["/memory-top/wt", "/memory-top/repo"])
  })

  slow.test("is found from a folder deep in a worktree", async () => {
    const repo = makeRepo()
    const worktree = repo.worktree("wt/deep")
    repo.write({ "src/a/b.txt": "b\n" }, worktree)
    const found = await Effect.runPromise(
      checkoutOf(join(worktree, "src", "a")).pipe(Effect.provide(BunServices.layer)),
    )
    expect(found).toBe(worktree)
  })

  slow.test("reads the worktree's list and writes its README; the main checkout's stay", async () => {
    const repo = makeRepo()
    const readme = withRequires("# demo\n", [old]) ?? ""
    repo.commit("Requires", {
      ".tutti/settings.json": settings([old]),
      ".gitignore": ".tutti/run/\n",
      "README.md": readme,
    })
    const worktree = repo.worktree("wt/added")
    repo.write({ ".tutti/settings.json": settings([old, added]) }, worktree)

    const written = await tuttiRequires(worktree, ["--readme"])
    expect(written.error).toBe("")
    expect(written.code).toBe(0)
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe(
      withRequires("# demo\n", [old, added]),
    )
    expect(readFileSync(join(repo.dir, "README.md"), "utf8")).toBe(readme)

    const checked = await tuttiRequires(worktree, [])
    expect(checked.code).toBe(0)
    expect(checked.out).toContain("added: ")
    expect(existsSync(join(worktree, "marker"))).toBe(true)
    expect(existsSync(join(repo.dir, "marker"))).toBe(false)

    expect(repo.git(["status", "--porcelain"])).toBe("")
  })
})
