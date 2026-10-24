// bd's error in the lines that say bd failed: BeadsFailed and BeadsTimedOut have no message of
// their own, so a line gives beadsWhy's reason, bd's first line of stderr or its time limit, never
// an empty one or the error's tag.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Organs } from "../src/organs/Organs.ts"
import { formatDuration } from "../src/project/configFile.ts"
import { putAside } from "../src/run/aside.ts"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line, ticketLine } from "../src/run/log.ts"
import { Cause } from "../src/run/phase.ts"
import { make as makePredictor } from "../src/run/predict.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Beads } from "../src/services/Beads.ts"
import { TimeLimit } from "../src/services/exec.ts"
import { Git } from "../src/services/Git.ts"
import { result, run as step, turn } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer, type Fault } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"
import { layer as storeLayer } from "../src/testing/Store.ts"
import { expectLog, scenario } from "./harness.ts"

const locked = { id: "t-1", stderr: "Error: database is locked\nmore of bd's output\n" }
const slow = `bd took longer than ${formatDuration(TimeLimit.write)}`

/** Sets t-1, Working, aside with bd failing `op` as `fault` says; the log and warn records. */
const setAside = (op: string, fault: Fault) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger
      yield* ledger.transition("t-1", Cause.Ready(), { title: "One ticket" })
      yield* ledger.transition("t-1", Cause.Dispatched())
      yield* (yield* Backlog).fail(op, fault)
      const deferred = yield* putAside(
        { id: "t-1", title: "One ticket" },
        {
          note: "tutti: set aside.",
          reason: "set aside",
          detail: "set aside",
          deferred: ticketLine("t-1")`set aside`,
          failed: "t-1 set aside, and bd could not defer it",
          instead: "look at it",
        },
      )
      const warned = (yield* (yield* Captured).records).filter((record) => record.kind === "warn")
      return { deferred, log: yield* texts, warned }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ledgerLayer(),
          beadsLayer([{ id: "t-1" }]),
          storeLayer({
            version: 1,
            tickets: { "t-1": { session: "session-t-1", resumes: 0, metadata: {} } },
          }),
        ),
      ),
    ),
  )

describe("DEFER_FAILED", () => {
  test("gives bd's first line of stderr when bd update fails", async () => {
    const text =
      "  DEFER_FAILED: t-1 set aside, and bd could not defer it: Error: database is locked; kept out of this run, look at it"
    const left = await setAside("update", locked)
    expect(left.deferred).toBe(false)
    expect(left.log).toContain(text)
    expect(left.warned).toEqual([expect.objectContaining({ ticket: "t-1", aside: true, text })])
  })

  test("gives bd's time limit when bd defer times out", async () => {
    const left = await setAside("defer", { id: "t-1", timedOut: true })
    expect(left.deferred).toBe(false)
    expect(left.log).toContain(
      `  DEFER_FAILED: t-1 set aside, and bd could not defer it: ${slow}; kept out of this run, look at it`,
    )
  })

  test("in a run, a worker leaving its ticket open that bd can't defer", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-bdwhy-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-bdwhy-worktrees-")))
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: [{ id: "t-1" }],
        git: { dir: repo },
        worktrees: { root },
        // The worker ends its turn with nothing done, and bd fails tutti's next write to t-1.
        scripts: (world) => ({
          "t-1": [turn([step(world.backlog.fail("defer", locked))], result("Nothing to do here."))],
        }),
      },
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
          branch: "tutti/t-1",
          base: "main",
        })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        return yield* Fiber.join(fiber) as Effect.Effect<Outcome>
      }),
    )
    expectLog(ran, [
      "  DEFER_FAILED: t-1 still open, and bd could not defer it: Error: database is locked; kept out of this run, nothing done, so its worktree and branch are removed",
    ])
    expect(ran.issues.find((issue) => issue.id === "t-1")?.status).toBe("open")
  })
})

describe("a predicted footprint bd can't keep", () => {
  const tracked = ["README.md", "src/a.ts"]

  /** Predicts t-1's files with bd failing the write of its metadata as `fault` says. */
  const predicting = (fault: Fault) => {
    const organs = Organs.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          cannedLayer({ predictor: { files: ["src/a.ts"] } }),
          configLayer(appConfig()),
        ),
      ),
    )
    const files = Object.fromEntries(tracked.map((f) => [f, `// ${f}\n`]))
    const layers = Layer.mergeAll(organs, memoryGit({ files })).pipe(
      Layer.provideMerge(
        Layer.mergeAll(beadsLayer([{ id: "t-1" }]), ledgerLayer(), runFibersLayer),
      ),
      Layer.provideMerge(TestClock.layer()),
    )
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* Backlog).fail("update", fault)
        const predictor = yield* makePredictor({ repo: "/repo" })
        const issue = yield* (yield* Beads).show("t-1")
        yield* predictor.queue([issue], repoFiles(tracked), () => Effect.succeed([]))
        for (let i = 0; i < 200; i++) yield* Effect.yieldNow
        return yield* texts
      }).pipe(Effect.scoped, Effect.provide(layers)),
    )
  }

  test("says why with bd's first line of stderr, and is still used", async () => {
    const lines = await predicting(locked)
    expect(lines).toContain(
      "  t-1 footprint predicted, but bd could not keep it: Error: database is locked",
    )
    expect(lines).toContain("  t-1 footprint predicted: src/a.ts")
  })

  test("says why with bd's time limit when bd times out", async () => {
    const lines = await predicting({ id: "t-1", timedOut: true })
    expect(lines).toContain(`  t-1 footprint predicted, but bd could not keep it: ${slow}`)
  })
})
