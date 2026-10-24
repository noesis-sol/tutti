// The Store's commit (§ 3.3), shared by its live layer and its test layer: the changes applied in
// turn, the run stamped, and the state round-tripped through state.json's text, so a state that
// can't be written fails in tests as it does live.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, type FileSystem, type Layer, Result, type Schema } from "effect"
import fc from "fast-check"
import { phaseNames } from "../src/run/events.ts"
import {
  commit,
  emptyState,
  type RunStamp,
  type State,
  Store,
  type StoreUnreadable,
  StoreWriteFailed,
  stateText,
  stateVersion,
} from "../src/services/Store.ts"
import { layer as memoryLayer, testRun } from "../src/testing/Store.ts"

const run: RunStamp = { pid: 4242, started: "2026-10-17T08:31:00Z", version: "0.1.0" }

const newRepo = () => mkdtempSync(join(tmpdir(), "tutti-store-commit-"))

const session = { session: "s-1", worktree: "/work/demo-1", branch: "wt/demo-1" }

/** A change that leaves a value JSON can't hold in the ticket's metadata. */
const unencodable = (state: State): State => ({
  ...state,
  tickets: { "demo-1": { resumes: 0, metadata: { at: Number.NaN } } },
})

const throwing = (): State => {
  throw new Error("boom")
}

describe("commit", () => {
  test("applies the changes in turn, stamps the run and gives the text state.json holds", () => {
    const batch = commit(
      emptyState,
      [
        (state) => ({ ...state, tickets: { "demo-1": { ...session, resumes: 0, metadata: {} } } }),
        (state) => ({
          ...state,
          tickets: { "demo-1": { ...session, resumes: 2, metadata: { attempts: 1 } } },
        }),
      ],
      run,
    )
    expect(batch.changes.map(Exit.isSuccess)).toEqual([true, true])
    if (batch.result === undefined || Result.isFailure(batch.result)) throw new Error("no commit")
    const expected: State = {
      version: stateVersion,
      run,
      tickets: { "demo-1": { ...session, resumes: 2, metadata: { attempts: 1 } } },
    }
    expect(batch.result.success.state).toEqual(expected)
    expect(batch.result.success.text).toBe(stateText(expected))
  })

  test("a change that throws dies alone, and the batch goes on without it", () => {
    const batch = commit(
      emptyState,
      [throwing, (state) => ({ ...state, tickets: { "demo-2": { resumes: 1, metadata: {} } } })],
      run,
    )
    expect(Exit.isFailure(batch.changes[0] ?? Exit.void)).toBe(true)
    expect(Exit.isSuccess(batch.changes[1] ?? Exit.die("missing"))).toBe(true)
    if (batch.result === undefined || Result.isFailure(batch.result)) throw new Error("no commit")
    expect(Object.keys(batch.result.success.state.tickets)).toEqual(["demo-2"])
  })

  test("commits nothing when no change applied", () => {
    expect(commit(emptyState, [throwing], run).result).toBeUndefined()
    expect(commit(emptyState, [], run).result).toBeUndefined()
  })

  test("says why a state can't be encoded, or doesn't read back as it was", () => {
    const encoded = commit(emptyState, [unencodable], run).result
    expect(encoded !== undefined && Result.isFailure(encoded) && encoded.failure).toContain(
      "it doesn't encode: Expected JSON value",
    )
    const readBack = commit(
      emptyState,
      [(state) => ({ ...state, tickets: { "demo-1": { resumes: Number.NaN, metadata: {} } } })],
      run,
    ).result
    expect(readBack !== undefined && Result.isFailure(readBack) && readBack.failure).toContain(
      "it doesn't read back: Expected number",
    )
  })
})

/** The Store layers under test: the live one in a new folder, and the test one. */
const layers: ReadonlyArray<
  readonly [string, () => Layer.Layer<Store, StoreUnreadable, FileSystem.FileSystem>]
> = [
  ["live", () => Store.layer({ repo: newRepo(), run })],
  ["test", () => memoryLayer(emptyState, run)],
]

