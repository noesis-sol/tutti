// The Store (§ 3.3): `.tutti/run/state.json` in the main checkout, the carry-over one run leaves
// the next (§ 4.8), and the per-ticket metadata a run keeps beside it. It names the run that wrote
// it and, per ticket, its session ID, worktree and branch, why it was suspended, its phase as it
// left the run and how often its session was resumed.
//
// Every write goes through one fiber, which takes the changes queued and commits them in order: it
// writes the whole state to a temporary file in the same folder, fsyncs it, and renames it over
// `state.json` (writeFileAtomic). A crash at any point leaves either the old file or the new one, never a mix. An
// update returns once its change is on disk, so a session ID saved before its session starts
// survives a crash (§ 4.8). Readers get the last committed state.
import { join } from "node:path"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Queue,
  Ref,
  Schema,
} from "effect"
import type { PlatformError } from "effect/PlatformError"
import { writeFileAtomic } from "./atomicFile.ts"

/** The carry-over file, relative to the project's top (§ 9.1). */
export const stateFile = join(".tutti", "run", "state.json")

/** Where the carry-over file of the project at `repo` (its main checkout) is. */
export const statePath = (repo: string): string => join(repo, stateFile)

/** The version of state.json this tutti writes, and the only one it reads. */
export const stateVersion = 1

/**
 * Why a ticket's session was suspended (§ 4.8): `quit`, `PAUSED`, `TICKET_LIMIT`, `waiting on
 * you`, `asked`, …; another string can be saved too.
 */
export type SuspendedWhy =
  | "quit"
  | "PAUSED"
  | "TICKET_LIMIT"
  | "waiting on you"
  | "asked"
  | (string & {})

/** The phases a ticket can be in (§ 5.1), by name: what state.json records of one. */
export const phaseNames = [
  "Queued",
  "HeldBack",
  "Working",
  "ToMerge",
  "Merging",
  "Resolving",
  "Fixing",
  "Done",
  "Asked",
  "Waiting",
  "Deferred",
  "Review",
  "Blocked",
  "Stopped",
] as const

export type PhaseName = (typeof phaseNames)[number]

/** The run that wrote the file. */
const RunStamp = Schema.Struct({
  pid: Schema.Number,
  /** When the run started, RFC 3339. */
  started: Schema.String,
  /** tutti's version. */
  version: Schema.String,
})

export type RunStamp = Schema.Schema.Type<typeof RunStamp>

const TicketRecordFields = Schema.Struct({
  /** The session's UUID, saved before the session starts. */
  session: Schema.optionalKey(Schema.String),
  /** The ticket's worktree, an absolute path. */
  worktree: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  /** Why its session was suspended as the run ended; absent while the ticket is in a run. */
  suspended: Schema.optionalKey(Schema.String),
  /** Its phase as it left the run; absent while it is in one, and after a run that crashed. */
  phase: Schema.optionalKey(Schema.Literals(phaseNames)),
  /** How many times its session has been resumed. */
  resumes: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /** The run's own metadata for the ticket, by key: any JSON value. */
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
})

/** What the Store keeps of one ticket. */
const TicketRecord = TicketRecordFields.pipe(
  Schema.encodeKeys({ session: "session_id", resumes: "resume_count" }),
)

export type TicketRecord = Schema.Schema.Type<typeof TicketRecord>

export const State = Schema.Struct({
  version: Schema.Literal(stateVersion),
  /** The run that last wrote the file; absent until a run has. */
  run: Schema.optionalKey(RunStamp),
  /** By ticket ID. */
  tickets: Schema.Record(Schema.String, TicketRecord),
})

export type State = Schema.Schema.Type<typeof State>

/** The state before any run has written one. */
export const emptyState: State = { version: stateVersion, tickets: {} }

/** A ticket the Store has nothing on yet. */
export const emptyTicket: TicketRecord = { resumes: 0, metadata: {} }

/** state.json couldn't be read, or isn't JSON this tutti reads. */
export class StoreUnreadable extends Schema.TaggedError<StoreUnreadable>()("StoreUnreadable", {
  file: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.file} can't be read: ${this.reason}`
  }
}

