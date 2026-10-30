// The plan (§ 5 item 13, § 6): the organ that turns a screened feature request into an epic and its
// child tickets, as orchestra v0.7.7's does: each small enough for one worker, ordered only where
// order matters, naming their files so footprint scheduling can run them side by side, and solo
// where a ticket must run alone. It sees only the evidence, never the code, so a request whose right
// change depends on reading the code is planned as a design ticket first, which files the rest. Its
// prompt (prompts/plan.md) is orchestra's, adapted, with `solo` added.
//
// Its evidence, gathered by gatherFeature from the main checkout: the README and the agents'
// instructions (CLAUDE.md, the files a CLAUDE.md of imports alone imports, or AGENTS.md), each up
// to maxPlanDoc characters; the repository's files (git ls-files) with their line counts; the
// tickets not closed, so the plan doesn't repeat one; and the start of each file the request names
// by path. A file is read only when it resolves inside the checkout, so a symbolic link can't lead
// out of it. The request goes last, after the evidence: Claude reads long inputs best that way.
//
// Its answer is checked by validatePlan (project/planFile.ts): a plan that fails it is OrganFailed
// with the reasons. Showing, confirming and filing
// the plan are run/feature.ts's.
import { posix } from "node:path"
import { Effect, FileSystem, Option, Result, Schema } from "effect"
import {
  type FeaturePlan,
  maxPlanned,
  priorities,
  ticketTypes,
  validatePlan,
} from "../project/planFile.ts"
import { Beads, type BeadsError } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { type InputPart, section } from "./evidence.ts"
import { make, type OrganError, OrganFailed, Organs } from "./Organs.ts"
import { maxListed } from "./predictor.ts"
import template from "./prompts/plan.md" with { type: "text" }
import { cut } from "./screen.ts"

// ---------------------------------------------------------------------------------------------
// The answer

/**
 * The plan's answer, as orchestra's planSchema has it: the epic as two top-level strings rather
 * than an object, which the model's structured output gets right more often.
 */
export const PlanAnswer = Schema.Struct({
  epic_title: Schema.String,
  epic_description: Schema.String,
  tickets: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      type: Schema.Literals(ticketTypes),
      priority: Schema.Literals(priorities),
      description: Schema.String,
      acceptance: Schema.String,
      files: Schema.Array(Schema.String),
      blocked_by: Schema.Array(Schema.String),
      solo: Schema.Boolean,
    }),
  ),
  questions: Schema.Array(Schema.String),
})
export type PlanAnswer = typeof PlanAnswer.Type

export const plan = make("plan", {
  prompt: template.replaceAll("{{maxPlanned}}", String(maxPlanned)),
  answer: PlanAnswer,
  evidenceSource: "written by someone else (the request) or gathered from the repository",
})

// ---------------------------------------------------------------------------------------------
// The evidence

/** A repository file and its length in lines: none when not counted. */
export interface TrackedFile {
  readonly path: string
  /** Absent for a binary file, one too large or unreadable, or one past maxListed. */
  readonly lines?: number
}

/** A ticket that isn't closed, whatever its status, which the plan must not repeat. */
export interface UnclosedTicket {
  readonly id: string
  readonly status: string
  readonly title: string
}

/** A file the request names, and the start of it. */
export interface NamedFile {
  readonly path: string
  readonly body: string
}

/** What the plan organ plans a request from: gatherFeature reads it. */
export interface FeatureEvidence {
  readonly request: string
  /** The repository's name. */
  readonly repo: string
  readonly readme: string
  /** The agents' instructions, and the files they come from, comma-separated. */
  readonly guide: string
  readonly guideName: string
  readonly files: ReadonlyArray<TrackedFile>
  readonly unclosed: ReadonlyArray<UnclosedTicket>
  readonly named: ReadonlyArray<NamedFile>
}

/** The most characters of the README and of the guide the plan reads. */
export const maxPlanDoc = 16000
/** The most files named in the request whose start the plan reads. */
export const maxNamed = 8
/** The most characters of each of them. */
export const maxNamedChars = 16000
/** The most unclosed tickets listed. */
export const maxUnclosed = 500
/** The largest file whose lines are counted, in bytes: reading larger ones would hold the plan up. */
export const maxCounted = 4 << 20

/** A file's start, to look for a NUL byte in: one makes it binary. */
const sniffBytes = 8 << 10

