// TimeMachine (§ 11): macOS's backups, through tmutil, which the run asks to leave the worktrees'
// folder out (src/run/worktreesRoot.ts). `tmutil addexclusion <folder>` without -p is a sticky
// exclusion: an extended attribute on the folder itself, which needs no sudo and covers everything
// below it, and goes with the folder. `tmutil isexcluded <folder>` says `[Excluded]`, `[Included]`
// or, for a path that isn't there, `[UNKNOWN]`, and exits 0 for each.
import { Context, Effect, type FileSystem, Layer, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { exec, TimeLimit } from "./exec.ts"

/** tmutil couldn't be run, or failed; `reason` says how. */
export class TimeMachineFailed extends Schema.TaggedError<TimeMachineFailed>()(
  "TimeMachineFailed",
  { path: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `tmutil can't exclude ${this.path} from Time Machine: ${this.reason}`
  }
}

/** Whether tmutil isexcluded's output says the path is excluded; undefined when it says neither. */
export const parseIsExcluded = (stdout: string): boolean | undefined => {
  const said = /^\s*\[(\w+)\]/.exec(stdout)?.[1]
  return said === "Excluded" ? true : said === "Included" ? false : undefined
}

export class TimeMachine extends Context.Service<
  TimeMachine,
  {
    /** Whether Time Machine leaves `path` out of its backups, it or a folder above it excluded. */
    isExcluded(path: string): Effect.Effect<boolean, TimeMachineFailed>
    /** Excludes `path` from Time Machine's backups, stickily, on the folder itself. */
    exclude(path: string): Effect.Effect<void, TimeMachineFailed>
  }
>()("tutti/services/TimeMachine") {
  /** tmutil's, through effect/process. */
  static readonly layer = Layer.effect(
    TimeMachine,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
      >()
      const tmutil = (path: string, args: ReadonlyArray<string>) =>
        exec({ command: "tmutil", args: [...args, path], timeLimit: TimeLimit.read }).pipe(
          Effect.provideContext(context),
          Effect.mapError(
            (error) =>
              new TimeMachineFailed({
                path,
                reason: error._tag === "CommandNotRun" ? error.reason : "it timed out",
              }),
          ),
          Effect.flatMap((out) =>
            out.exitCode === 0
              ? Effect.succeed(out.stdout)
              : Effect.fail(
                  new TimeMachineFailed({
                    path,
                    reason: out.stderr.trim().split("\n")[0] || `exit ${out.exitCode}`,
                  }),
                ),
          ),
        )
      return TimeMachine.of({
        isExcluded: (path) =>
          Effect.flatMap(tmutil(path, ["isexcluded"]), (stdout) => {
            const excluded = parseIsExcluded(stdout)
            return excluded === undefined
              ? Effect.fail(
                  new TimeMachineFailed({
                    path,
                    reason: `tmutil isexcluded said ${JSON.stringify(stdout.trim())}`,
                  }),
                )
              : Effect.succeed(excluded)
          }),
        exclude: (path) => Effect.asVoid(tmutil(path, ["addexclusion"])),
      })
    }),
  )
}
