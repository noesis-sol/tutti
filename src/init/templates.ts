// The versions of tutti's templates (§ 8.3), as orchestra 0.9.0 records its own: init writes the
// worker prompt, the verifier and the create-check-suite skill from tutti's templates, and from then
// on they are the project's, kept as they are. So that a project still hears of what tutti changes
// in its templates later, .tutti/settings.json records the version of each template its copy came
// from (`templates`), and the changes below say, section by section, what each later version
// changed. A run says under its START line which sections a project's copy lacks (templateNotes),
// init says it of the files it keeps, and `tutti init --update` rewrites those sections from the
// templates, keeping the rest of each file (./update.ts).
//
// A change to worker-prompt.md, verifierSection, verifier.md or create-check-suite.md is recorded
// here, as a new version of its template: the test that pins the templates
// (test/template-versions.test.ts) fails until it is.
import { join } from "node:path"
import { Effect, FileSystem, Option } from "effect"
import { builtInWorkerPrompt, requiresRule, withSuites } from "../project/prompt.ts"
import type { Settings } from "../project/settings.ts"
import verifierTemplate from "../project/templates/verifier.md" with { type: "text" }
import { lineDiff } from "../ui/transcriptItems.ts"
import {
  skillPath,
  skillText,
  suitesIntro,
  usesVerifier,
  verifierPath,
  verifierSection,
} from "./checks.ts"
import { joinAnd } from "./steps.ts"

/** One change to a template, made by one of its versions. */
export interface TemplateChange {
  /** The template's version that made it, counting from 1. */
  readonly version: number
  /** The heading of the section it changed (its "## " line's text), "" for the opening. */
  readonly section: string
  /** What changed, as the notice says it. */
  readonly what: string
  /**
   * Words only the changed text has, on one line of it: a project's copy that has them has the
   * change, though it records an older version (copied by hand) or none (written before versions
   * were recorded, or imported from orchestra). Where orchestra's template words the change as
   * tutti's does but for the name, the marker leaves the name out, so that a prompt imported from
   * orchestra with the change has it.
   */
  readonly marker: string
}

/** The heading of the worker prompt's section that runs the verifier. */
export const verifyHeading = "Verify"

/** The changes to the worker prompt's template, worker-prompt.md with verifierSection. */
export const promptChanges: ReadonlyArray<TemplateChange> = [
  {
    version: 1,
    section: "",
    what: "a removal Claude Code's safety check holds is refused outright in auto mode",
    marker: "in auto mode refuses it outright",
  },
  {
    version: 2,
    section: verifyHeading,
    what: "the worker gives the verifier the commit at which its checks passed and the commands it ran there, so that it needn't run them again",
    marker: "commit at which your checks passed",
  },
  {
    version: 2,
    section: verifyHeading,
    what: "a later round is given the earlier rounds' findings, and a disagreement between rounds goes to the maintainer rather than round again",
    marker: "earlier rounds' findings",
  },
  {
    version: 3,
    section: "",
    what: "a worker passes Bash no timeout of its own, as tutti raises Bash's default to the merge check's limit",
    marker: "Bash no timeout of your own",
  },
  {
    version: 4,
    section: "",
    what: "a worker checks its own change and leaves the whole suite to the merge check",
    marker: "Leave the whole suite to",
  },
  {
    version: 4,
    section: "Close",
    what: "a ticket closes once the worker's own checks pass",
    marker: "Close the ticket only when your checks pass",
  },
  {
    version: 4,
    section: verifyHeading,
    what: "the verifier runs once the worker's own checks pass",
    marker: "once your checks pass after your last commit",
  },
  {
    version: 5,
    section: "Working unattended",
    what: "no to-do checklist is asked for, which Beads' own guidance forbids",
    marker: "keep the ticket's notes current",
  },
  {
    version: 6,
    section: "",
    what: "what a ticket needs of the machine goes in the project's requires list, never installed by hand outside it",
    marker: requiresRule,
  },
]

