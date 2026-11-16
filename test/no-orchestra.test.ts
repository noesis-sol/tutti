// tutti stands on its own (tutti-h75j): its code, tests, spec and docs name orchestra only where
// tutti imports an orchestra project or runs beside an orchestra run, and in the notices and the
// changelog. This test reads every tracked file and fails on a line naming orchestra in a file off
// `allowed`, so that the next comment saying "as orchestra does" doesn't pass the check. The word
// orchestrator, and orchestrate's other forms, are English, not the program, and pass anywhere.
import { describe, expect, test } from "bun:test"
import { lstatSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

/** A mention of orchestra, the program: orchestrator, orchestrate and the like aside. */
const mention = /orchestra(?!t)/i

/** The files that may name orchestra, by path from the repository's root, each with why. */
const allowed: ReadonlyArray<{ readonly files: ReadonlyArray<string>; readonly reason: string }> = [
  {
    reason: "tutti init's import of an orchestra project's settings and worker prompt",
    files: [
      "src/init/import.ts",
      "src/init/init.ts",
      "src/init/form.ts",
      "src/init/lineForm.ts",
      "src/project/templateVersions.ts",
    ],
  },
  {
    reason: "the import's tests and their fixture, an orchestra project",
    files: [
      "test/import.test.ts",
      "test/import-orchestra-keys.test.ts",
      "test/import-permission-mode-unset.test.ts",
      "test/import-ticket-limit-zero.test.ts",
      "test/fixtures/orchestra-project/.orchestra/worker-prompt.md",
      "test/form-clicks.test.tsx",
      "test/ui-init-form.test.tsx",
      "test/init-description-wrap.test.tsx",
      "test/init-worker-model.test.ts",
      "test/keep-awake-default.test.ts",
      "test/merge-train.test.ts",
      "test/own-check.test.ts",
      "test/spec-settings.test.ts",
      "test/question-options.test.ts",
      "test/template-versions.test.ts",
    ],
  },
  {
    reason: "the run lock, which tutti takes in orchestra's orchestra.lock too, and its tests",
    files: [
      "src/services/RunLock.ts",
      "src/testing/RunLock.ts",
      "src/plan/plan.ts",
      "test/fixtures/run-lock/holder.ts",
      "test/run-lock.test.ts",
      "test/run-lock-init-refusal.test.ts",
      "test/run-lock-links.test.ts",
      "test/plan-lock-warning.test.ts",
      "test/run-start-question.test.ts",
      "test/shared-test-layers.test.ts",
    ],
  },
  {
    reason: "the machine's workers and other runs, tutti's and orchestra's, and their tests",
    files: [
      "src/services/machine.ts",
      "src/core/AppConfig.ts",
      "src/project/flags.ts",
      "src/run/resolveConfig.ts",
      "src/run/machineGate.ts",
      "src/run/overnight.ts",
      "src/run/run/starting.ts",
      "src/run/runView.ts",
      "src/services/events.ts",
      "test/machine-core-share.test.ts",
      "test/machine-workers.test.ts",
      "test/machine-workers-default.test.ts",
      "test/shared-machine.test.ts",
      "test/shared-runs-title.test.ts",
      "test/eventstream.test.ts",
      "test/overnight-checks.test.ts",
      "test/overnight-preflight.test.ts",
      "test/airtight-env.test.ts",
      "test/app-config.test.ts",
    ],
  },
  {
    reason:
      "what an orchestra run leaves in the repository: its run folder, state, wt/<id> branches",
    files: [
      "src/run/startup.ts",
      "src/run/unmerged.ts",
      "src/services/gitStatus.ts",
      "src/services/lenient.ts",
      "src/init/workers.ts",
      "test/startup.test.ts",
      "test/start-scheme-notices.test.ts",
      "test/lenient-json.test.ts",
      "test/unmerged.test.ts",
      "test/git-status-changes.test.ts",
      "test/merge-untracked.test.ts",
      "test/init-workers-steps.test.ts",
    ],
  },
  {
    reason: "the tests' environment, which leaves out an orchestra worker's variables",
    files: ["scripts/test.ts"],
  },
  {
    reason: "tests that orchestra's old names, its share variables and scheme, are gone from tutti",
    files: [
      "test/core-share.test.ts",
      "test/memory-share.test.ts",
      "test/merge-check-share.test.ts",
      "test/test-memory.test.ts",
      "test/scheme-tutti-default.test.ts",
    ],
  },
  {
    reason: "the spec's and the docs' sections on the import and on running beside orchestra",
    files: [
      "README.md",
      "docs/spec/tutti-spec.md",
      "docs/setup.md",
      "docs/running.md",
      "docs/workers.md",
      "docs/events.md",
      "skills/tutti/SKILL.md",
    ],
  },
  {
    reason: "the notices of what tutti takes from orchestra, and the changelog's past entries",
    files: ["THIRD_PARTY_NOTICES.md", "CHANGELOG.md"],
  },
  { reason: "this test, which names what it looks for", files: ["test/no-orchestra.test.ts"] },
]

const allowedFiles = new Set(allowed.flatMap((entry) => entry.files))

/** The mentions of orchestra in `files` off `allowed`, as `<path>:<line>: <the line>`. */
const offList = (files: ReadonlyMap<string, string>): ReadonlyArray<string> =>
  [...files].flatMap(([path, text]) =>
    allowedFiles.has(path)
      ? []
      : text
          .split("\n")
          .flatMap((line, at) => (mention.test(line) ? [`${path}:${at + 1}: ${line.trim()}`] : [])),
  )

/** What the failure says, after the lines it found. */
const where =
  "orchestra may be named only where tutti imports an orchestra project or runs beside an orchestra run, in the files test/no-orchestra.test.ts lists, each with its reason; say what tutti does in its own terms, or add the file there with why"

/** The report of the mentions off the list: "" for none. */
const report = (found: ReadonlyArray<string>): string =>
  found.length === 0 ? "" : [...found, where].join("\n")

/** Every tracked file's text, by path, but those deleted in the worktree and those not text. */
const trackedFiles = (): ReadonlyMap<string, string> => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe" })
  if (listed.exitCode !== 0) throw new Error(`git ls-files exited ${listed.exitCode}`)
  const files = new Map<string, string>()
  for (const path of listed.stdout.toString().split("\0")) {
    if (path === "") continue
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false })
    if (stat === undefined || !stat.isFile()) continue
    const text = readFileSync(join(root, path), "utf8")
    if (!text.includes("\0")) files.set(path, text)
  }
  return files
}

