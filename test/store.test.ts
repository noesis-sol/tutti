import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, type FileSystem, Layer, type Schema } from "effect"
import fc from "fast-check"
import {
  emptyState,
  parseState,
  phaseNames,
  type RunStamp,
  readState,
  type State,
  Store,
  StoreUnreadable,
  StoreWriteFailed,
  statePath,
  stateText,
  stateVersion,
} from "../src/services/Store.ts"
import { layer as memoryLayer } from "../src/testing/Store.ts"

const run: RunStamp = { pid: 4242, started: "2026-10-17T08:31:00Z", version: "0.1.0" }
const later: RunStamp = { pid: 4343, started: "2026-10-17T09:00:00Z", version: "0.1.0" }

const newRepo = () => mkdtempSync(join(tmpdir(), "tutti-store-"))

const onDisk = (repo: string): unknown => JSON.parse(readFileSync(statePath(repo), "utf8"))

/** Runs `effect` with the live Store of `repo`, writing as `stamp`. */
const withStore = <A, E>(
  repo: string,
  effect: Effect.Effect<A, E, Store | FileSystem.FileSystem>,
  options: { readonly stamp?: RunStamp } = {},
): Promise<Exit.Exit<A, E | StoreUnreadable>> =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        Store.layer({ repo, run: options.stamp ?? run }).pipe(
          Layer.provideMerge(BunFileSystem.layer),
        ),
      ),
    ),
  )

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected a success, got ${exit.cause}`)
}

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const session = {
  session: "0b8f3c1e-8d4b-4c5e-9a57-6c1d2e3f4a5b",
  worktree: "/work/project-tutti/demo-1",
  branch: "wt/demo-1",
}

describe("state.json", () => {
  test("round trip: what one run saves, the next reads, with the run that wrote it", async () => {
    const repo = newRepo()
    value(
      await withStore(
        repo,
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.saveSession("demo-1", session)
          yield* store.suspend("demo-1", "PAUSED", "Working")
          yield* store.setMetadata("demo-1", "attempts", 2)
          yield* store.saveSession("demo-2", { ...session, branch: "wt/demo-2" })
          yield* store.suspend("demo-2", "asked", "Asked")
          yield* store.saveSession("demo-3", { ...session, branch: "wt/demo-3" })
          yield* store.remove("demo-3")
        }),
      ),
    )
    expect(onDisk(repo)).toEqual({
      version: stateVersion,
      run,
      tickets: {
        "demo-1": {
          session_id: session.session,
          worktree: session.worktree,
          branch: session.branch,
          suspended: "PAUSED",
          phase: "Working",
          resume_count: 0,
          metadata: { attempts: 2 },
        },
        "demo-2": {
          session_id: session.session,
          worktree: session.worktree,
          branch: "wt/demo-2",
          suspended: "asked",
          phase: "Asked",
          resume_count: 0,
          metadata: {},
        },
      },
    })

    const next = value(
      await withStore(
        repo,
        Effect.gen(function* () {
          const store = yield* Store
          const found = yield* store.state
          yield* store.resumed("demo-1")
          return { found, resumed: yield* store.ticket("demo-1") }
        }),
        { stamp: later },
      ),
    )
    expect(next.found.run).toEqual(run)
    expect(next.found.tickets["demo-1"]).toEqual({
      ...session,
      suspended: "PAUSED",
      phase: "Working",
      resumes: 0,
      metadata: { attempts: 2 },
    })
    expect(next.resumed).toEqual({ ...session, resumes: 1, metadata: { attempts: 2 } })
    expect(onDisk(repo)).toMatchObject({ run: later })
  })

  test("no state.json yet reads as the empty state, and writes none", async () => {
    const repo = newRepo()
    expect(
      value(
        await withStore(
          repo,
          Effect.flatMap(Store, (store) => store.state),
        ),
      ),
    ).toEqual(emptyState)
    expect(existsSync(statePath(repo))).toBe(false)
  })

  test("any state reads back as it was written", () => {
    const json: fc.Arbitrary<Schema.Json> = fc.jsonValue() as fc.Arbitrary<Schema.Json>
    const ticket = fc.record(
      {
        session: fc.uuid(),
        worktree: fc.string(),
        branch: fc.string(),
        suspended: fc.string(),
        phase: fc.constantFrom(...phaseNames),
        resumes: fc.nat(),
        metadata: fc.dictionary(fc.string(), json),
      },
      { requiredKeys: ["resumes", "metadata"] },
    )
    const state: fc.Arbitrary<State> = fc.record(
      {
        version: fc.constant(stateVersion),
        run: fc.record({ pid: fc.nat(), started: fc.string(), version: fc.string() }),
        tickets: fc.dictionary(fc.string(), ticket),
      },
      { requiredKeys: ["version", "tickets"] },
    )
    fc.assert(
      fc.property(state, (written) => {
        // JSON has no -0: it reads back as 0.
        const read = Effect.runSync(parseState("state.json", stateText(written)))
        expect(read).toEqual(JSON.parse(JSON.stringify(written)) as State)
      }),
    )
  })
})

describe("the single writer", () => {
  test("concurrent updates are committed one at a time, and none is lost", async () => {
    const repo = newRepo()
    const tickets = Array.from({ length: 200 }, (_, index) => `demo-${index}`)
    const state = value(
      await withStore(
        repo,
        Effect.gen(function* () {
          const store = yield* Store
          yield* Effect.all(
            tickets.flatMap((id) => [
              store.saveSession(id, { ...session, branch: `wt/${id}` }),
              store.update((current) => {
                const count = current.tickets.counter?.metadata.count
                return {
                  ...current,
                  tickets: {
                    ...current.tickets,
                    counter: {
                      resumes: 0,
                      metadata: { count: (typeof count === "number" ? count : 0) + 1 },
                    },
                  },
                }
              }),
            ]),
            { concurrency: "unbounded" },
          )
          return yield* store.state
        }),
      ),
    )
    expect(state.tickets.counter?.metadata).toEqual({ count: tickets.length })
    const read = value(
      await Effect.runPromiseExit(readState(repo)),
    )
    expect(read).toEqual(state)
    for (const id of tickets) expect(read.tickets[id]?.branch).toBe(`wt/${id}`)
  })

  test("a session ID saved before its session starts is on disk at once, for after a crash", async () => {
    const repo = newRepo()
    const seen = value(
      await withStore(
        repo,
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.saveSession("demo-1", session)
          // The run hasn't ended: what a run started after a crash here would read.
          return yield* readState(repo)
        }),
      ),
    )
    expect(seen.tickets["demo-1"]?.session).toBe(session.session)
  })

  test("a change that throws fails alone, and the writer goes on", async () => {
    const repo = newRepo()
    const exit = await withStore(
      repo,
      Effect.gen(function* () {
        const store = yield* Store
        const thrown = yield* Effect.exit(
          store.update(() => {
            throw new Error("bug")
          }),
        )
        yield* store.saveSession("demo-1", session)
        return thrown
      }),
    )
    expect(Exit.isFailure(value(exit))).toBe(true)
    expect(onDisk(repo)).toMatchObject({ tickets: { "demo-1": { session_id: session.session } } })
  })
})

describe("atomic writes", () => {
  test("a temporary file a crash left beside state.json is passed over, the old state read", async () => {
    const repo = newRepo()
    value(
      await withStore(
        repo,
        Effect.flatMap(Store, (store) => store.saveSession("demo-1", session)),
      ),
    )
    // What a crash between the write and the rename leaves: the new state written in full beside
    // the old file, under the temporary name, and never renamed over it.
    const before = readFileSync(statePath(repo), "utf8")
    const left = join(dirname(statePath(repo)), `.state.json.tutti-1-${crypto.randomUUID()}.tmp`)
    writeFileSync(left, before.replace('"demo-1"', '"demo-2"'))

    const after = value(
      await withStore(
        repo,
        Effect.gen(function* () {
          const store = yield* Store
          const found = yield* store.state
          yield* store.saveSession("demo-3", session)
          return found
        }),
      ),
    )
    expect(Object.keys(after.tickets)).toEqual(["demo-1"])
    expect(Object.keys((onDisk(repo) as State).tickets)).toEqual(["demo-1", "demo-3"])
    expect(readFileSync(left, "utf8")).toContain('"demo-2"')
  })

  test("a write that fails is StoreWriteFailed, and the committed state stays as it was", async () => {
    const repo = newRepo()
    const folder = dirname(statePath(repo))
    const result = value(
      await withStore(
        repo,
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.saveSession("demo-1", session)
          // No temporary file can be made beside state.json.
          chmodSync(folder, 0o555)
          const failed = yield* Effect.flip(store.saveSession("demo-2", session))
          chmodSync(folder, 0o755)
          return { failed, state: yield* store.state }
        }),
      ),
    )
    expect(result.failed).toBeInstanceOf(StoreWriteFailed)
    expect(result.failed.file).toBe(statePath(repo))
    expect(result.failed.reason).toContain("EACCES")
    expect(Object.keys(result.state.tickets)).toEqual(["demo-1"])
    expect(Object.keys((onDisk(repo) as State).tickets)).toEqual(["demo-1"])
    expect(readdirSync(folder)).toEqual(["state.json"])
  })
})

describe("an unreadable state.json", () => {
  const unreadable = async (text: string) => {
    const repo = newRepo()
    mkdirSync(dirname(statePath(repo)), { recursive: true })
    writeFileSync(statePath(repo), text)
    const error = failure(
      await withStore(
        repo,
        Effect.flatMap(Store, (store) => store.state),
      ),
    )
    expect(error).toBeInstanceOf(StoreUnreadable)
    expect((error as StoreUnreadable).file).toBe(statePath(repo))
    expect((error as StoreUnreadable).message).toContain(statePath(repo))
    return error as StoreUnreadable
  }

  test("JSON cut short is StoreUnreadable, naming the file", async () => {
    expect((await unreadable('{"version": 1, "tick')).reason).toContain("isn't valid JSON")
  })

  test("a version this tutti doesn't read is StoreUnreadable", async () => {
    await unreadable(JSON.stringify({ version: 2, tickets: {} }))
  })

  test("a ticket of the wrong shape is StoreUnreadable", async () => {
    await unreadable(JSON.stringify({ version: 1, tickets: { "demo-1": { resume_count: "x" } } }))
  })
})

describe("the in-memory layer", () => {
  test("keeps tickets, sessions, suspensions and metadata as the live one does", () => {
    const state = Effect.runSync(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveSession("demo-1", session)
        yield* store.setMetadata("demo-1", "a", "x")
        yield* store.setMetadata("demo-1", "b", [1, 2])
        yield* store.unsetMetadata("demo-1", "a")
        yield* store.suspend("demo-1", "waiting on you", "Working")
        yield* store.saveSession("demo-2", session)
        yield* store.remove("demo-2")
        return {
          metadata: yield* store.metadata("demo-1"),
          ticket: yield* store.ticket("demo-1"),
          gone: yield* store.ticket("demo-2"),
          none: yield* store.metadata("demo-9"),
        }
      }).pipe(Effect.provide(memoryLayer())),
    )
    expect(state).toEqual({
      metadata: { b: [1, 2] },
      ticket: {
        ...session,
        suspended: "waiting on you",
        phase: "Working",
        resumes: 0,
        metadata: { b: [1, 2] },
      },
      gone: undefined,
      none: {},
    })
  })

  test("starts from the state it is given", () => {
    const initial: State = {
      version: stateVersion,
      run,
      tickets: { "demo-1": { ...session, resumes: 1, metadata: {} } },
    }
    const ticket = Effect.runSync(
      Effect.flatMap(Store, (store) => store.ticket("demo-1")).pipe(
        Effect.provide(memoryLayer(initial)),
      ),
    )
    expect(ticket?.resumes).toBe(1)
  })
})
