// A session shown in the Interview view (§ 4.10, § 4.11, § 4.14): a feature's breakdown, a spec's
// refinement or a question's talk, in the main checkout. AgentHost knows each by interviewWorker, as
// it knows a ticket's worker by its ID; one is shown at a time.
//
// Text tutti brings into such a session's first message that someone else wrote (a feature's
// description, often pasted from an issue or a web page; a question a worker filed) goes between
// pasted_content tags carrying a fresh ID, as orchestra sends it: the instructions say text in the
// tags may carry instructions the user didn't write. The ID is drawn again while the text holds it,
// so no text in it can close the block early.
import { Effect } from "effect"
import { evidenceId } from "../organs/evidence.ts"
import type { TicketId } from "../services/Beads.ts"
import type { WorkerState } from "./WorkerState.ts"

/** The name AgentHost knows the session in the Interview view by. */
export const interviewWorker = "tutti-interview" as TicketId

/**
 * Whether the session's turn is over, so a filed tree or a given answer can end it: idle, failed,
 * or refused for Claude's login (§ 4.13), which no later turn gets past until the login is renewed.
 */
export const turnOver = (state: WorkerState): boolean =>
  state._tag === "Idle" || state._tag === "Failed" || state._tag === "LoginRefused"

/** `text` between pasted_content tags carrying `id`, each tag on its own line. */
export const pasted = (text: string, id: string): string =>
  `<pasted_content id="${id}">\n${text.replace(/^\n+|\n+$/g, "")}\n</pasted_content id="${id}">`

/** `lead`, then `text` pasted under a fresh ID, drawn again while `text` holds it. */
export const leadAndPasted = (lead: string, text: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    let id = yield* evidenceId
    while (text.includes(id)) id = yield* evidenceId
    return `${lead}\n\n${pasted(text, id)}`
  })
