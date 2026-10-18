// Worktrees (§ 3.3): a ticket's worktree at <worktrees>/<id> on its branch tutti/<id> (§ 11), made
// from the base or reused with what an earlier attempt left in it (§ 5 item 6); its .tutti/run/
// files, kept out of git through the repository's info/exclude as orchestra does, and opened only
// through openUnder, the symlink guard (§ 9.1); and its removal with its branch once it is done.
//
// A ticket's ID names a folder and a branch, and workers file tickets themselves: Beads checks only
// an ID's prefix, so one like x-../../y reaches the run. An ID that could lead out of the worktree
// folder, or that git can't take in a branch name, is BadTicketId before anything is made from it.
//
// A worktree's .tutti/run/ is its worker's to change, and a worker reads ticket text tutti can't
// fully trust. Had it put a symbolic link in place of .tutti, .tutti/run or a file there, tutti
// would write wherever that led, and git's ignore rule for the folder (/.tutti/run/, which matches a
// folder and not a link) wouldn't cover files written through it, for a worker's git add -A to
// commit. So every link on the way is refused, wherever it points, with RunFilesOutside.
import { lstatSync, mkdirSync, readSync, writeSync } from "node:fs"
import { join } from "node:path"
import { Context, Effect, FileSystem, Layer, Schema, type Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import {
  close,
  type LibcError,
  O,
  openUnder,
  type PathRefused,
  SymlinkRefused,
} from "../native/libc.ts"
import { type Commit, Git, type GitError, GitFailed, GitWriter, type StatusEntry } from "./Git.ts"

/** A ticket ID that can't name a worktree folder and a branch; `why` says what is wrong with it. */
export class BadTicketId extends Schema.TaggedError<BadTicketId>()("BadTicketId", {
  id: Schema.String,
  why: Schema.String,
}) {
  override get message(): string {
    return `${this.why}: ${JSON.stringify(this.id)}`
  }
}

/** A symbolic link stands at `path` (relative to the worktree) on the way to a run file. */
export class RunFilesOutside extends Schema.TaggedError<RunFilesOutside>()("RunFilesOutside", {
  worktree: Schema.String,
  path: Schema.String,
}) {
  override get message(): string {
    return `${join(this.worktree, this.path)} is a symbolic link; tutti writes a worker's run files only in its worktree's own ${runFolder} folder, which git ignores`
  }
}

/** The repository's info/exclude couldn't be read or written; it is left as it was. */
export class ExcludeUnwritable extends Schema.TaggedError<ExcludeUnwritable>()(
  "ExcludeUnwritable",
  { file: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.file} can't be updated: ${this.reason}`
  }
}

export type RunFilesError = RunFilesOutside | LibcError | PathRefused

/** The folder, relative to a checkout, of the files tutti keeps there (§ 9.1). */
export const runFolder = ".tutti/run"

/** The info/exclude entry that keeps every worktree's .tutti/run/ out of git. */
export const runExcludeEntry = `/${runFolder}/`

const runExcludeComment = "# per-ticket files written by tutti"

/** The branch a ticket's worker commits on, in its own worktree (§ 11). */
export const branchOf = (id: string): string => `tutti/${id}`

/** Whether git refuses the character anywhere in a ref name (git help check-ref-format). */
const notInRef = (char: string): boolean =>
  char < " " || char === "\u007f" || " ~^:?*[".includes(char)

/**
 * A character an ID can't show: a control, format, private-use, surrogate or unassigned character
 * (\p{C}), or a separator. git takes C1 controls such as U+009B, the 8-bit CSI, and format
 * characters such as U+202E, which reorders the text after it, but an ID is printed wherever tutti
 * reports on its ticket.
 */
const notPrintable = /[\p{C}\p{Z}]/u

/**
 * Says why ticket `id` can't be run, or returns undefined, as orchestra's IDProblem does. It must be
 * a plain name for a folder (no path separator, no `..`, not `.`), one git takes in a branch name,
 * and every character of it printable.
 */