/** The changes to the verifier's template, verifier.md. */
export const verifierChanges: ReadonlyArray<TemplateChange> = [
  {
    version: 1,
    section: "",
    what: "its description asks for the commit at which the worker's checks passed and the commands it ran there",
    marker: "the commands you ran there",
  },
  {
    version: 1,
    section: "Its checks",
    what: "how to run each suite on what a change touches",
    marker: "on what a change touches where its tool allows it",
  },
  {
    version: 1,
    section: "How to verify",
    what: "it quotes the worker's passing checks at the same commit rather than run them again, and runs the suites only on what the change touches",
    marker: "Leave the whole suite to",
  },
  {
    version: 1,
    section: "How to verify",
    what: "it weighs the earlier rounds' findings and says where it disagrees with one, and why",
    marker: "DISAGREES WITH ROUND",
  },
  {
    version: 2,
    section: "Rules",
    what: "it passes Bash no timeout where Bash's default is as long as a check may take, as in a worker, and otherwise waits on a longer check in the background with short waits",
    marker: "Give a check its time",
  },
]

/** The heading of the skill's section that gets the runners passing. */
export const passingHeading = "4. Get the runners passing on main"

/** The changes to the create-check-suite skill's template, create-check-suite.md. */
export const skillChanges: ReadonlyArray<TemplateChange> = [
  {
    version: 1,
    section: passingHeading,
    what: "check-fast is run three times in all to catch a flaky test, and check-full once, at the end",
    marker: "Once check-fast passes, run it twice more",
  },
]

/** The versions of tutti's templates a project's files came from, as its settings record them. */
export type Templates = Settings["templates"]

/** The version of the last of `changes`. */
export const latestVersion = (changes: ReadonlyArray<TemplateChange>): number =>
  Math.max(0, ...changes.map((change) => change.version))

/** The versions of tutti's templates now. */
export const currentTemplates: Templates = {
  worker_prompt: latestVersion(promptChanges),
  verifier: latestVersion(verifierChanges),
  check_suite_skill: latestVersion(skillChanges),
}

/**
 * A part of a template or of a project's copy of it: the opening, before the first "## " heading
 * (title ""), or a heading and what follows it up to the next.
 */
export interface Section {
  readonly title: string
  readonly text: string
}

/** `text` split at its "## " headings; joined again, the sections give `text` back. */
export const sections = (text: string): ReadonlyArray<Section> => {
  const all: Array<{ title: string; text: string }> = [{ title: "", text: "" }]
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (line.startsWith("## ")) all.push({ title: line.slice(3).trim(), text: "" })
    const last = all[all.length - 1] as { title: string; text: string }
    last.text += line
  }
  return all
}

const indexOf = (all: ReadonlyArray<Section>, title: string): number =>
  all.findIndex((each) => each.title === title)

/** A file of the project's that init wrote from one of tutti's templates. */
interface TemplateFile {
  /** From the project's top. */
  readonly path: string
  /** The template's name, as the notice says it. */
  readonly template: string
  readonly changes: ReadonlyArray<TemplateChange>
  readonly recorded: (templates: Templates) => number
  /** The titles of the template's sections, in its order: the order the notice names them in. */
  readonly order: ReadonlyArray<string>
  /**
   * Whether a project's copy, `text`, may go without the section titled `title`: the worker
   * prompt's Verify where it doesn't run the verifier. A change to such a section isn't the copy's
   * to take.
   */
  readonly optional: (text: string, title: string) => boolean
  /**
   * Whether `text`, the file at the template's path, is the project's own rather than a copy of the
   * template: none of the template's changes are its to take.
   */
  readonly own: (text: string) => boolean
}

/** The worker prompt, from the project's top. */
const promptPath = join(".tutti", "worker-prompt.md")

const promptFile: TemplateFile = {
  path: promptPath,
  template: "worker prompt",
  changes: promptChanges,
  recorded: (templates) => templates.worker_prompt,
  order: sections(builtInWorkerPrompt + verifierSection).map((each) => each.title),
  optional: (text, title) => title === verifyHeading && !usesVerifier(text),
  own: () => false,
}

/**
 * Words every version of the verifier's template opens with, orchestra's too: a verifier.md without
 * them, nor the template's sections of its own, is the project's own subagent of that name.
 */
export const verifierOpening = "You verify a change you did not write"

/** The headings of the verifier template's sections that a project's own verifier wouldn't have. */
const verifierHeadings = ["Its checks", "How to verify"]

const verifierFile: TemplateFile = {
  path: verifierPath,
  template: "verifier",
  changes: verifierChanges,
  recorded: (templates) => templates.verifier,
  order: sections(verifierTemplate).map((each) => each.title),
  optional: () => false,
  own: (text) =>
    !text.includes(verifierOpening) &&
    !sections(text).some((each) => verifierHeadings.includes(each.title)),
}

