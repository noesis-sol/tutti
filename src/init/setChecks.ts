// tutti checks (§ 8.1, § 8.3): init's Checks step on its own, in a project init has set up, between
// runs. It asks what the flags don't answer through init's form, in the same words: the scout, "The
// project's checks", the two checklists, "Also file tickets for untested areas?", the replace
// questions for runners that are there and differ, then the setup command; none of the step's other
// questions (the ticket prefix, the verifier). Without a terminal it asks nothing, and with no flag
// either it says what it would need. Then, holding the run lock (`"init": true`, as init holds it),
// it writes what init's Checks step writes, staged and put in together (./staged.ts), the settings
// last, so that a failure or a cancel leaves the project as it was:
//
//   scripts/check-fast.sh     the runners
//   scripts/check-full.sh
//   .claude/skills/…          the create-check-suite skill, where test work needs it
//   .tutti/settings.json      the checks' commands, time limits and setup command, the skill's
//                             template version, the features map as a shared file
//
// and files the test work init would. Its summary is init's: a line for each step, then what's left
// for you, the files to commit among it.
import { join } from "node:path"
import { Clock, Deferred, type Duration, Effect, FileSystem, type Scope } from "effect"
import type { Scouting } from "../organs/scout.ts"
import { settingsFile } from "../project/settings.ts"
import { AtomicWriter } from "../services/atomicFile.ts"
import { RunLock } from "../services/RunLock.ts"
import {
  applySkill,
  asksChecks,
  type ChecksAnswers,
  type ChecksQuestions,
  filesTestWork,
  fileTestWork,
  findFeaturesMap,
  setupSteps,
  testWork,
} from "./checks.ts"
import {
  type ChecksFlags,
  checksAsked,
  checksPlan,
  type InitForm,
  type InitSummary,
  nextSteps,
  readSettingsJson,
  refused,
  writeRunners,
  writeSettings,
} from "./init.ts"
import { fastRunner, fullRunner } from "./runners.ts"
import { commitStaged, staging } from "./staged.ts"
import { type Machine, runSteps, type Step } from "./steps.ts"

/** What tutti checks works on, and with. */
export interface ChecksOptions<R> {
  /** The main checkout. */
  readonly repo: string
  /** Its git folder that every worktree shares, absolute: where the run lock is. */
  readonly commonDir: string
  /** The branch the main checkout is on, for the lock and the test work. */
  readonly branch: string
  readonly version: string
  readonly flags: ChecksFlags
  /** init's form, whose Checks step it asks; null without a terminal, when it asks nothing. */
  readonly form: InitForm | null
  /** The scout's search for the project's suites, which the form runs: what it found, or why not. */
  readonly scout: Effect.Effect<Scouting, string, R>
  readonly machine: Machine
  /** Catches stops once the questions are answered, as init's do. */
  readonly catchStops?: (stop: () => void) => Effect.Effect<void, never, Scope.Scope>
  /** Told the name of each step as it starts. */
  readonly starting?: (step: string) => Effect.Effect<void>
}

/** Whether `flags` give tutti checks anything to do without asking. */
export const givesChecks = (flags: ChecksFlags): boolean =>
  Object.values(flags).some((value: string | Duration.Duration | undefined) => value !== undefined)

/** What tutti checks says it needs without a terminal, given no flag. */
export const checksUnasked =
  'there is no terminal to ask in: give the checks with --check-fast "<command>" and --check-full "<command>", their time limits with --check-fast-timeout and --check-full-timeout, or the setup command with --setup "<command>"'

/**
 * tutti checks in the project at `options.repo`: its summary, or why it refused, having changed
 * nothing; FormCancelled when the form was cancelled, having changed nothing either.
 */
export const setChecks = <R>(options: ChecksOptions<R>) => {
  const work = checksWork(options)
  const cancels = options.form?.cancels
  return cancels === undefined ? work : Effect.raceFirst(work, cancels)
}

