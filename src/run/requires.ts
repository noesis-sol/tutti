// The check of the project's requires list (src/project/requires.ts), as orchestra 0.9.1's: every
// check runs in the main checkout, side by side, each within a minute, its output dropped; for a
// failed check with an install, the install runs, one at a time (package managers lock their own
// state), within the merge check's time limit, its whole output kept in .tutti/run/requires-<name>.log,
// and the check runs again. A requirement limited to other operating systems isn't checked.
//
// A run checks the list as it starts, before its first ticket or any worker it carries over, and
// stops REQUIREMENTS_MISSING, exit 2, for what is still missing, rather than leave every ticket to
// fail on it one by one (runRequires). A merge that changes the list on the base has the run take
// the new one (setup.ts's takeSettings) and check it again, as at its start, before the next ticket
// starts: what is still missing stops the run REQUIREMENTS_MISSING too, the running tickets finishing
// first (a HOLD line), as orchestra's takeRequires and recheckRequires have it. `tutti init` lists
// the requirements among what the machine needs, and `tutti requires` prints each one's state.
import { join } from "node:path"
import { Duration, Effect } from "effect"
import { BranchEnv } from "../agent/env.ts"
import { O } from "../native/libc.ts"
import { appliesOn, requireLogName } from "../project/requires.ts"
import { type Requirement, settingsFile } from "../project/settings.ts"
import { exec } from "../services/exec.ts"
import { openRunFile, runFolder } from "../services/Worktrees.ts"
import { detail, line, Tag } from "./log.ts"
import { sayer } from "./say.ts"

/** How long each check may run: it only looks, so it is short. */
export const checkLimit: Duration.Duration = Duration.minutes(1)

/** The most checks run side by side. */
const atOnce = 8

/** How a requirement was found. */
export type RequireState =
  /** Its check passed. */
  | "met"
  /** Its check failed, its install ran, and the check passes now. */
  | "installed"
  /** Its check fails: nothing installs it, or its install didn't help. */
  | "missing"
  /** It doesn't apply on this operating system, and wasn't checked. */
  | "otherOS"

/** How one requirement was found. */
export interface RequireResult {
  readonly requirement: Requirement
  readonly state: RequireState
  /** Its install ran. */
  readonly ran: boolean
  /** Why its install failed; undefined where it worked or didn't run. */
  readonly installError?: string
  /** Where its install's whole output is; undefined where it didn't run or couldn't be kept. */
  readonly output?: string
  /** Why its install's output couldn't be kept, where it couldn't. */
  readonly keptError?: string
}

/** How each requirement was found, in the list's order. */
export type RequireReport = ReadonlyArray<RequireResult>

/** How the requirements are checked. */
export interface CheckOptions {
  /** The main checkout, where every command runs. */
  readonly repo: string
  /** Each install's time limit: the merge check's. */
  readonly installLimit: Duration.Input
  /** Only check: a failed check is missing, its install not run. */
  readonly noInstall?: boolean
  /** The operating system the platforms are read for; process.platform by default. */
  readonly platform?: string
  /** Told what runs as it starts: "checking 3 requirements", "installing jq: brew install jq". */
  readonly working?: (what: string) => Effect.Effect<void>
}

/** `n` things, as "1 requirement" or "3 requirements". */
const countOf = (n: number, thing: string): string => `${n} ${thing}${n === 1 ? "" : "s"}`

/** The first line of `text`. */
const firstLine = (text: string): string => text.split("\n")[0] ?? ""

/**
 * Runs `command` with sh in `repo` within `limit`, in the environment of commands run on a branch's
 * behalf (BranchEnv): whether it exited 0.
 */
const passes = (command: string, repo: string, limit: Duration.Input) =>
  Effect.gen(function* () {
    return yield* exec({
      command: "sh",
      args: ["-c", command],
      cwd: repo,
      baseEnv: yield* BranchEnv,
      timeLimit: limit,
      maxOutputBytes: 0,
    })
  }).pipe(
    Effect.map((output) => output.exitCode === 0),
    Effect.orElseSucceed(() => false),
  )

/**
 * Runs the install `command` of the requirement `name` in `repo` within `limit`, in BranchEnv's
 * environment, its whole output in .tutti/run/: why it failed, if it did, and where its output is,
 * or why it couldn't be kept.
 */
const install = (name: string, command: string, repo: string, limit: Duration.Input) =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* Effect.result(
        openRunFile(repo, requireLogName(name), O.WRONLY | O.CREAT | O.TRUNC),
      )
      const kept =
        opened._tag === "Success"
          ? { outputFd: opened.success, output: join(repo, runFolder, requireLogName(name)) }
          : { keptError: opened.failure.message }
      const ran = yield* Effect.result(
        exec({
          command: "sh",
          args: ["-c", command],
          cwd: repo,
          baseEnv: yield* BranchEnv,
          timeLimit: limit,
          maxOutputBytes: 64 * 1024,
          ...("outputFd" in kept ? { outputFd: kept.outputFd } : {}),
        }),
      )
      const installError =
        ran._tag === "Failure"
          ? ran.failure._tag === "CommandTimedOut"
            ? `timed out: stopped after ${Duration.format(ran.failure.timeLimit)}`
            : ran.failure.reason
          : ran.success.exitCode === 0
            ? undefined
            : `exit status ${ran.success.exitCode}`
      return {
        ...(installError === undefined ? {} : { installError }),
        ...("output" in kept ? { output: kept.output } : { keptError: kept.keptError }),
      }
    }),
  )

