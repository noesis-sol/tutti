// A real git repository in a temp folder, for the tests whose subject is git (Appendix B): commits,
// branches and worktrees made with git itself. The repository's own config names the committer and
// turns off signing and the user's hooks, so neither the helper nor the code under test reads the
// user's global settings for those.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export interface Repo {
  /** The main checkout, with its path resolved (as git prints it, /private/var on macOS). */
  readonly dir: string
  /** Runs git in dir (the main checkout by default) and returns its stdout; throws when it fails. */
  git(args: ReadonlyArray<string>, dir?: string): string
  /** Writes the files (paths relative to dir), stages them and commits; returns the commit's hash. */
  commit(message: string, files?: Readonly<Record<string, string>>, dir?: string): string
  /** Writes the files, relative to dir, without staging them. */
  write(files: Readonly<Record<string, string>>, dir?: string): void
  /** A new branch at start (HEAD by default), not checked out. */
  branch(name: string, start?: string): void
  /** A new worktree at a fresh path beside the repository, on a new branch from base; its path. */
  worktree(branch: string, base?: string): string
  /** The full hash rev names in dir. */
  head(rev?: string, dir?: string): string
}

/** A fresh repository on branch `main`, with one commit holding README.md. */
export const makeRepo = (): Repo => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-git-")))
  const dir = join(root, "repo")
  mkdirSync(dir)
  let worktrees = 0

  const git = (args: ReadonlyArray<string>, cwd = dir): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr.toString()}`)
    }
    return result.stdout.toString()
  }

  const write = (files: Readonly<Record<string, string>>, cwd = dir): void => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true })
      writeFileSync(join(cwd, path), content)
    }
  }

  const head = (rev = "HEAD", cwd = dir): string =>
    git(["rev-parse", "--verify", "--end-of-options", rev], cwd).trim()

  const commit = (
    message: string,
    files: Readonly<Record<string, string>> = {},
    cwd = dir,
  ): string => {
    write(files, cwd)
    git(["add", "--all"], cwd)
    git(["commit", "--quiet", "--allow-empty", "-m", message], cwd)
    return head("HEAD", cwd)
  }

  git(["init", "--quiet", "-b", "main"])
  git(["config", "user.name", "tutti test"])
  git(["config", "user.email", "test@tutti.invalid"])
  git(["config", "commit.gpgsign", "false"])
  git(["config", "core.hooksPath", join(root, "hooks")])
  commit("Start", { "README.md": "# demo\n" })

  return {
    dir,
    git,
    commit,
    write,
    branch: (name, start = "HEAD") => void git(["branch", name, start]),
    worktree: (branch, base = "HEAD") => {
      worktrees += 1
      const path = join(root, `worktree-${worktrees}`)
      git(["worktree", "add", "--quiet", "-b", branch, path, base])
      return path
    },
    head,
  }
}

/** The folder of the repository's hooks (core.hooksPath), outside it, made when first asked for. */
export const hooksDir = (repo: Repo): string => {
  const path = join(dirname(repo.dir), "hooks")
  mkdirSync(path, { recursive: true })
  return path
}