/** state.json couldn't be written; the last committed state stays as it was, on disk too. */
export class StoreWriteFailed extends Schema.TaggedError<StoreWriteFailed>()("StoreWriteFailed", {
  file: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.file} can't be written: ${this.reason}`
  }
}

/** What a ticket's session is started or resumed with. */
export interface SessionStart {
  readonly session: string
  readonly worktree: string
  readonly branch: string
}

export class Store extends Context.Service<
  Store,
  {
    /** The last committed state. */
    readonly state: Effect.Effect<State>
    /** What the last committed state has on the ticket, if anything. */
    ticket(id: string): Effect.Effect<TicketRecord | undefined>
    /** Applies `change` to the state and commits it, returning once the result is on disk. */
    update(change: (state: State) => State): Effect.Effect<State, StoreWriteFailed>
    /**
     * Applies `change` to what the state has on the ticket (`emptyTicket` when nothing) and
     * commits it; `undefined` removes the ticket.
     */
    updateTicket(
      id: string,
      change: (ticket: TicketRecord) => TicketRecord | undefined,
    ): Effect.Effect<void, StoreWriteFailed>
    /** Saves the session a ticket is about to start, with its worktree and branch (§ 4.8). */
    saveSession(id: string, start: SessionStart): Effect.Effect<void, StoreWriteFailed>
    /** Saves why the ticket's session was suspended, and the phase it left the run in. */
    suspend(id: string, why: SuspendedWhy, phase: PhaseName): Effect.Effect<void, StoreWriteFailed>
    /** Counts one more resume of the ticket's session, which is in a run again. */
    resumed(id: string): Effect.Effect<void, StoreWriteFailed>
    /** Forgets the ticket: merged, or dropped. */
    remove(id: string): Effect.Effect<void, StoreWriteFailed>
    /** The run's metadata for the ticket. */
    metadata(id: string): Effect.Effect<Readonly<Record<string, Schema.Json>>>
    /** Sets one key of the ticket's metadata, keeping the others. */
    setMetadata(id: string, key: string, value: Schema.Json): Effect.Effect<void, StoreWriteFailed>
    unsetMetadata(id: string, key: string): Effect.Effect<void, StoreWriteFailed>
  }
>()("tutti/services/Store") {
  /**
   * The Store of the project at `repo`, the main checkout, writing as the run `run`. Building it
   * reads state.json (none yet is `emptyState`); closing its scope commits the changes still queued.
   */
  static readonly layer = (options: { readonly repo: string; readonly run: RunStamp }) =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = statePath(options.repo)
        const committed = yield* Ref.make(yield* readState(file))
        const writes = yield* Queue.unbounded<Write>()
        const commit = commitWrites(fs, file, options.run, committed)

        // A batch taken is committed even if the writer is interrupted meanwhile.
        const writer = yield* Effect.forkDetach(
          Effect.forever(
            Effect.uninterruptibleMask((restore) =>
              Effect.flatMap(restore(Queue.takeAll(writes)), commit),
            ),
          ),
        )
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Fiber.interrupt(writer)
            const left = yield* Queue.clear(writes)
            if (left.length > 0) yield* commit(left)
          }),
        )

        return makeStore(Ref.get(committed), (change) =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<State, StoreWriteFailed>()
            yield* Queue.offer(writes, { change, done })
            return yield* Deferred.await(done)
          }),
        )
      }),
    )
}

/** A change waiting for the writer, and where its result goes. */
interface Write {
  readonly change: (state: State) => State
  readonly done: Deferred.Deferred<State, StoreWriteFailed>
}

const encodeState = Schema.encodeSync(State)
const decodeState = Schema.decodeUnknownExit(State)

/** The text state.json holds for `state`. */
export const stateText = (state: State): string =>
  `${JSON.stringify(encodeState(state), null, 2)}\n`

/** Reads the state from the text of a state.json, or says why it can't be. */
export const parseState = (file: string, text: string): Effect.Effect<State, StoreUnreadable> =>
  Effect.gen(function* () {
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) =>
        new StoreUnreadable({
          file,
          reason: `it isn't valid JSON: ${error instanceof Error ? error.message : error}`,
        }),
    })
    const exit = decodeState(json, { errors: "all" })
    if (Exit.isSuccess(exit)) return exit.value
    const reasons = exit.cause.reasons.flatMap((reason) =>
      reason._tag === "Fail" ? [String(reason.error.issue)] : [],
    )
    return yield* new StoreUnreadable({ file, reason: reasons.join("; ") || "it doesn't decode" })
  })

