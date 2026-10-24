// The RunLock (§ 9.2, § 11): one run at a time per repository, and never while orchestra runs in
// it. A run takes flock(LOCK_EX|LOCK_NB) on `<git-common-dir>/tutti.lock` and on orchestra's
// `<git-common-dir>/orchestra.lock`, and holds both until its scope closes. The system releases a
// flock however the process ends, `kill -9` included; the files are opened with O_CLOEXEC, so no
// child (a `claude`, a git command, a check) inherits a descriptor and keeps the lock after tutti.
//
// Each file then names its holder in JSON: tutti.lock the run (pid, start time, version, branch,
// scope or feature, `"init": true` for init), orchestra.lock what orchestra writes there (pid,
// started, version as `tutti <version>`, branch), so an orchestra started meanwhile refuses naming
// tutti's PID. A file is opened without O_TRUNC and rewritten only once locked: truncating first
// would wipe the holder's JSON from a file someone else holds. Once held, tutti.lock can be
// rewritten, for a feature chosen at the start question after the lock was taken.
//
// The git folder is writable from every worktree, so a worker could put a symbolic link at a lock
// file's name, or a hard link to a file of its user's: tutti would then write its JSON over that
// file and empty it on release. Each file is opened with openUnder (§ 9.1's guard: O_NOFOLLOW, a
// regular file only), one with more than one link is refused, and the holder is read from the
// descriptor the lock is on, never again by name.
//
// `tutti plan --apply` probes the locks without taking them, to warn that a run is under way: a
// shared flock for a moment, as orchestra's plan takes, which a run's retries get past.
import { fstatSync, ftruncateSync, readSync, writeSync } from "node:fs"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Option, Schema, Scope, Struct } from "effect"
import {
  close,
  flockExclusiveNonBlocking,
  flockSharedNonBlocking,
  LibcError,
  O,
  openUnder,
  unlock,
} from "../native/libc.ts"
import { clock } from "../run/localTime.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { lenientKey, Positive } from "./lenient.ts"

/** The two programs whose lock files a run takes. */
export type Program = "tutti" | "orchestra"

/** The lock file of each, in the git folder every worktree shares. */
export const lockFiles: Record<Program, string> = {
  tutti: "tutti.lock",
  orchestra: "orchestra.lock",
}

/** The run taking the lock: what tutti.lock says of it. */
export const Holder = Schema.Struct({
  pid: Schema.Number,
  /** When the run started, RFC 3339. */
  started: Schema.String,
  /** tutti's version. */
  version: Schema.String,
  /** The branch the run merges to. */
  branch: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  feature: Schema.optionalKey(Schema.String),
  init: Schema.optionalKey(Schema.Literal(true)),
})

export type Holder = Schema.Schema.Type<typeof Holder>

/**
 * What a held lock file says of its holder: each field it has with the right type. A holder that
 * has just taken the lock may not have written yet, and orchestra's file has fields of its own.
 */
const seenFields = {
  pid: Positive,
  started: Schema.String,
  version: Schema.String,
  branch: Schema.String,
  scope: Schema.String,
  feature: Schema.String,
  init: Schema.Literal(true),
}

export const SeenHolder = Schema.Struct(Struct.map(seenFields, Schema.optionalKey))

export type SeenHolder = Schema.Schema.Type<typeof SeenHolder>

/** The local time of an RFC 3339 instant as `08:31`, or undefined when it isn't one. */
const clockTime = (started: string): string | undefined => {
  const time = new Date(started).getTime()
  return Number.isNaN(time) ? undefined : clock(time)
}

/**
 * Another run holds a lock: tutti's (`program` "tutti") or orchestra's. The caller exits 2 with
 * the message, `tutti is already running in <repo> (pid 44497, since 08:31, main)`, or with
 * `(tutti init, pid 44497, …)` when init holds it, as orchestra says `(orchestra init, pid …)`.
 */
