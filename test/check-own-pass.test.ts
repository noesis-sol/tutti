// scripts/check-own.sh standing on an earlier pass in the same worktree (scripts/check-own.ts'
// standOn): the tests that passed and that nothing changed since touches are left out. The script
// runs in a real git repository of its own in a temp folder, its steps stubbed as in
// test/check-own.test.ts, scripts/test.sh printing the test files it was given.
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import fc from "fast-check"
import {
  type PassRecord,
  readRecord,
  recordFile,
  setupFiles,
  standOn,
} from "../scripts/check-own.ts"
import { testEnv, which } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const all = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"]

describe("standOn", () => {
  test("leaves out the tests that passed and that the change since doesn't touch", () => {
    const picked = standOn(
      ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
      ["test/b.test.ts"],
      ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
      all,
    )
    expect(picked).toEqual({
      run: ["test/b.test.ts"],
      leftOut: 2,
      passed: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
    })
  })

  test("runs a selected test the pass didn't run, and keeps the pass's tests not selected now", () => {
    const picked = standOn(
      ["test/a.test.ts", "test/c.test.ts"],
      [],
      ["test/a.test.ts", "test/d.test.ts"],
      all,
    )
    expect(picked.run).toEqual(["test/c.test.ts"])
    expect(picked.leftOut).toBe(1)
    expect(picked.passed).toEqual(["test/a.test.ts", "test/c.test.ts", "test/d.test.ts"])
  })

  test("runs the whole selection when the change since touches every test", () => {
    const picked = standOn(["test/a.test.ts"], "all", ["test/a.test.ts"], all)
    expect(picked).toEqual({ run: ["test/a.test.ts"], leftOut: 0, passed: ["test/a.test.ts"] })
    expect(standOn("all", "all", all, all).run).toBe("all")
  })

  test("names the files of the whole suite it still runs, and forgets deleted tests", () => {
    const picked = standOn("all", ["test/c.test.ts"], [...all, "test/gone.test.ts"], all)
    expect(picked.run).toEqual(["test/c.test.ts"])
    expect(picked.leftOut).toBe(3)
    expect(picked.passed).toEqual(all)
    expect(standOn("all", [], [], all).run).toBe("all")
  })

  test("runs every selected test the pass doesn't stand for, and no other", () => {
    const tests = fc.subarray(all)
    fc.assert(
      fc.property(tests, tests, tests, (selection, since, passed) => {
        const picked = standOn(selection, since, passed, all)
        const run = picked.run === "all" ? all : picked.run
        for (const test of selection) {
          const stands = passed.includes(test) && !since.includes(test)
          expect(run.includes(test)).toBe(!stands)
        }
        expect(run.every((test) => selection.includes(test))).toBe(true)
        expect(picked.leftOut).toBe(selection.length - run.length)
      }),
    )
  })
})

describe("readRecord", () => {
  const tree = "a".repeat(40)

  test("reads a record check-own.ts wrote", () => {
    const record: PassRecord = { tree, mode: "slow", tests: ["test/a.test.ts"] }
    expect(readRecord(JSON.stringify(record))).toEqual(record)
  })

  test("reads anything else as no record", () => {
    for (const text of [
      "",
      "null",
      "[]",
      "{",
      JSON.stringify({ tree: "HEAD", mode: "plain", tests: [] }),
      JSON.stringify({ tree, mode: "fast", tests: [] }),
      JSON.stringify({ tree, mode: "plain", tests: [1] }),
    ]) {
      expect(readRecord(text)).toBeUndefined()
    }
    fc.assert(fc.property(fc.string(), (text) => readRecord(text) === undefined))
  })
})