/** Reads the state.json at `file`: `emptyState` when there is none. */
export const readState = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.fail(new StoreUnreadable({ file, reason: error.message })),
        ),
      )
    return text === undefined ? emptyState : yield* parseState(file, text)
  })

/**
 * Writes `state` to `file` atomically (writeFileAtomic): to a temporary file in the same folder,
 * fsynced, then renamed over it, and the folder fsynced so the rename itself lasts.
 */
export const writeStateAtomically = (
  fs: FileSystem.FileSystem,
  file: string,
  state: State,
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(join(file, ".."), { recursive: true })
    yield* Effect.provideService(writeFileAtomic(file, stateText(state)), FileSystem.FileSystem, fs)
  })

/**
 * Commits a batch of writes as one: applies each change in turn, writes the result once, and then
 * completes each write with it. A change that throws dies alone, and the batch goes on without it.
 * A batch whose file can't be written fails every write in it, and leaves the state as it was.
 */
const commitWrites =
  (fs: FileSystem.FileSystem, file: string, run: RunStamp, committed: Ref.Ref<State>) =>
  (writes: ReadonlyArray<Write>): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        let state = yield* Ref.get(committed)
        const applied: Array<Write> = []
        for (const write of writes) {
          const next = yield* Effect.exit(Effect.sync(() => write.change(state)))
          if (Exit.isSuccess(next)) {
            state = next.value
            applied.push(write)
          } else {
            yield* Deferred.done(write.done, next)
          }
        }
        if (applied.length === 0) return
        const stamped: State = { ...state, run }
        const written = yield* Effect.exit(
          writeStateAtomically(fs, file, stamped).pipe(
            Effect.mapError((error) => new StoreWriteFailed({ file, reason: error.message })),
          ),
        )
        if (Exit.isSuccess(written)) yield* Ref.set(committed, stamped)
        const result = Exit.map(written, () => stamped)
        for (const write of applied) yield* Deferred.done(write.done, result)
      }),
    )

const withTicket =
  (id: string, change: (ticket: TicketRecord) => TicketRecord | undefined) =>
  (state: State): State => {
    const { [id]: current, ...others } = state.tickets
    const next = change(current ?? emptyTicket)
    return { ...state, tickets: next === undefined ? others : { ...others, [id]: next } }
  }

/** The Store's operations over a way to read the committed state and one to commit a change. */
export const makeStore = (
  state: Effect.Effect<State>,
  update: (change: (state: State) => State) => Effect.Effect<State, StoreWriteFailed>,
): Store["Service"] => {
  const updateTicket = (id: string, change: (ticket: TicketRecord) => TicketRecord | undefined) =>
    Effect.asVoid(update(withTicket(id, change)))
  const ticket = (id: string) =>
    Effect.map(state, (current) =>
      Object.hasOwn(current.tickets, id) ? current.tickets[id] : undefined,
    )
  return Store.of({
    state,
    ticket,
    update,
    updateTicket,
    saveSession: (id, start) =>
      updateTicket(id, ({ suspended: _, phase: __, ...ticket }) => ({ ...ticket, ...start })),
    suspend: (id, why, phase) =>
      updateTicket(id, (ticket) => ({ ...ticket, suspended: why, phase })),
    resumed: (id) =>
      updateTicket(id, ({ suspended: _, phase: __, ...ticket }) => ({
        ...ticket,
        resumes: ticket.resumes + 1,
      })),
    remove: (id) => updateTicket(id, () => undefined),
    metadata: (id) => Effect.map(ticket(id), (record) => record?.metadata ?? {}),
    setMetadata: (id, key, value) =>
      updateTicket(id, (ticket) => ({ ...ticket, metadata: { ...ticket.metadata, [key]: value } })),
    unsetMetadata: (id, key) =>
      updateTicket(id, (ticket) => {
        const { [key]: _, ...metadata } = ticket.metadata
        return { ...ticket, metadata }
      }),
  })
}
