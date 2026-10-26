// A spec at a web URL (§ 4.14), `tutti --spec https://…`: tutti's own addition to orchestra's --spec,
// which takes a file only. The URL is read here, and readSpec (spec.ts) checks and names the text
// fetched as it does a file from outside the repository, committed as a copy in .tutti/specs/.
//
// - specUrl: the URL as given, https only, with no user name or password, and the name of its copy,
//   from its last path segment; a GitHub file page and a one-file gist page are fetched as their raw
//   files (githubFile, gistOf);
// - fetchSpec: the text, through Effect's HttpClient, within 30 s, at most 5 MB, redirects followed
//   up to 5 and only over https, no credentials or cookies sent; a GitHub file whose raw fetch
//   answers 404 is read through the maintainer's own gh login (`gh api`), its token never leaving gh;
// - fetchOnce: one fetch a run, for the setup of an empty repository and the startup checks both,
//   and for the start question's field and the spec it reads, there keeping only what was fetched.
//
// Each problem is a line of the startup checks' report. The URL is recorded and shown without its
// query and fragment, which may hold a token.
import { STATUS_CODES } from "node:http"
import { Duration, Effect, type FileSystem, Option, Result, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import { exec } from "../services/exec.ts"
import { sanitizeLine } from "../ui/sanitize.ts"

/** How long a spec's fetch may take, redirects and gh included. */
export const fetchTimeLimit: Duration.Duration = Duration.seconds(30)

/** The most a spec fetched may be, in bytes. */
export const maxSpecBytes = 5 * 1024 * 1024

/** The most redirects a spec's fetch follows. */
export const maxRedirects = 5

/** The longest a copy's name is, before `.md` is added. */
export const maxNameLength = 100

/** Whether --spec's text names a URL rather than a file: it starts with a scheme and `://`. */
export const isSpecUrl = (given: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(given.trim())

/** A file on GitHub: its repository, ref and path (as the URL encodes it), and its raw URL. */
export interface GitHubFile {
  readonly owner: string
  readonly repo: string
  readonly ref: string
  readonly path: string
  readonly raw: URL
}

/** How many of `rest`'s segments are the ref: `refs/heads/<branch>` and `refs/tags/<tag>` are 3. */
const refLength = (rest: ReadonlyArray<string>): number =>
  rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") ? 3 : 1

/** The URL's path segments, as it encodes them, without the empty one a trailing slash leaves. */
const segmentsOf = (url: URL): ReadonlyArray<string> => {
  const segments = url.pathname.split("/").slice(1)
  return segments.at(-1) === "" ? segments.slice(0, -1) : segments
}

/**
 * The GitHub file `url` names, or null: a file page (`github.com/<owner>/<repo>/blob/<ref>/<path>`,
 * or `/raw/`), whose raw URL is `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, or that raw
 * URL itself, kept as it is.
 */
export const githubFile = (url: URL): GitHubFile | null => {
  const segments = segmentsOf(url)
  if (segments.some((segment) => segment === "")) return null
  const host = url.hostname
  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, kind, ...rest] = segments
    if (owner === undefined || repo === undefined || (kind !== "blob" && kind !== "raw")) {
      return null
    }
    const n = refLength(rest)
    const path = rest.slice(n)
    if (rest.length < n || path.length === 0) return null
    const ref = rest.slice(0, n).join("/")
    return {
      owner,
      repo,
      ref,
      path: path.join("/"),
      raw: new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join("/")}`),
    }
  }
  if (host === "raw.githubusercontent.com") {
    const [owner, repo, ...rest] = segments
    const n = refLength(rest)
    const path = rest.slice(n)
    if (owner === undefined || repo === undefined || rest.length < n || path.length === 0) {
      return null
    }
    return { owner, repo, ref: rest.slice(0, n).join("/"), path: path.join("/"), raw: url }
  }
  return null
}

/** The gist `url`'s page names, `gist.github.com/<user>/<id>`, or null. */
export const gistOf = (url: URL): { readonly user: string; readonly id: string } | null => {
  if (url.hostname !== "gist.github.com") return null
  const [user, id, ...rest] = segmentsOf(url)
  return user !== undefined && user !== "" && id !== undefined && /^[0-9a-z]+$/i.test(id)
    ? rest.length === 0
      ? { user, id }
      : null
    : null
}

/**
 * The name of the copy of the spec at `url`, in .tutti/specs/: its last path segment, decoded and
 * made a safe file name (letters, digits, `.`, `_` and `-`, no leading dot), `.md` added unless it
 * ends in `.md`, `.markdown` or `.txt`; null when nothing of it is left.
 */
export const copyName = (url: URL): string | null => {
  const last = segmentsOf(url).at(-1)
  if (last === undefined) return null
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    // Not percent-encoded text: taken as it is.
  }
  const trim = (name: string) => name.replace(/^[.-]+/, "").replace(/[.-]+$/, "")
  const safe = trim(
    trim(
      decoded
        .normalize("NFC")
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .replace(/-{2,}/g, "-"),
    ).slice(0, maxNameLength),
  )
  if (safe === "") return null
  return /\.(md|markdown|txt)$/i.test(safe) ? safe : `${safe}.md`
}

/** `url` as it is recorded and shown: without its query and fragment, which may hold a token. */
export const shownUrl = (url: URL): string => {
  const bare = new URL(url.href)
  bare.search = ""
  bare.hash = ""
  bare.username = ""
  bare.password = ""
  return sanitizeLine(bare.href)
}

/** A spec's URL, as specUrl reads it. */
export interface SpecUrl {
  /** The URL as given, its query included, which is what is fetched. */
  readonly url: URL
  /** The URL as it is recorded and shown (shownUrl). */
  readonly shown: string
  /** The URL and what gave it, as problems name it: `https://… (--spec)`. */
  readonly label: string
  /** The name of its copy in .tutti/specs/. */
  readonly name: string
}

/** The URL --spec (or TUTTI_SPEC, `from`) gives, or the problem with it. */
export const specUrl = (given: string, from: string): Result.Result<SpecUrl, string> => {
  const text = given.trim()
  if (!URL.canParse(text)) {
    return Result.fail(
      `The spec ${sanitizeLine(text)} (${from}) isn't a URL tutti can read: give an https:// URL, or a file's path.`,
    )
  }
  const url = new URL(text)
  const shown = shownUrl(url)
  const label = `${shown} (${from})`
  if (url.protocol === "http:") {
    return Result.fail(`The spec ${label} is fetched over http: fetch the spec over https.`)
  }
  if (url.protocol !== "https:") {
    return Result.fail(
      `The spec ${label} is a ${sanitizeLine(url.protocol.slice(0, -1))} URL: tutti fetches a spec over https only.`,
    )
  }
  if (url.username !== "" || url.password !== "") {
    return Result.fail(
      `The spec ${label} holds a user name or password, and tutti sends no credentials: give the URL without them.`,
    )
  }
  const name = copyName(url)
  if (name === null) {
    return Result.fail(`The spec ${label} names no file: give the URL of the spec's raw file.`)
  }
  return Result.succeed({ url, shown, label, name })
}

/** What a spec's fetch got: the bytes, and the media type the server gave them, if any. */
export interface Fetched {
  readonly bytes: Uint8Array
  readonly contentType: string | null
}

/** Fetches the spec at a URL: what it got, or the problem, a line of the startup checks' report. */
export type SpecFetch<R = never> = (
  target: SpecUrl,
) => Effect.Effect<Result.Result<Fetched, string>, never, R>

/** Why a fetch failed: an HTTP status, or another reason, in its own words. */
interface Failure {
  readonly why: string
  readonly status?: number
}

/** An HTTP status as a person reads it: `HTTP 404 Not Found`. */
export const statusWhy = (status: number): string =>
  `HTTP ${status}${STATUS_CODES[status] === undefined ? "" : ` ${STATUS_CODES[status]}`}`

/** Why the fetch's transport failed: DNS, TLS or the connection, in the error's own words. */
const transportWhy = (error: unknown): string => {
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined
  const from = cause instanceof Error ? cause : error instanceof Error ? error : undefined
  if (from === undefined) return "the request failed"
  const code =
    "code" in from && typeof from.code === "string" && !from.message.includes(from.code)
      ? ` (${from.code})`
      : ""
  return sanitizeLine(`${from.message || "the request failed"}${code}`)
}

const tooBig = `is more than ${maxSpecBytes / (1024 * 1024)} MB`

/** The response's body, at most maxSpecBytes. */
const readBody = (response: {
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly stream: Stream.Stream<Uint8Array, unknown>
}): Effect.Effect<Result.Result<Uint8Array, Failure>> =>
  Effect.gen(function* () {
    const length = Number(response.headers["content-length"])
    if (Number.isFinite(length) && length > maxSpecBytes) return Result.fail({ why: tooBig })
    const chunks: Array<Uint8Array> = []
    let size = 0
    const read = yield* Effect.result(
      Stream.runForEachWhile(response.stream, (chunk) =>
        Effect.sync(() => {
          size += chunk.length
          if (size <= maxSpecBytes) chunks.push(chunk)
          return size <= maxSpecBytes
        }),
      ),
    )
    if (size > maxSpecBytes) return Result.fail({ why: tooBig })
    if (Result.isFailure(read)) return Result.fail({ why: transportWhy(read.failure) })
    return Result.succeed(Buffer.concat(chunks))
  })

/**
 * GETs `url`, following up to maxRedirects redirects, each over https; no credentials, no cookies
 * and no trace headers are sent. What it got, or why not.
 */
const get = (
  url: URL,
  accept: string | null = null,
): Effect.Effect<Result.Result<Fetched, Failure>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    // A fragment is the page's, never sent.
    const unfragmented = (target: URL) => {
      const bare = new URL(target.href)
      bare.hash = ""
      return bare
    }
    let current = unfragmented(url)
    for (let hops = 0; ; hops++) {
      const sent = yield* Effect.result(
        client.execute(
          HttpClientRequest.get(current, accept === null ? {} : { headers: { accept } }),
        ),
      )
      if (Result.isFailure(sent)) return Result.fail({ why: transportWhy(sent.failure) })
      const response = sent.success
      const location = response.headers.location
      if (response.status >= 300 && response.status < 400 && location !== undefined) {
        if (hops >= maxRedirects) {
          return Result.fail({ why: `redirected more than ${maxRedirects} times` })
        }
        if (!URL.canParse(location, current.href)) {
          return Result.fail({ why: `redirected to ${sanitizeLine(location)}, not a URL` })
        }
        const next = new URL(location, current)
        if (next.protocol !== "https:") {
          return Result.fail({
            why: `redirected to ${sanitizeLine(next.host || next.href)} over ${sanitizeLine(next.protocol.slice(0, -1))}`,
          })
        }
        current = unfragmented(next)
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        return Result.fail({ why: statusWhy(response.status), status: response.status })
      }
      const body = yield* readBody(response)
      if (Result.isFailure(body)) return Result.fail(body.failure)
      return Result.succeed({
        bytes: body.success,
        contentType: response.headers["content-type"] ?? null,
      })
    }
  }).pipe(
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, {
      redirect: "manual",
      credentials: "omit",
    }),
  )