export class AlreadyRunning extends Schema.TaggedError<AlreadyRunning>()("AlreadyRunning", {
  program: Schema.Literals(["tutti", "orchestra"]),
  repo: Schema.String,
  holder: SeenHolder,
}) {
  override get message(): string {
    const { pid, started, branch, init } = this.holder
    const since = started === undefined ? undefined : clockTime(started)
    const details = [
      init === true ? `${this.program} init` : undefined,
      pid === undefined ? undefined : `pid ${pid}`,
      since === undefined ? undefined : `since ${since}`,
      branch === undefined || branch === "" ? undefined : sanitizeLine(branch),
    ].filter((part) => part !== undefined)
    const which =
      details.length > 0 ? details.join(", ") : `${lockFiles[this.program]} doesn't say which`
    const running = this.program === "tutti" ? "is already running" : "is running"
    return `${this.program} ${running} in ${sanitizeLine(this.repo)} (${which})`
  }
}

/** A lock file couldn't be opened, locked or written. */
export class LockFailed extends Schema.TaggedError<LockFailed>()("LockFailed", {
  file: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `can't take the run lock ${this.file}: ${this.reason}`
  }
}

/** What a run asks the lock for. */
export interface LockRequest {
  /** The repository, for the refusal's message. */
  readonly repo: string
  /** Its `git rev-parse --git-common-dir`, absolute: where the lock files are. */
  readonly commonDir: string
  readonly holder: Holder
}

/** A held lock file's text: each field SeenHolder has, where its value has the right type. */
const SeenHolderFile = Schema.fromJsonString(Schema.Struct(Struct.map(seenFields, lenientKey)))

const decodeHolder = Schema.decodeUnknownOption(SeenHolderFile)

/** Reads what a held lock file says of its holder; text that isn't a JSON object says nothing. */
export const parseHolder = (text: string): SeenHolder =>
  Option.getOrElse(decodeHolder(text), () => ({}))

/** The JSON tutti.lock holds for `holder`. */
export const tuttiLockText = (holder: Holder): string =>
  `${JSON.stringify(Schema.encodeSync(Holder)(holder), null, 2)}\n`

/** The JSON tutti writes to orchestra.lock for `holder`, in orchestra's shape. */
export const orchestraLockText = (holder: Holder): string =>
  `${JSON.stringify(
    {
      pid: holder.pid,
      started: holder.started,
      version: `tutti ${holder.version}`,
      branch: holder.branch,
    },
    null,
    2,
  )}\n`

/** The locks a run holds: tutti.lock's holder can be rewritten while it holds them. */
export interface HeldLock {
  /** Rewrites tutti.lock to name `holder`. */
  readonly rewrite: (holder: Holder) => Effect.Effect<void, LockFailed>
}

/** How often a held lock is tried before the run is refused, and how long apart. */
const lockAttempts = 5
const lockRetryDelay = "25 millis"

const failed = (file: string) => (error: unknown) =>
  new LockFailed({ file, reason: error instanceof Error ? error.message : String(error) })

/** What the file open at `fd` says, from its start; nothing where it can't be read. */
const readHolder = (fd: number): SeenHolder => {
  try {
    const buffer = Buffer.alloc(fstatSync(fd).size)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read)
      if (n === 0) break
      read += n
    }
    return parseHolder(buffer.subarray(0, read).toString("utf8"))
  } catch {
    return {}
  }
}

/** Fails when the file open at `fd` has another name too: a hard link to some other file. */
const singleLinked = (fd: number, file: string): Effect.Effect<void, LockFailed> =>
  Effect.try({ try: () => fstatSync(fd).nlink, catch: failed(file) }).pipe(
    Effect.flatMap((links) =>
      links > 1
        ? Effect.fail(
            new LockFailed({ file, reason: `it has ${links} links, so it may be another file` }),
          )
        : Effect.void,
    ),
  )

/**
 * Takes the flock on `<commonDir>/<program's file>` and writes `text` to it, for the scope. On
 * release the file is emptied before its descriptor closes, so it never names a run that ended.
 * Gives what writes the file again, with another text.
 */
const take = (
  request: LockRequest,
  program: Program,
  text: string,
): Effect.Effect<
  (text: string) => Effect.Effect<void, LockFailed>,
  AlreadyRunning | LockFailed,
  Scope.Scope