const stub = (file: string, body: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

const passingTests = 'echo "test.sh $*"'

/**
 * A repository on main with the script and stubbed steps, and a branch `work` checked out that
 * changed src/a.ts and src/b.ts, so check-own picks test/a.test.ts and test/b.test.ts.
 */
const project = () => {
  const repo = makeRepo()
  const bin = join(repo.dir, "..", "bin")
  stub(join(bin, "bunx"), 'echo "bunx $*"')
  mkdirSync(join(repo.dir, "scripts"))
  for (const name of ["check-own.sh", "check-own.ts"]) {
    copyFileSync(resolve(import.meta.dir, "../scripts", name), join(repo.dir, "scripts", name))
  }
  chmodSync(join(repo.dir, "scripts", "check-own.sh"), 0o755)
  stub(join(repo.dir, "scripts", "test.sh"), passingTests)
  stub(join(repo.dir, "scripts", "check.sh"), 'echo "whole check"')
  stub(join(repo.dir, "scripts", "fetch-shellcheck.sh"), "exit 2")
  repo.commit("Project", {
    "package.json": "{}\n",
    "src/a.ts": "export const a = 1\n",
    "src/b.ts": "export const b = 2\n",
    "test/a.test.ts": 'import { a } from "../src/a.ts"\n',
    "test/b.test.ts": 'import { b } from "../src/b.ts"\n',
  })
  repo.git(["checkout", "--quiet", "-b", "work"])
  repo.commit("Change a and b", {
    "src/a.ts": "export const a = 10\n",
    "src/b.ts": "export const b = 20\n",
  })
  const tools = [process.execPath, which("git") ?? "/usr/bin/git"].map((tool) => dirname(tool))
  const run = (mode: "plain" | "slow" = "plain") => {
    const proc = Bun.spawnSync([join(repo.dir, "scripts", "check-own.sh")], {
      cwd: repo.dir,
      env: {
        HOME: testEnv.HOME ?? "",
        PATH: [bin, ...tools, "/usr/bin", "/bin"].join(":"),
        ...(mode === "slow" ? { TUTTI_SLOW: "1" } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = proc.stdout.toString() + proc.stderr.toString()
    const lines = out.trimEnd().split("\n")
    return { code: proc.exitCode, out, last: lines[lines.length - 1] ?? "" }
  }
  const gitDir = join(repo.dir, ".git")
  return { repo, run, gitDir }
}

const both = "test.sh ./test/a.test.ts ./test/b.test.ts\n"

describe("scripts/check-own.sh after a pass", () => {
  slow.test("runs no test after a change to documents alone, and says what it left out", () => {
    const { repo, run, gitDir } = project()
    expect(run().out).toContain(both)
    const kept = readRecord(readFileSync(recordFile(gitDir, "plain"), "utf8"))
    expect(kept?.tests).toEqual(["test/a.test.ts", "test/b.test.ts"])
    expect(kept?.mode).toBe("plain")
    repo.write({ "docs/notes.md": "notes\n", "CHANGELOG.md": "- a line\n" })
    const { out, last } = run()
    expect(out).toMatch(
      /check-own: 2 test files passed at [0-9a-f]{7} and nothing since touches them; running none\./,
    )
    expect(out).not.toContain("test.sh")
    expect(out).toContain("bunx biome check")
    expect(last).toBe("scripts/check-own.sh: PASS")
  })

  slow.test("runs only the tests a code change since the pass touches", () => {
    const { repo, run } = project()
    run()
    repo.commit("Change b again", { "src/b.ts": "export const b = 200\n" })
    const { out } = run()
    expect(out).toContain("check-own: 1 test file passed at")
    expect(out).toContain("running 1.")
    expect(out).toContain("test.sh ./test/b.test.ts\n")
    // The record now holds both: a.test.ts still stands, b.test.ts ran.
    repo.write({ "docs/notes.md": "notes\n" })
    expect(run().out).toContain("running none.")
  })

  slow.test("counts what isn't committed yet, untracked files included, as changed since", () => {
    const { repo, run } = project()
    run()
    repo.write({
      "src/c.ts": 'import { a } from "./a.ts"\n',
      "test/c.test.ts": 'import "../src/c.ts"\n',
    })
    const { out } = run()
    expect(out).toContain("test.sh ./test/c.test.ts\n")
    expect(out).toContain("check-own: 2 test files passed at")
  })

  slow.test("runs the whole selection when the project's setup changed since the pass", () => {
    const { repo, run } = project()
    run()
    repo.git(["checkout", "--quiet", "main"])
    repo.commit("Bump", { "package.json": '{ "name": "x" }\n' })
    repo.git(["checkout", "--quiet", "work"])
    repo.git(["rebase", "--quiet", "main"])
    const { out } = run()
    expect(out).not.toContain("whole check")
    expect(out).not.toContain("passed at")
    expect(out).toContain(both)
  })

  slow.test(
    "lets a TUTTI_SLOW=1 pass stand for a plain run, and not a plain pass for a slow one",
    () => {
      const slowFirst = project()
      expect(slowFirst.run("slow").last).toBe("TUTTI_SLOW=1 scripts/check-own.sh: PASS")
      slowFirst.repo.write({ "docs/notes.md": "notes\n" })
      expect(slowFirst.run("plain").out).toContain("running none.")

      const plainFirst = project()
      plainFirst.run("plain")
      plainFirst.repo.write({ "docs/notes.md": "notes\n" })
      const { out } = plainFirst.run("slow")
      expect(out).not.toContain("passed at")
      expect(out).toContain(both)
      // That slow pass now stands for the next slow run.
      plainFirst.repo.write({ "docs/notes.md": "more notes\n" })
      expect(plainFirst.run("slow").out).toContain("running none.")
    },
  )

  slow.test("keeps nothing on a failure, and forgets the passes kept", () => {
    const { repo, run, gitDir } = project()
    run("slow")
    expect(existsSync(recordFile(gitDir, "slow"))).toBe(true)
    expect(existsSync(recordFile(gitDir, "plain"))).toBe(true)
    stub(join(repo.dir, "scripts", "test.sh"), "exit 3")
    repo.commit("Change b again", { "src/b.ts": "export const b = 200\n" })
    expect(run().last).toBe("scripts/check-own.sh: FAIL in test (exit 3)")
    for (const mode of ["plain", "slow", "next"] as const) {
      expect(existsSync(recordFile(gitDir, mode))).toBe(false)
    }
    stub(join(repo.dir, "scripts", "test.sh"), passingTests)
    repo.write({ "docs/notes.md": "notes\n" })
    const { out } = run()
    expect(out).not.toContain("passed at")
    expect(out).toContain(both)
  })
})

describe("setupFiles", () => {
  test("is the list of setup files check-own.sh runs scripts/check.sh whole for", () => {
    const script = readFileSync(resolve(import.meta.dir, "../scripts/check-own.sh"), "utf8")
    expect(script).toContain(`for file in ${setupFiles.join(" ")}; do`)
  })
})