export const ticketIdProblem = (id: string): string | undefined => {
  if (id === "" || id === "." || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return "IDs with path characters can't be run"
  }
  if (
    id.startsWith(".") ||
    id.endsWith(".") ||
    id.endsWith(".lock") ||
    id.includes("@{") ||
    Array.from(id).some(notInRef)
  ) {
    return "IDs that can't name a git branch can't be run"
  }
  if (notPrintable.test(id)) return "IDs with control or invisible characters can't be run"
  return undefined
}

/** The ID itself, or BadTicketId saying why it can't be run. */
export const checkTicketId = (id: string): Effect.Effect<string, BadTicketId> => {
  const why = ticketIdProblem(id)
  return why === undefined ? Effect.succeed(id) : Effect.fail(new BadTicketId({ id, why }))
}

/** What an earlier attempt at a ticket left: nothing in a new worktree. */
export interface Earlier {
  /** The commits on its branch the base doesn't have (`git log <base>..HEAD`), newest first. */
  readonly commits: ReadonlyArray<Commit>
  /** Its uncommitted changes and untracked files (`git status`). */
  readonly status: ReadonlyArray<StatusEntry>
}

export const nothingEarlier: Earlier = { commits: [], status: [] }

/** Whether an earlier attempt left work: commits, uncommitted changes, or both. */
export const leftWork = (earlier: Earlier): boolean =>
  earlier.commits.length > 0 || earlier.status.length > 0

/** A ticket's worktree, ready for its worker. */
export interface TicketWorktree {
  readonly id: string
  /** `tutti/<id>`. */
  readonly branch: string
  /** The worktree's folder, absolute. */
  readonly path: string
  /** Its worktree or its branch was there already, left by an earlier attempt. */
  readonly reused: boolean
  readonly earlier: Earlier
}

/**
 * Adds `/.tutti/run/` to the info/exclude in the git folder `commonDir`, unless it has it, keeping
 * every other line. info/exclude is shared by every worktree and never committed, so the run files
 * are ignored even on a branch cut before .tutti/.gitignore was committed. The file is rewritten
 * atomically (a temporary file beside it, then a rename), and through a link to it, as git reads
 * it: the user's entries, which git keeps nowhere else, are never left half written.
 */
export const ensureExcluded = (
  commonDir: string,
): Effect.Effect<void, ExcludeUnwritable, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const linked = join(commonDir, "info", "exclude")
    const file = yield* fs.realPath(linked).pipe(Effect.orElseSucceed(() => linked))
    const unwritable = (error: PlatformError) =>
      new ExcludeUnwritable({ file, reason: error.message })
    const text = yield* fs.readFileString(file).pipe(
      Effect.catchTag("PlatformError", (error) =>
        // Rewriting a file that couldn't be read would lose the entries it holds.
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(unwritable(error)),
      ),
    )
    const lines = text === "" ? [] : text.replace(/\n+$/, "").split("\n")
    if (lines.some((line) => line.trim() === runExcludeEntry)) return
    const updated = `${[...lines, runExcludeComment, runExcludeEntry].join("\n")}\n`
    const folder = join(file, "..")
    // A name of its own, so a temporary file a crash left behind is never in the way.
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(folder, { recursive: true })
      yield* fs.writeFileString(temporary, updated)
      yield* fs.rename(temporary, file)
    }).pipe(
      Effect.tapError(() => Effect.ignore(fs.remove(temporary))),
      Effect.mapError(unwritable),
    )
  })

// makeRunFolder makes .tutti and .tutti/run in the worktree where they are missing, stopping at
// anything that isn't a folder, which openUnder then refuses: nothing is made through a link. A
// folder that can't be made is left for openUnder to fail on, saying why.
const makeRunFolder = (worktree: string): void => {
  for (const folder of [join(worktree, ".tutti"), join(worktree, runFolder)]) {
    try {
      if (!lstatSync(folder).isDirectory()) return
    } catch {
      try {
        mkdirSync(folder)
      } catch {
        return
      }
    }
  }
}

/**
 * Opens `name` (a path below the worktree's .tutti/run/) with `flags`, through openUnder, making the
 * folder first when it is missing. A symbolic link anywhere from the worktree down is refused with
 * RunFilesOutside, naming it. The descriptor is closed with the scope.
 */
