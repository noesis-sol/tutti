// Filing a finished worker's message as a ticket (§ 7.5, tutti-g0wd): once a worker has finished,
// its card gone, the composer can't send it what you typed, and Ctrl+T, or the File as ticket
// button on the finished line, files it as a new ticket instead, so that a follow-up written for
// the worker isn't lost. The view offers FileTicket with the text and a uuid it drew; the run files
// it with bd create, in a fiber of its own so the screen's other commands don't wait on bd, and
// puts how it went in the screen's `filings` under that uuid: the view empties the composer once
// it's filed, and keeps the text when it isn't.
//
// The ticket's title is the text's first line, cut to `titleLimit`; its description the whole text
// and where it was written; it was discovered from the finished ticket. The log has the FILED line,
// with the new ticket's ID, never the text, as a MESSAGE line has only its length.
import { Data, Effect, SubscriptionRef } from "effect"
import * as log from "../core/log.ts"
import { Log } from "../core/log.ts"
import { Beads, beadsWhy, type TicketId } from "../services/Beads.ts"
import { titleOf } from "../text/oneLine.ts"

/** How a filing went: the ticket bd created, or why it didn't. */
export type FileOutcome = Data.TaggedEnum<{
  Filed: { readonly id: TicketId; readonly title: string }
  NotFiled: { readonly why: string }
}>

export const FileOutcome = Data.taggedEnum<FileOutcome>()

/** A filing the view asked for, by the uuid it drew, and how it went. */
export interface TicketFiling {
  readonly uuid: string
  /** The finished ticket whose view it was written in. */
  readonly from: TicketId
  readonly outcome: FileOutcome
}

/** The most filings the screen keeps: the view waits only on its latest. */
export const filingsKept = 16

/** A filed ticket's description: the whole `text`, and where it was written. */
export const descriptionOf = (text: string, from: string): string =>
  `${text.trim()}\n\nWritten for ${from}'s worker in tutti's worker view, after the worker had finished.`

/**
 * Files `text`, written in `from`'s view, as a new ticket discovered from `from`, and puts how it
 * went in `filings` under `uuid`: the FILED line once bd has created it. It never fails: bd's error
 * is the NotFiled's why.
 */
export const fileTicket = (
  request: { readonly from: TicketId; readonly text: string; readonly uuid: string },
  filings: SubscriptionRef.SubscriptionRef<ReadonlyArray<TicketFiling>>,
): Effect.Effect<void, never, Beads | Log> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const logs = yield* Log
    const title = titleOf(request.text)
    const outcome = yield* beads
      .create({
        title,
        description: descriptionOf(request.text, request.from),
        discoveredFrom: [request.from],
      })
      .pipe(
        Effect.tap((issue) => logs.write(log.filedTicket(issue.id, request.from))),
        Effect.map((issue) => FileOutcome.Filed({ id: issue.id, title: issue.title })),
        Effect.catch((error) => Effect.succeed(FileOutcome.NotFiled({ why: beadsWhy(error) }))),
      )
    yield* SubscriptionRef.update(filings, (all) =>
      [...all, { uuid: request.uuid, from: request.from, outcome }].slice(-filingsKept),
    )
  })
