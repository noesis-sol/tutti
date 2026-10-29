// The checks gate (§ 4.14 "The checks gate"): a spec run's setup writes runners that check nothing,
// and the breakdown's environment ticket (the solo P0 ticket file_root files under the root epic)
// gives them their suites. Every later merge of the tree relies on them, so once that ticket has
// merged, and before the run starts or resumes any other ticket of the tree, the run checks them:
//
// 1. Still empty: a runner on the base that still checks nothing (init's runsNothing), or a check
//    the settings turn off, holds the tree.
// 2. Run again: check-fast runs twice more on the base's head, three runs in all with the merge's
//    own, as init's rule for catching flaky tests has it, then check-full once, each in a worktree
//    of its own on no branch after the setup, within its time limit counted awake, its whole output
//    kept in the main checkout's .tutti/run/ and its FLAKY: warnings said. A failure holds the tree.
// 3. Shown: what each runner runs, a CHECKS_GATE line each; in a terminal, offered to change in
//    tutti checks' form (GateAsk).
//
// A hold without a terminal files a question for the maintainer, which the tree's open tickets wait
// on, and stops the run with CHECKS_HELD (exit 2). In a terminal tutti checks' form opens first, and
// a change there is committed on the base, `tutti: set the checks`, and checked from step 1 again.
//
// It runs once per spec: once it passes, the root epic's `checks_gate` metadata records the runners
// it passed (their fingerprint), so that a run carried on, or a spec update whose environment ticket
// left the runners as they were, doesn't run it again. A question answered for runners as they still
// are lets the tree go on with them; one still open holds it again. It never runs in a run that
// isn't a spec run, nor in one whose tree has no environment ticket. A quit while it runs stops it,
// skipped, and the next run runs it again. Each step is a CHECKS_GATE line; its end is a checks_gate
// record (§ 10), and the run's summary says how it went.
import { createHash } from "node:crypto"
import { Clock, Duration, Effect, Option, Ref, Result, Semaphore } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { fastRunner, fullRunner, isRunner, runnerCommands, runsNothing } from "../init/runners.ts"
import { formatDuration } from "../project/configFile.ts"
import {
  Beads,
  beadsWhy,
  HumanLabel,
  type Issue,
  MetadataKey,
  type TicketId,
} from "../services/Beads.ts"
import { type CheckError, type CheckResult, Checks, setupLogName } from "../services/Checks.ts"
import { Git, type Sha, shortHash } from "../services/Git.ts"
import { Worktrees } from "../services/Worktrees.ts"
import { flakyWarnings, howFailed, outputTo, recorded } from "./check.ts"
import { type checksGateOutcomes, type GateRan, tenths } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import {
  type FullCheckRun,
  keepRunOutput,
  leftWarning,
  removeLeftWorktrees,
  worktreeWhy,
} from "./fullcheck.ts"
import { type StopReason, soloLabel, stopFor } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { type Line, Log, line, Tag, tagged } from "./log.ts"
import { warn } from "./say.ts"
import { unmergedLabel } from "./scope.ts"
import { SpecMetadata } from "./spec.ts"

/** The root epic's metadata key recording the runners the gate passed: their fingerprint. */
export const gateKey = "checks_gate"

/** A gate question's metadata key naming its spec; beside it, `checks_gate` the runners it was for. */
export const gateSpecKey = "checks_gate_spec"

/** How the checks gate's worktrees' folder names start, under the worktrees' folder. */
export const gateFolderPrefix = "checks-gate-"

/** Whose worktrees and output they are, for a line. */
const whose = "the checks gate's"

/** The title of the question a hold files. */
export const gateQuestionTitle = "Set the checks the spec's tree is checked with"

/** A runner, or the check the settings name in its place, as the gate reads it on the base. */
export interface RunnerRead {
  /** Which check it is. */
  readonly check: "fast" | "full"
  /** The settings' command for it; null where they turn it off. */
  readonly command: string | null
  /** The runner's path, where the command is the runner. */
  readonly path: string | null
  /** The runner's script on the base; null where the command isn't a runner, or it is missing. */
  readonly script: string | null
}

