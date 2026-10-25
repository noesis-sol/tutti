// The Store (§ 3.3): `.tutti/run/state.json` in the main checkout, the carry-over one run leaves
// the next (§ 4.8), and the per-ticket metadata a run keeps beside it. It names the run that wrote
// it and, per ticket, its session ID, worktree and branch, why it was suspended, its phase as it
// left the run and how often its session was resumed.
//
// Every write goes through one fiber, which takes the changes queued and commits them in order: it
// writes the whole state to a temporary file in the same folder, fsyncs it, and renames it over
// `state.json` (writeFileUnder, through the symlink guard). A crash at any point leaves either the
// old file or the new one, never a mix. It is read through the guard too (openUnder). An update returns once its change is on disk, so a session
// ID saved before its session starts survives a crash (§ 4.8). Readers get the last committed
// state.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
} from "effect"
import {
  close,
  LibcError,
  makeFoldersUnder,
  O,
  openUnder,
  type Refusal,
  writeFileUnder,
} from "../native/libc.ts"
import { phaseNames } from "../run/events.ts"
import type { TicketId } from "./Beads.ts"

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

/** A phase a ticket can be in (§ 5.1), by name: what state.json records of one. */
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
  /** The session's UUID, saved once the session has begun: its first system/init came. */
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

/** The state's tickets, each with its ID: state.json keeps them by ID. */
export const ticketsIn = (state: State): ReadonlyArray<readonly [TicketId, TicketRecord]> =>
  Object.entries(state.tickets).map(([id, record]) => [id as TicketId, record] as const)

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
    /**
     * The run that wrote state.json before this one, as the Store read it when built; absent when
     * none had. Every commit stamps this run on the state, so the state's own `run` is this one's
     * once it has written.
     */
    readonly previousRun: RunStamp | undefined
    /** What the last committed state has on the ticket, if anything. */
    ticket(id: TicketId): Effect.Effect<TicketRecord | undefined>
    /** Applies `change` to the state and commits it, returning once the result is on disk. */
    update(change: (state: State) => State): Effect.Effect<State, StoreWriteFailed>
    /**
     * Applies `change` to what the state has on the ticket (`emptyTicket` when nothing) and
     * commits it; `undefined` removes the ticket.
     */
    updateTicket(
      id: TicketId,
      change: (ticket: TicketRecord) => TicketRecord | undefined,
    ): Effect.Effect<void, StoreWriteFailed>
    /** Saves the session a ticket is about to start, with its worktree and branch (§ 4.8). */
    saveSession(id: TicketId, start: SessionStart): Effect.Effect<void, StoreWriteFailed>
    /** Saves why the ticket's session was suspended, and the phase it left the run in. */
    suspend(
      id: TicketId,
      why: SuspendedWhy,
      phase: PhaseName,
    ): Effect.Effect<void, StoreWriteFailed>
    /** Counts one more resume of the ticket's session, which is in a run again. */
    resumed(id: TicketId): Effect.Effect<void, StoreWriteFailed>
    /** Forgets the ticket: merged, or dropped. */
    remove(id: TicketId): Effect.Effect<void, StoreWriteFailed>
    /** The run's metadata for the ticket. */
    metadata(id: TicketId): Effect.Effect<Readonly<Record<string, Schema.Json>>>
    /** Sets one key of the ticket's metadata, keeping the others. */
    setMetadata(
      id: TicketId,
      key: string,
      value: Schema.Json,
    ): Effect.Effect<void, StoreWriteFailed>
    unsetMetadata(id: TicketId, key: string): Effect.Effect<void, StoreWriteFailed>
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
        const read = yield* readState(options.repo)
        const committed = yield* Ref.make(read)
        const writes = yield* Queue.unbounded<Write>()
        const commit = commitWrites(options.repo, options.run, committed)

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

        return makeStore(
          Ref.get(committed),
          (change) =>
            Effect.gen(function* () {
              const done = yield* Deferred.make<State, StoreWriteFailed>()
              yield* Queue.offer(writes, { change, done })
              return yield* Deferred.await(done)
            }),
          read.run,
        )
      }),
    )
}