/** Whether `text`, the project's .claude/agents/verifier.md, is its own subagent, not tutti's. */
export const ownVerifier = (text: string): boolean => verifierFile.own(text)

const skillFile: TemplateFile = {
  path: skillPath,
  template: "create-check-suite skill",
  changes: skillChanges,
  recorded: (templates) => templates.check_suite_skill,
  order: sections(skillText).map((each) => each.title),
  // A copy without the section is the project's own skill, not tutti's to change.
  optional: () => true,
  own: () => false,
}

/**
 * The changes of `file`'s template that `text`, the project's copy, which came from version
 * `recorded` of it, lacks: those since that version, unless the copy has their marker; in the
 * order of the template's sections. None where `text` is the project's own file, not a copy.
 */
const missingChanges = (
  file: TemplateFile,
  text: string,
  recorded: number,
): ReadonlyArray<TemplateChange> => {
  if (file.own(text)) return []
  const have = sections(text)
  const place = (change: TemplateChange) => file.order.indexOf(change.section)
  return file.changes
    .filter(
      (change) =>
        change.version > recorded &&
        !text.includes(change.marker) &&
        !(indexOf(have, change.section) < 0 && file.optional(text, change.section)),
    )
    .toSorted((a, b) => place(a) - place(b))
}

/** How the notice names the section titled `title`. */
const sectionName = (title: string): string => (title === "" ? "the opening" : title)

/** The titles of the sections `changes` changed, in the order they first come. */
const changedTitles = (changes: ReadonlyArray<TemplateChange>): ReadonlyArray<string> => [
  ...new Set(changes.map((change) => change.section)),
]

/** The sections `changes` changed, as the notice names them: "the opening and Close". */
export const sectionNames = (changes: ReadonlyArray<TemplateChange>): string =>
  joinAnd(changedTitles(changes).map(sectionName))

/** The sections `changes` changed, each with what changed in it: "the opening (a; b) and Close (c)". */
export const changedSections = (changes: ReadonlyArray<TemplateChange>): string =>
  joinAnd(
    changedTitles(changes).map(
      (title) =>
        `${sectionName(title)} (${changes
          .filter((change) => change.section === title)
          .map((change) => change.what)
          .join("; ")})`,
    ),
  )

/**
 * A file of the project's that lacks changes tutti made to its template since the project's copy
 * was written.
 */
export interface OutdatedTemplate {
  /** From the project's top. */
  readonly path: string
  /** The template's name: "worker prompt", "verifier", "create-check-suite skill". */
  readonly template: string
  /** The project's copy. */
  readonly text: string
  readonly missing: ReadonlyArray<TemplateChange>
}

/** What a run's start says of `outdated`, and how to take its changes. */
export const templateNote = (outdated: OutdatedTemplate): string =>
  `templates: ${outdated.path} is older than tutti's ${outdated.template} template, which has since changed ${changedSections(outdated.missing)}: tutti init --update rewrites those sections from the template, keeping the rest of the file, and shows the diff to commit`

/** What init says of `outdated`, a file it keeps as it is. */
export const keptNote = (outdated: OutdatedTemplate): string =>
  `${outdated.path} is older than tutti's ${outdated.template} template, which has since changed ${sectionNames(outdated.missing)}: tutti init --update takes those sections`

/**
 * The project's worker prompt, verifier and create-check-suite skill at `repo`, those it has, that
 * lack changes tutti made to their templates since the versions `recorded` names; the worker prompt
 * only where `prompt`. A file tutti can't read is left out: the run and init each say so where they
 * read it.
 */
export const outdatedTemplates = (repo: string, recorded: Templates, prompt = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const outdated: Array<OutdatedTemplate> = []
    for (const file of prompt ? [promptFile, verifierFile, skillFile] : [verifierFile, skillFile]) {
      const text = yield* fs.readFileString(join(repo, file.path)).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const missing = missingChanges(file, text.value, file.recorded(recorded))
      if (missing.length > 0) {
        outdated.push({ path: file.path, template: file.template, text: text.value, missing })
      }
    }
    return outdated
  })

/**
 * What a run says at its start of the project's worker prompt, verifier and skill where they are
 * older than tutti's templates: a line each (templateNote). `prompt` is false where the run's worker
 * prompt is its own (--prompt), and the project's isn't used.
 */
export const templateNotes = (repo: string, recorded: Templates, prompt: boolean) =>
  Effect.map(outdatedTemplates(repo, recorded, prompt), (outdated) => outdated.map(templateNote))

