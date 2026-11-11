// The run lock (§ 9.2) a bare `tutti`'s run (src/main.ts's runFrom) holds, and the worktrees'
// root it makes ready under it.
import { Effect, Layer, Result } from "effect"
import type { GettingReady } from "../../print/gettingReady.ts"
import { currentHome } from "../../project/userConfig.ts"
import type { Started } from "../../run/startup.ts"
import { claudeProjects, readyRoot } from "../../run/worktreesRoot.ts"
import { Git } from "../../services/Git.ts"
import { type HeldLock, type Holder, RunLock } from "../../services/RunLock.ts"
import { TimeMachine } from "../../services/TimeMachine.ts"
import { version } from "../version.ts"
import { gitLayer } from "./layers.ts"
import { cannotStart } from "./preflight.ts"

/** The run as `lockRun` locked it. */
export interface Locked {
  /** The lock, held until the scope closes. */
  readonly lock: HeldLock
  /** What the lock's file names, rewritten as the run learns its scope, feature or spec. */
  readonly holder: Holder
  /** The run, its worktrees' root made ready: the START block's line for it, and its warnings. */
  readonly started: Started
}

/**
 * The run lock of the run `started`, which began at `at`, taken in the scope and held until it
 * closes, after what the scope acquires later: the run's services. Then the worktrees' root
 * (src/run/worktreesRoot.ts), with the lock held, so no other run of the repository moves its
 * worktrees meanwhile, and before the pre-flight and the run's services, which make worktrees
 * there: the default claimed, the old root's worktrees moved into it once, and its Time Machine
 * exclusion made. The exit code of a run that can't start, said on stderr once the getting-ready
 * line `ready` has gone: no git folder, or the lock held by another run.
 */
export const lockRun = (started: Started, at: string, ready: GettingReady) =>
  Effect.gen(function* () {
    const cannot = cannotStart(ready)
    const { config, base } = started
    const commonDir = yield* Effect.result(
      Effect.flatMap(Git, (git) => git.commonDir(config.repo)).pipe(Effect.provide(gitLayer)),
    )
    if (Result.isFailure(commonDir)) {
      return yield* cannot(`tutti cannot find the git folder of ${config.repo}`)
    }
    const holder: Holder = {
      pid: process.pid,
      started: at,
      version,
      branch: base,
      ...(config.ticket === null ? {} : { scope: config.ticket }),
      ...(config.feature === null ? {} : { feature: config.feature }),
      ...(started.spec == null ? {} : { spec: started.spec.path }),
    }
    const locked = yield* Effect.result(
      Effect.flatMap(RunLock, (lock) =>
        lock.acquire({ repo: config.repo, commonDir: commonDir.success, holder }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    if (Result.isFailure(locked)) return yield* cannot(locked.failure.message)
    const rooted = yield* readyRoot(config, {
      platform: process.platform,
      home: yield* currentHome,
      projects: yield* claudeProjects,
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer, TimeMachine.layer)))
    const result: Locked = {
      lock: locked.success,
      holder,
      started: {
        ...started,
        config: { ...config, worktrees: rooted.root },
        worktrees: { line: rooted.line, notes: rooted.notes },
        warnings: [...started.warnings, ...rooted.warnings],
      },
    }
    return result
  })
