// scripts/check-fast.sh, tutti's merge check, runs scripts/check-own.sh on the ticket's branch
// rebased onto main (tutti-jhqq): tsc, biome, shellcheck and only the test files the change since
// main touches, saying how many; scripts/check.sh whole when the project's setup changed or there
// is no main. With TUTTI_OWN_SAME_TREE=1 it stands on no pass kept in the worktree but one at the
// tree it checks (scripts/check-own.ts' standing). The scripts run in a real git repository of
// their own in a temp folder, their steps stubbed as in test/check-own.test.ts.
import { describe, expect, test } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import fc from "fast-check"
import { type PassRecord, sameTreeVariable, standing } from "../scripts/check-own.ts"
import { testEnv, which } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const tree = (letter: string) => letter.repeat(40)

describe("standing", () => {
  const record: PassRecord = { tree: tree("a"), mode: "plain", tests: ["test/a.test.ts"] }

  test("lets any pass stand for a worker's own run", () => {
    expect(standing(record, tree("b"), false)).toBe(record)
    expect(standing(record, undefined, false)).toBe(record)
    expect(standing(undefined, tree("a"), false)).toBeUndefined()
  })

  test("lets only a pass at the tree being checked stand with the same-tree rule", () => {
    expect(standing(record, tree("a"), true)).toBe(record)
    expect(standing(record, tree("b"), true)).toBeUndefined()
    expect(standing(record, undefined, true)).toBeUndefined()
    expect(standing(undefined, tree("a"), true)).toBeUndefined()
  })

  test("never stands on a pass of another tree with the rule, nor refuses one at the same", () => {
    const hash = fc.stringMatching(/^[0-9a-f]{40}$/)
    fc.assert(
      fc.property(hash, hash, (kept, checked) => {
        const pass: PassRecord = { tree: kept, mode: "plain", tests: [] }
        expect(standing(pass, checked, true)).toBe(kept === checked ? pass : undefined)
        expect(standing(pass, checked, false)).toBe(pass)
      }),
    )
  })

  test("names the variable the merge check sets", () => {
    expect(sameTreeVariable).toBe("TUTTI_OWN_SAME_TREE")
  })
})

