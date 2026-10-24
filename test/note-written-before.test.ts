// A setup or check run with the worktree's status its caller read just before (checkWrote.ts's
// noteWritten `before`): git reads it only after the run, and the untracked files missing from the
// status given are those the run wrote; the status after it goes to the caller, for the next run.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { checkWroteName, noteWritten } from "../src/run/checkWrote.ts"
import { Git, type StatusEntry } from "../src/services/Git.ts"
import { runFolder } from "../src/services/Worktrees.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-note-written-${name}-`)))

describe("noteWritten with the status read before", () => {
  test("reads the status once, after the run, and notes what the run added to it", async () => {
    const repo = folder("repo")
    const path = join(folder("worktrees"), "a")
    mkdirSync(path)
    const { statuses, after } = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repository = yield* Repository
          const git = yield* Git
          yield* Effect.orDie(git.addWorktree(repo, path, { branch: "tutti/a", base: "main" }))
          yield* repository.write(path, { "mine.txt": "x\n" })
          const before = yield* Effect.orDie(git.status(path))
          const from = (yield* repository.calls).length
          let after: ReadonlyArray<StatusEntry> | undefined
          yield* noteWritten(path, repository.write(path, { "out/1.txt": "1\n" }), {
            before,
            read: (status) => {
              after = status
            },
          })
          const calls = (yield* repository.calls).slice(from)
          return { statuses: calls.filter((call) => call.op === "status").length, after }
        }),
        gitLayer({ dir: repo }),
      ),
    )
    expect(statuses).toBe(1)
    expect(after?.map((entry) => entry.path).sort()).toEqual(["mine.txt", "out/1.txt"])
    // mine.txt was in the status given: only out/1.txt is the run's.
    expect(readFileSync(join(path, runFolder, checkWroteName), "utf8")).toBe("out/1.txt\0")
  })
})