/** Reads the files of the checkout at a root, never one that resolves outside it. */
interface Reader {
  /** Up to `n` bytes of `file`, or none when it can't be read or lies outside. */
  readonly bytes: (file: string, n: number) => Effect.Effect<Option.Option<Uint8Array>>
  /** The file's size in bytes, or none. */
  readonly size: (file: string) => Effect.Effect<Option.Option<number>>
}

const reader = (repo: string): Effect.Effect<Reader, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(repo).pipe(Effect.orElseSucceed(() => repo))
    const real = (file: string) =>
      Effect.flatMap(fs.realPath(posix.join(root, file)), (path) =>
        path.startsWith(`${root}/`) ? Effect.succeed(path) : Effect.fail("outside" as const),
      )
    return {
      bytes: (file, n) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs.open(yield* real(file), { flag: "r" })
            return yield* handle.readAlloc(n)
          }),
        ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>())),
      size: (file) =>
        Effect.flatMap(real(file), (path) => fs.stat(path)).pipe(
          Effect.map((info) => Option.some(Number(info.size))),
          Effect.orElseSucceed(() => Option.none<number>()),
        ),
    } satisfies Reader
  })

const decoder = new TextDecoder()

/** Up to `n` characters of `file`, or none. */
const readStart = (read: Reader, file: string, n: number) =>
  Effect.map(
    read.bytes(file, n * 4),
    Option.map((bytes) => decoder.decode(bytes).slice(0, n + 1)),
  )

/** README.md of the checkout `repo`, its first maxPlanDoc characters and a bit; "" with none. */
export const readReadme = (repo: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.flatMap(reader(repo), (read) =>
    Effect.map(
      readStart(read, "README.md", maxPlanDoc),
      Option.getOrElse(() => ""),
    ),
  )

/** Whether the instructions are blank or hold only Claude Code imports (@path). */
export const onlyImports = (text: string): boolean =>
  text
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => word.startsWith("@") && word !== "@")

/**
 * The agents' instructions and the files they come from: CLAUDE.md; or, when it is blank or holds
 * only imports, the files it imports, one level deep and only inside the checkout; or AGENTS.md;
 * or CLAUDE.md as it is. ["", ""] when there is none.
 */
const readGuide = (read: Reader): Effect.Effect<readonly [string, string]> =>
  Effect.gen(function* () {
    const claude = yield* readStart(read, "CLAUDE.md", maxPlanDoc)
    if (Option.isSome(claude) && !onlyImports(claude.value)) return [claude.value, "CLAUDE.md"]
    const bodies: Array<string> = []
    const names: Array<string> = []
    let size = 0
    for (const word of Option.getOrElse(claude, () => "").split(/\s+/)) {
      if (word === "") continue
      const path = word.startsWith("@") ? word.slice(1) : word
      if (path.startsWith("~") || posix.isAbsolute(path) || size > maxPlanDoc) continue
      const clean = posix.normalize(path)
      if (clean === ".." || clean.startsWith("../") || names.includes(clean)) continue
      const body = yield* readStart(read, clean, maxPlanDoc)
      if (Option.isSome(body) && !onlyImports(body.value)) {
        bodies.push(body.value)
        names.push(clean)
        size += body.value.length
      }
    }
    if (names.length > 0) return [bodies.join("\n\n"), names.join(", ")]
    const agents = yield* readStart(read, "AGENTS.md", maxPlanDoc)
    if (Option.isSome(agents)) return [agents.value, "AGENTS.md"]
    return Option.isSome(claude) ? [claude.value, "CLAUDE.md"] : ["", ""]
  })

/** The lines in `bytes`, a last line without a newline counted. */
export const countLines = (bytes: Uint8Array): number => {
  let lines = 0
  for (const b of bytes) if (b === 10) lines++
  return bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? lines + 1 : lines
}

/** The lines of `file`: none for a binary one (a NUL in its start), one too large or unreadable. */
const linesOf = (read: Reader, file: string): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    const size = yield* read.size(file)
    if (Option.isNone(size) || size.value > maxCounted) return undefined
    if (size.value === 0) return 0
    const bytes = yield* read.bytes(file, maxCounted + 1)
    if (Option.isNone(bytes) || bytes.value.length > maxCounted) return undefined
    if (bytes.value.subarray(0, sniffBytes).includes(0)) return undefined
    return countLines(bytes.value)
  })

