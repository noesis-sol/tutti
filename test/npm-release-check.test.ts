// The npm workflow's gate on the tag's Release check (tutti-hljo): publish needs the release-check
// job, which runs scripts/release-check.ts, and the script passes only once the tag's Release run's
// check job succeeded. GitHub alone runs the workflows; the script is run here with a fake gh.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  checkJob,
  type Job,
  type Run,
  type Sources,
  tagRun,
  verdict,
  waitForCheck,
} from "../scripts/release-check.ts"
import { testEnv } from "./env.ts"

const checkout = resolve(import.meta.dir, "..")
const script = join(checkout, "scripts/release-check.ts")

interface Step {
  readonly uses?: string
  readonly run?: string
  readonly env?: Record<string, string>
  readonly with?: Record<string, unknown>
}
interface WorkflowJob {
  readonly name?: string
  readonly needs?: string | ReadonlyArray<string>
  readonly if?: string
  readonly permissions?: Record<string, string>
  readonly steps: ReadonlyArray<Step>
}
interface Workflow {
  readonly "run-name"?: string
  readonly jobs: Record<string, WorkflowJob>
}

const workflow = (name: string): Workflow =>
  Bun.YAML.parse(readFileSync(join(checkout, ".github/workflows", name), "utf8")) as Workflow
const npm = workflow("npm.yml")
const release = workflow("release.yml")
const job = (wf: Workflow, name: string): WorkflowJob => {
  const found = wf.jobs[name]
  if (found === undefined) throw new Error(`no job ${name}`)
  return found
}
/** A GitHub Actions expression, as a workflow writes it. */
const gh = (expression: string) => `\${{ ${expression} }}`

const tag = "v1.2.0"
const sha = "a".repeat(40)

const run = (fields: Partial<Run> = {}): Run => ({
  databaseId: 1,
  displayTitle: `Release ${tag}`,
  event: "push",
  headBranch: tag,
  headSha: sha,
  status: "completed",
  conclusion: "success",
  createdAt: "2026-10-25T10:00:00Z",
  ...fields,
})
const check = (status: string, conclusion = ""): Job => ({ name: "check", status, conclusion })
const built: Job = { name: "build (linux-x64)", status: "completed", conclusion: "success" }

describe("the npm workflow's gate", () => {
  test("publish needs the tag's Release check as well as the tarball's", () => {
    const needs = job(npm, "publish").needs
    expect(Array.isArray(needs) ? [...needs].sort() : needs).toEqual(["check", "release-check"])
  })

  test("the release-check job waits for the tag's Release check, when there is a token", () => {
    const gate = job(npm, "release-check")
    expect(gate.needs).toBe("token")
    expect(gate.if).toBe("needs.token.outputs.set == 'true'")
    expect(gate.permissions).toHaveProperty("actions", "read")
    const step = gate.steps.find((s) => s.run?.includes("scripts/release-check.ts"))
    expect(step?.run).toBe('bun scripts/release-check.ts "$TAG" "$(git rev-parse HEAD)"')
    expect(step?.env).toEqual({ GH_TOKEN: gh("github.token"), GH_REPO: gh("github.repository") })
    const checkoutStep = gate.steps.find((s) => s.uses?.startsWith("actions/checkout@"))
    expect(checkoutStep?.with?.ref).toBe(`refs/tags/${gh("env.TAG")}`)
  })

  test("Release's runs are titled with their tag, and its check job runs the whole suite", () => {
    expect(release["run-name"]).toBe(`Release ${gh("inputs.tag || github.ref_name")}`)
    const suite = job(release, checkJob)
    expect(suite.name).toBeUndefined()
    expect(suite.steps.map((s) => s.run)).toContain("scripts/check-full.sh")
  })
})

describe("the tag's Release run", () => {
  test("is its push's run at the tag's commit, or a run by hand titled with it", () => {
    expect(tagRun([run()], tag, sha)?.databaseId).toBe(1)
    const byHand = run({ event: "workflow_dispatch", headBranch: "main", headSha: "b".repeat(40) })
    expect(tagRun([byHand], tag, sha)).toBe(byHand)
  })

  test("is not another tag's, a push of the tag at another commit, or a run by hand titled otherwise", () => {
    const others = [
      run({ headBranch: "v1.1.0", displayTitle: "Release v1.1.0" }),
      run({ headSha: "c".repeat(40) }),
      run({ event: "workflow_dispatch", displayTitle: "Release" }),
      run({ event: "workflow_dispatch", displayTitle: "Release v1.2.0-rc.1" }),
      run({ event: "schedule" }),
    ]
    expect(tagRun(others, tag, sha)).toBeUndefined()
  })

  test("is the newest of them", () => {
    const pushed = run({ databaseId: 1, createdAt: "2026-10-25T10:00:00Z" })
    const byHand = run({
      databaseId: 2,
      event: "workflow_dispatch",
      createdAt: "2026-10-25T11:00:00Z",
    })
    expect(tagRun([pushed, byHand], tag, sha)).toBe(byHand)
    expect(tagRun([byHand, pushed], tag, sha)).toBe(byHand)
  })
})

