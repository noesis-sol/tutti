// The unmerged label (§ 4.8, § 11, § 5.1's ToMerge → Stopped), as orchestra's unmerged.go has it. A
// ticket closed in Beads and not merged when the run ends is labelled `unmerged`, so the tickets it
// blocks wait in later runs too, with where its branch was cut from the base in its metadata
// (`unmerged_fork`): the commits after it are the branch's own. tutti's workers can't outlive it,
// so a ticket still in progress isn't labelled, as orchestra labels the ones whose workers it
// leaves running.
//
// As a run starts, each ticket labelled `unmerged` is checked for having merged since, by hand: by
// tutti on tutti/<id>, or by orchestra on wt/<id>. It has when its branch is on the base with a
// commit of its own naming the ticket, or the base holds the branch's changes (squash-merged, the
// branch kept) and a commit on the base the branch doesn't have names it, or its branch is gone
// and a commit on the base since the fork names it. The label is then removed. One that hasn't
// merged is handed back, for carry-over to bring back ToMerge. git that can't tell keeps the label.
import { Effect, Result } from "effect"
import { Beads, type BeadsError, beadsWhy, type Issue } from "../services/Beads.ts"
import { type Commit, Git } from "../services/Git.ts"
import { branchOf, ticketIdProblem } from "../services/Worktrees.ts"
import type { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Log, line, Tag, ticketLine } from "./log.ts"
import type { MergeOptions } from "./merge.ts"
import { info, warn } from "./say.ts"
import { unmergedLabel } from "./scope.ts"

/**
 * The metadata key holding the commit on the base a ticket's branch was cut from (their
 * merge-base), as the run that labelled it `unmerged` found it (§ 11).
 */
export const forkKey = "unmerged_fork"

/** The branch orchestra's worker commits on (§ 11): a ticket orchestra labelled has its work there. */
export const orchestraBranchOf = (id: string): string => `wt/${id}`

/**
 * Whether `text` is a commit hash, abbreviated or whole, and so a revision git can't take for an
 * option or a range.
 */
export const isHash = (text: string): boolean => /^[0-9a-f]{7,64}$/.test(text)

/**
 * The commit the ticket's `unmerged_fork` holds, or undefined when it holds none, or something
 * other than a commit hash: the metadata is anyone's to change.
 */
export const forkOf = (issue: Issue): string | undefined => {
  const fork = issue.metadata[forkKey]
  return typeof fork === "string" && isHash(fork) ? fork : undefined
}

/** A letter, digit or underscore: what an ID's parts are made of. */
const idChar = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9_]$/.test(c)

/**
 * Whether `message` names the ticket `id` as a whole ID, not inside a longer one: not `id3`,
 * `xid`, `id-x`, nor the child `id.1`.
 */
export const namesTicket = (message: string, id: string): boolean => {
  if (id === "") return false
  for (let at = message.indexOf(id); at !== -1; at = message.indexOf(id, at + 1)) {
    const before = message[at - 1]
    const end = at + id.length
    const after = message[end]
    const startsHere = before === undefined || (!idChar(before) && before !== "-" && before !== ".")
    const endsHere =
      after === undefined ||
      (!idChar(after) && !((after === "-" || after === ".") && idChar(message[end + 1])))
    if (startsHere && endsHere) return true
  }
  return false
}

/** The newest of `commits` (newest first) naming the ticket, if any. */
const naming = (commits: ReadonlyArray<Commit>, id: string): Commit | undefined =>
  commits.find((commit) => namesTicket(commit.message, id))

/** What became of a labelled ticket's work: merged with `commit`, and the branch it is on. */
export interface Found {
  /** The commit on the base naming it, when it has merged. */
  readonly merged?: Commit
  /** tutti/<id> or orchestra's wt/<id>, whichever is there, tutti's first; absent when neither is. */
  readonly branch?: string
}

/**
 * The commit naming the ticket that its branch, there in the repository, added: when the branch is
 * on the base, one of its own commits (since its fork, or else its tip alone), so that an older
 * commit naming the ticket on the base, or a branch with no commits of its own, isn't its merge;
 * when the base holds the branch's changes, squash-merged and the branch kept, a commit on the
 * base the branch doesn't have.
 */
const branchMerged = (issue: Issue, branch: string, options: MergeOptions) =>
  Effect.gen(function* () {
    const git = yield* Git
    const { repo, base } = options
    const ahead = yield* git.log(repo, base, branch)
    if (ahead.length === 0) {
      const fork = forkOf(issue)
      return naming(yield* git.log(repo, fork ?? `${branch}^`, branch), issue.id)
    }
    if (!(yield* git.holds(repo, base, branch))) return undefined
    return naming(yield* git.log(repo, branch, base), issue.id)
  }).pipe(Effect.orElseSucceed(() => undefined))

/**
 * Whether the labelled ticket's work has merged since, by hand, and where it is: on tutti/<id>,
 * else orchestra's wt/<id>; with neither branch there, a commit on the base since the fork
 * (`unmerged_fork`) naming the ticket is its merge. Without a fork, or when git can't tell, it
 * hasn't merged. The Nothing to run box asks it too, so the run and the box agree.
 */
export const mergedSince = (
  issue: Issue,
  options: MergeOptions,
): Effect.Effect<Found, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    if (ticketIdProblem(issue.id) !== undefined) return {}
    for (const branch of [branchOf(issue.id), orchestraBranchOf(issue.id)]) {
      const there = yield* Effect.result(git.branchExists(options.repo, branch))
      if (Result.isFailure(there)) return {}
      if (there.success) {
        const merged = yield* branchMerged(issue, branch, options)
        return merged === undefined ? { branch } : { merged, branch }
      }
    }
    const fork = forkOf(issue)
    if (fork === undefined) return {}
    const since = yield* Effect.result(git.log(options.repo, fork, options.base))
    const merged = Result.isSuccess(since) ? naming(since.success, issue.id) : undefined
    return merged === undefined ? {} : { merged }
  })

