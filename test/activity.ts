// What a Working ticket's worker is doing, as RunView reads it (runView.ts activityOf): the
// worker's state, or a question it asked. The ledger doesn't keep the activity, so a test that
// wants a row or a card at an activity gives the worker these.

import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import type { Activity } from "../src/run/phase.ts"
import type { TicketId } from "../src/services/Beads.ts"

/** The worker's state RunView reads `activity` from; `answer` is a question's, not a state's. */
export const stateFor = (activity: Activity): WorkerState | undefined => {
  switch (activity) {
    case "working":
    case "editing":
    case "reading":
    case "testing":
    case "subagent":
      return WorkerState.Working({ doing: activity })
    case "starting":
      return WorkerState.Starting()
    case "retrying":
      return WorkerState.Retrying({ attempt: 1, max: 10, status: null })
    case "allow":
      return WorkerState.NeedsYou({ requests: 1 })
    case "limit":
      return WorkerState.UsageLimited({ resetsAt: null })
    case "answer":
      return undefined
  }
}

/** A question `ticket`'s worker asked, open since `createdAt`: its row's `answer?`. */
export const questionOf = (ticket: TicketId, createdAt = 0): AttentionRequest => ({
  id: `q-${ticket}`,
  ticket,
  kind: {
    _tag: "Question",
    questions: [{ question: "Which store?", options: [{ label: "SQLite" }], multiSelect: false }],
    input: {},
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt,
})

/** The workers' states and the requests that put each of `doing`'s tickets at its activity. */
export const workersDoing = (
  doing: ReadonlyArray<readonly [string, Activity]>,
): {
  readonly workers: ReadonlyArray<readonly [string, WorkerState]>
  readonly requests: ReadonlyArray<AttentionRequest>
} => ({
  workers: doing.flatMap(([ticket, activity]) => {
    const state = stateFor(activity)
    return state === undefined ? [] : [[ticket, state] as const]
  }),
  requests: doing.flatMap(([ticket, activity]) =>
    activity === "answer" ? [questionOf(ticket as TicketId)] : [],
  ),
})