export const openRunFile = (
  worktree: string,
  name: string,
  flags: number,
  mode = 0o644,
): Effect.Effect<number, RunFilesError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      makeRunFolder(worktree)
      return openUnder(worktree, `${runFolder}/${name}`, flags, mode)
    }).pipe(
      Effect.catchIf(
        (error): error is SymlinkRefused => error instanceof SymlinkRefused,
        (error) => Effect.fail(new RunFilesOutside({ worktree, path: error.component })),
      ),
    ),
    (fd) => Effect.ignore(close(fd)),
  )

/**
 * Checks that the worktree's .tutti/run/ is a folder of its own, making it when it is missing: a
 * symbolic link in place of .tutti or .tutti/run is refused with RunFilesOutside, naming it, before
 * a worker is started there (§ 9.1).
 */
export const checkRunFolder = (worktree: string): Effect.Effect<void, RunFilesError> =>
  Effect.suspend(() => {
    makeRunFolder(worktree)
    return openUnder(worktree, runFolder, O.RDONLY | O.DIRECTORY)
  }).pipe(
    Effect.flatMap((fd) => Effect.ignore(close(fd))),
    Effect.catchIf(
      (error): error is SymlinkRefused => error instanceof SymlinkRefused,
      (error) => Effect.fail(new RunFilesOutside({ worktree, path: error.component })),
    ),
  )

/** Writes `text` to the run file `name` in the worktree, replacing what it held (see openRunFile). */
export const writeRunFile = (
  worktree: string,
  name: string,
  text: string,
): Effect.Effect<void, RunFilesError> =>
  Effect.scoped(
    Effect.flatMap(openRunFile(worktree, name, O.WRONLY | O.CREAT | O.TRUNC), (fd) =>
      Effect.sync(() => {
        const bytes = Buffer.from(text, "utf8")
        for (let written = 0; written < bytes.length; ) {
          written += writeSync(fd, bytes, written)
        }
      }),
    ),
  )

/** The first `most` bytes of the run file `name` in the worktree, as text (see openRunFile). */
export const readRunFile = (
  worktree: string,
  name: string,
  most = 4096,
): Effect.Effect<string, RunFilesError> =>
  Effect.scoped(
    Effect.flatMap(openRunFile(worktree, name, O.RDONLY), (fd) =>
      Effect.sync(() => {
        const bytes = Buffer.alloc(most)
        let read = 0
        for (let n = -1; n !== 0 && read < most; read += n) {
          n = readSync(fd, bytes, read, most - read, null)
        }
        return bytes.subarray(0, read).toString("utf8")
      }),
    ),
  )

export class Worktrees extends Context.Service<
  Worktrees,
  {
    /**
     * The ticket's worktree on tutti/<id>: the one an earlier attempt left, or a new one at
     * <worktrees>/<id> on its branch (made from the base when there is none), with what an earlier
     * attempt left on it. Its run files are excluded from git first.
     */
    prepare(id: string): Effect.Effect<TicketWorktree, BadTicketId | GitError | ExcludeUnwritable>
    /**
     * Removes the ticket's worktree and then its branch, each when there is one. git refuses a
     * worktree with changes and a branch the base doesn't have, unless forced.
     */
    remove(
      id: string,
      options?: { readonly force?: boolean },
    ): Effect.Effect<void, BadTicketId | GitError>
    /**
     * A new worktree in a folder of its own under the worktrees' folder, its name starting with
     * `prefix`, with `commit` checked out on no branch, its run files excluded from git first: the
     * full check's (§ 5 item 12). Its path, absolute.
     */
    addDetached(
      prefix: string,
      commit: string,
    ): Effect.Effect<string, GitError | ExcludeUnwritable | PlatformError>
    /**
     * Removes a worktree addDetached made, whatever was left in it, and has git forget it: its
     * folder is deleted, then git's worktrees are pruned.
     */
    removeDetached(path: string): Effect.Effect<void, GitError | PlatformError>
    /** Opens a file under a worktree's .tutti/run/ (see openRunFile). */
    openRunFile(
      worktree: string,
      name: string,
      flags: number,
      mode?: number,
    ): Effect.Effect<number, RunFilesError, Scope.Scope>
    /** Checks a worktree's .tutti/run/ before its worker starts (see checkRunFolder). */
    checkRunFolder(worktree: string): Effect.Effect<void, RunFilesError>
    /** Writes a file under a worktree's .tutti/run/ (see writeRunFile). */
    writeRunFile(worktree: string, name: string, text: string): Effect.Effect<void, RunFilesError>
  }
