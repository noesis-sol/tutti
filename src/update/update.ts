// tutti update (§ 12, § 8.1): replaces the tutti binary with the latest GitHub Release's, as
// orchestra update does. It reads the latest release, downloads checksums.txt and its signature,
// checksums.txt.sig, verifies the signature with the release keys built into the binary (keys.ts)
// before trusting a sum in it, downloads the archive of its own build's target and checks its
// SHA-256 against checksums.txt, writes the tutti in it to a file beside the binary, checks that it
// runs and names the release's version, and renames it over the binary. On every failure the old
// binary is left as it was and the file beside it removed.
//
// A build picks the archive of its own target, which its entry names (src/entries/<target>.ts): a
// musl build updates to the musl archive, a glibc build to the glibc one. Moving from one to the
// other is a reinstall with scripts/install.sh. A build from a clone is replaced only with --force;
// a tutti run from source (bun src/main.ts) is never, as the binary running it is Bun.
//
// A run going doesn't hold it off: nothing runs the binary during a run, and the rename leaves a
// run with the build it started with; the next run starts the new one.
//
// The daily check (§ 12, § 7.11 "A newer release"): a release build asks GitHub for the latest
// release in the background as a run starts, at most once a day, keeping the answer in
// `<cache>/tutti/latest-release.json`, and the run ends with a line saying when a newer release is
// out. TUTTI_NO_UPDATE_CHECK=1 turns it off. A check never fails or slows a run: its errors are
// ignored, and one still going as the run ends says nothing.
import { createHash, verify } from "node:crypto"
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { Duration, Effect, Option, Result, Schema, type Scope } from "effect"
import { onOff } from "../cli/flags.ts"
import { exec, TimeLimit } from "../services/exec.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
import { parsePublicKey, type ReleaseKey } from "./keys.ts"

/** The GitHub API's address for tutti's repository, which is public: its requests need no token. */
export const repositoryApi = "https://api.github.com/repos/noesis-sol/tutti"

/** The file of a release's SHA-256 sums, and of its ed25519 signature. */
export const checksumsName = "checksums.txt"
export const signatureName = "checksums.txt.sig"

/** Time limits on the requests: one still going at its limit is stopped and fails. */
export const limits = {
  /** The latest release's details, checksums.txt and its signature. */
  request: Duration.seconds(30),
  /** The archive, which holds Claude Code too. */
  download: Duration.minutes(10),
  /** The daily check's request for the latest release. */
  check: Duration.seconds(5),
} as const

/** How long the daily check's answer stands before GitHub is asked again. */
export const checkEvery = Duration.hours(24)

// Size limits on what the requests read: far above what a release has, below what would fill memory.
const maxDetails = 4 * 1024 * 1024
const maxArchive = 1024 * 1024 * 1024

/** tutti update couldn't update, and says why; the binary is unchanged. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()("UpdateFailed", {
  message: Schema.String,
}) {}

/** The binary's folder can't be written in, such as root's /usr/local/bin. */
export class CannotWrite extends Schema.TaggedError<CannotWrite>()("CannotWrite", {
  dir: Schema.String,
  message: Schema.String,
}) {}

/** The requests' fetch: the global one, or a test's. */
export type Fetch = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<Response>

/** Where releases are read from. */
export interface Releases {
  /** The repository's API address, without a trailing slash. */
  readonly api: string
  readonly fetch: Fetch
}

/** GitHub's releases of tutti. */
export const githubReleases: Releases = {
  api: repositoryApi,
  fetch: (url, init) => fetch(url, init),
}

/** A GitHub Release of tutti. */
export interface Release {
  /** Its version, v0.9.0. */
  readonly tag: string
  /** Its page. */
  readonly url: string
  /** The download address of each file attached, by name. */
  readonly assets: ReadonlyMap<string, string>
}

// A version: a semantic version with an optional leading v (v0.9.0, 1.2.0-rc.1), its build
// metadata (+…) ignored. The numbers are kept as written, without leading zeros, so longer is larger.
interface Semver {
  readonly core: readonly [string, string, string]
  readonly pre: ReadonlyArray<string>
}

const numeric = /^(0|[1-9]\d*)$/
const identifier = /^[0-9A-Za-z-]+$/

