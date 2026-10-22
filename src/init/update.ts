// tutti init --update (§ 8.3): brings the project's worker prompt and verifier up to date with
// tutti's templates (./templates.ts). In each, only the sections the templates changed since the
// project's copy was written are rewritten from them, the rest of the file, the project's own
// sections included, kept as it is; .tutti/settings.json then records the templates' versions now.
// It prints the diff of each file it rewrote and leaves the commit to you. It holds the run lock,
// as init does, so that no run starts in a tree it writes into.
import { join } from "node:path"
import { Clock, Effect, FileSystem } from "effect"
import { settingsFile } from "../project/settings.ts"
import { writeFileAtomic } from "../services/atomicFile.ts"
import { RunLock } from "../services/RunLock.ts"
import { verifierFor, verifierPath } from "./checks.ts"
import { readSettingsJson, refused, workerPromptPath } from "./init.ts"
import { joinAnd, type Step, step, stepLine } from "./steps.ts"
import {
  currentPrompt,
  currentTemplates,
  type OutdatedTemplate,
  outdatedTemplates,
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
const currentText = (repo: string, outdated: OutdatedTemplate) =>
  outdated.path === verifierPath
    ? // The verifier's stack, which the scout found, is the copy's: no change touches that section.
      verifierFor(repo, [])
    : Effect.succeed(currentPrompt(outdated.text))

/**
 * Brings the worker prompt and the verifier of the project at `repo` up to date with tutti's
 * templates: in each, the sections the templates changed since the project's copy was written are
 * rewritten from them (`updated`), and the settings record the templates' versions now. It writes
 * nothing where nothing is out of date but the versions the settings record. Refused in a project
 * init hasn't set up, and with settings it can't read.
 */
export const updateTemplates = (repo: string) =>
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
    const files = [
      { path: workerPromptPath, label: "worker prompt" },
      { path: verifierPath, label: "verifier" },
    ]
    const verifierThere = yield* fs.exists(join(repo, verifierPath))
    for (const file of files) {
      const found = outdated.find((each) => each.path === file.path)
      if (found === undefined) {
        if (file.path === verifierPath && !verifierThere) continue
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
      verifier: verifierThere ? currentTemplates.verifier : 0,
    }
    if (
      read.json === null ||
      recorded.worker_prompt !== now.worker_prompt ||
      recorded.verifier !== now.verifier
    ) {
      const json = structuredClone(read.json ?? {})
      json.templates = now.verifier === 0 ? { worker_prompt: now.worker_prompt } : { ...now }
      yield* fs.makeDirectory(join(repo, ".tutti"), { recursive: true })
      yield* writeFileAtomic(join(repo, settingsFile), `${JSON.stringify(json, null, 2)}\n`)
      const versions = `worker prompt ${now.worker_prompt}${now.verifier === 0 ? "" : `, verifier ${now.verifier}`}`
      steps.push(
        step(
          "done",
          "settings",
          `recorded the versions of the templates the files now have (${versions})`,
          [settingsFile],
        ),
      )
    }
    return { steps, updates } satisfies TemplatesUpdated
  })

/** What is left after `updated`: to read the diff, where it rewrote a file, and to commit. */
export const updateNext = (updated: TemplatesUpdated): ReadonlyArray<string> => {
  const commit = [...new Set(updated.steps.flatMap((each) => each.commit ?? []))]
  return [
    ...(updated.updates.length === 0
      ? []
      : [
          "Read the diff above: a section rewritten from the template loses the project's own edits in it, which you may want to carry over.",
        ]),
    commit.length === 0
      ? "Nothing to commit: the worker prompt and the verifier have every change to their templates."
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