> => {
  const file = join(request.commonDir, lockFiles[program])
  return Effect.gen(function* () {
    const fd = yield* Effect.acquireRelease(
      openUnder(request.commonDir, lockFiles[program], O.RDWR | O.CREAT, 0o644).pipe(
        Effect.mapError(failed(file)),
      ),
      (fd) => Effect.ignore(close(fd)),
    )
    yield* singleLinked(fd, file)
    // orchestra takes a shared lock on its file for a moment (plan, init) and retries its own
    // exclusive one five times over about 100 ms to get past that; tutti does the same.
    let locked = false
    for (let attempt = 0; attempt < lockAttempts && !locked; attempt++) {
      if (attempt > 0) yield* Effect.sleep(lockRetryDelay)
      locked = yield* flockExclusiveNonBlocking(fd).pipe(Effect.mapError(failed(file)))
    }
    if (!locked) {
      const said = yield* Effect.sync(() => readHolder(fd))
      return yield* new AlreadyRunning({ program, repo: request.repo, holder: said })
    }
    yield* Effect.addFinalizer(() => Effect.ignore(Effect.try(() => ftruncateSync(fd, 0))))
    const write = (text: string) =>
      Effect.try({
        try: () => {
          ftruncateSync(fd, 0)
          writeSync(fd, text, 0)
        },
        catch: failed(file),
      })
    yield* write(text)
    return write
  })
}

/** What probing the lock asks for: the repository, and its git folder where the lock files are. */
export type ProbeRequest = Pick<LockRequest, "repo" | "commonDir">

/**
 * Whether a process holds the lock on `<commonDir>/<program's file>`: the AlreadyRunning a run
 * would be refused with, or undefined. It takes a shared flock for a moment, which a run's retries
 * get past, and creates no file: a missing one is held by nobody.
 */
const probeOne = (
  request: ProbeRequest,
  program: Program,
): Effect.Effect<AlreadyRunning | undefined, LockFailed> => {
  const file = join(request.commonDir, lockFiles[program])
  return Effect.acquireUseRelease(
    openUnder(request.commonDir, lockFiles[program], O.RDONLY).pipe(
      Effect.catchIf(
        (error) => error instanceof LibcError && error.code === "ENOENT",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError(failed(file)),
    ),
    (fd) =>
      fd === undefined
        ? Effect.succeed(undefined)
        : Effect.gen(function* () {
            const free = yield* flockSharedNonBlocking(fd).pipe(Effect.mapError(failed(file)))
            if (free) {
              yield* Effect.ignore(unlock(fd))
              return undefined
            }
            const said = yield* Effect.sync(() => readHolder(fd))
            return new AlreadyRunning({ program, repo: request.repo, holder: said })
          }),
    (fd) => (fd === undefined ? Effect.void : Effect.ignore(close(fd))),
  )
}

export class RunLock extends Context.Service<
  RunLock,
  {
    /**
     * Takes tutti.lock and then orchestra.lock in `request.commonDir`, held until the scope
     * closes. Fails with AlreadyRunning when another process holds either, holding neither then.
     */
    acquire(request: LockRequest): Effect.Effect<HeldLock, AlreadyRunning | LockFailed, Scope.Scope>
    /**
     * Whether another process holds tutti.lock or orchestra.lock in `request.commonDir`, without
     * taking either: the AlreadyRunning acquire would fail with, or undefined when neither is held.
     */
    probe(request: ProbeRequest): Effect.Effect<AlreadyRunning | undefined, LockFailed>
  }
>()("tutti/services/RunLock") {
  static readonly layer = Layer.succeed(
    RunLock,
    RunLock.of({
      acquire: (request) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            // Both are taken in a scope of their own, so a refusal of the second releases the
            // first at once, whatever the caller's scope does with the failure.
            const scope = yield* Scope.fork(yield* Scope.Scope)
            const both = Effect.gen(function* () {
              const write = yield* take(request, "tutti", tuttiLockText(request.holder))
              yield* take(request, "orchestra", orchestraLockText(request.holder))
              return {
                rewrite: (holder: Holder) => write(tuttiLockText(holder)),
              } satisfies HeldLock
            })
            const exit = yield* Effect.exit(Scope.provide(scope)(both))
            if (Exit.isFailure(exit)) yield* Scope.close(scope, exit)
            return yield* exit
          }),
        ),
      probe: (request) =>
        Effect.flatMap(probeOne(request, "tutti"), (held) =>
          held === undefined ? probeOne(request, "orchestra") : Effect.succeed(held),
        ),
    }),
  )
}