/** tutti checks' work, which a cancel between questions interrupts (InitForm's `cancels`). */
const checksWork = <R>(options: ChecksOptions<R>) =>
  Effect.gen(function* () {
    const { repo, flags, form, machine } = options
    const lock = yield* RunLock
    const started = new Date(yield* Clock.currentTimeMillis).toISOString()
    const request = {
      repo,
      commonDir: options.commonDir,
      holder: {
        pid: process.pid,
        started,
        version: options.version,
        branch: options.branch,
        init: true as const,
      },
    }
    const lockRefusal = (error: { readonly message: string }) =>
      refused(
        `${error.message}. tutti checks changes the runners and settings a run works from: set the checks between runs.`,
      )
    // Refused while a run holds the lock: checked before asking, and again once answered.
    yield* Effect.scoped(lock.acquire(request)).pipe(Effect.mapError(lockRefusal))
    const existing = yield* readSettingsJson(repo)
    if (existing.json === null) {
      return yield* refused(
        `tutti init hasn't set this project up (${settingsFile} is missing): run tutti init first, which sets the checks too.`,
      )
    }
    if (form === null && !givesChecks(flags)) return yield* refused(checksUnasked)

    const asked = yield* checksAsked(repo, existing.settings, flags, options.scout)
    const questions: ChecksQuestions = {
      checks: asked.checks,
      setup: asked.setup,
      prefix: null,
      verifier: false,
    }
    const checked: ChecksAnswers =
      form !== null && asksChecks(questions) ? yield* form.checks(questions) : {}
    const choice = checked.checks
    const plan = checksPlan(flags, asked, checked, "tutti checks' form")

    const fs = yield* FileSystem.FileSystem
    /** The checks, planned as one group: the runners, the skill, the settings. */
    const planChecks = Effect.gen(function* () {
      const steps: Array<Step> = []
      steps.push(...(yield* writeRunners(repo, plan)))
      const skill = yield* applySkill(repo, choice, checked.replaceSkill ?? false)
      steps.push(...skill)
      // The features map the skill writes is a shared file, added as the test work is filed.
      const sharedFile = filesTestWork(choice) ? (yield* findFeaturesMap(repo)).path : undefined
      const written = yield* writeSettings(repo, existing, {
        concurrent: null,
        mcp: null,
        ...(flags.checkFastTimeout === undefined
          ? {}
          : { checkFastTimeout: flags.checkFastTimeout }),
        ...(flags.checkFullTimeout === undefined
          ? {}
          : { checkFullTimeout: flags.checkFullTimeout }),
        ...(plan.setup === undefined ? {} : { setup: plan.setup.trim() }),
        ...(sharedFile === undefined ? {} : { sharedFile }),
        // Checks left for later keep the settings' commands, as they keep the runners there.
        fastRunnerChecks: plan.fast.suites !== null && plan.fast.later !== true,
        fullRunnerChecks: plan.full.suites !== null && plan.full.later !== true,
        fromTemplates: {
          prompt: false,
          verifier: false,
          skill: skill.some((each) => (each.commit ?? []).length > 0),
        },
      })
      steps.push(written.step)
      steps.push(
        ...setupSteps({
          command: written.settings.checks.setup.command,
          was: asked.setupWas,
          offer: asked.setupFound.offer,
          lockfiles: asked.setupFound.lockfiles,
          unasked: form === null && questions.setup !== null,
        }),
      )
      return steps
    })

    // Whether it wrote or replaced a runner: the test work closed before is filed again then.
    let runnersWritten = false
    /** The checks, written as one group: staged as planChecks writes them, then put in together. */
    const writeChecks = Effect.gen(function* () {
      const staged = staging(fs)
      const steps = yield* planChecks.pipe(
        Effect.provideService(FileSystem.FileSystem, staged.fs),
        Effect.provideService(AtomicWriter, staged.write),
      )
      const runners = [join(repo, fastRunner), join(repo, fullRunner)]
      yield* commitStaged(fs, repo, staged.writes(), join(repo, settingsFile))
      runnersWritten = staged.writes().some((each) => runners.includes(each.path))
      return steps
    })

    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Held until it ends: no run starts on runners it writes.
        yield* lock.acquire(request).pipe(Effect.mapError(lockRefusal))
        const stop = yield* Deferred.make<void>()
        if (options.catchStops !== undefined) {
          yield* options.catchStops(() => Deferred.doneUnsafe(stop, Effect.void))
        }
        const filesTests = testWork(choice, options.branch).length > 0
        const taken = [
          {
            name: "the checks",
            run: writeChecks,
            whole: true,
            stopped: () =>
              filesTests
                ? " once it had written the files above, before filing the test work: tutti checks again files it"
                : " once it had written the files above",
          },
          ...(filesTests
            ? [
                {
                  name: "the test work",
                  run: Effect.suspend(() =>
                    fileTestWork(repo, choice, options.branch, runnersWritten, "tutti checks"),
                  ),
                  whole: false,
                  stopped: () =>
                    " while filing the test work: tutti checks again files what is missing",
                },
              ]
            : []),
        ]
        const steps = yield* runSteps(taken, stop, options.starting)
        const next = yield* nextSteps(repo, machine, steps, choice?.kind === "later")
        return {
          steps,
          next,
          ready: !steps.some((each) => each.kind === "missing"),
        } satisfies InitSummary
      }),
    )
  })
