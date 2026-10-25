// The release and CI workflows (§ 12 Releases), which only GitHub runs: their targets are the
// entries' and scripts/build.sh's, and their steps run the scripts that exist, with the release key.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const checkout = resolve(import.meta.dir, "..")

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly env?: Record<string, string>
  readonly with?: Record<string, unknown>
}
interface Job {
  readonly needs?: string | ReadonlyArray<string>
  readonly "runs-on": string
  readonly permissions?: Record<string, string>
  readonly strategy?: { readonly matrix: Record<string, unknown> }
  readonly steps: ReadonlyArray<Step>
}
interface Workflow {
  readonly on: Record<string, unknown>
  readonly env?: Record<string, string>
  readonly jobs: Record<string, Job>
}

const workflow = (name: string): Workflow =>
  Bun.YAML.parse(readFileSync(join(checkout, ".github/workflows", name), "utf8")) as Workflow

const release = workflow("release.yml")
const ci = workflow("ci.yml")

/** The targets with an entry, src/entries/<target>.ts. */
const entries = readdirSync(join(checkout, "src/entries"))
  .map((file) => file.replace(/\.ts$/, ""))
  .filter((name) => name !== "musl")
  .sort()

const job = (wf: Workflow, name: string): Job => {
  const found = wf.jobs[name]
  if (found === undefined) throw new Error(`no job ${name}`)
  return found
}
/** A GitHub Actions expression, as a workflow writes it: `${{ <expression> }}`. */
const gh = (expression: string) => `\${{ ${expression} }}`
const runs = (j: Job) => j.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]))

describe("the release workflow", () => {
  test("runs on version tags, and by hand for a tag", () => {
    expect(release.on.push).toEqual({ tags: ["v*"] })
    expect(release.on).toHaveProperty("workflow_dispatch.inputs.tag.required", true)
  })

  test("builds every entry's target, which scripts/build.sh knows", () => {
    const targets = job(release, "build").strategy?.matrix.target as ReadonlyArray<string>
    expect([...targets].sort()).toEqual(entries)
    const script = readFileSync(join(checkout, "scripts/build.sh"), "utf8")
    const known = /^TARGETS="([^"]*)"$/m.exec(script)?.[1]?.split(" ").sort()
    expect(known).toEqual(entries)
    expect(runs(job(release, "build")).join("\n")).toContain(
      `scripts/build.sh --release --archive --out dist ${gh("matrix.target")}`,
    )
  })

  test("builds beside the check, and publishes only after it", () => {
    expect(runs(job(release, "check"))).toContain("scripts/check-full.sh")
    expect(job(release, "build").needs).toBeUndefined()
    expect(job(release, "publish").needs).toEqual(["check", "build", "run"])
  })

  test("fails before building without the release key", () => {
    const step = job(release, "check").steps.find((s) => s.name === "Check the release key")
    expect(step?.env?.TUTTI_RELEASE_KEY).toBe(gh("secrets.TUTTI_RELEASE_KEY"))
    expect(step?.run).toContain('[ -z "$TUTTI_RELEASE_KEY" ]')
    expect(step?.run).toContain("bun scripts/sign-checksums.ts")
  })

  test("signs checksums.txt, attests the archives and publishes them with both", () => {
    const publish = job(release, "publish")
    const sign = publish.steps.find((s) => s.name === "Sign")
    expect(sign?.env?.TUTTI_RELEASE_KEY).toBe(gh("secrets.TUTTI_RELEASE_KEY"))
    expect(sign?.run).toBe("bun scripts/sign-checksums.ts dist/checksums.txt")
    const attest = publish.steps.find((s) => s.uses?.startsWith("actions/attest@"))
    expect(attest?.with?.["subject-path"]).toBe("dist/*.tar.gz")
    expect(publish.permissions).toMatchObject({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    })
    const script = runs(publish).join("\n")
    expect(script).toContain("sha256sum tutti_*.tar.gz > checksums.txt")
    expect(script).toContain("dist/checksums.txt.sig")
    expect(script).toContain(`[ "$count" -eq ${entries.length} ]`)
    expect(script).toContain("--prerelease=")
  })

  test("its steps' scripts exist", () => {
    const named = [release, ci]
      .flatMap((wf) => Object.values(wf.jobs).flatMap(runs))
      .flatMap((run) => [...run.matchAll(/scripts\/[\w.-]+/g)].map((m) => m[0]))
    expect(named.length).toBeGreaterThan(0)
    for (const path of new Set(named)) expect(existsSync(join(checkout, path))).toBe(true)
  })

  test("pins the Bun ci.yml pins", () => {
    expect(release.env?.BUN_VERSION).toBeString()
    expect(release.env?.BUN_VERSION).toBe(ci.env?.BUN_VERSION as string)
  })
})

describe("the CI workflow", () => {
  test("runs the check with the slow suites on pushes to main and pull requests", () => {
    expect(ci.on).toHaveProperty("push.branches", ["main"])
    expect(ci.on).toHaveProperty("pull_request")
    expect(runs(job(ci, "check"))).toContain("scripts/check-full.sh")
  })
})