const parseSemver = (text: string): Semver | null => {
  const bare = (text.startsWith("v") ? text.slice(1) : text).split("+")[0] ?? ""
  const dash = bare.indexOf("-")
  const core = (dash === -1 ? bare : bare.slice(0, dash)).split(".")
  const pre = dash === -1 ? [] : bare.slice(dash + 1).split(".")
  const [major, minor, patch] = core
  if (core.length !== 3 || major === undefined || minor === undefined || patch === undefined) {
    return null
  }
  if (!core.every((part) => numeric.test(part))) return null
  if (!pre.every((part) => identifier.test(part) && (!/^\d+$/.test(part) || numeric.test(part)))) {
    return null
  }
  return { core: [major, minor, patch], pre }
}

/** Whether `text` is a version: a release tag such as v0.9.0 or v1.2.0-rc.1. */
export const isVersion = (text: string): boolean => parseSemver(text) !== null

const compareNumbers = (a: string, b: string): number =>
  a.length !== b.length ? Math.sign(a.length - b.length) : a < b ? -1 : a > b ? 1 : 0

/**
 * Compares the versions `a` and `b` by semantic-version precedence: -1 when `a` is older, 0 when
 * they rank the same, 1 when `a` is newer; none when either isn't a version.
 */
export const compareVersions = (a: string, b: string): Option.Option<-1 | 0 | 1> => {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (x === null || y === null) return Option.none()
  const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0) as -1 | 0 | 1
  for (let i = 0; i < 3; i++) {
    const c = compareNumbers(x.core[i] ?? "", y.core[i] ?? "")
    if (c !== 0) return Option.some(sign(c))
  }
  // A release ranks above its pre-releases.
  if (x.pre.length === 0 || y.pre.length === 0) {
    return Option.some(sign(y.pre.length - x.pre.length))
  }
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i] ?? ""
    const q = y.pre[i] ?? ""
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    // Numbers rank below words.
    const c = pn && qn ? compareNumbers(p, q) : pn ? -1 : qn ? 1 : p < q ? -1 : p > q ? 1 : 0
    if (c !== 0) return Option.some(sign(c))
  }
  return Option.some(sign(x.pre.length - y.pre.length))
}

/** The running build. */
export interface Build {
  /** package.json's version, 0.9.0. */
  readonly version: string
  /** The version as `tutti --version` shows it, with a clone's commit: 0.9.0 0123456789ab. */
  readonly shown: string
  /**
   * A release (built from a tag), a build from a clone, tutti run from source, or the npm package's
   * bundle, run by Bun and updated by the package manager that installed it.
   */
  readonly kind: "release" | "clone" | "source" | "npm"
  /** Its target, as its entry names it (darwin-arm64, linux-x64-musl); null from source. */
  readonly target: string | null
  /** The binary to replace. */
  readonly exe: string
}

/** The npm package's name, and how to get its latest version, for tutti update's lines. */
export const npmPackage = "@noesis-sol/tutti"
const npmUpgrade = `bunx ${npmPackage}@latest runs it, and bun add ${npmPackage}@latest (with -g where it is installed globally) installs it`

/** The name of the release `tag`'s archive for `target`: tutti_0.9.0_linux_x64_musl.tar.gz. */
export const archiveName = (tag: string, target: string): string =>
  `tutti_${tag.replace(/^v/, "")}_${target.replaceAll("-", "_")}.tar.gz`

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Reads at most `max` bytes of `response`'s body; null past them. */
const readLimited = async (response: Response, max: number): Promise<Uint8Array | null> => {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Array<Uint8Array> = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.length
  }
  return body
}

/** GETs `url` within `limit`, sending `accept`, and returns its body of at most `max` bytes. */
const get = (
  releases: Releases,
  url: string,
  options: { readonly accept: string; readonly limit: Duration.Duration; readonly max: number },
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await releases.fetch(url, {
        headers: { Accept: options.accept, "User-Agent": "tutti-update" },
        signal,
      })
      const body = await readLimited(response, options.max)
      if (body === null) {
        throw new Error(`GET ${url}: over ${Math.round(options.max / 1024 / 1024)} MB`)
      }
      if (response.status !== 200) {
        // GitHub's message, when it gave one.
        let message = ""
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
          if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
            message = typeof parsed.message === "string" ? `: ${parsed.message}` : ""
          }
        } catch {}
        throw new Error(`GET ${url}: ${response.status} ${response.statusText}${message}`)
      }
      return body
    },
    catch: (error) => new UpdateFailed({ message: describe(error) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.limit,
      orElse: () =>
        Effect.fail(
          new UpdateFailed({
            message: `GET ${url}: timed out after ${Duration.format(options.limit)}`,
          }),
        ),
    }),
  )

