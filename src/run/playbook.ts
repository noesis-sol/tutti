// The playbook (§ 5 item 13, tutti-5fs7.3; after ACE, arXiv 2510.04618): itemised lessons distilled
// from a project's own tickets, kept in .tutti/playbook.jsonl in the main checkout, one lesson a line,
// not committed, and carried from run to run so that a lesson gathers uses enough to be measured.
// This file is its fixed code: no model rewrites the whole, and every change is a delta merged here.
//
// - Gate (`gate`), before a lesson enters the pool, as a defective one contaminates what is distilled
//   after it (arXiv 2608.05810): fixed checks refuse a lesson that could skip or weaken a
//   check, test, verifier, permission or hook, by refusing one that names any at all; that touches
//   the git or bd usage the worker prompt sets, a ticket or a ref named at all among it; that repeats a run of words from the transcripts the reflector read; that is too long; that
//   has a scope that isn't a path below the project's top; that is alike one in the pool; or whose
//   evidence the run's records don't hold. The checks read words, so they refuse more than they must:
//   "the parser's tests share a cursor" goes too. A lesson refused costs little and one let through
//   costs a lot, and each refusal is in its `reflection` record, to loosen by if it costs too many.
// - Risk (`admittedState`): only a pitfall scoped to an area goes active; a strategy, a recovery, or a
//   scope that spans the project (`spansProject`) stays proposed until you approve it, never blocking
//   a run: the report lists them and `tutti playbook` acts on them.
// - Pool (`addLesson`): at `pool_cap`, a new lesson displaces a retired one, oldest first, else the
//   least helpful.
// - Inject (`chosenFor`, `lessonsSection`): a worker's prompt gets the active lessons whose scope
//   meets its ticket's footprint and whose holdout arm shows them, at most `lessons_injected`, the
//   most helpful first, in a marked section after its standing rules.
// - Measure (`armOf`, `measured`, `judgement`): each lesson goes to a random half of the tickets in its
//   scope, by a hash of its ID and the ticket's, so a ticket is in the same arm however often it is
//   started. Each ticket's scorecard then counts once for each lesson: clean (`cleanScore`) or not,
//   shown (helpful, harmful) or held back (held_clean, held_bad). Fisher's exact test compares the
//   two arms' clean rates: past `judged_after` uses, a lesson whose effect isn't distinguishable from
//   zero is retired, and one that measurably hurts is retired as soon as it does. Looking after each
//   ticket makes a false retirement likelier than the test's level says, and that costs one lesson.
//   A ticket not shown a lesson only for the cap on a prompt is in neither arm.
//
// The version is the highest of the lessons' versions: each change of what a worker could read (an
// admission, an approval, an edit, a retirement) takes the next, a count doesn't. A lesson's ID comes
// from its version, so no two lessons have one.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Duration, Effect, Schema } from "effect"
import {
  close,
  flockExclusiveNonBlocking,
  LibcError,
  makeFoldersUnder,
  O,
  openUnder,
  writeFileUnder,
} from "../native/libc.ts"
import { alike } from "../organs/critic.ts"
import { oneLine } from "../ui/oneLine.ts"
import { escapeMarkdown, sanitizeLine } from "../ui/sanitize.ts"
import {
  Count,
  type DispatchPlaybook,
  LessonEvidence,
  lessonKinds,
  type lessonRefusals,
  lessonRetired,
} from "./events.ts"
import type { Footprint } from "./footprint.ts"
import { globHolds, globsMeet, isGlob } from "./glob.ts"
import type { Score } from "./scorecard.ts"

/** The playbook's file, relative to the main checkout's top level. */
export const playbookFile = ".tutti/playbook.jsonl"

/** What keeps two writers apart: a run and `tutti playbook`. */
const lockFile = ".tutti/run/playbook.lock"

export type LessonKind = (typeof lessonKinds)[number]
export type Refusal = (typeof lessonRefusals)[number]
export type RetiredWhy = (typeof lessonRetired)[number]