/** What `runner` runs, a line each, for the gate's lines and its form: the runner's commands. */
export const runsOf = (runner: RunnerRead): ReadonlyArray<string> =>
  runner.command === null
    ? []
    : runner.script === null
      ? [runner.command]
      : runnerCommands(runner.script).filter((command) => command !== "exit 0")

/** What `runner` is called on a line: its runner's path, else its command, else its key. */
export const runnerName = (runner: RunnerRead): string =>
  runner.path ?? runner.command ?? `checks.${runner.check}.command`

/**
 * Why `runner` checks nothing, for a line; null where it checks something. A runner missing from
 * the base, or one that runs nothing but `exit 0`, checks nothing, as does a check the settings
 * turn off; a command that isn't a runner is taken to check something.
 */
export const emptyWhy = (runner: RunnerRead): string | null => {
  if (runner.command === null) return `checks.${runner.check}.command is null: nothing runs it`
  if (runner.path === null) return null
  if (runner.script === null) return `${runner.path} is not on the base`
  return runsNothing(runner.script) ? `${runner.path} checks nothing` : null
}

/**
 * The fingerprint of the runners the gate passed, as the root epic records it: the SHA-256 of each
 * one's command and script, to 16 hex digits.
 */
export const fingerprint = (runners: ReadonlyArray<RunnerRead>): string => {
  const hash = createHash("sha256")
  for (const runner of runners) {
    hash.update(`${runner.check}\0${runner.command ?? ""}\0${runner.script ?? ""}\0`)
  }
  return hash.digest("hex").slice(0, 16)
}

/**
 * The environment ticket of the spec at `path` among `issues`, the root epic's subtickets: the
 * solo P0 ticket with the spec's metadata, the last filed where there are more (a spec update's
 * own, which the gate waits for); null for none.
 */
export const environmentOf = (issues: ReadonlyArray<Issue>, path: string): Issue | null =>
  issues
    .filter(
      (issue) =>
        issue.type !== "epic" &&
        issue.priority === 0 &&
        issue.labels.includes(soloLabel) &&
        issue.metadata[SpecMetadata.spec] === path,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null

/** A time a check took, to the second: `2m5s`, `0s`. */
const took = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  return seconds === 0 ? "0s" : formatDuration(Duration.seconds(seconds))
}

/** One of the gate's lines: `CHECKS_GATE: …`. */
const gateLine = tagged(Tag.checksGate)

/** The commands a runner runs, as the gate shows them. */
export interface RunnerShown {
  readonly name: string
  readonly runs: ReadonlyArray<string>
}

/**
 * How the gate asks, in a terminal (§ 4.14): tutti checks' form in place of the dashboard. Without
 * one, the run has none, and a hold files a question.
 */
export interface GateAsk {
  /**
   * The tree is held, `why`: tutti checks' form opens. `set` once the checks it set are committed
   * on the base; `left` where it was left without setting them.
   */
  readonly held: (why: string) => Effect.Effect<"set" | "left">
  /**
   * The commands each runner runs, shown once they passed: `accepted` as they are (Enter), or `set`
   * once they were changed in tutti checks' form and committed on the base.
   */
  readonly shown: (runners: ReadonlyArray<RunnerShown>) => Effect.Effect<"accepted" | "set">
}

/** What the checks gate is given by the run. */
export interface ChecksGateOptions {
  /** The branch the run merges into. */
  readonly base: string
  /** The setup command as the run has it now, a merge's settings taken (setup.ts). */
  readonly setup: Effect.Effect<string | null>
  /** Stops the run (§ 5 item 10): a hold, CHECKS_HELD. */
  readonly stopped: (stop: StopReason) => Effect.Effect<void>
  /** Says what it runs as each check starts, for the dashboard; null once it is over. */
  readonly show?: (running: FullCheckRun | null) => Effect.Effect<void>
  /**
   * Whether the run takes work back now (holds.ts's takesBack): the gate starts only then, not
   * while a stop or the usage limit holds the run, or it winds down. Always without it.
   */
  readonly takesWork?: Effect.Effect<boolean>
  /** How it asks in a terminal; none without one. */
  readonly ask?: GateAsk
}