const stub = (file: string, body: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

const scripts = ["check-fast.sh", "check-own.sh", "check-own.ts"]

/**
 * A repository on main with the merge check's scripts and stubbed steps committed, and a branch
 * `work` checked out that changed src/a.ts, which test/a.test.ts reads; main then moved on with a
 * change to src/b.ts, which test/b.test.ts reads.
 */
const project = () => {
  const repo = makeRepo()
  const bin = join(repo.dir, "..", "bin")
  stub(join(bin, "bunx"), 'echo "bunx $*"')
  mkdirSync(join(repo.dir, "scripts"))
  for (const name of scripts) {
    copyFileSync(resolve(import.meta.dir, "../scripts", name), join(repo.dir, "scripts", name))
  }
  for (const name of ["check-fast.sh", "check-own.sh"]) {
    chmodSync(join(repo.dir, "scripts", name), 0o755)
  }
  stub(join(repo.dir, "scripts", "test.sh"), 'echo "test.sh $*"')
  stub(join(repo.dir, "scripts", "check.sh"), 'echo "whole check"')
  // Exit 2 is fetch-shellcheck.sh's "couldn't download it", which the check skips.
  stub(join(repo.dir, "scripts", "fetch-shellcheck.sh"), "exit 2")
  repo.commit("Project", {
    "package.json": "{}\n",
    "src/a.ts": "export const a = 1\n",
    "src/b.ts": "export const b = 2\n",
    "test/a.test.ts": 'import { a } from "../src/a.ts"\n',
    "test/b.test.ts": 'import { b } from "../src/b.ts"\n',
  })
  repo.git(["checkout", "--quiet", "-b", "work"])
  repo.commit("Change a", { "src/a.ts": "export const a = 10\n" })
  repo.git(["checkout", "--quiet", "main"])
  repo.commit("Change b on main", { "src/b.ts": "export const b = 20\n" })
  repo.git(["checkout", "--quiet", "work"])
  const tools = [process.execPath, which("git") ?? "/usr/bin/git"].map((tool) => dirname(tool))
  const run = (script: string, cwd = repo.dir, env: Record<string, string> = {}) => {
    const proc = Bun.spawnSync([join(cwd, "scripts", script)], {
      cwd,
      env: {
        HOME: testEnv.HOME ?? "",
        PATH: [bin, ...tools, "/usr/bin", "/bin"].join(":"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = proc.stdout.toString() + proc.stderr.toString()
    const lines = out.trimEnd().split("\n")
    return { code: proc.exitCode, out, last: lines[lines.length - 1] ?? "" }
  }
  const rebase = () => repo.git(["rebase", "--quiet", "main"])
  return { repo, run, rebase }
}

describe("scripts/check-fast.sh", () => {
  slow.test(
    "runs tsc, biome, shellcheck and only the tests the rebased change touches, saying how many",
    () => {
      const { run, rebase } = project()
      rebase()
      const { code, out, last } = run("check-fast.sh")
      expect(out).toContain("SUITE: check\n")
      expect(out).toContain("bunx tsc --noEmit")
      expect(out).toContain(
        "bunx biome check --files-ignore-unknown=true --no-errors-on-unmatched src/a.ts",
      )
      expect(out).toContain("test: running the 1 test file the change touches.")
      expect(out).toContain("test.sh ./test/a.test.ts\n")
      expect(out).not.toContain("b.test.ts")
      expect(out).toContain("shellcheck: no shell script changed")
      expect(out).not.toContain("whole check")
      expect(last).toBe("scripts/check-own.sh: PASS")
      expect(code).toBe(0)
    },
  )

  slow.test("picks against main in an early check's checkout on no branch too", () => {
    const { repo, run, rebase } = project()
    rebase()
    const checkout = join(repo.dir, "..", "early")
    repo.git(["worktree", "add", "--quiet", "--detach", checkout, "work"])
    const { out, last } = run("check-fast.sh", checkout)
    expect(out).toContain("test.sh ./test/a.test.ts\n")
    expect(out).not.toContain("b.test.ts")
    expect(last).toBe("scripts/check-own.sh: PASS")
  })

  slow.test(
    "stands on no pass the worker kept at another tree, and on one at the tree it checks",
    () => {
      const { run, rebase } = project()
      // The worker's own check passes before the rebase, keeping its pass in the worktree's git dir.
      const own = run("check-own.sh")
      expect(own.out).toContain("test.sh ./test/a.test.ts\n")
      expect(own.last).toBe("scripts/check-own.sh: PASS")
      rebase()
      // Standing on it, the merge check would run no test: the change since the pass is main's.
      const first = run("check-fast.sh")
      expect(first.out).toMatch(
        /check-own: standing on no pass: the plain one kept, at [0-9a-f]{7}, is of another tree \(TUTTI_OWN_SAME_TREE=1\)\./,
      )
      expect(first.out).toContain("test.sh ./test/a.test.ts\n")
      expect(first.out).not.toContain("nothing since touches them")
      expect(first.last).toBe("scripts/check-own.sh: PASS")
      // Checked again at the same tree, its own pass stands.
      const again = run("check-fast.sh")
      expect(again.out).toMatch(
        /check-own: 1 test file passed at [0-9a-f]{7} and nothing since touches them; running none\./,
      )
      expect(again.out).not.toContain("test.sh")
      expect(again.last).toBe("scripts/check-own.sh: PASS")
    },
  )

  slow.test("a worker's own run still stands on a pass of another tree", () => {
    const { run, rebase } = project()
    run("check-own.sh")
    rebase()
    const { out } = run("check-own.sh")
    expect(out).not.toContain("standing on no pass")
    expect(out).toContain("running none.")
  })

  slow.test("runs the whole check when the project's setup changed", () => {
    const { repo, run, rebase } = project()
    rebase()
    repo.commit("Bump", { "package.json": '{ "name": "x" }\n' })
    const { out, last } = run("check-fast.sh")
    expect(out).toContain("check-own: package.json changed: running scripts/check.sh whole")
    expect(out).toContain("whole check")
    expect(out).not.toContain("test.sh")
    expect(last).toBe("whole check")
  })

  slow.test("runs the whole check where there is no main to start from", () => {
    const { repo, run } = project()
    repo.git(["branch", "-m", "main", "trunk"])
    const { out, last } = run("check-fast.sh")
    expect(out).toContain("check-own: no main to start from: running scripts/check.sh whole")
    expect(last).toBe("whole check")
  })

  slow.test("ends with FAIL in the step that failed, keeping its exit status", () => {
    const { repo, run, rebase } = project()
    rebase()
    stub(join(repo.dir, "scripts", "test.sh"), "exit 3")
    const { code, last } = run("check-fast.sh")
    expect(last).toBe("scripts/check-own.sh: FAIL in test (exit 3)")
    expect(code).toBe(3)
  })
})
