// dropNothingDone's CLEANUP_FAILED line and its `warn` record are written together (Log's
// writeWith), the line first, so the log and events.jsonl give them in one order.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { dropNothingDone } from "../src/run/aside.ts"
import { EventStream } from "../src/run/eventstream.ts"
import { Log } from "../src/run/log.ts"
import { GitFailed } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { layer as capturedLog, texts } from "../src/testing/Log.ts"

const refusing = Layer.succeed(
  Worktrees,
  Worktrees.of({
    remove: () =>
      Effect.fail(
        new GitFailed({
          op: "worktree remove",
          command: "git worktree remove",
          exitCode: 128,
          stderr: "fatal: cannot remove a locked working tree\n",
        }),
      ),
  } as unknown as Worktrees["Service"]),
)

describe("dropNothingDone's CLEANUP_FAILED", () => {
  test("its line is in the log as its record is emitted", async () => {
    const seen: Array<ReadonlyArray<string>> = []
    const noting = Layer.effect(
      EventStream,
      Effect.gen(function* () {
        const log = yield* Log
        return EventStream.of({
          emit: () =>
            Effect.flatMap(texts.pipe(Effect.provideService(Log, log)), (now) =>
              Effect.sync(() => {
                seen.push(now)
              }),
            ),
        })
      }),
    )
    await Effect.runPromise(
      dropNothingDone({ id: "t-1", path: "/w/t-1", branch: "tutti/t-1" }).pipe(
        Effect.provide(Layer.mergeAll(refusing, noting.pipe(Layer.provideMerge(capturedLog())))),
      ),
    )
    expect(seen).toEqual([
      ["  CLEANUP_FAILED for /w/t-1 / tutti/t-1: fatal: cannot remove a locked working tree"],
    ])
  })
})
