// Triage in the background (§ 5 items 11 and 13, § 6.2), as orchestra v0.7.7's: each ticket set
// aside as its worker settles (deferred by its worker, or by tutti for a worker that left it
// unfinished) is handed to the triage organ, unless its worker reached the usage limit in its
// attempt (§ 4.12). Its evidence is gathered as it is set aside, in the ticket's own fiber: the
// ticket as bd show gives it, the end of tutti's transcript of its worker (the last 40 items, at
// most 8,000 characters of their text), the attention requests the worker raised and their answers
// and the calls Claude Code denied it without asking (Attention's tally and the log's lines), its
// compactions (the transcript's compact_boundary messages), its worktree's changes, and the error
// its last turn failed with. One fiber in the run's scope triages the queue one ticket at a time,
// so the run never waits for a model's answer.
//
// A verdict is written to the ticket's notes (`Triage (tutti): cause = …`), shown on its row
// (`◆ environment · high · …`, in place of its note), logged (`  triage <id>: …`) and recorded as a
// `triage` event, then counted toward the environment hold (environment.ts's blamed), with the
// hold's generation as the ticket was queued. A triage that fails is TRIAGE_FAILED, in the log and a
// `warn` record; one skipped for the usage limit is logged by Organs already. A defect while
// gathering or triaging one ticket is TRIAGE_FAILED too: it loses that ticket's verdict, and the
// queue goes on, so the run still ends.
//
// Off with --triage=false or the settings' organs.triage false: nothing is gathered or asked. The
// run doesn't end while a ticket waits for triage (pending), so a verdict can still hold it. A quit
// interrupts the run's scope, and with it the triage under way and those queued: they are skipped.
import {
  Cause,
  Effect,
  Exit,
  FiberSet,
  Queue,
  Ref,
  Result,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { Attention } from "../agent/Attention.ts"
import { type Item, Transcripts } from "../agent/Transcripts.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { type OrganError, Organs } from "../organs/Organs.ts"
import { ticketText } from "../organs/predictor.ts"
import {
  compactionsText,
  type Evidence,
  judge,
  note,
  rowText,
  tailItems,
  transcriptText,
  type Verdict,
} from "../organs/triage.ts"
import { Beads, beadsWhy } from "../services/Beads.ts"
import { Git, gitWhy, shortHash } from "../services/Git.ts"
import { allChangeEntries } from "../services/gitStatus.ts"
import type { EnvironmentHold } from "./environment.ts"
import type { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import { causeWhy, detail, filed, type Line, Log, line, Tag } from "./log.ts"
import { attentionLines, attentionSaid } from "./report.ts"
import { sayer } from "./say.ts"

/** A ticket set aside as its worker settled, for triage. */
export interface Deferral {
  readonly ticket: string
  /** How it was set aside, in tutti's words: `the worker deferred it`. */
  readonly how: string
  /** Its worktree. */
  readonly worktree: string
  /** The error its worker's last turn failed with, when it did. */
  readonly failed?: string
}

export interface Triage {
  /** Hands a deferred ticket to triage, its evidence gathered now; nothing when triage is off. */
  deferred(deferral: Deferral): Effect.Effect<void>
  /** How many tickets wait for triage or are being triaged. */
  readonly pending: Effect.Effect<number>
  /** The verdicts in, by ticket, as their rows show them: now, then each change. */
  readonly verdicts: Stream.Stream<ReadonlyMap<string, string>>
  /** Aborts the organ calls under way and takes no more tickets, as quitting does (quit.ts). */
  readonly interrupt: Effect.Effect<void>
}

/** Triage turned off: it takes no ticket. */
export const off: Triage = {
  deferred: () => Effect.void,
  pending: Effect.succeed(0),
  verdicts: Stream.succeed(new Map()),
  interrupt: Effect.void,
}

/** How many characters of transcript lines are read back for the tail: its last items count. */
const tailRead = 512 * 1024

/** `  triage <id>: environment (high confidence) - <summary>`. */
export const verdictLine = (id: string, v: Verdict): Line =>
  detail`triage ${id}: ${v.cause} (${v.confidence} confidence) - ${v.summary.trim()}`

/** `  TRIAGE_FAILED for <id>: <why>`. */
export const triageFailedLine = (id: string, why: string): Line =>
  `  ${Tag.triageFailed} for ${line`${id}: ${why}`}` as Line

/** Why triage gave no verdict, on one line. */
const failure = (error: Exclude<OrganError, { _tag: "OrganSkipped" }>): string => {
  switch (error._tag) {
    case "OrganFailed":
    case "OrganRefused":
      return error.reason.split("\n")[0] ?? error.reason
    case "OrganTimedOut":
      return "triage ran past its time limit"
  }
}

const orNone = (lines: ReadonlyArray<string>): string =>
  lines.length === 0 ? "(none)" : lines.join("\n")

/** A ticket queued for triage: its evidence, and the hold's generation as it was queued. */
interface Queued {
  readonly evidence: Evidence
  readonly generation: number
}

/**
 * The run's triage, its queue worked through by a fiber in the run's scope. `base` is where the
 * tickets' branches start; `hold` counts the verdicts; `done` is told each time a ticket's triage
 * ends, with a verdict or without.
 */
export const make = (options: {
  readonly base: string
  readonly hold: Pick<EnvironmentHold, "generation" | "blamed">
  readonly done?: Effect.Effect<void>
}): Effect.Effect<
  Triage,
  never,
  | AppConfig
  | Organs
  | Beads
  | Git
  | Log
  | EventStream
  | Transcripts
  | Attention
  | RunFibers
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    if (!config.settings.organs.triage) return off
    const organs = yield* Organs
    const beads = yield* Beads
    const git = yield* Git
    const logs = yield* Log
    const { say, warn } = yield* sayer
    const transcripts = yield* Transcripts
    const attention = yield* Attention
    const queued = yield* Queue.unbounded<Queued>()
    const pending = yield* Ref.make(0)
    const verdicts = yield* SubscriptionRef.make<ReadonlyMap<string, string>>(new Map())

    // Every compaction in the worker's transcript, read back a page at a time from its end.
    const allItems = (id: string) =>
      Effect.gen(function* () {
        const pages: Array<ReadonlyArray<Item>> = []
        let before: number | undefined
        for (;;) {
          const page = yield* transcripts.page(id, before)
          if (page.length === 0) break
          pages.unshift(page)
          const first = page[0]?.seq ?? 0
          if (first <= 1 || first === before) break
          before = first
        }
        return pages.flat()
      })

    const attentionText = (id: string) =>
      Effect.gen(function* () {
        const said = attentionSaid(yield* attention.tally(id))
        const logged = attentionLines(yield* logs.lines)
          .filter((each) => each.ticket === id)
          .map(filed)
        const tally =
          said.length === 0
            ? "No attention requests, and no calls Claude Code denied without asking."
            : `${said.join(", ")}.`
        return logged.length === 0
          ? tally
          : `${tally}\n\nAs the log has them:\n${logged.join("\n")}`
      })

    const worktreeText = (path: string) =>
      Effect.gen(function* () {
        const status = yield* git.status(path).pipe(
          Effect.map((entries) =>
            orNone(allChangeEntries(entries).map((e) => `${e.code} ${e.path}`)),
          ),
          Effect.catch((error) => Effect.succeed(`(git status failed: ${gitWhy(error)})`)),
        )
        const commits = yield* git.log(path, options.base).pipe(
          Effect.map((list) => orNone(list.map((c) => `${shortHash(c.hash)} ${c.subject}`))),
          Effect.catch((error) => Effect.succeed(`(git log failed: ${gitWhy(error)})`)),
        )
        const files = yield* git.changedFiles(path, options.base).pipe(
          Effect.map(orNone),
          Effect.catch((error) => Effect.succeed(`(git diff failed: ${gitWhy(error)})`)),
        )
        return (
          `Uncommitted changes:\n${status}\n\n` +
          `Commits on the ticket branch since ${options.base}:\n${commits}\n\n` +
          `Files the ticket branch changed since ${options.base}:\n${files}`
        )
      })

    // The evidence for one deferred ticket, gathered now.
    const gather = (d: Deferral) =>
      Effect.gen(function* () {
        const id = d.ticket
        const shown = yield* beads.show(id).pipe(
          Effect.map(ticketText),
          Effect.catch((error) => Effect.succeed(`${id}\n(bd show failed: ${beadsWhy(error)})`)),
        )
        const tail = yield* transcripts.tail(id, { items: tailItems, characters: tailRead })
        return {
          ticket: id,
          how: d.how,
          shown,
          transcript: transcriptText(tail),
          attention: yield* attentionText(id),
          compactions: compactionsText(yield* allItems(id)),
          worktree: yield* worktreeText(d.worktree),
          ...(d.failed === undefined ? {} : { failed: d.failed }),
        } satisfies Evidence
      })

    // A defect in one ticket's triage, TRIAGE_FAILED; an interruption (a quit) goes on up.
    const survived = (id: string, cause: Cause.Cause<never>) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const text = triageFailedLine(id, causeWhy(cause))
      return warn(text, id)
    }

    const triageOne = (q: Queued) =>
      Effect.gen(function* () {
        const id = q.evidence.ticket
        const answer = yield* judge(q.evidence).pipe(
          Effect.provideService(Organs, organs),
          Effect.result,
        )
        if (Result.isFailure(answer)) {
          // A call skipped for the usage limit is logged as such already.
          if (answer.failure._tag === "OrganSkipped") return
          const text = triageFailedLine(id, failure(answer.failure))
          yield* warn(text, id)
          return
        }
        const v = answer.success
        yield* Effect.ignore(beads.update(id, { appendNotes: note(v) }))
        const text = verdictLine(id, v)
        yield* say({
          kind: "triage",
          ticket: id,
          title: v.summary.trim(),
          detail: `${v.cause} · ${v.confidence}`,
          text,
        })
        yield* SubscriptionRef.update(verdicts, (all) => new Map(all).set(id, rowText(v)))
        yield* options.hold.blamed({
          ticket: id,
          cause: v.cause,
          confidence: v.confidence,
          summary: v.summary,
          generation: q.generation,
        })
      }).pipe(
        Effect.catchCause((cause) => survived(q.evidence.ticket, cause)),
        Effect.ensuring(
          Effect.andThen(
            Ref.update(pending, (n) => n - 1),
            options.done ?? Effect.void,
          ),
        ),
      )

    const fibers = yield* (yield* RunFibers).make<never, never>("triage")
    yield* FiberSet.run(fibers, Effect.forever(Effect.flatMap(Queue.take(queued), triageOne)))

    return {
      deferred: (d) =>
        Effect.gen(function* () {
          const generation = yield* options.hold.generation
          yield* Ref.update(pending, (n) => n + 1)
          const evidence = yield* gather(d).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Ref.update(pending, (n) => n - 1),
            ),
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.andThen(survived(d.ticket, cause), options.done ?? Effect.void),
                undefined,
              ),
            ),
          )
          if (evidence === undefined) return
          yield* Queue.offer(queued, { evidence, generation })
        }),
      pending: Ref.get(pending),
      verdicts: SubscriptionRef.changes(verdicts),
      interrupt: FiberSet.clear(fibers),
    } satisfies Triage
  })
