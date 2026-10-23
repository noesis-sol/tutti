// Git.branchExists, the one way the run asks whether a branch is there: show-ref's exit 1 is a
// missing branch whatever git said on stderr, any other failure is git's.

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { Git, GitFailed, GitWriter } from "../src/services/Git.ts"
import * as TestGit from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const liveGit = (command?: string) =>
  Git.layer(command === undefined ? {} : { command }).pipe(
    Layer.provide(GitWriter.layer),
    Layer.provide(BunServices.layer),
  )

const exists = (layer: Layer.Layer<Git>, repo: string, branch: string) =>
  Effect.runPromiseExit(
    Effect.flatMap(Effect.service(Git), (git) => git.branchExists(repo, branch)).pipe(
      Effect.provide(layer),
    ),
  )

/** A git that exits with `code`, saying `stderr`, whatever it is asked. */
const fakeGit = (code: number, stderr: string): string => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-branch-exists-"))), "bin")
  mkdirSync(dir)
  const path = join(dir, "git")
  writeFileSync(path, `#!/bin/sh\necho '${stderr}' >&2\nexit ${code}\n`)
  chmodSync(path, 0o755)
  return path
}

describe("branchExists over a git that fails", () => {
  test("exit 1 is a missing branch, whatever git says on stderr", async () => {
    const exit = await exists(liveGit(fakeGit(1, "warning: something")), tmpdir(), "tutti/t-1")
    expect(exit).toEqual(Exit.succeed(false))
  })

  test("any other exit is git's failure", async () => {
    const exit = await exists(liveGit(fakeGit(128, "fatal: oops")), tmpdir(), "tutti/t-1")
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      expect(error?._tag === "Fail" ? error.error : undefined).toBeInstanceOf(GitFailed)
    }
  })
})

slow.describe("branchExists against a real repository", () => {
  test("a branch is there, a missing one or a tag of the name isn't", async () => {
    const repo = makeRepo()
    repo.branch("tutti/t-1")
    repo.git(["tag", "tutti/t-2"])
    expect(await exists(liveGit(), repo.dir, "tutti/t-1")).toEqual(Exit.succeed(true))
    expect(await exists(liveGit(), repo.dir, "tutti/t-2")).toEqual(Exit.succeed(false))
    expect(await exists(liveGit(), repo.dir, "tutti/t-3")).toEqual(Exit.succeed(false))
  })
})

describe("branchExists in the test layer", () => {
  test("says the same of a branch and a missing one", async () => {
    const layer = TestGit.layer()
    const both = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repo = (yield* TestGit.Repository).dir
        return [yield* git.branchExists(repo, "main"), yield* git.branchExists(repo, "tutti/t-1")]
      }).pipe(Effect.provide(layer)),
    )
    expect(both).toEqual([true, false])
  })
})
