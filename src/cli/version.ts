// tutti's version (§ 8.1): package.json's, and for a build from a clone its commit's 12-character
// hash, plus `+dirty` when the tree had changes. A build learns its commit at build time, from the
// TUTTI_BUILD_COMMIT define `bun build` passes; run from source, tutti asks git at startup. A
// release build (from a tag) defines it as "", and has the bare version.
import { resolve } from "node:path"
import { Effect, FileSystem, Option } from "effect"
import pkg from "../../package.json" with { type: "json" }
import { exec } from "../services/exec.ts"

// `bun build --define 'TUTTI_BUILD_COMMIT:"<hash>[+dirty]"'`, or "" for a release; undefined from source.
declare const TUTTI_BUILD_COMMIT: string | undefined

/** The commit a build was made from. */
export interface BuildCommit {
  /** The first 12 characters of its hash. */
  readonly hash: string
  /** The tree had changes the commit doesn't hold. */
  readonly dirty: boolean
}

/** The version `tutti --version` shows: the bare version for a release, `<version> <hash>[+dirty]` for a clone. */
export const formatVersion = (version: string, commit: Option.Option<BuildCommit>): string =>
  Option.match(commit, {
    onNone: () => version,
    onSome: ({ hash, dirty }) => `${version} ${hash}${dirty ? "+dirty" : ""}`,
  })

/** The define's value as a commit: none for a release's "". */
export const parseBuildCommit = (define: string): Option.Option<BuildCommit> => {
  const dirty = define.endsWith("+dirty")
  const hash = (dirty ? define.slice(0, -"+dirty".length) : define).trim().slice(0, 12)
  return hash === "" ? Option.none() : Option.some({ hash, dirty })
}

// git gets a few seconds: the version is read at startup, and is shown bare without it.
const git = (root: string, args: ReadonlyArray<string>) =>
  exec({ command: "git", args, cwd: root, timeLimit: "5 seconds" }).pipe(
    Effect.flatMap((output) =>
      output.exitCode === 0 ? Effect.succeed(output.stdout) : Effect.fail(output.stderr),
    ),
  )

/**
 * The commit of the checkout tutti runs from, `root`, read with git; none when `root` isn't the top
 * of a git checkout (a source tree unpacked from an archive, or one inside another project's).
 */
export const sourceCommit = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const [revs, status] = yield* Effect.all(
      [
        git(root, ["rev-parse", "--show-toplevel", "HEAD"]),
        git(root, ["status", "--porcelain", "-z"]),
      ],
      { concurrency: 2 },
    )
    const [top, head] = revs.split("\n")
    if (top === undefined || head === undefined || head.length < 12) return Option.none()
    if ((yield* fs.realPath(top)) !== (yield* fs.realPath(root))) return Option.none()
    return Option.some<BuildCommit>({ hash: head.slice(0, 12), dirty: status !== "" })
  }).pipe(Effect.orElseSucceed(() => Option.none<BuildCommit>()))

// The checkout's top: src/cli's grandparent.
const sourceRoot = resolve(import.meta.dir, "..", "..")

/** tutti's version: the build's, from its define, or from source, the checkout's commit from git. */
export const tuttiVersion = Effect.suspend(() =>
  typeof TUTTI_BUILD_COMMIT === "string"
    ? Effect.succeed(formatVersion(pkg.version, parseBuildCommit(TUTTI_BUILD_COMMIT)))
    : Effect.map(sourceCommit(sourceRoot), (commit) => formatVersion(pkg.version, commit)),
)