/** The latest release, which GitHub never makes a draft or a pre-release. */
export const latestRelease = (
  releases: Releases,
  limit: Duration.Duration = limits.request,
): Effect.Effect<Release, UpdateFailed> =>
  Effect.gen(function* () {
    const body = yield* get(releases, `${releases.api}/releases/latest`, {
      accept: "application/vnd.github+json",
      limit,
      max: maxDetails,
    })
    const cannotRead = (why: string) =>
      new UpdateFailed({ message: `cannot read the latest release: ${why}` })
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(new TextDecoder().decode(body)),
      catch: (error) => cannotRead(describe(error)),
    })
    const decoded = yield* Schema.decodeUnknownEffect(LatestJson)(parsed).pipe(
      Effect.mapError((error) => cannotRead(error.message)),
    )
    if (!isVersion(decoded.tag_name)) {
      return yield* cannotRead(`its tag '${sanitizeLine(decoded.tag_name)}' is not a version`)
    }
    return {
      tag: decoded.tag_name,
      url: decoded.html_url,
      assets: new Map(decoded.assets.map((asset) => [asset.name, asset.browser_download_url])),
    }
  })

// The parts of GitHub's release JSON tutti update reads.
const LatestJson = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
})

/** The SHA-256 that `sums`, a checksums.txt ("<sha256>  <name>" a line), gives `name`. */
export const checksumOf = (sums: string, name: string): Option.Option<string> => {
  for (const line of sums.split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields.length === 2 && fields[1]?.replace(/^\*/, "") === name) {
      return Option.some((fields[0] ?? "").toLowerCase())
    }
  }
  return Option.none()
}

/**
 * Whether `signature` is an ed25519 signature of `sums` by one of `keys`: none when it is, else why
 * it isn't. The release wasn't made by the release workflow, or was changed since.
 */
export const signatureProblem = (
  sums: Uint8Array,
  signature: Uint8Array,
  keys: ReadonlyArray<ReleaseKey>,
): Option.Option<string> => {
  const doesnt = (why: string) =>
    Option.some(`${signatureName} doesn't verify ${checksumsName}: ${why}`)
  if (signature.length !== 64) {
    return doesnt(`it has ${signature.length} bytes, not an ed25519 signature's 64`)
  }
  for (const key of keys) {
    const parsed = parsePublicKey(key.pem)
    if (typeof parsed !== "string" && verify(null, sums, parsed, signature)) return Option.none()
  }
  return doesnt("it isn't signed by a release key")
}

/** The release's files that an update downloads: the archive's name, and each one's address. */
interface Assets {
  readonly archive: string
  readonly archiveUrl: string
  readonly sumsUrl: string
  readonly sigUrl: string
}

/** The release's files that an update downloads, for `target`. */
const assetsOf = (release: Release, target: string): Effect.Effect<Assets, UpdateFailed> =>
  Effect.gen(function* () {
    const archive = archiveName(release.tag, target)
    const find = (name: string, what: string) => {
      const url = release.assets.get(name)
      return url === undefined
        ? Effect.fail(new UpdateFailed({ message: `release ${release.tag} has no ${what}` }))
        : Effect.succeed(url)
    }
    return {
      archive,
      archiveUrl: yield* find(archive, `archive for ${target} (${archive})`),
      sumsUrl: yield* find(checksumsName, checksumsName),
      sigUrl: yield* find(signatureName, signatureName),
    }
  })

/**
 * Downloads checksums.txt and its signature, verifies the signature with `keys`, then downloads the
 * archive and checks its SHA-256 against checksums.txt, and returns the archive.
 */
const fetchVerified = (releases: Releases, assets: Assets, keys: ReadonlyArray<ReleaseKey>) =>
  Effect.gen(function* () {
    const details = { accept: "application/octet-stream", limit: limits.request, max: maxDetails }
    const sums = yield* get(releases, assets.sumsUrl, details)
    const signature = yield* get(releases, assets.sigUrl, details)
    // Verified before any sum in it is trusted, or the archive downloaded.
    const problem = signatureProblem(sums, signature, keys)
    if (Option.isSome(problem)) return yield* new UpdateFailed({ message: problem.value })
    const want = checksumOf(new TextDecoder().decode(sums), assets.archive)
    if (Option.isNone(want)) {
      return yield* new UpdateFailed({
        message: `${checksumsName} has no sum for ${assets.archive}`,
      })
    }
    const archive = yield* get(releases, assets.archiveUrl, {
      accept: "application/octet-stream",
      limit: limits.download,
      max: maxArchive,
    })
    const got = createHash("sha256").update(archive).digest("hex")
    if (got !== want.value) {
      return yield* new UpdateFailed({
        message: `${assets.archive} has SHA-256 ${got}, but ${checksumsName} says ${want.value}`,
      })
    }
    return archive
  })

