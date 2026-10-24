// rebaseInProgress (src/services/Git.ts) asks git where both of a rebase's state folders are in one
// rev-parse, and finds either: rebase-merge, a merge-backend rebase's, or rebase-apply, an apply
// backend's or git am's. The test layer counts it as the one call it is.
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"

/**
 * A git that logs its arguments a line a call and prints, for each `--git-path <name>`, that name
 * under a folder of its own, as rev-parse does.
 */
const fakeGit = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-rebase-in-progress-")))
  const gitDir = join(dir, "git-dir")
  mkdirSync(gitDir)
  const log = join(dir, "calls.log")
  const command = join(dir, "git")
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      "next=",
      'for arg in "$@"; do',
      `  if [ "$next" = 1 ]; then echo '${gitDir}'/"$arg"; next=; fi`,
      '  if [ "$arg" = --git-path ]; then next=1; fi',
      "done",
      "",
    ].join("\n"),
  )
  chmodSync(command, 0o755)
  const inProgress = () =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(Git), (git) => git.rebaseInProgress(dir)).pipe(
        Effect.provide(
          Git.layer({ command }).pipe(
            Layer.provide(GitWriter.layer),
            Layer.provide(BunServices.layer),
          ),
        ),
      ),
    )
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
  return { gitDir, inProgress, calls }
}

describe("rebaseInProgress", () => {
  test("runs one rev-parse for both folders, and finds a rebase in either", async () => {
    const git = fakeGit()
    expect(await git.inProgress()).toBe(false)
    mkdirSync(join(git.gitDir, "rebase-apply"))
    expect(await git.inProgress()).toBe(true)
    expect(git.calls()).toEqual([
      "rev-parse --path-format=absolute --git-path rebase-merge --git-path rebase-apply",
      "rev-parse --path-format=absolute --git-path rebase-merge --git-path rebase-apply",
    ])
  })

  test("finds a merge-backend rebase's folder too", async () => {
    const git = fakeGit()
    mkdirSync(join(git.gitDir, "rebase-merge"))
    expect(await git.inProgress()).toBe(true)
    expect(git.calls()).toHaveLength(1)
  })

  test("is one call in the test layer, as live", async () => {
    const calls = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* (yield* Git).rebaseInProgress(repository.dir)
        return yield* repository.calls
      }).pipe(Effect.provide(memoryLayer())),
    )
    expect(calls).toEqual([{ op: "rev-parse --git-path", dir: "/repo" }])
  })
})
