// `tutti requires` (§ 8.1), as orchestra 0.9.1's `orchestra requires`: checks what this machine must
// have for the project, the requires list in .tutti/settings.json, as each run does before its first
// ticket: each entry's check, and for one that fails, its install, then the check again. It prints
// each entry's state; what is still missing says its manual step, or why its install failed and
// where its output is. --no-install only checks; --markdown and --readme check nothing, and give
// the list as the README's section on what to install instead, printed or written into README.md.
import { Deferred, Effect } from "effect"
import {
  readmeName,
  requiresEnd,
  requiresMarkdown,
  requiresStart,
  writeReadmeRequires,
} from "../project/requires.ts"
import { readSettings, settingsFile } from "../project/settings.ts"
import { exitCodes } from "../run/holds.ts"
import { listen } from "../run/quit.ts"
import { checkRequires, missingDetail, missingWord, says } from "../run/requires.ts"

/** What `tutti requires` is asked to do. */
export interface RequiresFlags {
  readonly noInstall: boolean
  readonly markdown: boolean
  readonly readme: boolean
}

/** Where `tutti requires` says what it found: stdout's lines, and stderr's. */
export interface Say {
  readonly out: (line: string) => void
  readonly error: (line: string) => void
}

/** The exit codes, as the command's help gives them. */
export const requiresExits =
  "Exit codes: 0 every requirement met, 2 one missing or the list refused, 130 Ctrl+C."

/**
 * `tutti requires` in the checkout `top` (the one it is started in, a worktree's own), as `flags` say: its exit code, having said what it
 * found through `say`. Ctrl+C (and SIGTERM, SIGHUP) stops the check, 130.
 */
export const requires = (top: string, flags: RequiresFlags, say: Say) =>
  Effect.gen(function* () {
    const fail = (why: string) =>
      Effect.sync(() => {
        say.error(`tutti requires: ${why}`)
        return exitCodes.setup as number
      })
    if ([flags.noInstall, flags.markdown, flags.readme].filter(Boolean).length > 1) {
      return yield* fail("give one of --no-install, --markdown and --readme")
    }
    const settings = yield* Effect.result(readSettings(top))
    if (settings._tag === "Failure") {
      for (const problem of settings.failure.problems) {
        say.error(
          `tutti requires: ${settingsFile}: ${problem.path === "" ? "" : `${problem.path}: `}${problem.message}`,
        )
      }
      return exitCodes.setup as number
    }
    const list = settings.success.requires
    if (flags.markdown) {
      say.out(requiresMarkdown(list).replace(/\n$/u, ""))
      return exitCodes.ok as number
    }
    if (flags.readme) {
      const written = yield* Effect.result(writeReadmeRequires(top, list))
      if (written._tag === "Failure") return yield* fail(written.failure)
      say.out(
        written.success
          ? `Wrote the requires list into ${readmeName}, between ${requiresStart} and ${requiresEnd}: commit it with the list.`
          : `${readmeName}'s section is the requires list's already.`,
      )
      return exitCodes.ok as number
    }
    if (list.length === 0) {
      say.out(`No requirements: ${settingsFile} has no 'requires' list.`)
      return exitCodes.ok as number
    }
    const stop = yield* Deferred.make<void>()
    yield* listen(() => Deferred.doneUnsafe(stop, Effect.void))
    const report = yield* Effect.raceFirst(
      checkRequires(list, {
        repo: top,
        installLimit: settings.success.checks.fast.timeout,
        noInstall: flags.noInstall,
      }),
      Effect.as(Deferred.await(stop), null),
    )
    if (report === null) {
      say.error("tutti requires: stopped.")
      return exitCodes.interrupted as number
    }
    for (const res of report) say.out(`${res.requirement.name}: ${says(res)}`)
    const missing = missingDetail(report)
    if (missing === "") return exitCodes.ok as number
    say.error(`${missingWord}: ${missing}`)
    return exitCodes.setup as number
  }).pipe(Effect.scoped)
