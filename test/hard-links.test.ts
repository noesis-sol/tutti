// The symlink guard's truncating opens never truncate a file hard-linked to a run file's name: a
// worker can link another file of the same user on the same filesystem, the main checkout's
// .git/config say, to .tutti/run/check.log in its worktree, and a hard link is a regular file.

import { describe, expect, test } from "bun:test"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer } from "effect"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { close, O, openUnder } from "../src/native/libc.ts"
import { outputTo } from "../src/run/check.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Checks, checkLogName } from "../src/services/Checks.ts"
import { runFolder, writeRunFile } from "../src/services/Worktrees.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestLog from "../src/testing/Log.ts"
import * as TestWorktrees from "../src/testing/Worktrees.ts"

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-hard-links-")))

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

const secret = "[core]\n\trepositoryformatversion = 0\n"

/**
 * A worktree whose .tutti/run/`name` is a hard link to `config` outside it, and that file, which
 * holds `secret`.
 */
const linkedWorktree = (name: string) => {
  const base = tempDir()
  const config = join(base, "main", ".git", "config")
  mkdirSync(join(base, "main", ".git"), { recursive: true })
  writeFileSync(config, secret)
  const tree = join(base, "tree")
  mkdirSync(join(tree, runFolder), { recursive: true })
  linkSync(config, join(tree, runFolder, name))
  return { tree, config, file: join(tree, runFolder, name) }
}

/** Opens `relativePath` below `tree` with `flags`, writes `text` and closes it. */
const writeThrough = (tree: string, relativePath: string, flags: number, text: string) => {
  const fd = Effect.runSync(openUnder(tree, relativePath, flags))
  writeSync(fd, text)
  Effect.runSync(close(fd))
}

describe("openUnder with O_TRUNC", () => {
  test("leaves a hard-linked file as it was and writes a file of its own", () => {
    const { tree, config, file } = linkedWorktree(checkLogName)
    writeThrough(tree, `${runFolder}/${checkLogName}`, O.WRONLY | O.CREAT | O.TRUNC, "checked\n")
    expect(readFileSync(config, "utf8")).toBe(secret)
    expect(statSync(config).nlink).toBe(1)
    expect(readFileSync(file, "utf8")).toBe("checked\n")
    expect(statSync(file).nlink).toBe(1)
    expect(statSync(file).ino).not.toBe(statSync(config).ino)
  })

  test("creates the file afresh with the mode it is given", () => {
    const { tree, file } = linkedWorktree("state")
    const fd = Effect.runSync(openUnder(tree, `${runFolder}/state`, O.WRONLY | O.TRUNC, 0o600))
    Effect.runSync(close(fd))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(file).size).toBe(0)
  })

  test("truncates a file with one link where it is", () => {
    const tree = tempDir()
    mkdirSync(join(tree, runFolder), { recursive: true })
    const file = join(tree, runFolder, checkLogName)
    writeFileSync(file, "an earlier check's output, longer than the next\n")
    const inode = statSync(file).ino
    writeThrough(tree, `${runFolder}/${checkLogName}`, O.WRONLY | O.CREAT | O.TRUNC, "next\n")
    expect(readFileSync(file, "utf8")).toBe("next\n")
    expect(statSync(file).ino).toBe(inode)
  })

  test("still refuses a symbolic link at the name, leaving its target as it was", () => {
    const { tree, config } = linkedWorktree("other")
    symlinkSync(config, join(tree, runFolder, checkLogName))
    const exit = Effect.runSyncExit(
      openUnder(tree, `${runFolder}/${checkLogName}`, O.WRONLY | O.CREAT | O.TRUNC),
    )
    expect(failure(exit)).toMatchObject({ _tag: "SymlinkRefused" })
    expect(readFileSync(config, "utf8")).toBe(secret)
  })

  test("leaves O_APPEND's and plain writes' semantics alone on a file with one link", () => {
    const tree = tempDir()
    mkdirSync(join(tree, runFolder), { recursive: true })
    const file = join(tree, runFolder, "events")
    writeFileSync(file, "one\n")
    writeThrough(tree, `${runFolder}/events`, O.WRONLY | O.APPEND, "two\n")
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n")
  })
})

describe("a hard link at a run file's name", () => {
  test("writeRunFile replaces the run file, not the linked one", () => {
    const { tree, config, file } = linkedWorktree("state")
    Effect.runSync(writeRunFile(tree, "state", "mine"))
    expect(readFileSync(config, "utf8")).toBe(secret)
    expect(readFileSync(file, "utf8")).toBe("mine")
  })

  test("the merge check writes its output to a check.log of its own", async () => {
    const { tree, config, file } = linkedWorktree(checkLogName)
    const settings = {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        fast: { command: "echo checked", timeout: Duration.seconds(10) },
      },
    }
    const layer = Layer.mergeAll(
      Checks.layer.pipe(
        Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
        Layer.provide(BunServices.layer),
      ),
      TestWorktrees.layer(),
      TestLog.layer(),
    )
    const { ran, lines } = await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Effect.scoped(
          Effect.gen(function* () {
            const to = yield* outputTo(
              { id: "a" as TicketId, worktree: tree },
              checkLogName,
              "the check's",
            )
            return yield* Effect.exit((yield* Checks).fast({ cwd: tree, ...to }))
          }),
        )
        return { ran, lines: yield* TestLog.texts }
      }).pipe(Effect.provide(layer)),
    )
    expect(Exit.isSuccess(ran)).toBe(true)
    expect(lines).toEqual([])
    expect(readFileSync(config, "utf8")).toBe(secret)
    expect(readFileSync(file, "utf8")).toContain("checked")
  })
})
