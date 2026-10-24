// The run's notifications (§ 7.9), as orchestra's: what a notice says of each record of the event
// stream, in a few words, and the layer that sends them. Only the outcomes that matter to you
// notify: a ticket merged, set aside or waiting on a question, the run stopping or finishing, the
// full check failing, and, at most once in 30 seconds, a worker needing you (§ 4.5). The usage
// limit's hold notifies by itself (usageLimit.ts), and the run's end says how it finished with its
// totals (run.ts). The other holds, probes, warnings that set no ticket aside, triage and a run with
// nothing to run don't notify: they are in the log, the event stream and the dashboard.
import { Clock, Duration, Effect, Layer } from "effect"
import { Notifier } from "../services/Notifier.ts"
import { oneLine } from "../ui/oneLine.ts"
import type { Event } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { type PhaseTag, phaseFacts } from "./phase.ts"

/** How many characters of a title or reason a notice gives, cut with `…`: the log has the rest. */
export const noticeWidth = 60

/** How long after a worker's request notifies before another worker's can (§ 4.5). */
export const needsYouEvery: Duration.Duration = Duration.seconds(30)

/** What happened, then what it happened over (a title, a reason), shortened to noticeWidth. */
export const about = (what: string, over: string | undefined): string => {
  const said = oneLine(over ?? "", noticeWidth)
  return said === "" ? what : `${what} · ${said}`
}

/** `no tickets closed`, `1 ticket closed`, `12 tickets closed`. */
const closedCount = (n: number): string =>
  n === 0 ? "no tickets closed" : n === 1 ? "1 ticket closed" : `${n} tickets closed`

/**
 * The notice of a run that finished by itself, from its tickets' phases as it ends: `Finished the
 * run · 12 tickets closed · 2 set aside · 1 needs you`, counting each ticket as the dashboard's
 * totals do (phase.ts phaseFacts): set aside if deferred or left for review, needing you if blocked
 * from merging or waiting on a question; not those reopened or merged since.
 */
export const finished = (phases: Iterable<{ readonly _tag: PhaseTag }>): string => {
  const counts = { closed: 0, setAside: 0, needsYou: 0 }
  for (const phase of phases) {
    const notice = phaseFacts[phase._tag].notice
    if (notice !== null) counts[notice]++
  }
  const aside = counts.setAside > 0 ? ` · ${counts.setAside} set aside` : ""
  const needs =
    counts.needsYou === 0 ? "" : ` · ${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you`
  return `Finished the run · ${closedCount(counts.closed)}${aside}${needs}`
}

/** What a worker's request asks, for its notice: `Allow Bash(rm -rf build)?`. */
const asks = (event: Extract<Event, { kind: "attention" }>): string => {
  switch (event.type) {
    case "permission":
      return `Allow ${event.tool ?? "a tool"}(${event.summary ?? ""})?`
    case "question":
      return (event.questions ?? []).map((q) => q.question).join("; ")
    case "elicitation":
      return `input for ${event.tool ?? "an MCP server"}`
  }
}

/**
 * What a notification says of `event`, or null for one that doesn't notify. A worker's request
 * notifies only when `needsYou` (no other has in the last 30 seconds); the layer tells.
 */
export const notice = (event: Event, needsYou = true): string | null => {
  switch (event.kind) {
    case "closed":
      return about(`Closed ${event.ticket}`, event.title)
    case "deferred":
      return about(`Set aside ${event.ticket}`, event.detail)
    case "warn":
      // CHECKS_FAILED, MERGE_CONFLICT, …: not LONG_RUNNING and the like.
      return event.aside === true && event.ticket !== undefined
        ? about(`Set aside ${event.ticket}`, event.detail)
        : null
    case "asked": {
      // After the question's ID, its title.
      const detail = event.detail ?? ""
      const colon = detail.indexOf(": ")
      return about(`${event.ticket} needs your answer`, colon < 0 ? "" : detail.slice(colon + 2))
    }
    case "attention":
      return needsYou ? about(`${event.ticket} needs you`, asks(event)) : null
    case "stop":
      return `Stopped${event.detail === "" ? "" : `: ${event.detail}`}${event.ticket === undefined ? "" : ` on ${event.ticket}`}`
    case "full_check":
      if (event.detail !== "failed" && event.detail !== "timed out") return null
      // Without a suite, it failed in the setup before it.
      return about("Full check failed", event.suite ?? "setup")
    default:
      return null
  }
}

/**
 * The EventStream that also notifies, over the one it is given: each record that notifies sends
 * its notice once. A stop recorded as it happens and again with the run's closing line notifies
 * the first time only.
 */
export const notifying: Layer.Layer<EventStream, never, EventStream | Notifier> = Layer.effect(
  EventStream,
  Effect.gen(function* () {
    const stream = yield* EventStream
    const notifier = yield* Notifier
    const stopped = new Set<string>()
    let lastNeedsYou: number | null = null
    const send = (event: Event) =>
      Effect.gen(function* () {
        let needsYou = false
        if (event.kind === "attention") {
          const now = yield* Clock.currentTimeMillis
          needsYou = lastNeedsYou === null || now - lastNeedsYou >= Duration.toMillis(needsYouEvery)
          if (needsYou) lastNeedsYou = now
        }
        const text = notice(event, needsYou)
        if (text === null) return
        if (event.kind === "stop") {
          if (stopped.has(text)) return
          stopped.add(text)
        }
        yield* notifier.notify(text)
      })
    return EventStream.of({
      emit: (event) => Effect.andThen(stream.emit(event), send(event)),
      figures: stream.figures,
    })
  }),
)