describe.each(layers)("the %s layer", (_, layer) => {
  const runStore = <A, E>(effect: Effect.Effect<A, E, Store>) =>
    Effect.runPromiseExit(effect.pipe(Effect.provide(layer()), Effect.provide(BunFileSystem.layer)))

  test("stamps the run on what it commits", async () => {
    const exit = await runStore(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveSession("demo-1", session)
        return yield* store.state
      }),
    )
    expect(Exit.isSuccess(exit) && exit.value.run).toEqual(run)
  })

  test("fails a state it can't write, keeps the last one, and goes on committing", async () => {
    const exit = await runStore(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveSession("demo-1", session)
        const failed = yield* Effect.flip(store.update(unencodable))
        const kept = yield* store.ticket("demo-1")
        yield* store.resumed("demo-1")
        return { failed, kept, after: yield* store.ticket("demo-1") }
      }),
    )
    if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
    expect(exit.value.failed).toBeInstanceOf(StoreWriteFailed)
    expect(exit.value.failed.reason).toContain("it doesn't encode")
    expect(exit.value.kept).toEqual({ ...session, resumes: 0, metadata: {} })
    expect(exit.value.after?.resumes).toBe(1)
  })

  test("a change that throws dies, and the state stays as it was", async () => {
    const exit = await runStore(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveSession("demo-1", session)
        const died = yield* Effect.exit(store.update(throwing))
        return { died, state: yield* store.state }
      }),
    )
    if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
    expect(Exit.isFailure(exit.value.died)).toBe(true)
    expect(Object.keys(exit.value.state.tickets)).toEqual(["demo-1"])
  })
})

/** One of the Store's operations, on one of a few tickets. */
const operation = fc.oneof(
  fc.record({ op: fc.constant("saveSession" as const), id: fc.constantFrom("a", "b") }),
  fc.record({
    op: fc.constant("suspend" as const),
    id: fc.constantFrom("a", "b"),
    why: fc.string(),
    phase: fc.constantFrom(...phaseNames),
  }),
  fc.record({ op: fc.constant("resumed" as const), id: fc.constantFrom("a", "b") }),
  fc.record({ op: fc.constant("remove" as const), id: fc.constantFrom("a", "b") }),
  fc.record({
    op: fc.constant("setMetadata" as const),
    id: fc.constantFrom("a", "b"),
    key: fc.string(),
    value: fc.jsonValue().map((value) => value as Schema.Json),
  }),
  fc.record({
    op: fc.constant("unsetMetadata" as const),
    id: fc.constantFrom("a", "b"),
    key: fc.string(),
  }),
)

type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never

const perform = (store: Store["Service"], step: Operation) => {
  switch (step.op) {
    case "saveSession":
      return store.saveSession(step.id, session)
    case "suspend":
      return store.suspend(step.id, step.why, step.phase)
    case "resumed":
      return store.resumed(step.id)
    case "remove":
      return store.remove(step.id)
    case "setMetadata":
      return store.setMetadata(step.id, step.key, step.value)
    case "unsetMetadata":
      return store.unsetMetadata(step.id, step.key)
  }
}

describe("the test layer", () => {
  test("stamps a run of its own unless given one", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveSession("demo-1", session)
        return yield* store.state
      }).pipe(Effect.provide(memoryLayer())),
    )
    expect(state.run).toEqual(testRun)
  })

  test("commits what the live layer commits, for any run of operations", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { maxLength: 12 }), async (steps) => {
        const states = await Promise.all(
          layers.map(([, layer]) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const store = yield* Store
                for (const step of steps) yield* perform(store, step)
                return yield* store.state
              }).pipe(Effect.provide(layer()), Effect.provide(BunFileSystem.layer)),
            ),
          ),
        )
        expect(states[1]).toEqual(states[0] as State)
        if (steps.length > 0) expect(states[0]?.run).toEqual(run)
      }),
      { numRuns: 40 },
    )
  })
})