/** A ticket an earlier run left labelled `unmerged` that hasn't merged since. */
export interface LeftUnmerged {
  readonly issue: Issue
  /** Where its work is (see Found); absent when neither branch is there. */
  readonly branch?: string
}

/**
 * The tickets earlier runs left labelled `unmerged` that haven't merged since, as loadUnmerged
 * would hand them back, but only read: what the Nothing to run box counts, before the run.
 */
export const stillUnmerged = (
  options: MergeOptions,
): Effect.Effect<ReadonlySet<string>, BeadsError, Git | Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const labelled = yield* beads.list({ status: "closed", labels: [unmergedLabel] })
    const left = new Set<string>()
    for (const issue of labelled) {
      if ((yield* mergedSince(issue, options)).merged === undefined) left.add(issue.id)
    }
    return left
  })

/** `<hash> <subject>`, the hash cut to 7, as the log names a commit. */
const named = (commit: Commit) => line`${commit.hash.slice(0, 7)} ${commit.subject}`

/**
 * Removes the ticket's label, warning with LABEL_FAILED when bd can't: as the run starts, for one
 * merged by hand, and as one carried over merges (merge.ts). Whether it did.
 */
export const unlabel = (id: string) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const removed = yield* Effect.result(beads.removeLabel(id, unmergedLabel))
    if (Result.isSuccess(removed)) return true
    const text = ticketLine(
      Tag.labelFailed,
    )`bd could not remove ${id}'s '${unmergedLabel}' label: ${beadsWhy(removed.failure)}; later runs hold the tickets it blocks until it is removed (bd label remove ${id} ${unmergedLabel})`
    yield* warn(text, id)
    return false
  })

/**
 * The tickets earlier runs left labelled `unmerged` (closed, by tutti or orchestra), each checked
 * as the run starts and before it dispatches: one merged since by hand loses its label; the others
 * are handed back, for carry-over to bring back ToMerge, while the label holds the tickets they
 * block. bd failing to list them fails, for the run to stop on.
 */
export const loadUnmerged = (
  options: MergeOptions,
): Effect.Effect<ReadonlyArray<LeftUnmerged>, BeadsError, Git | Beads | Log | EventStream> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const { base } = options
    const labelled = yield* beads.list({ status: "closed", labels: [unmergedLabel] })
    const left: Array<LeftUnmerged> = []
    for (const issue of labelled) {
      const { id } = issue
      const found = yield* mergedSince(issue, options)
      if (found.merged !== undefined) {
        const text = detail`${id}, left unmerged by an earlier run, is on ${base} now (${named(found.merged)}); its '${unmergedLabel}' label is removed`
        yield* info(text, id)
        yield* unlabel(id)
        continue
      }
      const branch = found.branch ?? branchOf(id)
      const text = detail`${id} was left unmerged by an earlier run; tickets it blocks wait until ${branch} is merged into ${base} or its '${unmergedLabel}' label is removed`
      yield* info(text, id)
      left.push(found.branch === undefined ? { issue } : { issue, branch: found.branch })
    }
    return left
  })

/**
 * Labels the ticket `unmerged`, first noting where its branch left the base (`unmerged_fork`), so
 * a later run takes only the branch's own commits for its merge. A fork that can't be found or
 * noted leaves the branch's tip alone for its own. Whether bd labelled it.
 */
const label = (id: string, options: MergeOptions) =>
  Effect.gen(function* () {
    const git = yield* Git
    const beads = yield* Beads
    const { repo, base } = options
    const branch = branchOf(id)
    const fork = yield* Effect.result(git.mergeBase(repo, base, branch))
    if (Result.isSuccess(fork)) {
      yield* Effect.ignore(beads.setMetadata(id, forkKey, fork.success))
    }
    const added = yield* Effect.result(beads.addLabel(id, unmergedLabel))
    const text = Result.isSuccess(added)
      ? detail`${id} is closed but not merged, labelled '${unmergedLabel}': tickets it blocks wait until ${branch} is merged into ${base}, in later runs too`
      : ticketLine(
          Tag.labelFailed,
        )`bd could not label ${id} '${unmergedLabel}': ${beadsWhy(added.failure)}; later runs may start the tickets it blocks before it merges (bd label add ${id} ${unmergedLabel})`
    yield* (Result.isSuccess(added) ? info : warn)(text, id)
    return Result.isSuccess(added)
  })

/**
 * As the run ends, once its tickets have their last phases: each ticket it took up that is closed
 * in Beads and not merged (short of Done) is labelled `unmerged`, unless it is already; a ticket
 * still in progress isn't, since its worker ends with the run. One that merged in this run and still
 * has the label an earlier run gave it, which its merge couldn't remove, loses it. A ticket bd
 * can't show is passed over.
 */
export const labelAtEnd = (
  options: MergeOptions,
): Effect.Effect<void, never, Git | Beads | Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const state = yield* (yield* Ledger).current
    for (const entry of state.tickets.values()) {
      const shown = yield* Effect.result(beads.show(entry.ticket))
      if (Result.isFailure(shown)) continue
      const issue = shown.success
      const labelled = issue.labels.includes(unmergedLabel)
      if (entry.phase._tag === "Done") {
        if (labelled) yield* unlabel(issue.id)
      } else if (issue.status === "closed" && !labelled) {
        yield* label(issue.id, options)
      }
    }
  })