describe("the verdict", () => {
  test("passes only once the check job succeeded, whatever the rest of the run did", () => {
    expect(verdict(tag, run(), [built, check("completed", "success")]).kind).toBe("passed")
    const publishing = run({ status: "in_progress", conclusion: "" })
    expect(verdict(tag, publishing, [check("completed", "success")]).kind).toBe("passed")
    const publishFailed = run({ conclusion: "failure" })
    expect(verdict(tag, publishFailed, [check("completed", "success")]).kind).toBe("passed")
  })

  test("fails when the check job ended otherwise, or the run ended without it", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) {
      const answer = verdict(tag, run({ conclusion: "failure" }), [check("completed", conclusion)])
      expect(answer).toEqual({
        kind: "failed",
        why: `Release run 1 (push): its check job ended ${conclusion}`,
      })
    }
    expect(verdict(tag, run({ conclusion: "startup_failure" }), [])).toEqual({
      kind: "failed",
      why: "Release run 1 (push) ended (startup_failure) without its check job",
    })
  })

  test("waits while there is no run yet, or its check job hasn't ended", () => {
    expect(verdict(tag, undefined, []).kind).toBe("waiting")
    const going = run({ status: "in_progress", conclusion: "" })
    expect(verdict(tag, going, []).kind).toBe("waiting")
    expect(verdict(tag, going, [check("queued")]).kind).toBe("waiting")
    expect(verdict(tag, going, [built, check("in_progress")]).kind).toBe("waiting")
  })
})

/** Sources whose runs and jobs are each look's in `looks`, the last one repeated, on a fake clock. */
const fake = (looks: ReadonlyArray<{ runs: Run[]; jobs: Job[] }>) => {
  let clock = 0
  let look = 0
  const at = () => looks[Math.min(look, looks.length - 1)] ?? { runs: [], jobs: [] }
  const lines: string[] = []
  const sources: Sources = {
    runs: async () => at().runs,
    jobs: async () => at().jobs,
    sleep: async (ms) => {
      clock += ms
      look += 1
    },
    now: () => clock,
    log: (line) => lines.push(line),
  }
  return { sources, lines, looks: () => look }
}

describe("waiting for the check", () => {
  test("looks again until the run comes and its check succeeds", async () => {
    const going = run({ status: "in_progress", conclusion: "" })
    const { sources, looks } = fake([
      { runs: [], jobs: [] },
      { runs: [going], jobs: [check("in_progress")] },
      { runs: [going], jobs: [check("completed", "success")] },
    ])
    const answer = await waitForCheck(tag, sha, sources, 60_000, 1_000)
    expect(answer.kind).toBe("passed")
    expect(looks()).toBe(2)
  })

  test("stops at a failed check", async () => {
    const { sources } = fake([{ runs: [run()], jobs: [check("completed", "failure")] }])
    expect((await waitForCheck(tag, sha, sources, 60_000, 1_000)).kind).toBe("failed")
  })

  test("fails once the wait is up, saying what it waited on", async () => {
    const { sources, looks } = fake([{ runs: [], jobs: [] }])
    const answer = await waitForCheck(tag, sha, sources, 10 * 60_000, 60_000)
    expect(answer).toEqual({
      kind: "failed",
      why: `waited 10 minutes for ${tag}'s Release check: no Release run for ${tag} yet`,
    })
    expect(looks()).toBe(10)
  })
})

/** A folder holding a fake gh that prints `runs` for `gh run list` and `jobs` for `gh run view`. */
const fakeGh = (runs: ReadonlyArray<Run>, jobs: ReadonlyArray<Job>) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-release-check-"))
  writeFileSync(join(dir, "runs.json"), JSON.stringify(runs))
  writeFileSync(join(dir, "jobs.json"), JSON.stringify({ jobs }))
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$2" in\nlist) cat "${dir}/runs.json" ;;\nview) cat "${dir}/jobs.json" ;;\n*) exit 1 ;;\nesac\n`,
  )
  chmodSync(join(dir, "gh"), 0o755)
  return dir
}

/** The script run with `args`, with `dir`'s gh first on the PATH. */
const runScript = (dir: string, args: ReadonlyArray<string>) => {
  const proc = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: dir,
    env: {
      PATH: `${dir}:${testEnv.PATH ?? "/usr/bin:/bin"}`,
      RELEASE_CHECK_WAIT: "0",
      RELEASE_CHECK_EVERY: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

describe("scripts/release-check.ts", () => {
  test("exits 0 once the tag's check succeeded, reading Release's runs and the run's jobs", () => {
    const dir = fakeGh([run({ databaseId: 42 })], [built, check("completed", "success")])
    const result = runScript(dir, [tag, sha])
    expect(result).toMatchObject({
      code: 0,
      out: `${tag}'s Release check succeeded: Release run 42\n`,
    })
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n")
    expect(calls[0]).toStartWith("run list --workflow release.yml ")
    expect(calls[1]).toBe("run view 42 --json jobs")
  })

  test("exits 1 with an error for a failed check, or none in the wait", () => {
    const failed = runScript(fakeGh([run()], [check("completed", "failure")]), [tag, sha])
    expect(failed.code).toBe(1)
    expect(failed.out).toStartWith(
      `::error::${tag} isn't published until its Release check succeeds`,
    )
    const none = runScript(fakeGh([], []), [tag, sha])
    expect(none.code).toBe(1)
    expect(none.out).toContain("no Release run for v1.2.0 yet")
  })

  test("exits 1 when gh fails, and 2 without its two arguments", () => {
    const dir = fakeGh([], [])
    writeFileSync(join(dir, "gh"), "#!/bin/sh\necho 'HTTP 403' >&2\nexit 1\n")
    const broken = runScript(dir, [tag, sha])
    expect(broken.code).toBe(1)
    expect(broken.err).toContain("HTTP 403")
    expect(runScript(dir, [tag]).code).toBe(2)
  })
})
