// A check's recent passes carried over from run to run in state.json (tutti-nh1g): the run's
// Checking starts from those the last runs kept, so that its first check of a kind, the end-of-run
// full check above all, has an estimate for its bar, and each pass is written back for the next.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { checkOnce } from "../src/run/check.ts"
import { Checking, makeChecking, recentPasses, withPass } from "../src/run/checking.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { noCheckAt } from "../src/services/Checks.ts"
import {
  emptyState,
  parseState,
  type State,
  Store,
  stateFile,
  stateText,
} from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { type CheckRun, passed } from "../src/testing/Checks.ts"
import { layer as storeLayer } from "../src/testing/Store.ts"
import { advance, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-check-passes-carried-${name}-`)))

/** The median the bar of a check of `kind` is estimated from, `checking` watching one. */
const usualOf = (checking: Checking["Service"], kind: "fast" | "full") =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* checking.watch("t-1", { name: "merge check", kind, began: 0, at: noCheckAt })
      return (yield* checking.now).get("t-1")?.usual ?? null
    }),
  )

describe("the passes kept across runs", () => {
  test("a pass is added after its kind's others, the last recentPasses kept", () => {
    let passes = withPass({ full: [600] }, "fast", 10)
    for (const seconds of [20, 30, 40, 50, 60]) passes = withPass(passes, "fast", seconds)
    expect(recentPasses).toBe(5)
    expect(passes).toEqual({ full: [600], fast: [20, 30, 40, 50, 60] })
  })

  test("a time of no time, or none a bar can go by, is left out", () => {
    expect(withPass({ fast: [0, -3, 12, Number.NaN] }, "fast", 30)).toEqual({ fast: [12, 30] })
    expect(withPass({}, "full", 0)).toEqual({ full: [] })
  })

  test("the run's first check of a kind is estimated from the passes carried over", async () => {
    const state: State = { ...emptyState, passes: { full: [100, 300, 200], fast: [9_000] } }
    const usual = await Effect.runPromise(
      Effect.flatMap(Checking, (checking) => usualOf(checking, "full")).pipe(
        Effect.provide(Checking.layer.pipe(Layer.provide(storeLayer(state)))),
      ),
    )
    expect(usual).toBe(200)
  })

  test("with none carried over, there is no estimate until a pass", async () => {
    const usual = await Effect.runPromise(
      Effect.flatMap(Checking, (checking) => usualOf(checking, "full")).pipe(
        Effect.provide(Checking.layer.pipe(Layer.provide(storeLayer()))),
      ),
    )
    expect(usual).toBeNull()
  })

  test("passes carried over beyond the last recentPasses don't count", async () => {
    const checking = makeChecking({ fast: [1, 1, 1, 100, 100, 100, 100, 100] })
    expect(await Effect.runPromise(usualOf(checking, "fast"))).toBe(100)
  })

  test("each pass is written to state.json, both of two at once", async () => {
    const written = await Effect.runPromise(
      Effect.gen(function* () {
        const checking = yield* Checking
        yield* Effect.all([checking.passed("fast", 40), checking.passed("fast", 60)], {
          concurrency: "unbounded",
        })
        yield* checking.passed("full", 700)
        return (yield* (yield* Store).state).passes
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Checking.layer,
            storeLayer({ ...emptyState, passes: { fast: [20], setup: [5] } }),
          ),
        ),
      ),
    )
    expect(written?.setup).toEqual([5])
    expect(written?.full).toEqual([700])
    expect([...(written?.fast ?? [])].sort((a, b) => a - b)).toEqual([20, 40, 60])
  })

  test("a merge check that passes leaves its time in the Store for the next run", async () => {
    const repo = folder("repo")
    const seen: Array<number | null> = []
    // The run's Checking, as the check that runs reads it.
    let checking: Checking["Service"] | undefined
    const checked = (_: CheckRun) =>
      Effect.gen(function* () {
        if (checking !== undefined) seen.push(yield* usualOf(checking, "fast"))
        yield* advance("42 seconds")
        return passed("fast")
      })
    const ran = await scenario(
      {
        config: { repo },
        state: { ...emptyState, passes: { fast: [30] } },
        checks: { fast: [checked] },
      },
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const id = "t-1" as TicketId
        const worktree = (yield* worktrees.prepare(id)).path
        checking = yield* Checking
        yield* checkOnce({ id, worktree })
        return (yield* (yield* Store).state).passes?.fast
      }).pipe(Effect.provide(Checking.layer)),
    )
    expect(ran.exit._tag).toBe("Success")
    // Its first check of the run was estimated from the last run's pass.
    expect(seen).toEqual([30])
    const fast = ran.exit._tag === "Success" ? ran.exit.value : undefined
    expect(fast).toEqual([30, 42])
  })
})

describe("state.json's passes", () => {
  test("read back as they were written, the version still 1", async () => {
    const state: State = { ...emptyState, passes: { fast: [12.5, 30], full: [400] } }
    const text = stateText(state)
    expect(JSON.parse(text)).toMatchObject({ version: 1, passes: { fast: [12.5, 30] } })
    expect(await Effect.runPromise(parseState(stateFile, text))).toEqual(state)
  })

  test("a state.json without them is read as before", async () => {
    const text = JSON.stringify({ version: 1, tickets: {} })
    const read = await Effect.runPromise(parseState(stateFile, text))
    expect(read.passes).toBeUndefined()
  })
})
