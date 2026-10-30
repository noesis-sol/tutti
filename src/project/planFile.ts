// What a breakdown's tickets are checked against (§ 4.14, src/run/specTree.ts and
// src/agent/breakdownTools.ts): the types and priorities a ticket can have, a cycle of blocked-by
// links among tickets, and each ticket's files, kept where they can be the repository's.
import { posix } from "node:path"

/** The types a ticket under a breakdown's epic can have. */
export const ticketTypes = ["task", "feature", "bug", "chore"] as const

/** The priorities a ticket can have: 0 (critical) to 4 (backlog). */
export const priorities = [0, 1, 2, 3, 4] as const

/** A cycle of blocked-by links among the tickets, starting and ending with one key, or none. */
export const planCycle = (
  tickets: ReadonlyArray<{ readonly key: string; readonly blockedBy: ReadonlyArray<string> }>,
): ReadonlyArray<string> | undefined => {
  const blockers = new Map(tickets.map((t) => [t.key, t.blockedBy]))
  const state = new Map<string, "visiting" | "done">()
  const stack: Array<string> = []
  const visit = (key: string): ReadonlyArray<string> | undefined => {
    state.set(key, "visiting")
    stack.push(key)
    for (const blocker of blockers.get(key) ?? []) {
      const seen = state.get(blocker)
      if (seen === "visiting") return [...stack.slice(stack.indexOf(blocker)), blocker]
      if (seen === undefined) {
        const cycle = visit(blocker)
        if (cycle !== undefined) return cycle
      }
    }
    stack.pop()
    state.set(key, "done")
    return undefined
  }
  for (const t of tickets) {
    if (state.get(t.key) === undefined) {
      const cycle = visit(t.key)
      if (cycle !== undefined) return cycle
    }
  }
  return undefined
}

/**
 * Each ticket's files that are the repository's (`tracked`, as git ls-files lists them), or new
 * files in a directory holding some (or at the top), or with `newFolders` in a folder of its own
 * (a spec's tree, which may start from an empty repository), cleaned and without repeats; a note
 * for each one dropped.
 */
export const checkFiles = (
  tickets: ReadonlyArray<{ readonly key: string; readonly files: ReadonlyArray<string> }>,
  tracked: ReadonlyArray<string>,
  options: { readonly newFolders?: boolean } = {},
): {
  readonly files: ReadonlyArray<ReadonlyArray<string>>
  readonly notes: ReadonlyArray<string>
} => {
  const known = new Set(tracked)
  const dirs = new Set(["."])
  for (const f of tracked) {
    for (let d = posix.dirname(f); !dirs.has(d); d = posix.dirname(d)) dirs.add(d)
  }
  const notes: Array<string> = []
  const files = tickets.map((t) => {
    const kept: Array<string> = []
    for (const raw of t.files) {
      const f = raw.trim()
      if (f === "") continue
      const clean = posix.normalize(f.startsWith("./") ? f.slice(2) : f).replace(/\/+$/, "")
      const why =
        clean === "" ||
        clean === "." ||
        clean === ".." ||
        clean.startsWith("../") ||
        posix.isAbsolute(clean) ||
        clean.includes("\\") ||
        clean.includes("\0")
          ? "not a path inside the repository"
          : clean !== clean.trim()
            ? "it starts or ends with a space"
            : known.has(clean)
              ? undefined
              : dirs.has(clean)
                ? "a directory, not a file"
                : options.newFolders !== true && !dirs.has(posix.dirname(clean))
                  ? `not in the repository, and its directory ${posix.dirname(clean)}/ doesn't exist`
                  : undefined
      if (why !== undefined)
        notes.push(`dropped ${JSON.stringify(f)} from ${t.key}'s files: ${why}`)
      else if (!kept.includes(clean)) kept.push(clean)
    }
    return kept
  })
  return { files, notes }
}