/** A spec run's checks gate. */
export interface ChecksGate {
  /**
   * Runs the gate where it is due: the run's environment ticket merged, and the runners on the base
   * not passed yet. Called before each look's starts and resumes, and before each start: it holds
   * them until it is over, and a hold stops the run.
   */
  readonly before: Effect.Effect<void>
  /** What the run's summary says of it; null where it didn't run. */
  readonly said: Effect.Effect<string | null>
}

/** The gate of a run that isn't a spec run: never due. */
export const noGate: ChecksGate = { before: Effect.void, said: Effect.succeed(null) }

type GateEnv = AppConfig | Beads | Checks | Git | Worktrees | Ledger | Log | EventStream

/** How a check of the gate's went. */
type CheckRan =
  | { readonly _tag: "Passed" }
  | {
      readonly _tag: "Failed"
      readonly outcome: "failed" | "timed out" | "not run"
      readonly why: Line
      readonly output?: string
    }

/**
 * The checks gate of the run onto `options.base`: none outside a spec run. It removes the gate's
 * worktrees a killed run left as it is made.
 */
export const make = (options: ChecksGateOptions): Effect.Effect<ChecksGate, never, GateEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const root = config.ticket
    const path = config.specPath
    if (root === null || path === null) return noGate
    yield* removeLeftWorktrees(gateFolderPrefix, whose)
    const context = yield* Effect.context<GateEnv>()
    const beads = yield* Beads
    const git = yield* Git
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { base } = options
    const show = options.show ?? (() => Effect.void)

    const permit = yield* Semaphore.make(1)
    // The environment ticket as bd showed it once found; undefined until it is looked for.
    const environment = yield* Ref.make<Issue | null | undefined>(undefined)
    // Set once the gate has nothing more to do in this run: it ran, or isn't due for this spec.
    const settled = yield* Ref.make(false)
    const said = yield* Ref.make<string | null>(null)

    /** The environment ticket, looked for once; undefined where bd couldn't say, to look again. */
    const findEnvironment = Effect.gen(function* () {
      const known = yield* Ref.get(environment)
      if (known !== undefined) return known
      const listed = yield* Effect.result(
        beads.list({
          all: true,
          parent: root,
          labels: [soloLabel],
          metadata: { [SpecMetadata.spec]: path },
        }),
      )
      if (Result.isFailure(listed)) {
        yield* logs.write(
          gateLine`bd can't list ${root}'s tickets for its environment ticket (${beadsWhy(listed.failure)}); looking again before the next start`,
        )
        return undefined
      }
      const found = environmentOf(listed.success, path)
      yield* Ref.set(environment, found)
      return found
    })

    /** Whether the environment ticket has merged: in this run, or closed and merged before it. */
    const merged = (issue: Issue) =>
      Effect.map(ledger.current, (state) => {
        const phase = state.tickets.get(issue.id)?.phase
        if (phase !== undefined) return phase._tag === "Done" && phase.outcome._tag === "Merged"
        return issue.status === "closed" && !issue.labels.includes(unmergedLabel)
      })

    /** The runners on the base at `at`, as the settings name the checks. */
    const readRunners = (at: Sha) =>
      Effect.forEach(
        [
          { check: "fast" as const, runner: fastRunner },
          { check: "full" as const, runner: fullRunner },
        ],
        ({ check, runner }) =>
          Effect.gen(function* () {
            const command = config.settings.checks[check].command
            const path = command !== null && isRunner(command, runner) ? runner : null
            const script =
              path === null
                ? null
                : Option.getOrNull(yield* Effect.option(git.fileAt(config.repo, at, path)))
            return { check, command, path, script } satisfies RunnerRead
          }),
      )

    const gate = (env: Issue) =>
      Effect.gen(function* () {
        const began = yield* Clock.currentTimeMillis
        const elapsed = Effect.map(Clock.currentTimeMillis, (now) => now - began)
        const ran: Array<typeof GateRan.Type> = []
        let changed = false
        const end = (
          detail: (typeof checksGateOutcomes)[number],
          text: Line,
          summary: string,
          extra: { readonly output?: string; readonly question?: TicketId } = {},
        ) =>
          Effect.gen(function* () {
            const ms = yield* elapsed
            yield* Ref.set(said, summary)
            yield* show(null)
            yield* logs.writeWith(
              [text],
              events.emit({
                kind: "checks_gate",
                detail,
                ticket: env.id,
                ran,
                seconds: tenths(ms),
                ...extra,
                ...(changed ? { changed: true } : {}),
                text,
              }),
            )
          })

        /** Holds the tree, `why`, its output's file `output` where a check failed. */
        const hold = (
          detail: "empty" | "failed" | "timed out" | "not run",
          why: Line,
          at: Sha,
          runners: ReadonlyArray<RunnerRead>,
          output?: string,
        ) =>
          Effect.gen(function* () {
            const outputSaid = output === undefined ? "" : line`; the whole output is in ${output}`
            const filed = yield* fileQuestion(env, why, outputSaid, fingerprint(runners), runners)
            const waits =
              filed.question === undefined
                ? line`; bd couldn't file the question for it (${filed.why}), so nothing records the hold`
                : line`; the spec's tree waits on ${filed.question}, a question for you`
            const text = gateLine`held on ${base} at ${shortHash(at)}: ${why}${outputSaid}${waits}`
            yield* end(detail, text, `held: ${why}${outputSaid}`, {
              ...(output === undefined ? {} : { output }),
              ...(filed.question === undefined ? {} : { question: filed.question }),
            })
            yield* options.stopped(
              stopFor(
                "CHECKS_HELD",
                `the checks gate held the spec's tree: ${why}${outputSaid}${filed.question === undefined ? "" : line`; it waits on ${filed.question}: answer it once the checks are set (tutti checks), or to go on with them as they are`}`,
              ),
            )
          })

        const run = Effect.gen(function* () {
          for (;;) {
            const head = yield* Effect.result(git.revParse(config.repo, base))
            if (Result.isFailure(head)) {
              const text = gateLine`could not read ${base}'s head (${worktreeWhy(head.failure)}); the tree starts unchecked`
              yield* end("not run", text, "not run: git couldn't read the base")
              return
            }
            const at = head.success
            const runners = yield* readRunners(at)
            const print = fingerprint(runners)
            yield* logs.write(
              gateLine`${env.id}, the spec's environment ticket, merged: checking the checks on ${base} at ${shortHash(at)} before the rest of ${root} starts`,
            )

            // Answered already for these runners, or asked and not answered yet.
            const asked = yield* Effect.result(
              beads.list({
                all: true,
                labels: [HumanLabel],
                metadata: { [gateSpecKey]: path, [gateKey]: print },
              }),
            )
            const questions = Result.isSuccess(asked) ? asked.success : []
            const answered = questions.find((issue) => issue.status === "closed")
            const open = questions.find((issue) => issue.status !== "closed")
            if (answered !== undefined) {
              yield* record(print)
              const text = gateLine`${answered.id} was answered for these checks: the tree goes on with them as they are`
              yield* end("answered", text, `answered: ${answered.id}`, { question: answered.id })
              return
            }
            if (open !== undefined) {
              const why = line`the checks are still as ${open.id} asks about`
              const text = gateLine`held on ${base} at ${shortHash(at)}: ${why}; the spec's tree waits on it`
              yield* end("waiting", text, `held: waiting on ${open.id}`, { question: open.id })
              yield* options.stopped(
                stopFor(
                  "CHECKS_HELD",
                  `the checks gate held the spec's tree: it waits on ${open.id}: answer it once the checks are set (tutti checks), or to go on with them as they are`,
                ),
              )
              return
            }

            // 1. Still empty.
            const empty = runners.flatMap((runner) => {
              const why = emptyWhy(runner)
              return why === null ? [] : [why]
            })
            if (empty.length > 0) {
              const why = empty.join(", and ") as Line
              yield* logs.write(gateLine`${why}`)
              if (options.ask !== undefined && (yield* options.ask.held(why)) === "set") {
                changed = true
                continue
              }
              yield* hold("empty", why, at, runners)
              return
            }
            yield* logs.write(
              gateLine`${runners.map(runnerName).join(" and ")} check something: running check-fast twice more and check-full once on ${shortHash(at)}`,
            )

            // 2. Run again: check-fast twice more, three runs in all with the merge's, then
            // check-full once.
            const rounds = [
              { check: "fast" as const, of: "run 2 of 3" },
              { check: "fast" as const, of: "run 3 of 3" },
              { check: "full" as const, of: "run 1 of 1" },
            ]
            let failed: {
              readonly why: Line
              readonly output?: string
              readonly detail: "failed" | "timed out" | "not run"
            } | null = null
            for (const round of rounds) {
              const runner = runners.find((each) => each.check === round.check)
              const name = runner === undefined ? round.check : runnerName(runner)
              const went = yield* runOnce(round.check, `${name} ${round.of}`, at, began)
              if (went._tag === "Failed") {
                failed = {
                  why: line`${name} ${went.why} (${round.of}, on ${shortHash(at)})`,
                  detail: went.outcome,
                  ...(went.output === undefined ? {} : { output: went.output }),
                }
                break
              }
            }
            if (failed !== null) {
              if (options.ask !== undefined) {
                const why = line`${failed.why}${failed.output === undefined ? "" : line`; the whole output is in ${failed.output}`}`
                if ((yield* options.ask.held(why)) === "set") {
                  changed = true
                  continue
                }
              }
              yield* hold(failed.detail, failed.why, at, runners, failed.output)
              return
            }

            // 3. Shown.
            const shown = runners.map((runner) => ({
              name: runnerName(runner),
              runs: runsOf(runner),
            }))
            for (const each of shown) {
              yield* logs.write(gateLine`${each.name} runs: ${each.runs.join("; ")}`)
            }
            if (options.ask !== undefined && (yield* options.ask.shown(shown)) === "set") {
              changed = true
              continue
            }
            yield* record(print)
            const ms = yield* elapsed
            const text = gateLine`passed on ${base} at ${shortHash(at)} in ${took(ms)}: check-fast three times with the merge's, check-full once; the rest of ${root} starts`
            yield* end(
              "passed",
              text,
              `passed in ${took(ms)}${changed ? ", the checks set in tutti checks" : ""}`,
            )
            return
          }
        })

        /** Runs `check` once, in a worktree of its own at `at`, the setup first. */
        const runOnce = (check: "fast" | "full", what: string, at: Sha, since: number) =>
          Effect.gen(function* () {
            const worktrees = yield* Worktrees
            const checks = yield* Checks
            const setup = yield* options.setup
            const command = config.settings.checks[check].command ?? ""
            yield* show(
              setup === null
                ? { step: "check", command, began: since, gate: true }
                : { step: "setup", command: setup, began: since, gate: true },
            )
            const made = yield* Effect.result(worktrees.addDetached(gateFolderPrefix, at))
            if (Result.isFailure(made)) {
              const error = made.failure
              const why = error._tag === "ExcludeUnwritable" ? error.message : worktreeWhy(error)
              ran.push({ check, seconds: 0, outcome: "not run" })
              return {
                _tag: "Failed",
                outcome: "not run",
                why: line`could not run: no worktree for it (${why})`,
              } satisfies CheckRan as CheckRan
            }
            const dir = made.success
            const kept = `${gateFolderPrefix}${check}-${what.replace(/\D+/g, "-").replace(/^-|-$/g, "")}.log`
            const timed = <A, E, R>(
              step: "setup" | "fast" | "full",
              effect: Effect.Effect<Result.Result<A, E>, never, R>,
              outcome: (result: Result.Result<A, E>) => (typeof GateRan.Type)["outcome"],
            ) =>
              Effect.gen(function* () {
                const start = yield* Clock.currentTimeMillis
                const result = yield* effect
                const ms = (yield* Clock.currentTimeMillis) - start
                ran.push({ check: step, seconds: tenths(ms), outcome: outcome(result) })
                return result
              })
            const outcomeOf = (result: Result.Result<CheckResult, CheckError>) =>
              Result.isSuccess(result)
                ? ("passed" as const)
                : result.failure._tag === "CheckTimedOut"
                  ? ("timed out" as const)
                  : result.failure._tag === "CheckNotRun"
                    ? ("not run" as const)
                    : ("failed" as const)
            const failedWith = (error: CheckError, name: string, setupOf?: string) =>
              Effect.gen(function* () {
                const output =
                  error._tag === "CheckNotRun"
                    ? undefined
                    : yield* keepRunOutput(dir, name, kept, whose)
                const how = howFailed(error)
                return {
                  _tag: "Failed",
                  outcome: outcomeOf(Result.fail(error)) as "failed" | "timed out" | "not run",
                  why:
                    setupOf === undefined
                      ? (how as Line)
                      : line`did not run: the setup before it, '${setupOf}', ${how}`,
                  ...(output === undefined ? {} : { output }),
                } satisfies CheckRan as CheckRan
              })
            const body = Effect.gen(function* () {
              yield* logs.write(
                gateLine`running ${what}${setup === null ? "" : line`, after '${setup}',`} in ${dir} (time limit ${formatDuration(config.settings.checks[check].timeout)})`,
              )
              if (setup !== null) {
                const setUp = yield* timed(
                  "setup",
                  Effect.scoped(
                    Effect.flatMap(
                      outputTo({ worktree: dir }, setupLogName, `${whose} setup's`),
                      (to) =>
                        recorded(
                          "setup",
                          undefined,
                          checks.setup({ cwd: dir, ...to, before: check, command: setup }),
                        ),
                    ),
                  ),
                  outcomeOf,
                )
                if (Result.isFailure(setUp))
                  return yield* failedWith(setUp.failure, setupLogName, setup)
                yield* show({ step: "check", command, began: since, gate: true })
              }
              const name = `check-${check}.log`
              const checked = yield* timed(
                check,
                Effect.scoped(
                  Effect.flatMap(outputTo({ worktree: dir }, name, `${whose} ${what}'s`), (to) =>
                    // The check record names check-fast's runs as the merge check's.
                    recorded(
                      check === "fast" ? "merge" : "full",
                      undefined,
                      checks[check]({ cwd: dir, ...to }),
                    ),
                  ),
                ),
                outcomeOf,
              )
              if (Result.isFailure(checked)) return yield* failedWith(checked.failure, name)
              const output = yield* keepRunOutput(dir, name, kept, whose)
              yield* logs.write(gateLine`${what} passed; its whole output is in ${output}`)
              if (checked.success._tag === "CheckPassed") {
                for (const text of flakyWarnings(
                  line`the checks gate's ${what}`,
                  checked.success,
                )) {
                  yield* warn(text)
                }
              }
              return { _tag: "Passed" } satisfies CheckRan as CheckRan
            })
            return yield* Effect.ensuring(
              body,
              Effect.catch(worktrees.removeDetached(dir), (error) =>
                leftWarning(dir, error, whose),
              ),
            )
          })

        /** Records on the root epic that the gate passed these runners. */
        const record = (print: string) =>
          Effect.gen(function* () {
            const set = yield* Effect.result(beads.setMetadata(root, gateKey, print))
            if (Result.isFailure(set)) {
              yield* logs.write(
                gateLine`bd can't record on ${root} that the checks passed (${beadsWhy(set.failure)}); the next run checks them again`,
              )
            }
          })

        yield* run.pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              const ms = yield* elapsed
              yield* Ref.set(said, "skipped: the run was quit while it ran")
              yield* show(null)
              const text = gateLine`stopped after ${took(ms)}, as asked; the next run checks the checks again`
              yield* logs.writeWith(
                [text],
                events.emit({
                  kind: "checks_gate",
                  detail: "skipped",
                  ticket: env.id,
                  ran,
                  seconds: tenths(ms),
                  text,
                }),
              )
            }),
          ),
        )
      })

    /**
     * Files the question a hold asks, which the tree's open tickets wait on: the question, or why
     * bd couldn't file it.
     */
    const fileQuestion = (
      env: Issue,
      why: Line,
      outputSaid: string,
      print: string,
      runners: ReadonlyArray<RunnerRead>,
    ) =>
      Effect.gen(function* () {
        const open = yield* Effect.result(beads.list({ metadata: { [SpecMetadata.spec]: path } }))
        const waiting = Result.isSuccess(open)
          ? open.success.map((issue) => issue.id).filter((id) => id !== root && id !== env.id)
          : []
        const runs = runners
          .map((runner) => {
            const commands = runsOf(runner)
            return `- ${runnerName(runner)}: ${commands.length === 0 ? "nothing" : commands.join("; ")}`
          })
          .join("\n")
        const options = [
          {
            label: "Set the checks",
            description:
              "run tutti checks in the main checkout and commit what it writes, then answer: the next run checks them again",
          },
          {
            label: "Go on as they are",
            description: "the tree runs with these checks, and its merges check only what they run",
          },
        ]
        const description =
          `The spec's environment ticket ${env.id} merged, and tutti's checks gate held the rest of ` +
          `the tree (${root}): ${why}${outputSaid}. Every merge of the tree is checked with ` +
          `scripts/check-fast.sh, and the end of the run with scripts/check-full.sh. They run:\n\n` +
          `${runs}\n\nOptions:\n` +
          options
            .map((option, i) => `${i + 1}. ${option.label}: ${option.description}`)
            .join("\n") +
          `\n\nRecommended: ${options[0]?.label}. Answered with the checks as they are, the tree goes on with them.`
        const created = yield* Effect.result(
          beads.create({
            title: gateQuestionTitle,
            description,
            type: "task",
            priority: 1,
            labels: [HumanLabel],
            ...(waiting.length === 0 ? {} : { blocks: waiting }),
            metadata: {
              [MetadataKey.options]: options,
              [MetadataKey.recommended]: 0,
              [MetadataKey.maintainerOnly]: true,
              [gateSpecKey]: path,
              [gateKey]: print,
            },
          }),
        )
        return Result.isSuccess(created)
          ? { question: created.success.id }
          : { question: undefined, why: beadsWhy(created.failure) }
      })

    const before = permit
      .withPermit(
        Effect.gen(function* () {
          if (yield* Ref.get(settled)) return
          const env = yield* findEnvironment
          if (env === undefined) return
          if (env === null) {
            yield* Ref.set(settled, true)
            return
          }
          if (!(yield* merged(env))) return
          yield* Ref.set(settled, true)
          // Passed already for the runners on the base: a run carried on, or an update that left them.
          const head = yield* Effect.result(git.revParse(config.repo, base))
          if (Result.isSuccess(head)) {
            const meta = yield* Effect.result(beads.metadata(root))
            const passed = Result.isSuccess(meta) ? meta.success[gateKey] : undefined
            if (passed !== undefined && passed === fingerprint(yield* readRunners(head.success))) {
              yield* logs.write(
                gateLine`the checks on ${base} passed it for ${path} already; not run again`,
              )
              return
            }
          }
          yield* gate(env)
        }),
      )
      .pipe(Effect.provideContext(context))

    return { before, said: Ref.get(said) } satisfies ChecksGate
  })
