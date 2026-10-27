// tutti init --update (§ 8.3): brings the project's worker prompt, verifier and create-check-suite
// skill up to date with tutti's templates (./templates.ts). In each, only the sections the templates
// changed since the project's copy was written are rewritten from them, the rest of the file, the
// project's own sections included, kept as it is; .tutti/settings.json then records the templates'
// versions now, and gets "keep_awake": true where it has no keep_awake. Its files are written as
// one, as init's setup is (./staged.ts): staged, then put in together, the settings last, so that a
// failed write leaves them as they were. It prints the diff of each file it rewrote and leaves the
// commit to you. It holds the run lock, as init does, so that no run starts in a tree it writes
// into.
import { join } from "node:path"
import { Clock, Effect, FileSystem, Option } from "effect"
import { setIn } from "../project/jsonText.ts"
import { settingsFile } from "../project/settings.ts"
import { AtomicWriter, writeFileAtomic } from "../services/atomicFile.ts"
import { RunLock } from "../services/RunLock.ts"
import { skillPath, skillText, verifierFor, verifierPath } from "./checks.ts"
import { readSettingsJson, refused, workerPromptPath } from "./init.ts"
import { commitStaged, staging } from "./staged.ts"
import { joinAnd, type Step, step, stepLine } from "./steps.ts"
import {
  currentPrompt,
  currentTemplates,
  type OutdatedTemplate,
  outdatedTemplates,
  ownVerifier,
  sectionNames,
  type Templates,
  unifiedDiff,
  updated,
} from "./templates.ts"

/** A file `tutti init --update` rewrote: its text before and after. */
export interface TemplateUpdate {
  /** From the project's top. */
  readonly path: string
  readonly before: string
  readonly after: string
}

/** What `tutti init --update` did: its steps and the files it rewrote, for their diff. */
export interface TemplatesUpdated {
  readonly steps: ReadonlyArray<Step>
  readonly updates: ReadonlyArray<TemplateUpdate>
}

/** The template `outdated` came from, as init would write it for the project at `repo` now. */
const currentText = (repo: string, outdated: OutdatedTemplate) => {
  // The verifier's stack, which the scout found, is the copy's: no change touches that section.
  if (outdated.path === verifierPath) return verifierFor(repo, [])
  if (outdated.path === skillPath) return Effect.succeed(skillText)
  return Effect.succeed(currentPrompt(outdated.text))
}

/** What `tutti init --update` says of the project's verifier at `path` where it is its own. */
const ownVerifierDetail = (path: string) =>
  `${path} is the project's own subagent, not a copy of tutti's verifier template: kept as it is`

/** `updateTemplates`'s writes, made through the FileSystem and AtomicWriter it is given. */
const planUpdate = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(join(repo, workerPromptPath)))) {
      return yield* refused(`no ${workerPromptPath} to update: run tutti init first`)
    }
    const read = yield* readSettingsJson(repo)
    const recorded = read.settings.templates
    const outdated = yield* outdatedTemplates(repo, recorded)
    const steps: Array<Step> = []
    const updates: Array<TemplateUpdate> = []
    const verifierThere = yield* fs.exists(join(repo, verifierPath))
    // A verifier of the project's own takes none of the template's changes: no version is its.
    const verifierOwn =
      verifierThere &&
      Option.exists(
        yield* fs.readFileString(join(repo, verifierPath)).pipe(Effect.option),
        ownVerifier,
      )
    const skillThere = yield* fs.exists(join(repo, skillPath))
    const files = [
      { path: workerPromptPath, label: "worker prompt", there: true },
      { path: verifierPath, label: "verifier", there: verifierThere },
      { path: skillPath, label: "skill", there: skillThere },
    ]
    for (const file of files) {
      const found = outdated.find((each) => each.path === file.path)
      if (found === undefined) {
        if (!file.there) continue
        if (file.path === verifierPath && verifierOwn) {
          steps.push(step("kept", file.label, ownVerifierDetail(file.path)))
          continue
        }
        steps.push(step("kept", file.label, `${file.path} has every change to its template`))
        continue
      }
      const after = updated(found.text, yield* currentText(repo, found), found.missing)
      yield* writeFileAtomic(join(repo, file.path), after)
      updates.push({ path: file.path, before: found.text, after })
      steps.push(
        step(
          "done",
          file.label,
          `rewrote ${sectionNames(found.missing)} in ${file.path} from the template; the rest is as it was`,
          [file.path],
        ),
      )
    }
    const now: Templates = {
      worker_prompt: currentTemplates.worker_prompt,
      verifier: verifierThere && !verifierOwn ? currentTemplates.verifier : 0,
      check_suite_skill: skillThere ? currentTemplates.check_suite_skill : 0,
    }
    const recordTemplates =
      read.json === null ||
      recorded.worker_prompt !== now.worker_prompt ||
      recorded.verifier !== now.verifier ||
      recorded.check_suite_skill !== now.check_suite_skill
    // Keeping awake is the default: a file written before keep_awake was read again gets the key,
    // so that the project sees it.
    const addKeepAwake = read.json === null || !Object.hasOwn(read.json, "keep_awake")
    if (recordTemplates || addKeepAwake) {
      const templates = {
        worker_prompt: now.worker_prompt,
        ...(now.verifier === 0 ? {} : { verifier: now.verifier }),
        ...(now.check_suite_skill === 0 ? {} : { check_suite_skill: now.check_suite_skill }),
      }
      // The project's file keeps its own formatting but for the keys written.
      let text =
        read.text === null
          ? `${JSON.stringify({ keep_awake: true, templates }, null, 2)}\n`
          : read.text
      if (read.text !== null && addKeepAwake) text = setIn(text, ["keep_awake"], true)
      if (read.text !== null && recordTemplates) text = setIn(text, ["templates"], templates)
      yield* fs.makeDirectory(join(repo, ".tutti"), { recursive: true })
      yield* writeFileAtomic(join(repo, settingsFile), text)
      if (addKeepAwake) {
        steps.push(
          step(
            "done",
            "settings",
            `added "keep_awake": true: runs keep the machine awake unless it is false`,
            [settingsFile],
          ),
        )
      }
      if (recordTemplates) {
        const versions = [
          `worker prompt ${now.worker_prompt}`,
          ...(now.verifier === 0 ? [] : [`verifier ${now.verifier}`]),
          ...(now.check_suite_skill === 0
            ? []
            : [`create-check-suite skill ${now.check_suite_skill}`]),
        ].join(", ")
        steps.push(
          step(
            "done",
            "settings",
            `recorded the versions of the templates the files now have (${versions})`,
            [settingsFile],
          ),
        )
      }
    }
    return { steps, updates } satisfies TemplatesUpdated
  })

