import { expect } from "bun:test"
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { Git, GitWriter, rebaseMergesFile, rebaseMergesScript } from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

// The replaying rebase writes its script to the worktree's git folder, which the worktree's worker
// can write too: a link planted at the script's name must not have tutti write the script over the
// link's target (tutti-34k9.12). The write goes through the symlink guard (§ 9.1), as the lock
// files' and state.json's do, below the folder `git rev-parse --absolute-git-dir` names (the
// `--git-path` of the name would resolve to the link's target): a symbolic link at the name is
// refused, naming it, and the rebase fails without beginning; a file hard-linked to the name is
// left as it was, the script renamed over the name, and the rebase runs.

const layer = Git.layer().pipe(
  Layer.provideMerge(GitWriter.layer),
  Layer.provideMerge(BunServices.layer),
)

const rebase = (worktree: string, onto: string) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(
        Effect.flatMap(Effect.service(Git), (git) => git.rebase(worktree, onto)),
        layer,
      ),
    ),
  )

/** A library to vendor, whose squashed commit shares no history with the app's main. */
const library = (): Repo => {
  const lib = makeRepo()
  lib.commit("Library", { "package.json": '{ "name": "lib" }\n' })
  return lib
}

/** A worktree on tutti/a with a `git subtree add --squash` merge, and a main that moved on. */
const subtreeBranch = () => {
  const lib = library()
  const repo = makeRepo()
  repo.commit("App", { "package.json": '{ "name": "app" }\n' })
  const worktree = repo.worktree("tutti/a")
  repo.git(
    ["subtree", "add", "--quiet", "--squash", "--prefix", "vendor/lib", lib.dir, "main"],
    worktree,
  )
  repo.commit("a: Use the library (a)", { "src/app.ts": "import 'lib'\n" }, worktree)
  const main = repo.commit("Main moves on", { "main.txt": "main\n" })
  const gitDir = repo.git(["rev-parse", "--absolute-git-dir"], worktree).trim()
  return { repo, worktree, main, scriptPath: join(gitDir, rebaseMergesFile) }
}

/** A file of the worker's user outside the repository, as a planted link would point to. */
const targetFile = () => {
  const path = join(mkdtempSync(join(tmpdir(), "tutti-link-target-")), "zshrc")
  writeFileSync(path, "export PATH=~/bin:$PATH\n")
  return path
}

slow.test(
  "a symbolic link planted at the script's name is refused: its target is untouched and the rebase doesn't begin",
  async () => {
    const { repo, worktree, main, scriptPath } = subtreeBranch()
    const before = repo.head("tutti/a")
    const target = targetFile()
    symlinkSync(target, scriptPath)

    const exit = await rebase(worktree, main)

    expect(readFileSync(target, "utf8")).toBe("export PATH=~/bin:$PATH\n")
    const failure = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ""
    expect(failure).toContain('"_tag":"GitFailed"')
    expect(failure).toContain(JSON.stringify(`tutti could not write ${scriptPath}: `).slice(1, -1))
    expect(failure).toContain(`${rebaseMergesFile} is a symbolic link`)
    // Nothing begun: the branch where it was, the worktree clean, no rebase to abort.
    expect(repo.head("tutti/a")).toBe(before)
    expect(repo.git(["status", "--porcelain"], worktree)).toBe("")
    expect(existsSync(repo.git(["rev-parse", "--git-path", "rebase-merge"], worktree).trim())).toBe(
      false,
    )
  },
)

slow.test(
  "a file hard-linked to the script's name is left as it was; the script replaces the name and the rebase runs",
  async () => {
    const { repo, worktree, main, scriptPath } = subtreeBranch()
    const target = targetFile()
    linkSync(target, scriptPath)

    const exit = await rebase(worktree, main)

    expect(exit).toEqual(Exit.succeed({ merges: true }))
    expect(readFileSync(target, "utf8")).toBe("export PATH=~/bin:$PATH\n")
    expect(readFileSync(scriptPath, "utf8")).toBe(rebaseMergesScript)
    expect(repo.git(["merge-base", "--is-ancestor", main, "tutti/a"])).toBe("")
    expect(repo.git(["show", "tutti/a:vendor/lib/package.json"])).toBe('{ "name": "lib" }\n')
  },
)
