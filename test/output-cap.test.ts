import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, Option } from "effect"
import { exec } from "../src/services/exec.ts"
import { Git, GitFailed, GitWriter } from "../src/services/Git.ts"

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const tempDir = () => mkdtempSync(join(tmpdir(), "tutti-output-cap-"))

const printed = (bytes: number) =>
  Effect.runPromise(
    exec({
      command: "sh",
      args: ["-c", `head -c ${bytes} /dev/zero | tr '\\0' a; head -c ${bytes} /dev/zero >&2`],
      timeLimit: "10 seconds",
      maxOutputBytes: 8,
    }).pipe(Effect.provide(BunServices.layer)),
  )

describe("exec's output cap", () => {
  test("an output up to the cap is whole, and says so", async () => {
    const output = await printed(8)
    expect(output.stdout).toBe("aaaaaaaa")
    expect(output.truncated).toEqual({ stdout: false, stderr: false })
  })

  test("an output past the cap keeps its last bytes, and says it was cut", async () => {
    const output = await printed(9)
    expect(output.stdout).toBe("aaaaaaaa")
    expect(output.truncated).toEqual({ stdout: true, stderr: true })
  })
})

/** A git that prints `stdout` (printf's format) and exits with `code`, whatever it is asked. */
const fakeGit = (stdout: string, code = 0): string => {
  const path = join(tempDir(), "git")
  writeFileSync(path, `#!/bin/sh\nprintf '${stdout}'\nexit ${code}\n`)
  chmodSync(path, 0o755)
  return path
}

const withGit = <A, E>(
  command: string,
  use: (git: Git["Service"]) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.exit(
      Effect.flatMap(Effect.service(Git), use).pipe(
        Effect.provide(
          Git.layer({ command, maxOutputBytes: 12 }).pipe(
            Layer.provideMerge(GitWriter.layer),
            Layer.provideMerge(BunServices.layer),
          ),
        ),
      ),
    ),
  )

describe("Git's reads past exec's output cap", () => {
  test("a read within the cap returns every entry", async () => {
    const exit = await withGit(fakeGit("one\\0two\\0six\\0"), (git) => git.trackedFiles(tempDir()))
    expect(exit).toEqual(Exit.succeed(["one", "two", "six"]))
  })

  test("a read past the cap fails with GitFailed, rather than lose its first entries", async () => {
    const dir = tempDir()
    const git = fakeGit("one\\0two\\0three\\0four\\0")
    const reads: ReadonlyArray<(g: Git["Service"]) => Effect.Effect<unknown, unknown>> = [
      (g: Git["Service"]) => g.trackedFiles(dir),
      (g: Git["Service"]) => g.status(dir),
      (g: Git["Service"]) => g.log(dir, "main"),
      (g: Git["Service"]) => g.changedFiles(dir, "main"),
      (g: Git["Service"]) => g.currentBranch(dir),
      (g: Git["Service"]) => g.holds(dir, "main", "branch"),
    ]
    for (const read of reads) {
      const error = failure(await withGit(git, read))
      expect(error).toBeInstanceOf(GitFailed)
      expect(error).toMatchObject({ exitCode: 0 })
      expect((error as GitFailed).stderr).toContain("ran past 12 bytes")
    }
  })

  test("a failed read past the cap still fails with git's exit code", async () => {
    const exit = await withGit(fakeGit("one\\0two\\0three\\0four\\0", 2), (git) =>
      git.trackedFiles(tempDir()),
    )
    expect(failure(exit)).toMatchObject({ _tag: "GitFailed", op: "ls-files", exitCode: 2 })
  })

  test("a write whose output runs past the cap still succeeds, as its output isn't read", async () => {
    const exit = await withGit(fakeGit("one\\0two\\0three\\0four\\0"), (git) =>
      git.createBranch(tempDir(), "branch", "main"),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a read of a branch within the cap is the branch", async () => {
    const exit = await withGit(fakeGit("main\\n"), (git) => git.currentBranch(tempDir()))
    expect(exit).toEqual(Exit.succeed(Option.some("main")))
  })
})
