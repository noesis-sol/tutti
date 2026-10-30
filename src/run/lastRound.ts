// One more verifier round (§ 4.11, § 5's outcomes): a worker told to defer after three verifier
// rounds that still end in FAIL may have fixed the gaps and committed first, leaving the fix
// unverified, and its ticket to triage. So when a worker defers its ticket after three rounds and its
// branch has commits beyond the one the last round checked, tutti takes it back once in the run,
// before triage: it tells the idle worker that its last fix hasn't been verified, to run the
// verifier once more and close the ticket if it passes, defer it if it fails. A ticket deferred so a
// second time goes to triage as before; so does one deferred with no commit since the last round,
// before a third round, or by a worker you have steered, which tutti tells nothing (§ 4.3).
//
// The rounds are the worker's hooks' (src/agent/hooks.ts), which the host keeps: a round's start
// with the hashes its prompt names, one of them the commit the worker gave it, and its end. The
// commit the last round checked is the newest of the branch's commits beyond the base that its
// prompt names; a round that names none of them can't say, and is left as it is.
import { Effect, Result } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import type { VerifierRounds } from "../agent/hooks.ts"
import { Beads } from "../services/Beads.ts"
import { type Commit, Git, type GitError, givenHash, type Sha } from "../services/Git.ts"
import { Ledger } from "./ledger.ts"
import { detail, Log } from "./log.ts"
import type { Settled } from "./settle.ts"
import type { StartedWorker } from "./start.ts"
import { lastRoundText } from "./told.ts"

/** How many verifier rounds a worker runs before it defers a ticket they still fail. */
export const verifierRounds = 3

/**
 * The fix the worker's last verifier round didn't see, its branch's head, given its `rounds` and
 * the commits on its branch beyond the base, newest first: undefined when it has had its last round
 * already, ran fewer than three, or its last round checked the head or names none of `commits`.
 */
export const unverifiedFix = (
  rounds: VerifierRounds,
  commits: ReadonlyArray<{ readonly hash: Sha }>,
): Sha | undefined => {
  if (rounds.lastRound) return undefined
  const ended = rounds.rounds.filter((round) => round.ended)
  const last = ended.at(-1)
  if (ended.length < verifierRounds || last === undefined) return undefined
  const checked = commits.findIndex((commit) =>
    last.commits.some((hash) => commit.hash.startsWith(hash)),
  )
  return checked > 0 ? commits[0]?.hash : undefined
}

/** The note on a ticket given its last verifier round. */
export const lastRoundNote = (fix: Sha): string =>
  `tutti: deferred after three verifier rounds with its last fix, ${givenHash(fix)}, unverified; its worker was given one more round.`

/**
 * Gives the worker of a ticket it deferred after three verifier rounds, its last fix unverified,
 * one more round, waiting until the message is no longer outstanding: whether it did, for the
 * caller to settle the worker again. Once in the run, as `settled` and the worker's rounds say.
 */
export const lastRound = (
  worker: StartedWorker,
  settled: Settled,
  base: string,
): Effect.Effect<boolean, never, AgentHost | Beads | Git | Ledger | Log> =>
  Effect.gen(function* () {
    if (settled._tag !== "Read" || settled.reading._tag !== "Deferred") return false
    const host = yield* AgentHost
    const id = worker.ticket
    if ((yield* (yield* Ledger).current).tickets.get(id)?.steered === true) return false
    const rounds = yield* host.verifierRounds(id)
    const commits = yield* Effect.result(branchCommits(worker, base))
    if (Result.isFailure(commits)) return false
    const fix = unverifiedFix(rounds, commits.success)
    if (fix === undefined) return false
    yield* host.lastRound(id)
    const sent = yield* Effect.result(
      host.send(id, { text: lastRoundText(givenHash(fix)), from: "clientComposed" }),
    )
    if (Result.isFailure(sent)) return false
    yield* (yield* Log).write(
      detail`${id} deferred after three verifier rounds with its last fix unverified: one more round`,
    )
    yield* Effect.ignore((yield* Beads).update(id, { appendNotes: lastRoundNote(fix) }))
    yield* host.answered(id, sent.success)
    return true
  })

/** The commits on the worker's branch beyond `base`, newest first. */
const branchCommits = (
  worker: StartedWorker,
  base: string,
): Effect.Effect<ReadonlyArray<Commit>, GitError, Git> =>
  Effect.gen(function* () {
    return yield* (yield* Git).log(worker.worktree.path, base)
  })