/** The problem of a private GitHub file that gh can't read for want of a login. */
export const privateProblem = (target: SpecUrl, gh: "missing" | "logged out"): string =>
  gh === "missing"
    ? `The spec ${target.label} is private or missing; if it is private, install gh (https://cli.github.com), log it in (gh auth login) and run again.`
    : `The spec ${target.label} is private or missing; if it is private, log gh in (gh auth login) and run again.`

/** Reads the private GitHub file `file` through gh's login: `gh api …/contents/<path>`, raw. */
const throughGh = (
  target: SpecUrl,
  file: GitHubFile,
  gh: string,
): Effect.Effect<
  Result.Result<Fetched, string>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const failed = (why: string) => Result.fail(`Cannot fetch the spec ${target.label}: ${why}.`)
    let ref = file.ref
    try {
      ref = decodeURIComponent(file.ref)
    } catch {
      // Taken as it is.
    }
    const chunks: Array<Uint8Array> = []
    let size = 0
    const ran = yield* Effect.result(
      exec({
        command: gh,
        args: [
          "api",
          `repos/${file.owner}/${file.repo}/contents/${file.path}?ref=${encodeURIComponent(ref)}`,
          "-H",
          "Accept: application/vnd.github.raw",
        ],
        timeLimit: fetchTimeLimit,
        maxOutputBytes: maxSpecBytes + 1,
        onOutput: (chunk, from) => {
          if (from !== "stdout") return
          size += chunk.length
          if (size <= maxSpecBytes) chunks.push(chunk)
        },
      }),
    )
    if (Result.isFailure(ran)) {
      const error = ran.failure
      if (error._tag === "CommandTimedOut") {
        return failed(`took more than ${Duration.format(fetchTimeLimit)}`)
      }
      return Result.fail(privateProblem(target, "missing"))
    }
    const { exitCode, stderr } = ran.success
    if (exitCode !== 0) {
      if (exitCode === 4 || /gh auth login|not logged in/i.test(stderr)) {
        return Result.fail(privateProblem(target, "logged out"))
      }
      if (/HTTP 404/.test(stderr)) return failed(`${statusWhy(404)}, through your gh login too`)
      const first = stderr.trim().split("\n")[0] ?? ""
      return failed(`gh api failed: ${sanitizeLine(first) || `exit code ${exitCode}`}`)
    }
    if (size > maxSpecBytes) return failed(tooBig)
    return Result.succeed({ bytes: Buffer.concat(chunks), contentType: null })
  })