/** One lesson, as a line of the file holds it. */
export const Lesson = Schema.Struct({
  id: Schema.String,
  /** One or two sentences. */
  text: Schema.String,
  /** The path globs of its area; none: the whole project. */
  scope: Schema.Array(Schema.String),
  kind: Schema.Literals(lessonKinds),
  evidence: Schema.Array(LessonEvidence),
  state: Schema.Literals(["proposed", "active", "retired"]),
  /** The tickets shown it that went clean, and those that didn't. */
  helpful: Count,
  harmful: Count,
  /** The tickets held back from it that went clean, and those that didn't. */
  held_clean: Count,
  held_bad: Count,
  /** The tickets those count, each once. */
  measured: Schema.Array(Schema.String),
  /** When it entered the pool, as the event stream writes a time. */
  admitted_at: Schema.String,
  /** The playbook's version at its last change. */
  version: Count,
  retired: Schema.optionalKey(Schema.Literals(lessonRetired)),
})
export type Lesson = typeof Lesson.Type

/** The file as it was read: its lessons, and the lines that aren't one, kept as they are. */
export interface Read {
  readonly lessons: ReadonlyArray<Lesson>
  readonly bad: ReadonlyArray<string>
}

/** The lines of a playbook's file: a line that isn't a lesson, or repeats an ID, is kept aside. */
export const parsePlaybook = (text: string): Read => {
  const lessons: Array<Lesson> = []
  const bad: Array<string> = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      bad.push(line)
      continue
    }
    const lesson = Schema.decodeUnknownOption(Lesson)(raw)
    if (lesson._tag === "None" || lessons.some((each) => each.id === lesson.value.id)) {
      bad.push(line)
    } else {
      lessons.push(lesson.value)
    }
  }
  return { lessons, bad }
}

/** A playbook's file from its lessons and the lines read that weren't any. */
export const formatPlaybook = (read: Read): string =>
  [...read.lessons.map((lesson) => JSON.stringify(lesson)), ...read.bad]
    .map((line) => `${line}\n`)
    .join("")

/** The playbook's version: the highest of its lessons'. */
export const versionOf = (lessons: ReadonlyArray<Lesson>): number =>
  lessons.reduce((most, lesson) => Math.max(most, lesson.version), 0)

// ---------------------------------------------------------------------------------------------
// Scope

/** Whether `scope` is the whole project: no globs, or one that starts anywhere (a wildcard first). */
export const spansProject = (scope: ReadonlyArray<string>): boolean =>
  scope.length === 0 || scope.some((glob) => isGlob(glob.split("/")[0] ?? ""))

/** Whether a lesson of `scope` applies to a ticket of `footprint`: the project's, or one it meets. */
export const inScope = (
  scope: ReadonlyArray<string>,
  footprint: Pick<Footprint, "files" | "globs">,
): boolean =>
  scope.length === 0 ||
  scope.some(
    (glob) =>
      footprint.files.some((file) => globHolds(glob, file)) ||
      footprint.globs.some((other) => globsMeet(glob, other)),
  )

/** The most globs a lesson's scope has, and the longest. */
export const scopeGlobs = { most: 8, characters: 200 }

const goodGlob = (glob: string): boolean =>
  glob !== "" &&
  glob.length <= scopeGlobs.characters &&
  !glob.startsWith("/") &&
  !/\s/u.test(glob) &&
  !glob.split("/").includes("..")

// ---------------------------------------------------------------------------------------------
// The gate

/** The longest a lesson's text is: one or two sentences. */
export const lessonCharacters = 300

/** How many words in a row a lesson shares with a transcript for it to be a quote. */
export const quoteWords = 6

/** A lesson proposed: what the gate reads. */
export interface Candidate {
  readonly text: string
  readonly kind: LessonKind
  readonly scope: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<{ readonly ticket: string; readonly event: string }>
}

/** What the gate holds a lesson against. */
export interface GateContext {
  /** The pool, every state: a retired lesson doesn't come back. */
  readonly lessons: ReadonlyArray<Pick<Lesson, "text">>
  /** Whether the run's records hold `event` about `ticket`. */
  readonly known: (ticket: string, event: string) => boolean
  /** The transcripts the reflector read. */
  readonly transcripts: ReadonlyArray<string>
}

// Lower case, compatibility forms folded, invisible format characters out, one space between words:
// so that neither a fullwidth letter nor a zero-width space hides a word.
const normal = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u2018\u2019\u02bc]/gu, "'")
    .toLowerCase()
    .split(/\s+/u)
    .join(" ")
    .trim()

