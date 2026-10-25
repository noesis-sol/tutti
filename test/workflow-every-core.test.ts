// CI's and the release's checks run the tests on every core of the runner (TUTTI_TEST_PARALLEL),
// which runs nothing else, rather than the half scripts/test.sh keeps to on a shared machine.
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

describe.each(["ci.yml", "release.yml"])("%s's check", (name) => {
  test("sets TUTTI_TEST_PARALLEL to the runner's cores before it runs the suites", () => {
    const steps = checkSteps(name)
    const set = steps.findIndex(
      (step) =>
        step.run === 'echo "TUTTI_TEST_PARALLEL=$(getconf _NPROCESSORS_ONLN)" >> "$GITHUB_ENV"',
    )
    const check = steps.findIndex((step) => step.run === "scripts/check-full.sh")
    expect(set).toBeGreaterThanOrEqual(0)
    expect(check).toBeGreaterThan(set)
  })
})