/** The one file of the gist `id`, through GitHub's API: its raw URL, or the problem. */
const gistFile = (
  target: SpecUrl,
  id: string,
): Effect.Effect<Result.Result<URL, string>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const failed = (why: string) => Result.fail(`Cannot fetch the spec ${target.label}: ${why}.`)
    const got = yield* get(new URL(`https://api.github.com/gists/${id}`), "application/json")
    if (Result.isFailure(got)) return failed(got.failure.why)
    let files: unknown
    try {
      files = (JSON.parse(new TextDecoder().decode(got.success.bytes)) as { files?: unknown }).files
    } catch {
      return failed("GitHub's answer for the gist isn't JSON")
    }
    const each =
      typeof files === "object" && files !== null ? Object.values(files as object) : ([] as never[])
    if (each.length !== 1) {
      return Result.fail(
        `The spec ${target.label} is a gist of ${each.length} files: give the URL of its file's raw view.`,
      )
    }
    const raw = (each[0] as { raw_url?: unknown }).raw_url
    if (typeof raw !== "string" || !URL.canParse(raw) || new URL(raw).protocol !== "https:") {
      return failed("GitHub's answer for the gist names no raw file over https")
    }
    return Result.succeed(new URL(raw))
  })

/**
 * Fetches the spec at `target` (fetchTimeLimit for the whole of it): a GitHub file page as its raw
 * file, read through `gh` (the command) where the raw fetch answers 404; a one-file gist page as its
 * file; any other URL as it is. What it got, or the problem.
 */
