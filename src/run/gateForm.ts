// How a spec run's checks gate asks in a terminal (§ 4.14 "The checks gate", checksGate.ts's
// GateAsk): init's form, drawn in place of the dashboard (the screen's form slot, App.tsx), under
// the checks gate's title. A hold opens tutti checks' step at once, saying why; once the checks
// passed, the form shows what each runner runs and asks to keep them, Enter keeping them, No opening
// tutti checks' step. That step (src/init/setChecks.ts) works in a worktree of the base's head of
// its own, on no branch, under the run's lock, which the run holds already; what it changed there
// is committed (`tutti: set the checks`) and the base fast-forwarded to it, so the main checkout
// stays clean, the run taking the settings it changed (setup.ts's takeSettings), and the gate checks
// the checks again from the start. A form cancelled, or a step that changed nothing, keeps the
// checks as they are: a hold then files its question as without a terminal.
import { Effect, type FileSystem, Layer, Result, SubscriptionRef } from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { setChecks } from "../init/setChecks.ts"
import { type Machine, stepLine } from "../init/steps.ts"
import type { Scouting } from "../organs/scout.ts"
import type { Beads, TicketId } from "../services/Beads.ts"
import { Git, gitWhy, shortHash } from "../services/Git.ts"
import { RunLock } from "../services/RunLock.ts"
import { Worktrees } from "../services/Worktrees.ts"
import { type FormShown, makeInitForm } from "../ui/InitForm.tsx"
import { type FormHeading, gateHeading } from "../ui/initTitle.ts"
import { FormCancelled } from "../ui/questions.ts"
import { type GateAsk, gateFolderPrefix, type RunnerShown } from "./checksGate.ts"
import type { EventStream } from "./eventstream.ts"
import { leftWarning, worktreeWhy } from "./fullcheck.ts"
import { detail, Log, Tag, tagged } from "./log.ts"
import { type SetUps, takeSettings } from "./setup.ts"

/** The message of the commit a change made in the gate's form is committed with. */
export const setChecksMessage = "tutti: set the checks"

/** What the form asks once the checks passed. */
export const keepQuestion = "Keep these checks?"

/** What the form says under it: what each runner runs, a line each. */
export const keepDescription = (runners: ReadonlyArray<RunnerShown>): string =>
  [
    "Every merge of the spec's tree is checked with them. Yes starts the rest of the tree; No sets them in tutti checks' step.",
    ...runners.map(
      (runner) =>
        `${runner.name}: ${runner.runs.length === 0 ? "nothing" : runner.runs.join("; ")}`,
    ),
  ].join("\n")

/** What the form says under its title when the gate holds the tree, `why`. */
export const heldAbout = (why: string): string =>
  ` The checks gate holds the spec's tree: ${why}. Set the checks here, or press Esc to leave them as they are.`

/** A lock that is held already: the run's own, which tutti checks' step works under. */
const runsLock = Layer.succeed(
  RunLock,
  RunLock.of({
    acquire: () => Effect.succeed({ rewrite: () => Effect.void }),
    probe: () => Effect.succeed(undefined),
  }),
)

const gateLine = tagged(Tag.checksGate)

/**
 * The gate's asking in a terminal: init's form in `slot`, which the dashboard draws in place of its
 * screen. tutti checks' step scouts with `scout` and runs its commands on `machine`.
 */