/** The lines of `text` after its line `intro` that start with two spaces: the bullets init wrote. */
const keptBullets = (text: string, intro: string): string => {
  const at = `\n${text}`.indexOf(`\n${intro}`)
  if (at < 0) return ""
  const bullets: Array<string> = []
  for (const line of text.slice(at + intro.length).match(/[^\n]*\n/g) ?? []) {
    if (!line.startsWith("  ")) break
    bullets.push(line)
  }
  return bullets.join("")
}

/**
 * The worker prompt init would write now for a project whose prompt is `text`: the template, with
 * the Verify section where `text` runs the verifier. Init doesn't know the suites here, which the
 * scout found: the lines on running each on part of the project are `text`'s, a bullet a suite,
 * where it has them, and else say where the suites are.
 */
export const currentPrompt = (text: string): string => {
  const bullets = keptBullets(text, suitesIntro)
  const prompt = withSuites(builtInWorkerPrompt, bullets === "" ? "" : suitesIntro + bullets)
  return usesVerifier(text) ? `${prompt}${verifierSection}` : prompt
}

/**
 * `text`, a project's copy of a template, with the sections `changes` changed taken from `current`,
 * the template as init would write it for the project now: each replaced where `text` has it, else
 * added after the section before it in `current` that `text` has. The other sections, the
 * project's own among them, are kept as they are.
 */
export const updated = (
  text: string,
  current: string,
  changes: ReadonlyArray<Pick<TemplateChange, "section">>,
): string => {
  const have = sections(text).map((each) => ({ ...each }))
  const want = sections(current)
  for (const title of new Set(changes.map((change) => change.section))) {
    const w = indexOf(want, title)
    const taken = want[w]
    if (taken === undefined) continue // a section the template no longer has
    const i = indexOf(have, title)
    const there = have[i]
    if (there !== undefined) {
      there.text = taken.text
      continue
    }
    let at = have.length
    for (let p = w - 1; p >= 0; p--) {
      const found = indexOf(have, want[p]?.title ?? "")
      if (found >= 0) {
        at = found + 1
        break
      }
    }
    const before = have[at - 1]
    if (at === have.length && before !== undefined && !before.text.endsWith("\n")) {
      before.text += "\n"
    }
    have.splice(at, 0, { ...taken })
  }
  return have.map((each) => each.text).join("")
}

/** The lines of `text`, without their newlines. */
const diffLines = (text: string): ReadonlyArray<string> =>
  text === "" ? [] : text.replace(/\n$/, "").split("\n")

/** The unchanged lines a hunk shows around a change. */
const diffContext = 3

/** The unified diff of the file at `path` from `before` to `after`; "" where they are the same. */
export const unifiedDiff = (path: string, before: string, after: string): string => {
  const ops = lineDiff(diffLines(before), diffLines(after))
  // Where each line is in the old and the new text: the next line's place for the text it isn't in.
  const places: Array<{ readonly old: number; readonly now: number }> = []
  let old = 0
  let now = 0
  for (const each of ops) {
    places.push({ old, now })
    if (each.op !== "+") old++
    if (each.op !== "-") now++
  }
  const hunks: Array<string> = []
  let start = 0
  while (start < ops.length) {
    while (start < ops.length && ops[start]?.op === " ") start++
    if (start === ops.length) break
    // A hunk: from diffContext lines before the change to diffContext after the last change that
    // lies within 2 * diffContext unchanged lines of the one before it.
    const from = Math.max(start - diffContext, 0)
    let end = start
    for (let i = start, same = 0; i < ops.length && same <= 2 * diffContext; i++) {
      if (ops[i]?.op === " ") same++
      else {
        end = i
        same = 0
      }
    }
    const to = Math.min(end + 1 + diffContext, ops.length)
    const body = ops.slice(from, to)
    const oldCount = body.filter((each) => each.op !== "+").length
    const newCount = body.filter((each) => each.op !== "-").length
    const at = places[from] ?? { old: 0, now: 0 }
    hunks.push(
      `@@ -${at.old + 1},${oldCount} +${at.now + 1},${newCount} @@\n`,
      ...body.map((each) => `${each.op}${each.line}\n`),
    )
    start = to
  }
  return hunks.length === 0 ? "" : [`--- a/${path}\n+++ b/${path}\n`, ...hunks].join("")
}