describe("mentions of orchestra", () => {
  test("are only in the files the list allows", () => {
    expect(report(offList(trackedFiles()))).toBe("")
  })

  test("a comment naming orchestra off the list fails with its file and line", () => {
    const files = new Map([
      ["src/run/probe.ts", "export const a = 1\n// as orchestra does\nexport const b = 2\n"],
      ["docs/probe.md", "# Probe\n\nLike ORCHESTRA's.\n"],
    ])
    const found = offList(files)
    expect(found).toEqual([
      "src/run/probe.ts:2: // as orchestra does",
      "docs/probe.md:3: Like ORCHESTRA's.",
    ])
    expect(report(found)).toEndWith(where)
  })

  test("pass in a file on the list, and the word orchestrator anywhere", () => {
    const files = new Map([
      ["src/services/RunLock.ts", "// orchestra's lock\n"],
      ["src/run/probe.ts", "// an orchestrator, orchestrated\n"],
    ])
    expect(offList(files)).toEqual([])
  })

  test("every file on the list is tracked and still names orchestra, so it may come off", () => {
    const files = trackedFiles()
    const stale = [...allowedFiles].filter((path) => !mention.test(files.get(path) ?? ""))
    expect(stale).toEqual([])
  })

  test("every entry of the list has a reason and no file is listed twice", () => {
    for (const entry of allowed) expect(entry.reason.length).toBeGreaterThan(0)
    expect(allowedFiles.size).toBe(allowed.flatMap((entry) => entry.files).length)
  })
})