export const makeGateAsk = <R>(options: {
  readonly slot: SubscriptionRef.SubscriptionRef<FormShown | null>
  readonly base: string
  readonly version: string
  readonly setUps: SetUps
  readonly scout: (repo: string) => Effect.Effect<Scouting, string, R>
  readonly machine: Machine
  readonly clock?: () => number
}) =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const context = yield* Effect.context<
      | AppConfig
      | Beads
      | Git
      | Worktrees
      | Log
      | EventStream
      | AgentHost
      | FileSystem.FileSystem
      | R
    >()
    const { slot, base } = options

    /** `work` with the form in place of the dashboard, under `heading`, taken away once it ends. */
    const withForm = <A, E, R2>(
      heading: FormHeading,
      work: (opened: ReturnType<typeof makeInitForm>) => Effect.Effect<A, E, R2>,
    ) =>
      Effect.gen(function* () {
        const opened = makeInitForm(options.clock)
        yield* SubscriptionRef.set(slot, { screen: opened.screen, repo: config.repo, heading })
        const cancels = opened.form.cancels ?? Effect.never
        return yield* Effect.raceFirst(work(opened), cancels)
      }).pipe(Effect.ensuring(SubscriptionRef.set(slot, null)))

    /**
     * tutti checks' step on the base's head, in a worktree of its own: `set` once what it changed
     * is committed and the base fast-forwarded to it; `left` where it was cancelled, refused or
     * changed nothing.
     */
    const change = (form: ReturnType<typeof makeInitForm>["form"]) =>
      Effect.gen(function* () {
        const git = yield* Git
        const worktrees = yield* Worktrees
        const logs = yield* Log
        const head = yield* Effect.result(git.revParse(config.repo, base))
        const commonDir = yield* Effect.result(git.commonDir(config.repo))
        if (Result.isFailure(head) || Result.isFailure(commonDir)) {
          yield* logs.write(
            gateLine`git can't read ${base} for tutti checks' step; the checks stay as they are`,
          )
          return "left" as const
        }
        const made = yield* Effect.result(worktrees.addDetached(gateFolderPrefix, head.success))
        if (Result.isFailure(made)) {
          const error = made.failure
          const why = error._tag === "ExcludeUnwritable" ? error.message : worktreeWhy(error)
          yield* logs.write(
            gateLine`no worktree for tutti checks' step (${why}); the checks stay as they are`,
          )
          return "left" as const
        }
        const dir = made.success
        const work = Effect.gen(function* () {
          const ran = yield* Effect.result(
            setChecks({
              repo: dir,
              commonDir: commonDir.success,
              branch: base,
              version: options.version,
              flags: {},
              form,
              scout: options.scout(dir),
              machine: options.machine,
            }).pipe(Effect.provide(runsLock)),
          )
          if (Result.isFailure(ran)) {
            const error = ran.failure
            if (error instanceof FormCancelled) return "left" as const
            const why =
              typeof error === "object" && error !== null && "message" in error
                ? String(error.message)
                : String(error)
            yield* logs.write(
              gateLine`tutti checks' step failed (${why}); the checks stay as they are`,
            )
            return "left" as const
          }
          yield* logs.write(...ran.success.steps.map((step) => detail`${stepLine(step)}`))
          const status = yield* Effect.result(git.status(dir))
          const paths = Result.isSuccess(status) ? status.success.map((entry) => entry.path) : []
          if (paths.length === 0) {
            yield* logs.write(
              gateLine`tutti checks' step changed nothing; the checks stay as they are`,
            )
            return "left" as const
          }
          const committed = yield* Effect.result(
            Effect.gen(function* () {
              yield* git.addPaths(dir, paths)
              yield* git.commitPaths(dir, setChecksMessage, paths)
              const at = yield* git.revParse(dir, "HEAD")
              yield* git.fastForward(config.repo, at)
              return at
            }),
          )
          if (Result.isFailure(committed)) {
            const error = committed.failure
            const why =
              error._tag === "GitFailed" || error._tag === "GitTimedOut"
                ? gitWhy(error)
                : String(error)
            yield* logs.write(
              gateLine`the checks tutti checks set couldn't be committed on ${base} (${why}); the checks stay as they are`,
            )
            return "left" as const
          }
          yield* logs.write(
            gateLine`set the checks in tutti checks' form: committed on ${base} as ${shortHash(committed.success)} (${paths.length} ${paths.length === 1 ? "file" : "files"}); checking them again`,
          )
          yield* takeSettings(
            "the checks gate" as TicketId,
            { repo: config.repo, base },
            options.setUps,
            head.success,
            committed.success,
          )
          return "set" as const
        })
        return yield* Effect.ensuring(
          work,
          Effect.catch(worktrees.removeDetached(dir), (error) =>
            leftWarning(dir, error, "the checks gate's"),
          ),
        )
      })

    const ask: GateAsk = {
      held: (why) =>
        withForm({ ...gateHeading, about: heldAbout(why) }, (opened) => change(opened.form)).pipe(
          Effect.catchTag("FormCancelled", () => Effect.succeed("left" as const)),
          Effect.provideContext(context),
        ),
      shown: (runners) =>
        withForm(gateHeading, (opened) =>
          Effect.gen(function* () {
            yield* opened.fields.step("Checks")
            const keep = yield* opened.fields.confirm({
              question: keepQuestion,
              description: keepDescription(runners),
              initial: true,
            })
            if (keep) return "accepted" as const
            const changed = yield* change(opened.form)
            return changed === "set" ? ("set" as const) : ("accepted" as const)
          }),
        ).pipe(
          Effect.catchTag("FormCancelled", () => Effect.succeed("accepted" as const)),
          Effect.provideContext(context),
        ),
    }
    return ask
  })

/** Whether `scout` is there: none without organs, when tutti checks' step starts on manual. */
export const noScout = (): Effect.Effect<Scouting, string> =>
  Effect.fail("the run has no organs to scout with")
