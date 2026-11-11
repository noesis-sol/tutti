// The text work of tutti init --update (§ 8.3; ./update.ts): the worker prompt init would write for
// a project now (currentPrompt), a project's copy of a template with the sections the template
// changed taken from it (updated), and the unified diff it prints (unifiedDiff). The templates'
// versions, their changes and what a project's copies lack are src/project/templateVersions.ts's,
// which the run reads too.
import { builtInWorkerPrompt, withSuites } from "../project/prompt.ts"
import { suitesIntro, usesVerifier, verifierSection } from "../project/templateFiles.ts"
import { indexOf, sections, type TemplateChange } from "../project/templateVersions.ts"
import { lineDiff } from "../ui/transcriptItems.ts"

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