/**
 * Brings the worker prompt, the verifier and the create-check-suite skill of the project at `repo`,
 * those it has, up to date with tutti's templates: in each, the sections the templates changed since
 * the project's copy was written are rewritten from them (`updated`), and the settings record the
 * templates' versions now. It writes nothing where nothing is out of date but the versions the
 * settings record. Refused in a project init hasn't set up, and with settings it can't read. Its
 * files are written as one, the settings last; where one can't be, it fails with SetupNotWritten,
 * having left them as they were.
 */
export const updateTemplates = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const staged = staging(fs)
    const result = yield* planUpdate(repo).pipe(
      Effect.provideService(FileSystem.FileSystem, staged.fs),
      Effect.provideService(AtomicWriter, staged.write),
    )
    yield* commitStaged(fs, repo, staged.writes(), join(repo, settingsFile))
    return result
  })

/** What is left after `updated`: to read the diff, where it rewrote a file, and to commit. */
export const updateNext = (updated: TemplatesUpdated): ReadonlyArray<string> => {
  const commit = [...new Set(updated.steps.flatMap((each) => each.commit ?? []))]
  // A verifier of the project's own has no template's changes to have.
  const current = [
    "the worker prompt",
    ...(updated.steps.some(
      (each) => each.label === "verifier" && each.detail === ownVerifierDetail(verifierPath),
    )
      ? []
      : ["the verifier"]),
    ...(updated.steps.some((each) => each.label === "skill")
      ? ["the create-check-suite skill"]
      : []),
  ]
  return [
    ...(updated.updates.length === 0
      ? []
      : [
          "Read the diff above: a section rewritten from the template loses the project's own edits in it, which you may want to carry over.",
        ]),
    commit.length === 0
      ? `Nothing to commit: ${joinAnd(current)} ${current.length === 1 ? "has every change to its template" : "have every change to their templates"}.`
      : `Commit ${joinAnd(commit)}.`,
  ]
}

/** What `tutti init --update` prints: its steps, the diff of each file it rewrote, what's left. */
export const updateLines = (updated: TemplatesUpdated): ReadonlyArray<string> => {
  const diffs = updated.updates
    .map((each) => unifiedDiff(each.path, each.before, each.after))
    .filter((diff) => diff !== "")
  return [
    ...updated.steps.map(stepLine),
    ...(diffs.length === 0 ? [] : ["", ...diffs.join("\n").replace(/\n$/, "").split("\n")]),
    "",
    "Next:",
    ...updateNext(updated).map((line) => `  ${line}`),
  ]
}

/** What `tutti init --update` works on: the project, and the lock it holds while it writes. */
export interface UpdateOptions {
  /** The main checkout. */
  readonly repo: string
  /** Its git folder that every worktree shares, absolute: where the run lock is. */
  readonly commonDir: string
  /** The branch the main checkout is on, for the lock. */
  readonly branch: string
  readonly version: string
}

/**
 * `tutti init --update` in the project at `options.repo`, holding the run lock: refused while a run
 * holds it, having changed nothing.
 */
export const initUpdate = (options: UpdateOptions) =>
  Effect.gen(function* () {
    const lock = yield* RunLock
    const started = new Date(yield* Clock.currentTimeMillis).toISOString()
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* lock
          .acquire({
            repo: options.repo,
            commonDir: options.commonDir,
            holder: {
              pid: process.pid,
              started,
              version: options.version,
              branch: options.branch,
              init: true as const,
            },
          })
          .pipe(
            Effect.mapError((error) =>
              refused(
                `${error.message}. init --update changes the files a run works from: update between runs.`,
              ),
            ),
          )
        return yield* updateTemplates(options.repo)
      }),
    )
  })