/** A change waiting for the writer, and where its result goes. */
interface Write {
  readonly change: (state: State) => State
  readonly done: Deferred.Deferred<State, StoreWriteFailed>
}

const encodeState = Schema.encodeExit(State)
const decodeState = Schema.decodeUnknownExit(State)

/** The text state.json holds for the encoded state `json`. */
const jsonText = (json: unknown): string => `${JSON.stringify(json, null, 2)}\n`

/** The text state.json holds for `state`. */
export const stateText = (state: State): string => jsonText(Schema.encodeSync(State)(state))

/** What a schema's failure says is wrong, issue by issue. */
const issues = (cause: Cause.Cause<Schema.SchemaError>): string =>
  cause.reasons
    .flatMap((reason) => (reason._tag === "Fail" ? [reason.error.message] : []))
    .join("; ")

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
    return yield* new StoreUnreadable({ file, reason: issues(exit.cause) || "it doesn't decode" })
  })

/**
 * Reads the text of state.json below `repo` through the symlink guard (openUnder, § 9.1):
 * undefined when there is none, .tutti or .tutti/run missing too. A symbolic link at .tutti,
 * .tutti/run or state.json, which a merged ticket can leave there, is refused rather than read
 * through, as is anything there but a regular file: StoreUnreadable, saying why and quoting nothing
 * behind it.
 */