/** The file called tutti in the tar.gz `archive`. */
const tuttiIn = (archive: Uint8Array, name: string) =>
  Effect.tryPromise({
    try: async () => {
      const files = await new Bun.Archive(archive).files()
      for (const [path, file] of files) {
        if (path.replace(/^\.\//, "") === "tutti") return await file.bytes()
      }
      throw new Error("no tutti in it")
    },
    catch: (error) =>
      new UpdateFailed({ message: `cannot extract tutti from ${name}: ${describe(error)}` }),
  })

// A folder tutti update may not write in: one it lacks the permission for, or a read-only one.
const cannotWrite = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS")

/** Writes `bytes` to the new file `path`, and syncs it to disk. */
const writeSynced = (path: string, bytes: Uint8Array) => {
  const fd = openSync(path, "w", 0o600)
  try {
    for (let written = 0; written < bytes.length; ) {
      written += writeSync(fd, bytes, written)
    }
    // On disk before the rename makes it the binary: otherwise a power loss soon after could keep
    // the rename and lose the data, an empty tutti in place of the old one.
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Replaces the binary at `exe`, through any symbolic links, with `release`'s for `target`, verified
 * with `keys`; it returns the path it replaced. The new file is made beside it first, so that a
 * folder it can't write in fails before the download, and removed on any failure or interruption.
 */
export const install = (options: {
  readonly releases: Releases
  readonly keys: ReadonlyArray<ReleaseKey>
  readonly release: Release
  readonly target: string
  readonly exe: string
}) =>
  Effect.gen(function* () {
    const exe = yield* Effect.try({
      try: () => realpathSync(options.exe),
      catch: (error) =>
        new UpdateFailed({ message: `cannot find the binary to replace: ${describe(error)}` }),
    })
    const assets = yield* assetsOf(options.release, options.target)
    if (options.keys.length === 0) {
      return yield* new UpdateFailed({
        message:
          "this tutti holds no release key yet, so it can't tell a release made by tutti's release workflow from another",
      })
    }
    const dir = dirname(exe)
    const temporary = join(dir, `.tutti-update-${process.pid}-${Date.now().toString(36)}`)
    const failed = (error: unknown) =>
      cannotWrite(error)
        ? new CannotWrite({ dir, message: describe(error) })
        : new UpdateFailed({ message: describe(error) })
    yield* Effect.try({
      try: () => writeFileSync(temporary, "", { flag: "wx", mode: 0o600 }),
      catch: failed,
    })
    return yield* Effect.gen(function* () {
      const archive = yield* fetchVerified(options.releases, assets, options.keys)
      const binary = yield* tuttiIn(archive, assets.archive)
      yield* Effect.try({
        try: () => {
          writeSynced(temporary, binary)
          chmodSync(temporary, 0o755)
        },
        catch: failed,
      })
      const ran = yield* exec({
        command: temporary,
        args: ["--version"],
        timeLimit: TimeLimit.read,
      }).pipe(
        Effect.mapError(
          (error) => new UpdateFailed({ message: `the new binary doesn't run: ${error.message}` }),
        ),
      )
      const said = sanitizeLine(`${ran.stdout}${ran.stderr}`.trim())
      if (ran.exitCode !== 0) {
        return yield* new UpdateFailed({
          message: `the new binary doesn't run: it exited ${ran.exitCode}${said === "" ? "" : `: ${said}`}`,
        })
      }
      if (ran.stdout.trim() !== `tutti ${options.release.tag}`) {
        return yield* new UpdateFailed({
          message: `the new binary's --version says '${said}', not tutti ${options.release.tag}`,
        })
      }
      yield* Effect.try({ try: () => renameSync(temporary, exe), catch: failed })
      return exe
    }).pipe(
      // The old binary stays; a leftover file beside it would break nothing, but is removed.
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.sync(() => rmSync(temporary, { force: true })),
      ),
    )
  })

/** How a build stands against the latest release, which --check reports and tutti update acts on. */
export interface Verdict {
  /** It is the latest release. */
  readonly latest: boolean
  /** It ranks above the latest release. */
  readonly newer: boolean
  /** The latest release ranks above it. */
  readonly behind: boolean
}

/**
 * How `build` stands against the latest release, `tag`: the npm package built from a release, its
 * version bare, is that release.
 */
export const verdictOf = (build: Build, tag: string): Verdict => {
  const order = compareVersions(build.version, tag)
  const release =
    build.kind === "release" || (build.kind === "npm" && build.shown === build.version)
  return {
    latest: release && Option.contains(order, 0),
    newer: Option.contains(order, 1),
    behind: Option.isNone(order) || Option.contains(order, -1),
  }
}

/** tutti update's exit codes. */
export const updateExit = {
  /** Updated, or nothing to do; --check: none newer. */
  ok: 0,
  /** --check: a newer release is out. */
  available: 1,
  /** Refused: a build from a clone without --force, tutti run from source or the npm package, a folder it can't write in. */
  refused: 2,
  /** The update failed; the binary is unchanged. */
  failed: 4,
} as const

/** Where tutti update writes, a line at a time. */
export interface Say {
  readonly out: (line: string) => void
  readonly error: (line: string) => void
}

/**
 * tutti update [--check] [--force] for `build`, from `releases`, verified with `keys`: its exit
 * code. An interruption (Ctrl+C) leaves the binary as it was.
 */
export const update = (
  flags: { readonly check: boolean; readonly force: boolean },
  build: Build,
  options: {
    readonly releases: Releases
    readonly keys: ReadonlyArray<ReleaseKey>
    readonly say: Say
  },
) =>
  Effect.gen(function* () {
    const { say } = options
    const current = `v${build.shown}`
    const fetched = yield* Effect.result(latestRelease(options.releases))
    if (Result.isFailure(fetched)) {
      say.error(`tutti update: ${fetched.failure.message}`)
      return updateExit.failed
    }
    const release = fetched.success
    const page = sanitizeLine(release.url)
    const verdict = verdictOf(build, release.tag)
    if (flags.check) {
      if (verdict.latest) {
        say.out(`tutti ${current} is the latest release.`)
        return updateExit.ok
      }
      if (verdict.newer) {
        say.out(`tutti ${current} is newer than the latest release, ${release.tag}.`)
        return updateExit.ok
      }
      say.out(
        build.kind === "release"
          ? `tutti ${current}; the latest release is ${release.tag} (${page}): tutti update installs it.`
          : build.kind === "clone"
            ? `tutti ${current} is a build from a clone; the latest release is ${release.tag} (${page}): tutti update --force installs it.`
            : build.kind === "npm"
              ? `tutti ${current} is the npm package ${npmPackage}; the latest release is ${release.tag} (${page}): ${npmUpgrade}.`
              : `tutti ${current} runs from source; the latest release is ${release.tag} (${page}): scripts/install.sh installs it.`,
      )
      return verdict.behind ? updateExit.available : updateExit.ok
    }
    if (verdict.latest) {
      say.out(`tutti ${current} is the latest release already.`)
      return updateExit.ok
    }
    if (build.kind === "npm") {
      say.error(
        `tutti update: tutti ${current} is the npm package ${npmPackage}, which tutti update doesn't replace: ${npmUpgrade}.`,
      )
      return updateExit.refused
    }
    if (build.kind === "source" || build.target === null) {
      say.error(
        `tutti update: tutti ${current} runs from source, on Bun, which tutti update doesn't replace. Update the checkout with git, or install release ${release.tag} with scripts/install.sh.`,
      )
      return updateExit.refused
    }
    if (build.kind === "clone" && !flags.force) {
      say.error(
        `tutti update: tutti ${current} at ${build.exe} is a build from a clone, not a release. tutti update --force replaces it with ${release.tag}.`,
      )
      return updateExit.refused
    }
    if (verdict.newer && !flags.force) {
      say.out(
        `tutti ${current} is newer than the latest release, ${release.tag}: nothing to do (tutti update --force installs ${release.tag}).`,
      )
      return updateExit.ok
    }
    say.out(`Downloading tutti ${release.tag} for ${build.target}…`)
    const installed = yield* Effect.result(
      install({
        releases: options.releases,
        keys: options.keys,
        release,
        target: build.target,
        exe: build.exe,
      }),
    )
    if (Result.isFailure(installed)) {
      const error = installed.failure
      if (error._tag === "CannotWrite") {
        say.error(
          `tutti update: cannot replace ${build.exe}: cannot write in ${error.dir}: ${error.message}`,
        )
        say.error("Run it as the folder's owner instead: sudo tutti update")
        return updateExit.refused
      }
      say.error(`tutti update: ${error.message}`)
      say.error(`${build.exe} is unchanged.`)
      return updateExit.failed
    }
    say.out(`Updated tutti ${current} -> ${release.tag} (${installed.success})`)
    say.out(`Release notes: ${page}`)
    return updateExit.ok
  })

/** The environment variable that, on, turns the daily check off. */
export const noUpdateCheck = "TUTTI_NO_UPDATE_CHECK"

/**
 * Whether a run of `build` checks for a newer release: a release build, unless
 * TUTTI_NO_UPDATE_CHECK is on; not the npm package, whose package manager updates it. A value that is neither on nor off turns it off too.
 */
export const checksForUpdates = (
  build: Pick<Build, "kind">,
  env: (name: string) => string | undefined,
): boolean => {
  if (build.kind !== "release") return false
  const text = env(noUpdateCheck)
  if (text === undefined || text === "") return true
  const off = onOff(text)
  return Result.isSuccess(off) && !off.success
}

/**
 * The daily check's folder in the user's cache folder: `$XDG_CACHE_HOME/tutti`, or
 * `~/.cache/tutti` when XDG_CACHE_HOME is unset, empty or relative.
 */
export const cacheDir = (env: (name: string) => string | undefined): string => {
  const xdg = env("XDG_CACHE_HOME")
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(env("HOME") ?? homedir(), ".cache")
  return join(base, "tutti")
}

/** The cache file's name, in cacheDir. */
export const cacheName = "latest-release.json"

/** The cache: the latest release's tag, as of when GitHub was last asked. */
interface Cached {
  /** Absent when GitHub has never answered. */
  readonly latest?: string
  /** When GitHub was last asked, in milliseconds since the epoch. */
  readonly checked: number
}

const readCache = (dir: string): Cached => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, cacheName), "utf8"))
    if (typeof parsed !== "object" || parsed === null) return { checked: 0 }
    const checked = "checked" in parsed && typeof parsed.checked === "number" ? parsed.checked : 0
    const latest =
      "latest" in parsed && typeof parsed.latest === "string" ? parsed.latest : undefined
    return latest === undefined ? { checked } : { latest, checked }
  } catch {
    return { checked: 0 }
  }
}