/** Checks every requirement in `list` as `options` say (see the module's comment). */
export const checkRequires = (list: ReadonlyArray<Requirement>, options: CheckOptions) =>
  Effect.gen(function* () {
    const platform = options.platform ?? process.platform
    const working = options.working ?? (() => Effect.void)
    const due = list.filter((r) => appliesOn(r, platform))
    if (due.length > 0) yield* working(`checking ${countOf(due.length, "requirement")}`)
    const checked = yield* Effect.forEach(
      list,
      (r) =>
        appliesOn(r, platform)
          ? Effect.map(passes(r.check, options.repo, checkLimit), (met) =>
              met ? ("met" as const) : ("missing" as const),
            )
          : Effect.succeed("otherOS" as const),
      { concurrency: atOnce },
    )
    const report: Array<RequireResult> = []
    for (const [i, r] of list.entries()) {
      const state = checked[i] ?? "missing"
      if (
        state !== "missing" ||
        r.install === undefined ||
        r.install === "" ||
        options.noInstall === true
      ) {
        report.push({ requirement: r, state, ran: false })
        continue
      }
      yield* working(`installing ${r.name}: ${r.install}`)
      const installed = yield* install(r.name, r.install, options.repo, options.installLimit)
      const met =
        installed.installError === undefined && (yield* passes(r.check, options.repo, checkLimit))
      report.push({ requirement: r, state: met ? "installed" : "missing", ran: true, ...installed })
    }
    return report as RequireReport
  })

/** Whether the lists `a` and `b` are the same requirements, in the same order. */
export const sameRequires = (
  a: ReadonlyArray<Requirement>,
  b: ReadonlyArray<Requirement>,
): boolean =>
  a.length === b.length &&
  a.every((r, i) => {
    const other = b[i]
    return (
      other !== undefined &&
      r.name === other.name &&
      r.check === other.check &&
      r.install === other.install &&
      r.manual === other.manual &&
      (r.platforms ?? []).join(",") === (other.platforms ?? []).join(",")
    )
  })

/** The requirements still missing. */
export const missingOf = (report: RequireReport): RequireReport =>
  report.filter((res) => res.state === "missing")

/**
 * What to do about a requirement still missing: its manual step, or why its install didn't meet it
 * and where its output is, or that nothing installed it.
 */
export const whyMissing = (res: RequireResult): string => {
  const r = res.requirement
  if (r.manual !== undefined && r.manual !== "") return r.manual
  if (!res.ran && r.install !== undefined && r.install !== "") {
    return `'${r.check}' fails; install it with '${r.install}'`
  }
  if (!res.ran) return `'${r.check}' fails`
  const where =
    res.output === undefined
      ? `its output could not be kept: ${res.keptError ?? "unknown"}`
      : `its output is in ${res.output}`
  return res.installError !== undefined
    ? `'${r.install}' failed: ${firstLine(res.installError)}; ${where}`
    : `'${r.install}' ran, but '${r.check}' still fails; ${where}`
}

/** How `res` was found, for `tutti requires` and init: met, installed, or missing and what to do. */
export const says = (res: RequireResult): string => {
  switch (res.state) {
    case "met":
      return "met"
    case "installed":
      return `installed with '${res.requirement.install}'`
    case "otherOS":
      return `not checked: only on ${(res.requirement.platforms ?? []).join(", ")}`
    case "missing":
      return `missing: ${whyMissing(res)}`
  }
}

/**
 * How each requirement was found, the met ones and those installed first, for the run's log as it
 * starts; "" for none checked.
 */
export const summaryOf = (report: RequireReport): string => {
  const met = report.filter((res) => res.state === "met").map((res) => res.requirement.name)
  const installed = report
    .filter((res) => res.state === "installed")
    .map((res) => `${res.requirement.name} (installed with '${res.requirement.install}')`)
  const other = report
    .filter((res) => res.state === "otherOS")
    .map(
      (res) => `${res.requirement.name} (only on ${(res.requirement.platforms ?? []).join(", ")})`,
    )
  return [
    ...(met.length > 0 ? [`${met.join(", ")} met`] : []),
    ...(installed.length > 0 ? [`${installed.join(", ")} installed`] : []),
    ...(other.length > 0 ? [`${other.join(", ")} not checked`] : []),
  ].join("; ")
}

/** The first word of the line a run stops with for what is still missing. */
export const missingWord = "REQUIREMENTS_MISSING"

/**
 * What follows `REQUIREMENTS_MISSING: ` for what is still missing: each name and what to do, then
 * how to go on; "" for none.
 */
export const missingDetail = (report: RequireReport): string => {
  const missing = missingOf(report)
  if (missing.length === 0) return ""
  const each = missing.map((res) => `${res.requirement.name} (${whyMissing(res)})`).join("; ")
  return `${each}; meet ${missing.length === 1 ? "it" : "them"} (each entry of 'requires' in ${settingsFile} says how), then run again`
}

/**
 * The run's check of its requirements, as it starts and again once a merge changed them: each step
 * said as a REQUIRES line (under the START block at the start), then how they were found; what is
 * still missing, as missingDetail says it, or "" for nothing missing or none to check.
 */
export const runRequires = (list: ReadonlyArray<Requirement>, options: CheckOptions) =>
  Effect.gen(function* () {
    if (list.length === 0) return ""
    const { info } = yield* sayer
    const say = (what: string) => {
      const text = detail`${Tag.requires}: ${what}`
      return info(text)
    }
    const report = yield* checkRequires(list, { ...options, working: say })
    for (const res of report) {
      if (res.keptError !== undefined) {
        yield* say(
          line`cannot keep the output of ${res.requirement.name}'s install: ${res.keptError}`,
        )
      }
    }
    const summary = summaryOf(report)
    if (summary !== "") yield* say(summary)
    return missingDetail(report)
  })
