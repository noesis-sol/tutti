// CI's and the release's checks run the tests on every core of the runner (TUTTI_TEST_PARALLEL) and
// in all its memory (TUTTI_MEMORY_MB), which runs nothing else, rather than the half of the cores
// scripts/test.sh keeps to on a shared machine and the memory free now less tutti's reserve: at
// 1.5 GB a process, the default while a fresh runner has no record, macos-latest's 7 GB held one
// process (tutti-34k9.9).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const checkout = resolve(import.meta.dir, "..")

interface Step {
  readonly name?: string
  readonly run?: string
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps: ReadonlyArray<Step> }>
}

const checkSteps = (name: string): ReadonlyArray<Step> => {
  const parsed = Bun.YAML.parse(
    readFileSync(join(checkout, ".github/workflows", name), "utf8"),
  ) as Workflow
  const check = parsed.jobs.check
  if (check === undefined) throw new Error(`${name} has no check job`)
  return check.steps
}

const lines = (step: Step): ReadonlyArray<string> =>
  (step.run ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")

describe.each(["ci.yml", "release.yml"])("%s's check", (name) => {
  test("sets TUTTI_TEST_PARALLEL to the runner's cores and TUTTI_MEMORY_MB to its memory before it runs the suites", () => {
    const steps = checkSteps(name)
    const set = steps.findIndex((step) =>
      lines(step).includes(
        'echo "TUTTI_TEST_PARALLEL=$(getconf _NPROCESSORS_ONLN)" >> "$GITHUB_ENV"',
      ),
    )
    const check = steps.findIndex((step) => step.run === "scripts/check-full.sh")
    expect(set).toBeGreaterThanOrEqual(0)
    expect(check).toBeGreaterThan(set)
    expect(lines(steps[set] ?? {})).toContain(
      `echo "TUTTI_MEMORY_MB=$(bun --print 'Math.floor(require("node:os").totalmem() / 1048576)')" >> "$GITHUB_ENV"`,
    )
    // bun is set up before the step reads the memory with it.
    const bun = steps.findIndex((step) =>
      (step as { uses?: string }).uses?.startsWith("oven-sh/setup-bun"),
    )
    expect(bun).toBeGreaterThanOrEqual(0)
    expect(bun).toBeLessThan(set)
  })
})