>()("tutti/services/Worktrees") {
  /**
   * The worktrees of the repository at `repo` (its main checkout), each at `<root>/<id>`, their
   * branches made from `base`.
   */
  static readonly layer = (options: {
    readonly repo: string
    readonly root: string
    readonly base: string
  }) =>
    Layer.effect(
      Worktrees,
      Effect.gen(function* () {
        const git = yield* Git
        const writer = yield* GitWriter
        const fs = yield* FileSystem.FileSystem
        const { repo, root, base } = options

        // Whether the branch exists: rev-parse --verify --quiet says nothing and exits 1 when not.
        const hasBranch = (branch: string) =>
          git.revParse(repo, `refs/heads/${branch}`).pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => error instanceof GitFailed && error.exitCode === 1 && error.stderr === "",
              () => Effect.succeed(false),
            ),
          )

        // The worktree that has the branch checked out, if one does; a prunable one doesn't count.
        const worktreeOf = (branch: string) =>
          Effect.map(git.worktrees(repo), (worktrees) =>
            worktrees.find((worktree) => worktree.branch === branch && !worktree.prunable),
          )

        const earlierIn = (path: string) =>
          Effect.all({ commits: git.log(path, base), status: git.status(path) })

        const prepare = (id: string) =>
          Effect.gen(function* () {
            yield* checkTicketId(id)
            const branch = branchOf(id)
            // One writer from looking for the worktree to making it, so no other makes it meanwhile.
            return yield* writer.withLock(
              Effect.gen(function* () {
                yield* ensureExcluded(yield* git.commonDir(repo)).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                )
                // Forgets a worktree whose folder was deleted, so it isn't reused.
                yield* git.pruneWorktrees(repo)
                const existing = yield* worktreeOf(branch)
                if (existing !== undefined) {
                  const earlier = yield* earlierIn(existing.path)
                  return { id, branch, path: existing.path, reused: true, earlier }
                }
                const path = join(root, id)
                const branchLeft = yield* hasBranch(branch)
                yield* git.addWorktree(repo, path, branchLeft ? { branch } : { branch, base })
                const earlier = branchLeft ? yield* earlierIn(path) : nothingEarlier
                return { id, branch, path, reused: branchLeft, earlier }
              }),
            )
          })

        const remove = (id: string, removal: { readonly force?: boolean } = {}) =>
          Effect.gen(function* () {
            yield* checkTicketId(id)
            const branch = branchOf(id)
            const force = removal.force === true
            yield* writer.withLock(
              Effect.gen(function* () {
                const existing = yield* worktreeOf(branch)
                if (existing !== undefined)
                  yield* git.removeWorktree(repo, existing.path, { force })
                yield* git.pruneWorktrees(repo)
                if (yield* hasBranch(branch)) yield* git.deleteBranch(repo, branch, { force })
              }),
            )
          })

        const addDetached = (prefix: string, commit: string) =>
          writer.withLock(
            Effect.gen(function* () {
              yield* ensureExcluded(yield* git.commonDir(repo)).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              )
              yield* fs.makeDirectory(root, { recursive: true })
              const path = yield* fs.makeTempDirectory({ directory: root, prefix })
              // git forgets what it registered of a worktree it couldn't make on the next prune.
              yield* git
                .addDetachedWorktree(repo, path, commit)
                .pipe(Effect.tapError(() => Effect.ignore(fs.remove(path, { recursive: true }))))
              return path
            }),
          )

        const removeDetached = (path: string) =>
          Effect.andThen(
            fs.remove(path, { recursive: true, force: true }),
            git.pruneWorktrees(repo),
          )

        return Worktrees.of({
          prepare,
          remove,
          addDetached,
          removeDetached,
          openRunFile,
          checkRunFolder,
          writeRunFile,
        })
      }),
    )
}
