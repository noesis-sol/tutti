// scripts/release-check.ts: waits for a tag's Release check (.github/workflows/release.yml's check
// job, the whole suite on the tag) and exits 0 once it succeeded, 1 once it failed or after the wait,
// saying why. The npm workflow (.github/workflows/npm.yml) publishes only after it, so a tag whose
// suite fails is never published to npm.
//
// The tag's Release run is the newest of: the run its push started (event push, on the tag at its
// commit; a re-run of its jobs is the same run), and the runs started by hand for it (event
// workflow_dispatch, which release.yml's run-name titles "Release <tag>"). The newest decides: a run
// started by hand after a failed one is waited on, and its check stands. It reads the runs with gh,
// in the repository $GH_REPO names, with $GH_TOKEN's actions: read.
//
//   bun scripts/release-check.ts <tag> <the tag's commit>
//
// $RELEASE_CHECK_WAIT and $RELEASE_CHECK_EVERY are the wait and the time between looks, in seconds
// (40 minutes and 30 seconds): the check takes up to its 30 minutes, after a runner is free.

/** A Release run, as `gh run list --json` gives it. */
export interface Run {
  readonly databaseId: number
  readonly displayTitle: string
  readonly event: string
  readonly headBranch: string
  readonly headSha: string
  readonly status: string
  readonly conclusion: string
  readonly createdAt: string
}

/** A run's job, as `gh run view --json jobs` gives it. */
export interface Job {
  readonly name: string
  readonly status: string
  readonly conclusion: string
}

/** The fields `gh run list` is asked for. */
export const runFields = [
  "databaseId",
  "displayTitle",
  "event",
  "headBranch",
  "headSha",
  "status",
  "conclusion",
  "createdAt",
] as const

/** The Release workflow's job that runs the suite. */
export const checkJob = "check"

/** The tag's newest Release run among `runs`, or undefined when it has none yet. */
export const tagRun = (runs: ReadonlyArray<Run>, tag: string, sha: string): Run | undefined =>
  runs
    .filter(
      (run) =>
        (run.event === "push" && run.headBranch === tag && run.headSha === sha) ||
        (run.event === "workflow_dispatch" && run.displayTitle === `Release ${tag}`),
    )
    .reduce<Run | undefined>(
      (newest, run) => (newest === undefined || run.createdAt > newest.createdAt ? run : newest),
      undefined,
    )

/** Where the tag's Release check is: succeeded, failed (and why), or still to wait for. */
export type Verdict =
  | { readonly kind: "passed"; readonly run: Run }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "waiting"; readonly why: string }

/** The verdict on `run` (the tag's, undefined for none yet) from its jobs. */
export const verdict = (tag: string, run: Run | undefined, jobs: ReadonlyArray<Job>): Verdict => {
  if (run === undefined) return { kind: "waiting", why: `no Release run for ${tag} yet` }
  const named = `Release run ${run.databaseId} (${run.event})`
  const check = jobs.find((job) => job.name === checkJob)
  if (check === undefined || check.status !== "completed") {
    return run.status === "completed"
      ? { kind: "failed", why: `${named} ended (${run.conclusion}) without its check job` }
      : { kind: "waiting", why: `${named}: its check job is ${check?.status ?? "not started"}` }
  }
  return check.conclusion === "success"
    ? { kind: "passed", run }
    : { kind: "failed", why: `${named}: its check job ended ${check.conclusion}` }
}

/** What the wait reads and how it sleeps: gh and the clock in the workflow, fakes in the tests. */
export interface Sources {
  readonly runs: () => Promise<ReadonlyArray<Run>>
  readonly jobs: (run: Run) => Promise<ReadonlyArray<Job>>
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly log: (line: string) => void
}

/** Looks every `everyMs` until the tag's check is decided or `waitMs` is up; the last verdict. */
export const waitForCheck = async (
  tag: string,
  sha: string,
  sources: Sources,
  waitMs: number,
  everyMs: number,
): Promise<Verdict> => {
  const deadline = sources.now() + waitMs
  for (;;) {
    const run = tagRun(await sources.runs(), tag, sha)
    const answer = verdict(tag, run, run === undefined ? [] : await sources.jobs(run))
    if (answer.kind !== "waiting") return answer
    if (sources.now() + everyMs > deadline) {
      return {
        kind: "failed",
        why: `waited ${Math.round(waitMs / 60_000)} minutes for ${tag}'s Release check: ${answer.why}`,
      }
    }
    sources.log(`${answer.why}; looking again in ${Math.round(everyMs / 1000)} s`)
    await sources.sleep(everyMs)
  }
}

/** gh's JSON output for `args`; throws with its stderr when it fails. */
const gh = async (args: ReadonlyArray<string>): Promise<unknown> => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`gh ${args.join(" ")} exited ${code}: ${err.trim()}`)
  return JSON.parse(out)
}

/** gh and the clock. */
export const ghSources: Sources = {
  runs: async () =>
    (await gh([
      "run",
      "list",
      "--workflow",
      "release.yml",
      "--limit",
      "100",
      "--json",
      runFields.join(","),
    ])) as ReadonlyArray<Run>,
  jobs: async (run) =>
    ((await gh(["run", "view", String(run.databaseId), "--json", "jobs"])) as { jobs: Job[] }).jobs,
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  log: (line) => console.log(line),
}

/** Seconds from the environment variable `name`, or `fallback`. */
const seconds = (name: string, fallback: number): number => {
  const value = Number(process.env[name])
  return (Number.isFinite(value) && value >= 0 ? value : fallback) * 1000
}

if (import.meta.main) {
  const [tag, sha, ...rest] = process.argv.slice(2)
  if (tag === undefined || sha === undefined || rest.length > 0) {
    process.stderr.write("usage: bun scripts/release-check.ts <tag> <the tag's commit>\n")
    process.exit(2)
  }
  const answer = await waitForCheck(
    tag,
    sha,
    ghSources,
    seconds("RELEASE_CHECK_WAIT", 40 * 60),
    seconds("RELEASE_CHECK_EVERY", 30),
  )
  if (answer.kind === "passed") {
    console.log(`${tag}'s Release check succeeded: Release run ${answer.run.databaseId}`)
  } else {
    console.log(
      `::error::${tag} isn't published until its Release check succeeds: ${answer.why}. Re-run the Release run's failed jobs, or run Release for ${tag} by hand, then run this again.`,
    )
    process.exit(1)
  }
}