// Replaces the cache through a file renamed over it, so that a run reading it never sees half of it.
// A cache that can't be written is asked about again next run.
const writeCache = (dir: string, cached: Cached) => {
  const temporary = join(dir, `.${cacheName}-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(temporary, JSON.stringify(cached))
    renameSync(temporary, join(dir, cacheName))
  } catch {
    rmSync(temporary, { force: true })
  }
}

/**
 * The latest release's tag when it is newer than `current` (package.json's version), from the
 * cache in `cache` when GitHub was asked within checkEvery, or else from GitHub, recording its
 * answer. A failed request is recorded too, keeping the last answer, so that GitHub isn't asked
 * again within a day; one interrupted, as the run ended before it, isn't.
 */
export const newerRelease = (options: {
  readonly releases: Releases
  readonly current: string
  readonly cache: string
  readonly now: () => number
}): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const now = options.now()
    let last = readCache(options.cache)
    const age = now - last.checked
    if (age < 0 || age >= Duration.toMillis(checkEvery)) {
      const asked = yield* Effect.result(latestRelease(options.releases, limits.check))
      last = Result.isSuccess(asked)
        ? { latest: asked.success.tag, checked: now }
        : { ...last, checked: now }
      writeCache(options.cache, last)
    }
    const latest = last.latest
    return latest !== undefined && Option.contains(compareVersions(options.current, latest), -1)
      ? Option.some(latest)
      : Option.none()
  })

/**
 * Starts the daily check in the background, in the scope, which interrupts it as it closes. What
 * it returns gives the newer release's tag once the check has found one; none while it is going.
 */
export const startCheck = (
  options: Parameters<typeof newerRelease>[0],
): Effect.Effect<Effect.Effect<Option.Option<string>>, never, Scope.Scope> =>
  Effect.gen(function* () {
    let found = Option.none<string>()
    yield* Effect.forkScoped(
      Effect.tap(newerRelease(options), (newer) =>
        Effect.sync(() => {
          found = newer
        }),
      ),
    )
    return Effect.sync(() => found)
  })

/** The line a run ends with when release `newer` is out and `current` runs, its command last. */
export const newerNotice = (newer: string, current: string) => ({
  text: `tutti ${newer} is available (you have v${current}): `,
  command: "tutti update",
})
