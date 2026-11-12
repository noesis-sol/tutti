// `tutti playbook` (§ 8.1, tutti-5fs7.3): the maintainer's hand on the playbook (src/run/playbook.ts),
// in the main checkout, beside a run or between runs: it lists the lessons, the proposed first, with
// their counts and effect; `approve` makes a proposed lesson active, `edit` gives one new words, its
// counts begun again, and `retire` takes one out of workers' prompts. An edit goes through the gate's
// checks on the words, as a lesson from the reflector does, since a worker reads it the same way.

import { Effect } from "effect"
import { exitCodes } from "../run/holds.ts"
import {
  approveLesson,
  changePlaybook,
  editLesson,
  effectOf,
  type Lesson,
  lessonCharacters,
  noRecall,
  readPlaybook,
  recallOf,
  retireLesson,
  touchesGitOrBd,
  versionOf,
  weakensChecks,
} from "../run/playbook.ts"
import { oneLine } from "../text/oneLine.ts"
import { sanitizeLine } from "../text/sanitize.ts"

/** What `tutti playbook` is asked to do: list, or act on a lesson. */
export type PlaybookAct =
  | { readonly _tag: "List" }
  | { readonly _tag: "Approve"; readonly id: string }
  | { readonly _tag: "Edit"; readonly id: string; readonly text: string }
  | { readonly _tag: "Retire"; readonly id: string }

/** The exit codes, as the command's help gives them. */
export const playbookExits = "Exit codes: 0 done, 2 the lesson or the file refused."

/** What the command's arguments ask for, or why they don't ask for anything. */
export const playbookAct = (
  action: string | undefined,
  id: string | undefined,
  text: string | undefined,
): PlaybookAct | string => {
  if (action === undefined) return { _tag: "List" }
  if (action !== "approve" && action !== "edit" && action !== "retire") {
    return `give approve, edit or retire, not ${sanitizeLine(action)}`
  }
  if (id === undefined) return `${action} needs a lesson's ID`
  if (action === "edit") {
    return text === undefined ? "edit needs the lesson's new words" : { _tag: "Edit", id, text }
  }
  if (text !== undefined) return `${action} takes only a lesson's ID`
  return action === "approve" ? { _tag: "Approve", id } : { _tag: "Retire", id }
}

/** Where `tutti playbook` says what it found. */
export interface Say {
  readonly out: (line: string) => void
  readonly error: (line: string) => void
}

/** One lesson on a line: `L3 proposed pitfall src/** +2/-1, held 1/1, effect +17 points: text`. */
export const lessonLine = (lesson: Lesson): string => {
  const points = (found: { readonly effect: number; readonly p: number } | undefined): string =>
    found === undefined ? "" : ` ${Math.round(found.effect * 100)} points (p ${found.p.toFixed(2)})`
  const found = effectOf(lesson)
  const effect = found === undefined ? "" : `, effect${points(found)}`
  const counts = lesson.recall ?? noRecall
  const recall =
    lesson.record === undefined
      ? ""
      : `, recall staged ${counts.staged_clean}/${counts.staged_bad}, plain ${counts.plain_clean}/${counts.plain_bad}${points(recallOf(lesson))}`
  const scope = lesson.scope.length === 0 ? "the whole project" : lesson.scope.join(", ")
  const state = lesson.retired === undefined ? lesson.state : `retired (${lesson.retired})`
  return sanitizeLine(
    `${lesson.id} ${state} ${lesson.kind} [${scope}] helpful ${lesson.helpful}, harmful ${lesson.harmful}, ` +
      `held back ${lesson.held_clean} clean, ${lesson.held_bad} not${effect}${recall}: ${lesson.text}`,
  )
}

/** The line under a lesson's that holds its record, `  record: …`; undefined with none. */
export const recordLine = (lesson: Lesson): string | undefined =>
  lesson.record === undefined ? undefined : sanitizeLine(`  record: ${lesson.record}`)

const rank = (lesson: Lesson): number =>
  lesson.state === "proposed" ? 0 : lesson.state === "active" ? 1 : 2

/** Why `act` can't be done to `lesson`; undefined when it can. */
export const refusedAct = (act: PlaybookAct, lesson: Lesson | undefined): string | undefined => {
  if (act._tag === "List") return undefined
  if (lesson === undefined) return `no lesson ${act.id}`
  if (lesson.state === "retired") return `${act.id} is retired`
  if (act._tag === "Approve" && lesson.state !== "proposed") return `${act.id} is active already`
  if (act._tag !== "Edit") return undefined
  const text = oneLine(sanitizeLine(act.text), lessonCharacters + 1)
  if (text === "") return "the lesson's text is empty"
  if (text.length > lessonCharacters) return `a lesson is at most ${lessonCharacters} characters`
  if (weakensChecks(text)) {
    return "a lesson doesn't name a check, test, verifier, permission or hook, or dismiss anything"
  }
  if (touchesGitOrBd(text))
    return "a lesson doesn't name a ticket, or anything of how workers use git or bd"
  return undefined
}

/** `tutti playbook` in the main checkout `top`, as `act` says: its exit code. */
export const playbook = (top: string, act: PlaybookAct, say: Say) =>
  Effect.gen(function* () {
    const failed = (why: string) =>
      Effect.sync(() => {
        say.error(`tutti playbook: ${why}`)
        return exitCodes.setup as number
      })
    if (act._tag === "List") {
      const read = yield* Effect.result(readPlaybook(top))
      if (read._tag === "Failure") return yield* failed(read.failure.reason)
      const { lessons, bad } = read.success
      if (lessons.length === 0) say.out("The playbook has no lessons yet.")
      else {
        say.out(`Playbook version ${versionOf(lessons)}:`)
        for (const lesson of [...lessons].sort((a, b) => rank(a) - rank(b))) {
          say.out(lessonLine(lesson))
          const record = recordLine(lesson)
          if (record !== undefined) say.out(record)
        }
      }
      if (bad.length > 0)
        say.error(`tutti playbook: ${bad.length} lines aren't lessons, left as they are`)
      return exitCodes.ok as number
    }
    const done = yield* Effect.result(
      changePlaybook(top, (lessons) => {
        const lesson = lessons.find((each) => each.id === act.id)
        const refused = refusedAct(act, lesson)
        if (refused !== undefined) return { lessons, result: refused }
        const next =
          act._tag === "Approve"
            ? approveLesson(lessons, act.id)
            : act._tag === "Retire"
              ? retireLesson(lessons, act.id, "by_you")
              : editLesson(lessons, act.id, oneLine(sanitizeLine(act.text), lessonCharacters))
        return { lessons: next, result: undefined }
      }),
    )
    if (done._tag === "Failure") return yield* failed(done.failure.reason)
    if (done.success !== undefined) return yield* failed(done.success)
    const words = { Approve: "approved", Edit: "edited", Retire: "retired" }
    say.out(`${act.id} ${words[act._tag]}.`)
    return exitCodes.ok as number
  })
