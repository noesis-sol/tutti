// The run's loop on its own (look.ts), over stub parts: each look, what it decides, and the probe
// once nothing is left; and limitedOnly (runEnd.ts), which the usage-limit hold reads at each look.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { Probed } from "../src/run/environment.ts"
import { noHolds, type StopReason, type Stops, stopFor } from "../src/run/holds.ts"
import { type Entry, emptyState, emptyTallies } from "../src/run/ledger.ts"
import { type LoopParts, make as makeLoop } from "../src/run/look.ts"
import { emptyQueue, type QueueState } from "../src/run/mergequeue.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { limitedOnly } from "../src/run/runEnd.ts"
import type { Wake } from "../src/run/wakes.ts"
import type { TicketId } from "../src/services/Beads.ts"

const entry = (ticket: TicketId, phase: TicketPhase): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase,
  since: 0,
  worker: null,
  row: null,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const request = (ticket: TicketId): AttentionRequest => ({
  id: `r-${ticket}`,
  ticket,
  kind: { _tag: "Permission", tool: "Bash", input: {}, suggestions: [], summary: "ls" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

const working = TicketPhase.Working()
const merged = TicketPhase.Done({ outcome: { _tag: "NoChange" } })

/** What the stub parts read, changed by the test between the loop's waits. */
interface World {
  tickets: ReadonlyArray<Entry>
  running: ReadonlyArray<TicketId>
  asking: ReadonlyArray<TicketId>
  stops: Stops
  usageHeld: boolean
  merges: QueueState
  limited: ReadonlyArray<TicketId>
  /** The reasons each look takes, in turn; none recorded once they run out. */
  woken: Array<ReadonlySet<Wake>>
  /** What the usage-limit hold's look gives. */
  limit: StopReason | null
  /** What each probe gives, in turn; Ends once they run out. */
  probes: Array<Probed>
  /** What each endAfter gives, in turn; true once they run out. */
  endAfters: Array<boolean>
  endAsked: boolean
  acted: number
  dashboard: boolean
}

const world = (over: Partial<World> = {}): World => ({
  tickets: [],
  running: [],
  asking: [],
  stops: [],
  usageHeld: false,
  merges: emptyQueue,
  limited: [],
  woken: [],
  limit: null,
  probes: [],
  endAfters: [],
  endAsked: false,
  acted: 0,
  dashboard: true,
  ...over,
})

/**
 * Runs the loop over stub parts reading `w` until it ends, `steps` changing `w` at each of its
 * waits, in turn: a wait with none left fails the test. Gives what the parts were asked to do.
 */
const runLoop = (w: World, steps: ReadonlyArray<(w: World) => void> = []) => {
  const calls: Array<string> = []
  const left = [...steps]
  const holdsNow = () => ({ ...noHolds, stops: w.stops })
  const parts: LoopParts = {
    fill: Effect.sync(() => calls.push("fill")),
    wakes: {
      take: Effect.sync(() => w.woken.shift() ?? new Set()),
      next: () =>
        Effect.suspend(() => {
          const step = left.shift()
          if (step === undefined) return Effect.die("the loop waited with nothing to wake it")
          calls.push("wait")
          step(w)
          return Effect.void
        }),
    },
    gate: Effect.sync(() => ({
      stop: w.stops[0] ?? null,
      usageHeld: w.usageHeld,
      ended: false,
      windingDown: false,
      limitReached: false,
    })),
    holds: {
      now: Effect.sync(holdsNow),
      currentStops: Effect.sync(() => w.stops),
      changeHolds: (change) =>
        Effect.sync(() => {
          const before = holdsNow()
          w.stops = change(before).stops
          return before
        }),
      stopped: (stop) =>
        Effect.sync(() => {
          calls.push(`stopped ${stop.why}`)
          w.stops = [...w.stops, stop]
        }),
    },
    ledger: {
      current: Effect.sync(() => ({
        ...emptyState,
        tickets: new Map(w.tickets.map((each) => [each.ticket, each])),
      })),
    },
    attention: { current: Effect.sync(() => w.asking.map(request)) },
    scheduler: {
      running: Effect.sync(() => new Set(w.running)),
      freed: Effect.never,
      interrupt: Effect.sync(() => calls.push("interrupt")),
    },
    queue: {
      state: Effect.sync(() => w.merges),
      hold: Effect.sync(() => calls.push("hold merges")),
    },
    triage: { pending: Effect.succeed(0) },
    usage: {
      limited: Effect.sync(() => new Set(w.limited)),
      handBacks: Effect.succeed(new Set()),
      look: (alone) =>
        Effect.sync(() => {
          calls.push(`usage look ${alone ? "alone" : "not alone"}`)
          return w.limit
        }),
    },
    commands: {
      acted: Effect.sync(() => w.acted),
      endAsked: Effect.sync(() => {
        const asked = w.endAsked
        w.endAsked = false
        return asked
      }),
      endAfter: (seen) =>
        Effect.sync(() => {
          calls.push(`end after ${seen}`)
          return w.endAfters.shift() ?? true
        }),
      askEnd: Effect.sync(() => {
        calls.push("ask end")
        w.endAsked = true
      }),
    },
    environment: {
      probe: (stops) =>
        Effect.sync(() => {
          calls.push(`probe ${stops.map((stop) => stop.why).join(" ") || "nothing"}`)
          return w.probes.shift() ?? Probed.Ends()
        }),
    },
    resuming: Effect.succeed(false),
    answering: Effect.succeed(false),
    showEndOfRun: (tickets) =>
      Effect.sync(() => calls.push(`box ${tickets === null ? "none" : tickets.join(" ")}`)),
    dashboard: w.dashboard,
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const loop = yield* makeLoop(parts)
      yield* loop.untilEnd
      return calls
    }),
  )
}

describe("the run's loop", () => {
  test("nothing left: it fills, probes the machine and ends", async () => {
    expect(await runLoop(world())).toEqual([
      "fill",
      "usage look alone",
      "box none",
      "probe nothing",
      "end after 0",
    ])
  })

  test("a busy look waits for the next wake and looks again", async () => {
    const calls = await runLoop(
      world({ tickets: [entry("t-1" as TicketId, working)], running: ["t-1" as TicketId] }),
      [
        (w) => {
          w.tickets = [entry("t-1" as TicketId, merged)]
          w.running = []
        },
      ],
    )
    expect(calls).toEqual([
      "fill",
      "usage look not alone",
      "box none",
      "wait",
      "fill",
      "usage look alone",
      "box none",
      "probe nothing",
      "end after 0",
    ])
  })

  test("a look woken only by an attention change skips the fill", async () => {
    const calls = await runLoop(world({ woken: [new Set(["attention"])] }))
    expect(calls).not.toContain("fill")
    expect(calls.at(-1)).toBe("end after 0")
  })

  test("with a worker waiting on you, a dashboard shows the box and waits for its q", async () => {
    const calls = await runLoop(
      world({
        tickets: [entry("t-1" as TicketId, working)],
        running: ["t-1" as TicketId],
        asking: ["t-1" as TicketId],
      }),
      [
        (w) => {
          w.endAsked = true
        },
      ],
    )
    expect(calls).toEqual([
      "fill",
      "usage look not alone",
      "box t-1",
      "wait",
      "fill",
      "usage look not alone",
      "box t-1",
      "probe nothing",
      "end after 0",
    ])
  })

  test("a command acted on meanwhile has it look again, the box's q still asked", async () => {
    const calls = await runLoop(
      world({
        tickets: [entry("t-1" as TicketId, working)],
        running: ["t-1" as TicketId],
        asking: ["t-1" as TicketId],
        endAsked: true,
        endAfters: [false],
      }),
    )
    expect(calls.filter((call) => call.startsWith("end after") || call === "ask end")).toEqual([
      "end after 0",
      "ask end",
      "end after 0",
    ])
    expect(calls).not.toContain("wait")
  })

  test("plain, a worker waiting on you holds the run only until a stop", async () => {
    const calls = await runLoop(
      world({
        tickets: [entry("t-1" as TicketId, working)],
        running: ["t-1" as TicketId],
        asking: ["t-1" as TicketId],
        dashboard: false,
      }),
      [
        (w) => {
          w.stops = [stopFor("BLOCKED", "t-1 waits on you", { ticket: "t-1" as TicketId })]
        },
      ],
    )
    expect(calls.slice(-3)).toEqual(["box none", "probe BLOCKED", "end after 0"])
    expect(calls.filter((call) => call === "wait")).toHaveLength(1)
  })

  test("with the usage-limit hold on and nothing else left, it waits for the reset", async () => {
    const calls = await runLoop(world({ usageHeld: true }), [
      (w) => {
        w.usageHeld = false
      },
    ])
    expect(calls.filter((call) => call === "wait")).toHaveLength(1)
    expect(calls.at(-1)).toBe("end after 0")
  })

  test("a usage limit it can't wait for stops everything and ends the run at once", async () => {
    const limit = stopFor("USAGE_LIMIT", "the limit resets too late")
    const calls = await runLoop(
      world({
        tickets: [entry("t-1" as TicketId, working)],
        running: ["t-1" as TicketId],
        limited: ["t-1" as TicketId],
        limit,
      }),
    )
    expect(calls).toEqual([
      "fill",
      "usage look alone",
      "interrupt",
      "hold merges",
      "stopped USAGE_LIMIT",
      "end after null",
    ])
  })

  test("the probe lifting the hold's stop looks again; one failing puts its stop in place", async () => {
    const failed = stopFor("ENVIRONMENT", "the probe failed")
    const lifted = world({
      stops: [stopFor("ENVIRONMENT", "two quick failures")],
      probes: [Probed.Resumed()],
    })
    const calls = await runLoop(lifted)
    expect(calls.filter((call) => call.startsWith("probe"))).toEqual([
      "probe ENVIRONMENT",
      "probe nothing",
    ])
    expect(lifted.stops).toEqual([])

    const swapped = world({
      stops: [stopFor("ENVIRONMENT", "two quick failures")],
      probes: [Probed.Failed({ stop: failed })],
    })
    await runLoop(swapped)
    expect(swapped.stops).toEqual([failed])
  })
})

describe("limitedOnly", () => {
  const read = (over: Partial<Parameters<typeof limitedOnly>[0]> = {}) =>
    limitedOnly({
      limited: new Set(),
      handBacks: new Set(),
      overLimit: new Set(),
      tickets: [],
      merges: emptyQueue,
      ...over,
    })

  test("workers at the limit alone, with nothing merging, are all that runs", () => {
    expect(
      read({ limited: new Set(["a" as TicketId]), tickets: [entry("a" as TicketId, working)] }),
    ).toBe(true)
  })

  test("another ticket running, or a merge under way or due, is not", () => {
    const tickets = [entry("a" as TicketId, working), entry("b" as TicketId, working)]
    expect(read({ limited: new Set(["a" as TicketId]), tickets })).toBe(false)
    expect(read({ merges: { ...emptyQueue, merging: "c" as TicketId } })).toBe(false)
    expect(read({ merges: { ...emptyQueue, waiting: ["c" as TicketId] } })).toBe(false)
  })

  test("a worker past its ticket limit is not waited for", () => {
    expect(
      read({ overLimit: new Set(["a" as TicketId]), tickets: [entry("a" as TicketId, working)] }),
    ).toBe(true)
  })

  test("a hand-back's worker at the limit waits for it only once its hand-back does", () => {
    const tickets = [
      entry("a" as TicketId, TicketPhase.Resolving({ attempt: 1 })),
      entry("b" as TicketId, TicketPhase.Fixing({ attempt: 1, afterResolution: false })),
    ]
    const merges = { ...emptyQueue, resolving: ["a" as TicketId, "b" as TicketId] }
    const limited = new Set(["a" as TicketId, "b" as TicketId])
    expect(
      read({ limited, tickets, merges, handBacks: new Set(["a" as TicketId, "b" as TicketId]) }),
    ).toBe(true)
    expect(read({ limited, tickets, merges, handBacks: new Set(["a" as TicketId]) })).toBe(false)
  })
})