// A line reference after a path: a.ts:120, a.ts:120-140, a.ts:120:5, a.ts#L120 or a.ts#L120-L140.
const lineRef = /(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/

/**
 * The repository files the request names by path, in the order it names them, at most maxNamed:
 * its words that are tracked paths once quotes, brackets, trailing punctuation, a leading ./ and a
 * line reference are taken off.
 */
export const namedPaths = (
  request: string,
  tracked: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const known = new Set(tracked)
  const named: Array<string> = []
  for (const raw of request.split(/[\s"'`()[\]{}<>,;]+/)) {
    const word = raw.replace(/[.:!?]+$/, "").replace(lineRef, "")
    const path = word.startsWith("./") ? word.slice(2) : word
    if (known.has(path) && !named.includes(path) && named.length < maxNamed) named.push(path)
  }
  return named
}

/**
 * The plan's evidence for `request` from the main checkout `repo`: its README, guide, files and
 * their lines, the tickets not closed, and the files the request names. A missing README or guide
 * is left empty.
 */
export const gatherFeature = (
  repo: string,
  request: string,
): Effect.Effect<FeatureEvidence, BeadsError, FileSystem.FileSystem | Git | Beads> =>
  Effect.gen(function* () {
    const read = yield* reader(repo)
    // Every ticket not closed, epics too: one left in progress by a stopped run, or set aside with
    // bd defer, is still to be done.
    const unclosed = (yield* (yield* Beads).list()).map((issue) => ({
      id: issue.id,
      status: issue.status,
      title: issue.title,
    }))
    const tracked = yield* (yield* Git)
      .trackedFiles(repo)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
    const files = yield* Effect.forEach(
      tracked,
      (path, i) =>
        i < maxListed
          ? Effect.map(linesOf(read, path), (lines) =>
              lines === undefined ? { path } : { path, lines },
            )
          : Effect.succeed({ path }),
      { concurrency: 16 },
    )
    const named: Array<NamedFile> = []
    for (const path of namedPaths(request, tracked)) {
      const body = yield* readStart(read, path, maxNamedChars)
      if (Option.isSome(body)) {
        named.push({ path, body: body.value.includes("\0") ? "(binary)" : body.value })
      }
    }
    const [guide, guideName] = yield* readGuide(read)
    return {
      request,
      repo: posix.basename(repo),
      readme: Option.getOrElse(yield* readStart(read, "README.md", maxPlanDoc), () => ""),
      guide,
      guideName,
      files,
      unclosed,
      named,
    }
  })

/** The plan's input: the evidence, then the request, then what to do with it. */
export const planInput = (ev: FeatureEvidence): ReadonlyArray<InputPart> => {
  const listed = ev.files
    .slice(0, maxListed)
    .map((f) => (f.lines === undefined ? f.path : `${f.path}  ${f.lines}`))
  if (ev.files.length > maxListed) listed.push(`(… and ${ev.files.length - maxListed} more)`)
  const unclosed = ev.unclosed.slice(0, maxUnclosed).map((t) => `${t.id}  ${t.status}  ${t.title}`)
  if (ev.unclosed.length > maxUnclosed) {
    unclosed.push(`(… and ${ev.unclosed.length - maxUnclosed} more)`)
  }
  return [
    section("Feature request", ev.request),
    section("README", cut(ev.readme, maxPlanDoc)),
    section(`Agent instructions (${ev.guideName || "CLAUDE.md"})`, cut(ev.guide, maxPlanDoc)),
    section("Repository files (git ls-files), each with its line count", listed.join("\n")),
    section("Tickets not closed (ID, status and title)", unclosed.join("\n")),
    ...ev.named.map((f) =>
      section(`File named in the request: ${f.path}`, cut(f.body, maxNamedChars)),
    ),
    `Plan the feature request above for the repository ${ev.repo} as an epic and its tickets.\n`,
  ]
}

/**
 * The plan of the request in `ev`, checked by validatePlan against the repository's files: an
 * epic and its tickets, or, with no tickets, the questions it needs answered first. A plan that
 * fails the checks fails OrganFailed with the reasons.
 */
export const planFeature = (ev: FeatureEvidence): Effect.Effect<FeaturePlan, OrganError, Organs> =>
  Effect.gen(function* () {
    const answer = yield* (yield* Organs).ask(plan, planInput(ev))
    const checked = validatePlan(
      answer,
      ev.files.map((f) => f.path),
    )
    if (Result.isFailure(checked)) {
      return yield* new OrganFailed({
        organ: plan.name,
        subtype: null,
        reason: `the plan doesn't hold: ${checked.failure.join("; ")}`,
      })
    }
    return checked.success
  })