export const fetchSpec = (
  target: SpecUrl,
  gh = "gh",
): Effect.Effect<
  Result.Result<Fetched, string>,
  never,
  HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const failed = (why: string) => Result.fail(`Cannot fetch the spec ${target.label}: ${why}.`)
    const file = githubFile(target.url)
    const gist = gistOf(target.url)
    let url = file === null ? target.url : file.raw
    if (gist !== null) {
      const raw = yield* gistFile(target, gist.id)
      if (Result.isFailure(raw)) return Result.fail(raw.failure)
      url = raw.success
    }
    const got = yield* get(url)
    if (Result.isSuccess(got)) return Result.succeed(got.success)
    if (file !== null && got.failure.status === 404) return yield* throughGh(target, file, gh)
    return failed(got.failure.why)
  }).pipe(
    Effect.timeoutOption(fetchTimeLimit),
    Effect.map((done) =>
      Option.getOrElse(done, () =>
        Result.fail(
          `Cannot fetch the spec ${target.label}: took more than ${Duration.format(fetchTimeLimit)}.`,
        ),
      ),
    ),
  )

/** What fetchSpecLive runs on besides its HttpClient: gh, for a private GitHub file, is a process. */
export type LiveFetch = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

/** fetchSpec over the platform's fetch: the live HttpClient layer. */
export const fetchSpecLive: SpecFetch<LiveFetch> = (target) =>
  Effect.provide(fetchSpec(target), FetchHttpClient.layer)

/**
 * `fetch`, fetching each URL once: a second call for it gets what the first got. With `failures`
 * false, only what was fetched is kept, and a URL whose fetch failed is fetched again: the start
 * question's field, where a URL that failed is fixed or tried again.
 */
export const fetchOnce = <R>(
  fetch: SpecFetch<R>,
  options: { readonly failures?: boolean } = {},
): SpecFetch<R> => {
  const keepFailures = options.failures ?? true
  const got = new Map<string, Result.Result<Fetched, string>>()
  return (target) =>
    Effect.suspend(() => {
      const had = got.get(target.url.href)
      return had !== undefined
        ? Effect.succeed(had)
        : Effect.tap(fetch(target), (result) =>
            Effect.sync(() => {
              if (keepFailures || Result.isSuccess(result)) got.set(target.url.href, result)
            }),
          )
    })
}