export const readStateText = (repo: string): Effect.Effect<string | undefined, StoreUnreadable> => {
  const file = statePath(repo)
  const unreadable = (reason: string) => new StoreUnreadable({ file, reason })
  return Effect.acquireUseRelease(
    openUnder(repo, stateFile, O.RDONLY).pipe(
      Effect.catchIf(
        (error) => error instanceof LibcError && error.code === "ENOENT",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError((error) => unreadable(error.message)),
    ),
    (fd) =>
      fd === undefined
        ? Effect.succeed(undefined)
        : Effect.try({
            try: () => readFileSync(fd, "utf8"),
            catch: (error) => unreadable(error instanceof Error ? error.message : String(error)),
          }),
    (fd) => (fd === undefined ? Effect.void : Effect.ignore(close(fd))),
  )
}

/**
 * Reads state.json below `repo` through the symlink guard (readStateText): `emptyState` when there
 * is none; StoreUnreadable where the guard refuses it or it isn't a state this tutti reads.
 */
export const readState = (repo: string): Effect.Effect<State, StoreUnreadable> =>
  Effect.flatMap(readStateText(repo), (text) =>
    text === undefined ? Effect.succeed(emptyState) : parseState(statePath(repo), text),
  )

/**
 * Writes `text`, a state's (stateText), to state.json below `repo` atomically and through the
 * symlink guard (writeFileUnder, § 9.1): to a temporary file in the same folder, fsynced, then
 * renamed over it, and the folder fsynced so the rename itself lasts. A symbolic link at .tutti,
 * .tutti/run or state.json, which a merged ticket can leave there, is refused rather than written
 * through.
 */
const writeStateUnder = (repo: string, text: string): Effect.Effect<void, Refusal> =>
  Effect.andThen(
    Effect.sync(() => makeFoldersUnder(repo, dirname(stateFile))),
    writeFileUnder(repo, stateFile, text),
  )

/** A state as committed: as reading state.json back gives it, and the text state.json holds. */
export interface Committed {
  readonly state: State
  readonly text: string
}

/** What a batch of changes commits. */
export interface Commit {
  /** Each change's outcome, in order: a defect for one that threw, which the batch goes on without. */
  readonly changes: ReadonlyArray<Exit.Exit<void>>
  /**
   * The state the batch commits; absent when no change applied, and why not when the state can't
   * be written as state.json.
   */
  readonly result: Result.Result<Committed, string> | undefined
}

/**
 * Commits a batch of changes to `state` as the run `run`, all but the writing (§ 3.3): applies each
 * change in turn, stamps the run, encodes the result to state.json's text and decodes that text
 * back, so the state committed is the one a later read gives and one that can't be encoded fails
 * here. Both the live layer and the test layer commit through it.
 */
export const commit = (
  state: State,
  changes: ReadonlyArray<(state: State) => State>,
  run: RunStamp,
): Commit => {
  let next = state
  let applied = false
  const outcomes = changes.map((change): Exit.Exit<void> => {
    try {
      next = change(next)
      applied = true
      return Exit.void
    } catch (error) {
      return Exit.die(error)
    }
  })
  return { changes: outcomes, result: applied ? roundTrip({ ...next, run }) : undefined }
}

/** `state` as state.json's text and as that text reads back, or why it can't be written. */
const roundTrip = (state: State): Result.Result<Committed, string> => {
  const encoded = encodeState(state, { errors: "all" })
  if (Exit.isFailure(encoded)) return Result.fail(`it doesn't encode: ${issues(encoded.cause)}`)
  const text = jsonText(encoded.value)
  const decoded = decodeState(JSON.parse(text), { errors: "all" })
  if (Exit.isFailure(decoded)) return Result.fail(`it doesn't read back: ${issues(decoded.cause)}`)
  return Result.succeed({ state: decoded.value, text })
}

/**
 * Commits a batch of writes as one (commit): writes the result once, and then completes each write
 * with it. A change that throws dies alone, and the batch goes on without it. A batch whose state
 * can't be written fails every write in it, and leaves the state as it was.
 */
const commitWrites =
  (repo: string, run: RunStamp, committed: Ref.Ref<State>) =>
  (writes: ReadonlyArray<Write>): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const batch = commit(
          yield* Ref.get(committed),
          writes.map((write) => write.change),
          run,
        )
        const applied: Array<Write> = []
        for (const [index, write] of writes.entries()) {
          const outcome = batch.changes[index] ?? Exit.void
          if (Exit.isSuccess(outcome)) applied.push(write)
          else yield* Deferred.failCause(write.done, outcome.cause)
        }
        if (batch.result === undefined) return
        const failed = (reason: string) => new StoreWriteFailed({ file: statePath(repo), reason })
        const written = yield* Effect.exit(
          Result.isSuccess(batch.result)
            ? writeStateUnder(repo, batch.result.success.text).pipe(
                Effect.mapError((error) => failed(error.message)),
                Effect.as(batch.result.success.state),
              )
            : Effect.fail(failed(batch.result.failure)),
        )
        if (Exit.isSuccess(written)) yield* Ref.set(committed, written.value)
        for (const write of applied) yield* Deferred.done(write.done, written)
      }),
    )

const withTicket =
  (id: TicketId, change: (ticket: TicketRecord) => TicketRecord | undefined) =>
  (state: State): State => {
    const { [id]: current, ...others } = state.tickets
    const next = change(current ?? emptyTicket)
    return { ...state, tickets: next === undefined ? others : { ...others, [id]: next } }
  }

/**
 * The Store's operations over a way to read the committed state and one to commit a change, the
 * run that wrote the state before this one being `previousRun`.
 */
export const makeStore = (
  state: Effect.Effect<State>,
  update: (change: (state: State) => State) => Effect.Effect<State, StoreWriteFailed>,
  previousRun: RunStamp | undefined,
): Store["Service"] => {
  const updateTicket = (id: TicketId, change: (ticket: TicketRecord) => TicketRecord | undefined) =>
    Effect.asVoid(update(withTicket(id, change)))
  const ticket = (id: TicketId) =>
    Effect.map(state, (current) =>
      Object.hasOwn(current.tickets, id) ? current.tickets[id] : undefined,
    )
  return Store.of({
    state,
    previousRun,
    ticket,
    update: Effect.fn("Store.update")(update),
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