const words = (text: string): ReadonlyArray<string> =>
  normal(text)
    .split(/[^\p{L}\p{N}_./'-]+/u)
    .filter((word) => word !== "")

// What guards the work, named anywhere, a test file's path or a word run together included: a lesson
// has no need of it, as a lesson is about the code, and no list of the ways to do without a check
// would hold them all ("stop running the tests", "waive the verifier", "failures here are expected").
const guarded =
  /(?<![\p{L}\p{N}])(?:check|test|suite|verif|lint|typecheck|tsc|biome|shellcheck|ci(?![\p{L}\p{N}])|assert|gate|coverage|pre-commit|pre-push|snapshot)|permission|hook/u

// What dismisses something else, whatever it is called there.
const dismissing =
  /--no-verify|--force|dangerously|\.skip\b|\.only\b|@ts-ignore|@ts-nocheck|biome-ignore|allowedtools|(?<![\p{L}\p{N}])(?:skip|bypass|disregard|waive|forgo|sidestep|circumvent|xfail|flak(?:y|es?|iness))|\bmove on\b|\bcarry on\b/u

/**
 * Whether `text` could skip or weaken a check, test, verifier, permission or hook: it names one at
 * all, or dismisses something.
 */
export const weakensChecks = (text: string): boolean => {
  const said = normal(text)
  return guarded.test(said) || dismissing.test(said)
}

// A word of git's or bd's as a word, not a file's name: src/run/merge.ts is code, and a merge conflict
// is what happens to a ticket, not how a worker uses git. A ticket named at all is bd's: the worker
// prompt sets what a worker does with one. "main" and the like say which ref, whatever the verb.
const gitOrBd =
  /(?<![\p{L}\p{N}_./])(?:git|bd|beads|commits?|committing|committed|amend\w*|push(?:es|ed|ing)?|pull(?:s|ed|ing)?|fetch\w*|rebas\w*|stash\w*|cherry[- ]pick\w*|worktrees?|branch(?:es)?|checkouts?|origin|main|master|revert\w*|squash\w*|tickets?|follow-?ups?|--hard|reset\s+(?:--\w+|your\b|hard\b)|switch\s+to|stag(?:e|ing)\s+(?:all|everything|your|the\s+changes)|merg(?:e|es|ing)(?!\s+(?:conflicts?|queue|train))|(?:close|closing|mark|reopen\w*|claim\w*|defer\w*|file|filing)\s+(?:\w+\s+){0,3}(?:issue|question)s?)(?![\p{L}\p{N}_-]|\.\p{L})/u

/** Whether `text` touches the git or bd usage the worker prompt sets. */
export const touchesGitOrBd = (text: string): boolean => gitOrBd.test(normal(text))

const carried =
  /ignore (?:all|any|the|your|previous|prior|earlier|above)|system prompt|standing rules|you are now|new instructions|<\/?evidence|https?:\/\/|\b(?:curl|wget|ssh|sudo|api[ _-]?key|secret|credentials?|password|token)\b/u

/**
 * Whether `text` carries instructions out of what the reflector read: a run of `quoteWords` words
 * from one of `transcripts`, or words of the kind an injected instruction uses.
 */
export const quotesTranscript = (text: string, transcripts: ReadonlyArray<string>): boolean => {
  if (carried.test(normal(text))) return true
  const list = words(text)
  if (list.length < quoteWords) return false
  const read = transcripts.map((transcript) => ` ${words(transcript).join(" ")} `)
  for (let i = 0; i + quoteWords <= list.length; i++) {
    const run = ` ${list.slice(i, i + quoteWords).join(" ")} `
    if (read.some((each) => each.includes(run))) return true
  }
  return false
}

/** Why the gate refuses `candidate`; undefined when it passes. */
export const gate = (candidate: Candidate, context: GateContext): Refusal | undefined => {
  const text = candidate.text
  if (normal(text) === "") return "empty"
  if (text.length > lessonCharacters) return "too_long"
  if (candidate.scope.length > scopeGlobs.most || !candidate.scope.every(goodGlob)) {
    return "bad_scope"
  }
  if (weakensChecks(text)) return "weakens_checks"
  if (touchesGitOrBd(text)) return "git_or_bd"
  if (quotesTranscript(text, context.transcripts)) return "quotes_transcript"
  if (
    candidate.evidence.length === 0 ||
    !candidate.evidence.every((each) => context.known(each.ticket, each.event))
  ) {
    return "no_evidence"
  }
  if (context.lessons.some((lesson) => alike(lesson.text, text))) return "duplicate"
  return undefined
}

/** What a lesson past the gate starts as: active only for a pitfall scoped to an area. */
export const admittedState = (
  candidate: Pick<Candidate, "kind" | "scope">,
): "active" | "proposed" =>
  candidate.kind === "pitfall" && !spansProject(candidate.scope) ? "active" : "proposed"

// ---------------------------------------------------------------------------------------------
// The deltas

/** A lesson's helpful less harmful counts. */
const net = (lesson: Lesson): number => lesson.helpful - lesson.harmful

/** The lesson a new one displaces from a full pool: a retired one, else the least helpful. */
export const displaceable = (lessons: ReadonlyArray<Lesson>): Lesson | undefined => {
  const oldestFirst = [...lessons].sort((a, b) => a.version - b.version)
  return (
    oldestFirst.find((lesson) => lesson.state === "retired") ??
    oldestFirst.sort((a, b) => net(a) - net(b))[0]
  )
}

/**
 * The pool with `candidate` added at the next version, displacing another at `cap`; undefined when
 * the pool can hold nothing.
 */
export const addLesson = (
  lessons: ReadonlyArray<Lesson>,
  candidate: Candidate,
  cap: number,
  at: string,
):
  | {
      readonly lessons: ReadonlyArray<Lesson>
      readonly lesson: Lesson
      readonly displaced?: string
    }
  | undefined => {
  const out = lessons.length >= cap ? displaceable(lessons) : undefined
  if (lessons.length >= cap && out === undefined) return undefined
  const version = versionOf(lessons) + 1
  const lesson: Lesson = {
    id: `L${version}`,
    text: candidate.text,
    scope: candidate.scope,
    kind: candidate.kind,
    evidence: candidate.evidence,
    state: admittedState(candidate),
    helpful: 0,
    harmful: 0,
    held_clean: 0,
    held_bad: 0,
    measured: [],
    admitted_at: at,
    version,
  }
  return {
    lessons: [...lessons.filter((each) => each.id !== out?.id), lesson],
    lesson,
    ...(out === undefined ? {} : { displaced: out.id }),
  }
}

const changeOne = (
  lessons: ReadonlyArray<Lesson>,
  id: string,
  change: (lesson: Lesson, version: number) => Lesson,
): ReadonlyArray<Lesson> => {
  const version = versionOf(lessons) + 1
  return lessons.map((lesson) => (lesson.id === id ? change(lesson, version) : lesson))
}

/** The pool with lesson `id` retired, for `why`, at the next version. */
export const retireLesson = (
  lessons: ReadonlyArray<Lesson>,
  id: string,
  why: RetiredWhy,
): ReadonlyArray<Lesson> =>
  changeOne(lessons, id, (lesson, version) => ({
    ...lesson,
    state: "retired",
    retired: why,
    version,
  }))

/** The pool with lesson `id` active, as you approved it, at the next version. */
export const approveLesson = (lessons: ReadonlyArray<Lesson>, id: string): ReadonlyArray<Lesson> =>
  changeOne(lessons, id, (lesson, version) => ({ ...lesson, state: "active", version }))

/** The pool with lesson `id` saying `text`, its counts begun again, at the next version. */
export const editLesson = (
  lessons: ReadonlyArray<Lesson>,
  id: string,
  text: string,
): ReadonlyArray<Lesson> =>
  changeOne(lessons, id, (lesson, version) => ({
    ...lesson,
    text,
    helpful: 0,
    harmful: 0,
    held_clean: 0,
    held_bad: 0,
    measured: [],
    version,
  }))

/** `lesson` with `ticket`'s scorecard counted, once a ticket: shown it or held back, clean or not. */
export const measured = (
  lesson: Lesson,
  ticket: string,
  shown: boolean,
  clean: boolean,
): Lesson => {
  if (lesson.measured.includes(ticket)) return lesson
  const counted = { ...lesson, measured: [...lesson.measured, ticket] }
  if (shown) {
    return clean
      ? { ...counted, helpful: lesson.helpful + 1 }
      : { ...counted, harmful: lesson.harmful + 1 }
  }
  return clean
    ? { ...counted, held_clean: lesson.held_clean + 1 }
    : { ...counted, held_bad: lesson.held_bad + 1 }
}

// ---------------------------------------------------------------------------------------------
// The holdout

/** Which arm of `lesson`'s holdout `ticket` is in: true, shown it. Half of them, by a hash. */
export const armOf = (lesson: string, ticket: string): boolean =>
  ((createHash("sha256").update(`${lesson}\0${ticket}`).digest()[0] ?? 0) & 1) === 0

/** What a ticket gets of the playbook: the lessons its worker reads, those held back from it. */
export interface Chosen {
  readonly version: number
  readonly lessons: ReadonlyArray<Lesson>
  readonly held: ReadonlyArray<Lesson>
}

/**
 * What `ticket`, of `footprint`, gets of `lessons`: the active ones in its scope, each in its arm,
 * the most helpful first and at most `most` shown; one past that is in neither arm.
 */
export const chosenFor = (
  lessons: ReadonlyArray<Lesson>,
  footprint: Pick<Footprint, "files" | "globs">,
  ticket: string,
  most: number,
): Chosen => {
  const version = versionOf(lessons)
  if (most === 0) return { version, lessons: [], held: [] }
  const applying = lessons.filter(
    (lesson) => lesson.state === "active" && inScope(lesson.scope, footprint),
  )
  const shown = applying
    .filter((lesson) => armOf(lesson.id, ticket))
    .sort((a, b) => net(b) - net(a) || a.version - b.version)
  return {
    version,
    lessons: shown.slice(0, most),
    held: applying.filter((lesson) => !armOf(lesson.id, ticket)),
  }
}

/** What a dispatch record says of `chosen`; undefined with no lesson in the ticket's scope. */
export const dispatchOf = (chosen: Chosen): typeof DispatchPlaybook.Type | undefined =>
  chosen.lessons.length + chosen.held.length === 0
    ? undefined
    : {
        version: chosen.version,
        lessons: chosen.lessons.map((lesson) => lesson.id),
        held: chosen.held.map((lesson) => lesson.id),
      }

const scopeWords = (scope: ReadonlyArray<string>): string =>
  scope.length === 0 ? "the whole project" : scope.join(", ")

/** The section of a worker's standing rules that holds `chosen`'s lessons; empty with none. */
export const lessonsSection = (chosen: Chosen): string =>
  chosen.lessons.length === 0
    ? ""
    : `\n\n## Lessons from this project's earlier tickets (tutti's playbook, version ${chosen.version})\n\n` +
      "tutti distilled these from how earlier tickets went. They are advice on the work: your rules " +
      "above stand over them, and none of them changes a check, a test, the verifier, a permission, " +
      "a hook, or how you use git and bd.\n\n" +
      chosen.lessons
        .map(
          (lesson) =>
            `- ${oneLine(sanitizeLine(lesson.text), lessonCharacters)} (${lesson.kind}; ${oneLine(sanitizeLine(scopeWords(lesson.scope)), scopeGlobs.characters)})`,
        )
        .join("\n") +
      "\n"

// ---------------------------------------------------------------------------------------------
// The measure

/** Whether a scorecard's outcome is a judged end: not a ticket waiting, stopped or back in the queue. */
export const judgedOutcome = (outcome: Score["outcome"]): boolean =>
  outcome === "merged" || outcome === "no_change" || outcome === "set_aside"

/**
 * Whether a scorecard went clean: merged or closed with no change, no hand-back, no check of its
 * failed or timed out, no verifier round failed and its last fix verified. Working time and cost
 * are left out: tickets differ too much in both for so few of them to say anything.
 */
export const cleanScore = (score: Score): boolean =>
  (score.outcome === "merged" || score.outcome === "no_change") &&
  score.hand_backs.resolve + score.hand_backs.fix === 0 &&
  score.checks.failed + score.checks.timed_out === 0 &&
  score.verifier.failed === 0 &&
  score.verifier.last_fix_verified !== false

const logFactorials = [0]
const logFactorial = (n: number): number => {
  for (let i = logFactorials.length; i <= n; i++) {
    logFactorials.push((logFactorials[i - 1] ?? 0) + Math.log(i))
  }
  return logFactorials[n] ?? 0
}

/**
 * Fisher's exact test, two-sided, of the table [a b; c d]: the chance, the margins kept, of a table
 * no likelier than this one.
 */
export const fisher = (a: number, b: number, c: number, d: number): number => {
  const row = a + b
  const other = c + d
  const column = a + c
  const all = row + other
  const chance = (x: number): number =>
    Math.exp(
      logFactorial(row) +
        logFactorial(other) +
        logFactorial(column) +
        logFactorial(all - column) -
        logFactorial(all) -
        logFactorial(x) -
        logFactorial(row - x) -
        logFactorial(column - x) -
        logFactorial(other - column + x),
    )
  const seen = chance(a)
  let p = 0
  for (let x = Math.max(0, column - other); x <= Math.min(row, column); x++) {
    const each = chance(x)
    // A hair over, so that a table as likely as this one still counts, its sums rounded as they are.
    if (each <= seen * (1 + 1e-9)) p += each
  }
  return Math.min(1, p)
}

/** How unlikely an effect is by chance for it to count as one. */
export const significance = 0.05

/** A lesson's effect: the shown arm's clean rate less the held-back arm's, and the test of it. */
export const effectOf = (
  lesson: Pick<Lesson, "helpful" | "harmful" | "held_clean" | "held_bad">,
): { readonly effect: number; readonly p: number } | undefined => {
  const shown = lesson.helpful + lesson.harmful
  const held = lesson.held_clean + lesson.held_bad
  if (shown === 0 || held === 0) return undefined
  return {
    effect: lesson.helpful / shown - lesson.held_clean / held,
    p: fisher(lesson.helpful, lesson.harmful, lesson.held_clean, lesson.held_bad),
  }
}

/**
 * What `lesson`'s counts make of it: harmful once it measurably hurts, whatever its uses; of no
 * effect, past `uses` uses (never with 0), unless it measurably helps; nothing yet, else.
 */
export const judgement = (
  lesson: Pick<Lesson, "helpful" | "harmful" | "held_clean" | "held_bad">,
  uses: number,
): Exclude<RetiredWhy, "by_you"> | undefined => {
  const found = effectOf(lesson)
  const shows = found !== undefined && found.p < significance
  if (shows && found.effect < 0) return "harmful"
  if (uses > 0 && lesson.helpful + lesson.harmful >= uses && !(shows && found.effect > 0)) {
    return "no_effect"
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// The report

const cell = (untrusted: string): string => escapeMarkdown(sanitizeLine(untrusted))

const effectWords = (lesson: Lesson): string => {
  const found = effectOf(lesson)
  if (found === undefined) return "not yet"
  const points = Math.round(found.effect * 100)
  return `${points > 0 ? "+" : ""}${points} points (p ${found.p.toFixed(2)})`
}

const stateWords = (lesson: Lesson): string =>
  lesson.state !== "retired"
    ? lesson.state
    : lesson.retired === "no_effect"
      ? "retired, no effect"
      : lesson.retired === "harmful"
        ? "retired, harmful"
        : "retired, by you"

/**
 * The report's Playbook section, after the reviewer's text: the lessons waiting for you, and each
 * lesson's counts and effect; nothing with no lessons.
 */
export const playbookReport = (lessons: ReadonlyArray<Lesson>): string => {
  if (lessons.length === 0) return ""
  const proposed = lessons.filter((lesson) => lesson.state === "proposed")
  const waiting =
    proposed.length === 0
      ? ""
      : "\n### Proposed, waiting for you\n\n" +
        "None of these reaches a worker until you approve it, and no run waits for them: " +
        "`tutti playbook approve <id>`, `tutti playbook edit <id> <text>`, `tutti playbook retire <id>`.\n\n" +
        proposed
          .map(
            (lesson) =>
              `- **${cell(lesson.id)}** (${lesson.kind}, ${cell(scopeWords(lesson.scope))}; from ` +
              `${cell([...new Set(lesson.evidence.map((each) => each.ticket))].join(", "))}): ${cell(lesson.text)}`,
          )
          .join("\n") +
        "\n"
  const rows = lessons.map(
    (lesson) =>
      `| ${[
        cell(lesson.id),
        stateWords(lesson),
        lesson.kind,
        cell(scopeWords(lesson.scope)),
        lesson.helpful,
        lesson.harmful,
        lesson.held_clean,
        lesson.held_bad,
        effectWords(lesson),
        cell(lesson.text),
      ].join(" | ")} |`,
  )
  return (
    `\n## Playbook\n\nVersion ${versionOf(lessons)} of ${playbookFile}: its lessons, each counted ` +
    "against its holdout, the half of the tickets in its scope held back from it. Helpful and " +
    "harmful are the tickets shown it that went clean and that didn't; the effect is the shown " +
    "clean rate less the held-back one.\n" +
    `${waiting}\n### Lessons\n\n` +
    "| Lesson | State | Kind | Scope | Helpful | Harmful | Held back, clean | Held back, not | Effect | Text |\n" +
    "|---|---|---|---|---|---|---|---|---|---|\n" +
    `${rows.join("\n")}\n`
  )
}

// ---------------------------------------------------------------------------------------------
// The file

/** The playbook's file couldn't be read or written, as a link in its path was refused. */
export class PlaybookUnavailable extends Schema.TaggedError<PlaybookUnavailable>()(
  "PlaybookUnavailable",
  { reason: Schema.String },
) {}

const unavailable = (reason: string) => new PlaybookUnavailable({ reason })

const whyOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The playbook in the main checkout `repo`, through the symlink guard (openUnder, § 9.1): empty when
 * it has none; a link in its path is refused, as a merged ticket can leave one there.
 */
export const readPlaybook = (repo: string): Effect.Effect<Read, PlaybookUnavailable> =>
  Effect.acquireUseRelease(
    openUnder(repo, playbookFile, O.RDONLY).pipe(
      Effect.catchIf(
        (error) => error instanceof LibcError && error.code === "ENOENT",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError((error) => unavailable(error.message)),
    ),
    (fd) =>
      fd === undefined
        ? Effect.succeed(parsePlaybook(""))
        : Effect.try({
            try: () => parsePlaybook(readFileSync(fd, "utf8")),
            catch: (error) => unavailable(whyOf(error)),
          }),
    (fd) => (fd === undefined ? Effect.void : Effect.ignore(close(fd))),
  )

// How long a writer waits for the other to be done: a write takes milliseconds.
const lockTries = 200
const lockWait = Duration.millis(25)

const locked = <A, E, R>(
  repo: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlaybookUnavailable, R> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const folders = makeFoldersUnder(repo, ".tutti/run")
      if (folders !== undefined) return yield* unavailable(folders)
      const fd = yield* openUnder(repo, lockFile, O.RDWR | O.CREAT).pipe(
        Effect.mapError((error) => unavailable(error.message)),
      )
      for (let tried = 0; tried < lockTries; tried++) {
        const held = yield* flockExclusiveNonBlocking(fd).pipe(
          Effect.catch((error) =>
            Effect.andThen(Effect.ignore(close(fd)), Effect.fail(unavailable(error.message))),
          ),
        )
        if (held) return fd
        yield* Effect.sleep(lockWait)
      }
      yield* Effect.ignore(close(fd))
      return yield* unavailable(`another writer holds ${lockFile}`)
    }),
    () => use,
    (fd) => Effect.ignore(close(fd)),
  )

/**
 * Changes the playbook in `repo` as `change` says of the lessons there now, one writer at a time:
 * the file is replaced whole, so a reader finds the old one or the new one, and the lines that
 * aren't lessons stay. It is not written when `change` gives back the lessons it was given.
 */
export const changePlaybook = <A>(
  repo: string,
  change: (lessons: ReadonlyArray<Lesson>) => {
    readonly lessons: ReadonlyArray<Lesson>
    readonly result: A
  },
): Effect.Effect<A, PlaybookUnavailable> =>
  locked(
    repo,
    Effect.gen(function* () {
      const read = yield* readPlaybook(repo)
      const { lessons, result } = change(read.lessons)
      if (lessons === read.lessons) return result
      const folders = makeFoldersUnder(repo, ".tutti")
      if (folders !== undefined) return yield* unavailable(folders)
      yield* writeFileUnder(repo, playbookFile, formatPlaybook({ lessons, bad: read.bad })).pipe(
        Effect.mapError((error) => unavailable(error.message)),
      )
      return result
    }),
  )
