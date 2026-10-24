// The mark a merge train leaves on a ticket whose branch it rebased onto the branch ahead
// (mergetrain.ts), in state.json: while it is there, the branch may have the commits of the branch
// ahead, so its merge (merge.ts's prepare) sets aside one not put back as its worker left it.
import { Effect, Predicate, type Schema } from "effect"
import { isHash } from "../services/Git.ts"
import { Store } from "../services/Store.ts"

/** The Store metadata key marking a ticket's branch as rebased by its train onto the branch ahead. */
export const aheadKey = "checked_ahead"

/** Where a branch a train rebased onto the branch ahead was, and what it was rebased to. */
export interface RebasedAhead {
  /** Its commit as its worker left it. */
  readonly orig: string
  /** The commit it is rebased onto: the branch ahead as it was checked. */
  readonly onto: string
  /** Its commit once rebased; "" until the rebase is over, or when git couldn't say. */
  readonly head: string
  /** The branch ahead of it. */
  readonly behind: string
  /** The setup may have run in its worktree, on top of the branch ahead. */
  readonly setUp: boolean
}

/**
 * The mark `value` holds, or undefined when it holds none, or none with the commit to put the
 * branch back to. state.json is anyone's to edit, so only a commit hash is taken for a commit.
 */
export const rebasedAheadOf = (value: Schema.Json | undefined): RebasedAhead | undefined => {
  if (!Predicate.isObject(value)) return undefined
  const fields: Readonly<Record<string, unknown>> = value
  const field = (key: string) => (Object.hasOwn(fields, key) ? fields[key] : undefined)
  const hash = (key: string) => {
    const it = field(key)
    return typeof it === "string" && isHash(it) ? it : ""
  }
  const orig = hash("orig")
  if (orig === "") return undefined
  const behind = field("behind")
  return {
    orig,
    onto: hash("onto"),
    head: hash("head"),
    behind: typeof behind === "string" && behind !== "" ? behind : "the branch ahead of it",
    setUp: field("setUp") === true,
  }
}

/** Marks the ticket's branch as rebased onto the branch ahead; a Store that can't be written doesn't. */
export const markAhead = (id: string, mark: RebasedAhead): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* Effect.ignore(store.setMetadata(id, aheadKey, { ...mark }))
  })

/** Clears the ticket's mark, its branch boarded or put back, if it has one. */
export const clearAhead = (id: string): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    if (!Object.hasOwn(yield* store.metadata(id), aheadKey)) return
    yield* Effect.ignore(store.unsetMetadata(id, aheadKey))
  })
