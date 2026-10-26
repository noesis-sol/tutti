// scripts/check-own.sh, a worker's check of its own change (check_own in .orchestra/settings.json),
// and scripts/check-own.ts, which picks the test files the change touches. The script runs in a
// real git repository of its own in a temp folder, its steps stubbed: bunx on PATH (tsc, biome),
// scripts/test.sh, scripts/check.sh and scripts/fetch-shellcheck.sh, each printing what it was given.
import { describe, expect, test } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import fc from "fast-check"
import {
  pathMentions,
  resolveSpecifier,
  specifiers,
  testsFor,
  withoutImports,
} from "../scripts/check-own.ts"
import { testEnv, which } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const sources = (files: Record<string, string>) => new Map(Object.entries(files))
const existing = (files: Record<string, string>) => (file: string) => file in files

describe("specifiers", () => {
  test("reads imports, re-exports, dynamic imports and requires", () => {
    const source = [
      'import { a } from "../src/a.ts"',
      'import { type B } from "./b"',
      'export * from "../src/c.ts"',
      'import "./side-effect.ts"',
      'const d = await import("./d.ts")',
      'const e = require("e")',
    ].join("\n")
    expect(specifiers(source)).toEqual([
      "../src/a.ts",
      "./b",
      "../src/c.ts",
      "./side-effect.ts",
      "./d.ts",
      "e",
    ])
  })

  test("finds every import's specifier in any source", () => {
    const specifier = fc.stringMatching(/^\.{1,2}\/[a-zA-Z0-9_./-]{1,30}$/)
    fc.assert(
      fc.property(fc.array(specifier, { maxLength: 8 }), fc.string(), (list, noise) => {
        const clean = noise.replace(/["'\n]/g, "")
        const source = list.map((s) => `// ${clean}\nimport { x } from "${s}"`).join("\n")
        expect(specifiers(source)).toEqual(list)
      }),
    )
  })
})

describe("resolveSpecifier", () => {
  const files = existing({ "src/a.ts": "", "src/ui/view.tsx": "", "src/run/index.ts": "" })

  test("resolves a relative specifier to the repository's file, with or without its extension", () => {
    expect(resolveSpecifier("test/a.test.ts", "../src/a.ts", files)).toBe("src/a.ts")
    expect(resolveSpecifier("test/a.test.ts", "../src/a", files)).toBe("src/a.ts")
    expect(resolveSpecifier("src/ui/x.ts", "./view", files)).toBe("src/ui/view.tsx")
    expect(resolveSpecifier("src/x.ts", "./run", files)).toBe("src/run/index.ts")
  })

  test("keeps the path of a file that isn't there, as a deleted module's importers still read it", () => {
    expect(resolveSpecifier("test/a.test.ts", "../src/gone.ts", files)).toBe("src/gone.ts")
  })

  test("leaves packages and paths outside the repository unresolved", () => {
    expect(resolveSpecifier("test/a.test.ts", "effect", files)).toBeUndefined()
    expect(resolveSpecifier("test/a.test.ts", "../../elsewhere.ts", files)).toBeUndefined()
  })
})

describe("pathMentions", () => {
  test("names a file by its path and the folders it is in, relative to test/ for test files", () => {
    expect(pathMentions("test/fixtures/bd/ready.json")).toEqual([
      "fixtures/bd/ready.json",
      '"fixtures", "bd", "ready.json"',
      "fixtures/bd",
      'fixtures", "bd',
    ])
    expect(pathMentions("scripts/check.sh")).toEqual(["scripts/check.sh", '"scripts", "check.sh"'])
  })
})

describe("withoutImports", () => {
  test("takes out imports, re-exports and requires, and keeps the rest", () => {
    const source = [
      'import { a } from "../src/run/a.ts"',
      'export * from "../src/run/c.ts"',
      'const d = await import("../src/run/d.ts")',
      'const fixture = "fixtures/bd/ready.json"',
      'const dir = resolve(import.meta.dir, "../src/run")',
    ].join("\n")
    const left = withoutImports(source)
    expect(left).not.toContain("src/run/a.ts")
    expect(left).not.toContain("src/run/c.ts")
    expect(left).not.toContain("src/run/d.ts")
    expect(left).toContain('"fixtures/bd/ready.json"')
    expect(left).toContain('resolve(import.meta.dir, "../src/run")')
  })

  test("leaves no specifier behind in any source", () => {
    const specifier = fc.stringMatching(/^\.{1,2}\/[a-zA-Z0-9_./-]{1,30}$/)
    fc.assert(
      fc.property(fc.array(specifier, { maxLength: 8 }), fc.string(), (list, noise) => {
        const clean = noise.replace(/["'\n]/g, "")
        const source = list.map((s) => `// ${clean}\nimport { x } from "${s}"`).join("\n")
        expect(specifiers(withoutImports(source))).toEqual([])
      }),
    )
  })
})

describe("testsFor", () => {
  const files = {
    "src/a.ts": 'export const a = 1\nconst readme = "scripts/check.sh"',
    "src/b.ts": 'import { a } from "./a.ts"',
    "src/c.ts": "export const c = 3",
    "test/a.test.ts": 'import { a } from "../src/a.ts"',
    "test/b.test.ts": 'import { b } from "../src/b.ts"',
    "test/c.test.ts": 'import { c } from "../src/c.ts"',
    "test/helper.ts": 'export const fake = "fixtures/fake/tool.ts"',
    "test/fake.test.ts": 'import { fake } from "./helper.ts"',
    "test/script.test.ts": 'const script = resolve(import.meta.dir, "../scripts/check.sh")',
    "test/fixtures/fake/tool.ts": "console.log(1)",
  }
  const tests = (changed: ReadonlyArray<string>) =>
    testsFor(changed, sources(files), existing(files))

  test("takes the tests that import a changed module, at any depth", () => {
    expect(tests(["src/a.ts"])).toEqual(["test/a.test.ts", "test/b.test.ts"])
    expect(tests(["src/c.ts"])).toEqual(["test/c.test.ts"])
  })

  test("takes a changed test file itself", () => {
    expect(tests(["test/c.test.ts", "README.md"])).toEqual(["test/c.test.ts"])
  })

  test("takes the tests that name a changed file, through the helpers that name it", () => {
    expect(tests(["scripts/check.sh"])).toEqual(["test/script.test.ts"])
    expect(tests(["test/fixtures/fake/tool.ts"])).toEqual(["test/fake.test.ts"])
  })

  test("doesn't take a product module that names a changed file's path", () => {
    expect(tests(["scripts/check.sh"])).not.toContain("test/a.test.ts")
  })

  test("leaves out a test that was deleted, and takes nothing for a change no test reads", () => {
    expect(tests(["test/gone.test.ts"])).toEqual([])
    expect(tests(["docs/setup.md"])).toEqual([])
  })

  test("doesn't take a test for a file in a folder it imports from but doesn't reach", () => {
    const run = {
      "src/run/a.ts": "export const a = 1",
      "src/run/b.ts": "export const b = 2",
      "src/run/c.ts": 'export { a } from "./a.ts"',
      "test/a.test.ts": 'import { a } from "../src/run/a.ts"',
      "test/c.test.ts": 'import { a } from "../src/run/c.ts"',
      "test/b.test.ts": 'import {\n  b,\n} from "../src/run/b.ts"',
    }
    const picks = (changed: ReadonlyArray<string>) => testsFor(changed, sources(run), existing(run))
    expect(picks(["src/run/b.ts"])).toEqual(["test/b.test.ts"])
    expect(picks(["src/run/a.ts"])).toEqual(["test/a.test.ts", "test/c.test.ts"])
  })

  test("takes a test that names a changed file's folder or path outside its imports", () => {
    const named = {
      "src/entries/a.ts": "export const a = 1",
      "src/main.ts": 'import { a } from "./entries/a.ts"',
      "test/release.test.ts": 'const entries = resolve(root, "src/entries")',
      "test/binary.test.ts": 'const main = join(import.meta.dir, "..", "src", "main.ts")',
      "test/other.test.ts": 'const other = join(import.meta.dir, "..", "src", "other.ts")',
      "test/fixture.test.ts": 'const ready = readFileSync("fixtures/bd/ready.json")',
      "test/fixtures/bd/ready.json": "[]",
    }
    const picks = (changed: ReadonlyArray<string>) =>
      testsFor(changed, sources(named), existing(named))
    expect(picks(["src/entries/a.ts"])).toEqual(["test/release.test.ts"])
    expect(picks(["src/main.ts"])).toEqual(["test/binary.test.ts"])
    expect(picks(["test/fixtures/bd/ready.json"])).toEqual(["test/fixture.test.ts"])
  })

  test("takes the whole suite for a change to the test runner or its preload", () => {
    expect(tests(["scripts/test.ts"])).toBe("all")
    expect(tests(["src/c.ts", "test/warm-up.ts"])).toBe("all")
  })
})

const stub = (file: string, body: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

/** A repository on main with the script and stubbed steps, and a branch `work` checked out. */
const project = () => {
  const repo = makeRepo()
  const bin = join(repo.dir, "..", "bin")
  stub(join(bin, "bunx"), 'echo "bunx $*"')
  mkdirSync(join(repo.dir, "scripts"))
  for (const name of ["check-own.sh", "check-own.ts"]) {
    copyFileSync(resolve(import.meta.dir, "../scripts", name), join(repo.dir, "scripts", name))
  }
  chmodSync(join(repo.dir, "scripts", "check-own.sh"), 0o755)
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
  const tools = [process.execPath, which("git") ?? "/usr/bin/git"].map((tool) => dirname(tool))
  const run = () => {
    const proc = Bun.spawnSync([join(repo.dir, "scripts", "check-own.sh")], {
      cwd: repo.dir,
      env: { HOME: testEnv.HOME ?? "", PATH: [bin, ...tools, "/usr/bin", "/bin"].join(":") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = proc.stdout.toString() + proc.stderr.toString()
    const lines = out.trimEnd().split("\n")
    return { code: proc.exitCode, out, last: lines[lines.length - 1] }
  }
  return { repo, run }
}

describe("scripts/check-own.sh", () => {
  slow.test("checks the files the branch changed and runs the tests they touch", () => {
    const { repo, run } = project()
    repo.commit("Change a", { "src/a.ts": "export const a = 10\n" })
    repo.write({ "src/new.ts": 'import { a } from "./a.ts"\n' })
    const { code, out, last } = run()
    expect(out).toContain("bunx tsc --noEmit")
    expect(out).toContain(
      "bunx biome check --files-ignore-unknown=true --no-errors-on-unmatched src/a.ts src/new.ts",
    )
    expect(out).toContain("test.sh ./test/a.test.ts\n")
    expect(out).toContain("shellcheck: no shell script changed")
    expect(last).toBe("scripts/check-own.sh: PASS")
    expect(code).toBe(0)
  })

  slow.test("says so and runs no test when no test reads the change", () => {
    const { repo, run } = project()
    repo.write({ "docs/notes.md": "notes\n" })
    const { out, last } = run()
    expect(out).toContain("tsc: no TypeScript or JSON file changed")
    expect(out).toContain("test: no test file covers the change")
    expect(out).not.toContain("test.sh")
    expect(last).toBe("scripts/check-own.sh: PASS")
  })

  slow.test("type-checks a change that only deletes a module", () => {
    const { repo, run } = project()
    repo.git(["rm", "--quiet", "src/b.ts"])
    const { out } = run()
    expect(out).toContain("bunx tsc --noEmit")
    expect(out).toContain("test.sh ./test/b.test.ts\n")
  })

  slow.test("runs the whole check when the project's setup changed", () => {
    const { repo, run } = project()
    repo.commit("Bump", { "package.json": '{ "name": "x" }\n' })
    const { out, last } = run()
    expect(out).toContain("check-own: package.json changed: running scripts/check.sh whole")
    expect(last).toBe("whole check")
  })

  slow.test("ends with FAIL in the step that failed, keeping its exit status", () => {
    const { repo, run } = project()
    stub(join(repo.dir, "scripts", "test.sh"), "exit 3")
    repo.write({ "test/b.test.ts": 'import { b } from "../src/b.ts"\n// more\n' })
    const { code, last } = run()
    expect(last).toBe("scripts/check-own.sh: FAIL in test (exit 3)")
    expect(code).toBe(3)
  })

  test("is the check_own orchestra's workers run on their own change", () => {
    const settings = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../.orchestra/settings.json"), "utf8"),
    )
    expect(settings.check_own).toBe("scripts/check-own.sh")
  })
})
