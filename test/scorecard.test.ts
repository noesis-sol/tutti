// Scorecards (src/services/scorecard.ts): every ticket_end the EventStream writes is followed by its
// ticket's score, computed from the records before it; property tests over arbitrary event
// sequences check each part against the records counted directly, the ranking and the report's
// table, and the readers of a worker's and the verifier's text (a revert's subject, a verdict).
import { describe, expect, test } from "bun:test"
import type { HookInput } from "@anthropic-ai/claude-agent-sdk"
import { Arbitrary, Effect, Result } from "effect"
import fc from "fast-check"
import { VerifierEvent, verdictOf, verifierEvent } from "../src/agent/hooks.ts"
import type { DependencyType, Issue, TicketId } from "../src/services/Beads.ts"
import { EventStream } from "../src/services/EventStream.ts"
import { decodeLine, type Event, type EventRecord, kinds } from "../src/services/events.ts"
import { addRecord, noFigures, scoreAfter, scoresParts } from "../src/services/figures.ts"
import type { Sha } from "../src/services/Git.ts"
import {
  badness,
  dependentFollowUps,
  followUpsOf,
  noScoring,
  ranked,
  revertsIn,
  type Score,
  scorecardsEvidence,
  scorecardsReport,
  scoreOf,
  scoreStep,
  shownEach,
  sizeClass,
} from "../src/services/scorecard.ts"
import { Captured, layer as capturedLayer } from "../src/testing/EventStream.ts"

const tickets = ["t-1", "t-2", "t-3"] as const
const ticket = fc.constantFrom(...tickets)
const outcomes = ["merged", "no_change", "set_aside", "needs_you", "stopped", "queued"] as const

type TicketEnd = Extract<Event, { readonly kind: "ticket_end" }>

const ticketEnd = (t: string, fields: Partial<TicketEnd> = {}): TicketEnd => ({
  kind: "ticket_end",
  ticket: t,
  outcome: "merged",
  phase: "Done",
  seconds: 60,
  turns: 3,
  hand_backs: { resolve: 0, fix: 0 },
  ...fields,
})

/** The records that go into a scorecard, and some that don't, about the three tickets. */
const event: fc.Arbitrary<Event> = fc.oneof(
  ticket.map((t): Event => ({ kind: "phase", ticket: t, to: "Working", cause: "Dispatched" })),
  fc.tuple(ticket, fc.nat(40)).map(
    ([t, files]): Event => ({
      kind: "dispatch",
      ticket: t,
      title: "T",
      n: 1,
      queued: 0,
      footprint: files,
      text: "x",
    }),
  ),
  fc
    .tuple(
      ticket,
      fc.constantFrom("began", "ended", "unverified" as const),
      fc.option(fc.boolean()),
    )
    .map(
      ([t, detail, pass]): Event => ({
        kind: "verifier",
        ticket: t,
        detail,
        ...(detail !== "ended" || pass === null ? {} : { verdict: pass ? "pass" : "fail" }),
      }),
    ),
  fc
    .tuple(
      fc.option(ticket),
      fc.constantFrom("merge", "recheck", "fix", "full", "setup", "early" as const),
      fc.constantFrom("passed", "failed", "timed_out", "not_run" as const),
    )
    .map(
      ([t, suite, result]): Event => ({
        kind: "check",
        suite,
        ...(t === null ? {} : { ticket: t }),
        command: "scripts/check.sh",
        seconds: 1,
        result,
      }),
    ),
  fc
    .tuple(fc.option(ticket), fc.constantFrom("  FLAKY: a test", "  CHECKS_FAILED: x", "FLAKY: y"))
    .map(([t, text]): Event => ({ kind: "warn", ...(t === null ? {} : { ticket: t }), text })),
  ticket.map(
    (t): Event => ({ kind: "denied", ticket: t, tool: "Bash", reason_type: "rule", reason: "r" }),
  ),
  fc
    .tuple(
      ticket,
      fc.constantFrom<"allow" | "deny" | "allow_run" | ReadonlyArray<string>>(
        "allow",
        "deny",
        "allow_run",
        ["A"],
      ),
    )
    .map(
      ([t, answer]): Event => ({
        kind: "attention_answered",
        ticket: t,
        request: "r",
        answer,
        after_ms: 1,
      }),
    ),
  ticket.map((t): Event => ({ kind: "asked", ticket: t, title: "T", detail: "q-1", text: "x" })),
  fc.tuple(ticket, fc.constantFrom("permission", "question", "elicitation" as const)).map(
    ([t, type]): Event => ({
      kind: "attention",
      ticket: t,
      request: "r",
      type,
      default_to_no: false,
    }),
  ),
  fc
    .tuple(
      ticket,
      fc.constantFrom(...outcomes),
      fc.nat(5),
      fc.nat(5),
      fc.option(fc.integer({ min: 0, max: 500 })),
      fc.integer({ min: 0, max: 3000 }),
    )
    .map(([t, outcome, resolve, fix, cents, working]) =>
      ticketEnd(t, {
        outcome,
        phase: outcome === "merged" || outcome === "no_change" ? "Done" : "Review",
        hand_backs: { resolve, fix },
        phases: { working, resolving: resolve * 10, fixing: fix * 10 },
        ...(cents === null ? {} : { cost_usd: cents / 100 }),
      }),
    ),
  fc
    .tuple(ticket, ticket)
    .map(([t, other]): Event => ({ kind: "score_update", ticket: t, follow_up: `${other}-f` })),
)

/** The records the test EventStream captures as `events` are emitted, in order. */
const streamed = (events: ReadonlyArray<Event>): ReadonlyArray<EventRecord> =>
  Effect.runSync(
    Effect.gen(function* () {
      const stream = yield* EventStream
      for (const each of events) yield* stream.emit(each)
      return yield* (yield* Captured).records
    }).pipe(Effect.provide(capturedLayer())),
  )

/** `record` without its head, as it was emitted. */
const bare = (record: EventRecord): Event => {
  const { v: _v, time: _time, run: _run, ...rest } = record
  return rest as Event
}

const about = (events: ReadonlyArray<Event>, t: string) =>
  events.filter((each) => "ticket" in each && each.ticket === t)

describe("a ticket's scorecard", () => {
  test("follows each of its ticket_end records, and every score follows one", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), (events) => {
        const records = streamed(events)
        const ends = events.filter((each) => each.kind === "ticket_end").length
        expect(records).toHaveLength(events.length + ends)
        records.forEach((record, i) => {
          if (record.kind === "ticket_end") {
            const next = records[i + 1]
            expect(next?.kind).toBe("score")
            expect(next).toMatchObject({
              ticket: record.ticket,
              outcome: record.outcome,
              phase: record.phase,
              hand_backs: record.hand_backs ?? { resolve: 0, fix: 0 },
              seconds: record.seconds,
              working: record.phases?.working ?? 0,
            })
          }
          if (record.kind === "score") expect(records[i - 1]?.kind).toBe("ticket_end")
        })
      }),
    )
  })

  test("counts what the records before it say of its ticket", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), (events) => {
        const records = streamed(events).map(bare)
        records.forEach((record, i) => {
          if (record.kind !== "score") return
          const before = about(records.slice(0, i - 1), record.ticket)
          const count = (test: (each: Event) => boolean) => before.filter(test).length
          const verifier = before.flatMap((each) => (each.kind === "verifier" ? [each] : []))
          const rounds = count((each) => each.kind === "verifier" && each.detail === "began")
          const verdicts = verifier.flatMap((each) =>
            each.detail === "ended" && each.verdict !== undefined ? [each.verdict] : [],
          )
          const lastBegan = verifier.map((each) => each.detail).lastIndexOf("began")
          const unverified = verifier
            .slice(lastBegan + 1)
            .some((each) => each.detail === "unverified")
          const ofSuites = (result: string) =>
            count(
              (each) =>
                each.kind === "check" &&
                ["merge", "recheck", "fix"].includes(each.suite) &&
                each.result === result,
            )
          const last = verdicts.at(-1)
          expect<unknown>(record.verifier).toEqual({
            rounds,
            passed: verdicts.filter((each) => each === "pass").length,
            failed: verdicts.filter((each) => each === "fail").length,
            ...(last === undefined ? {} : { last }),
            ...(rounds === 0 ? {} : { last_fix_verified: !unverified }),
          })
          expect(record.checks).toEqual({
            failed: ofSuites("failed"),
            timed_out: ofSuites("timed_out"),
          })
          expect(record.flaky).toBe(
            count((each) => each.kind === "warn" && /^\s*FLAKY: /.test(each.text)),
          )
          expect(record.denied).toBe(
            count(
              (each) =>
                each.kind === "denied" ||
                (each.kind === "attention_answered" && each.answer === "deny"),
            ),
          )
          expect(record.asked).toBe(
            count(
              (each) =>
                each.kind === "asked" || (each.kind === "attention" && each.type === "question"),
            ),
          )
          const dispatched = before.flatMap((each) => (each.kind === "dispatch" ? [each] : []))
          expect(record.size).toBe(dispatched.at(-1)?.footprint)
          const followUps = [
            ...new Set(
              before.flatMap((each) =>
                each.kind === "score_update" && each.follow_up !== undefined
                  ? [each.follow_up]
                  : [],
              ),
            ),
          ]
          expect(record.follow_ups).toEqual(followUps.length === 0 ? undefined : followUps)
        })
      }),
    )
  })

  test("sets its working time and cost beside the latest scores of the others of its size", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), (events) => {
        const records = streamed(events).map(bare)
        records.forEach((record, i) => {
          if (record.kind !== "score") return
          const latest = new Map<string, Score>()
          for (const each of records.slice(0, i))
            if (each.kind === "score") latest.set(each.ticket, each)
          latest.delete(record.ticket)
          const peers = [...latest.values()].filter(
            (each) => sizeClass(each.size) === sizeClass(record.size),
          )
          if (peers.length === 0) {
            expect(record.median).toBeUndefined()
            return
          }
          expect(record.median?.tickets).toBe(peers.length)
          const working = peers.map((each) => each.working)
          expect(record.median?.working).toBeGreaterThanOrEqual(Math.min(...working) - 0.05)
          expect(record.median?.working).toBeLessThanOrEqual(Math.max(...working) + 0.05)
        })
      }),
    )
  })

  test("is the same for the same records, whatever else the stream has", () => {
    // Records of every kind, as their schemas allow them, mixed in among those that score.
    const any = Effect.runSync(
      Effect.forEach(Object.values(kinds), (schema) =>
        Arbitrary.sampleEffect(Arbitrary.schema(schema), { count: 8, seed: "scorecard" }),
      ),
    ).flat() as ReadonlyArray<EventRecord>
    fc.assert(
      fc.property(
        fc.array(fc.oneof(event, fc.constantFrom(...any).map(bare)), { maxLength: 60 }),
        (events) => {
          const once = streamed(events)
          for (const record of once) {
            if (record.kind === "score") {
              expect(Result.isSuccess(decodeLine(JSON.stringify(record)))).toBe(true)
            }
          }
          expect(streamed(events).map(bare)).toEqual(once.map(bare))
        },
      ),
    )
  })

  test("a record that scores nothing leaves the figures as they were", () => {
    const figures = addRecord(noFigures, { kind: "done", text: "READY_EMPTY" }, 0)
    expect(figures).toBe(noFigures)
    expect(scoreAfter(figures, { kind: "done", text: "READY_EMPTY" })).toBeUndefined()
  })

  test("a fix tutti found unverified stays so until a round begins after it", () => {
    const steps: ReadonlyArray<Event> = [
      { kind: "verifier", ticket: "t-1", detail: "began" },
      { kind: "verifier", ticket: "t-1", detail: "ended", verdict: "fail" },
      { kind: "verifier", ticket: "t-1", detail: "unverified", commit: "4d5e6f7a8b" },
    ]
    const scoring = steps.reduce((s, each) => scoreStep(s, each, 0), noScoring)
    expect(scoreOf(scoring, ticketEnd("t-1")).verifier).toEqual({
      rounds: 1,
      passed: 0,
      failed: 1,
      last: "fail",
      last_fix_verified: false,
    })
    const again = scoreStep(scoring, { kind: "verifier", ticket: "t-1", detail: "began" }, 0)
    expect(scoreOf(again, ticketEnd("t-1")).verifier.last_fix_verified).toBe(true)
    expect(scoreOf(noScoring, ticketEnd("t-1")).verifier).toEqual({
      rounds: 0,
      passed: 0,
      failed: 0,
    })
  })

  test("a score_update after a ticket's score names its follow-up and revert on it", () => {
    const end = ticketEnd("t-1")
    let scoring = scoreStep(noScoring, end, 0)
    scoring = scoreStep(scoring, scoreOf(scoring, end), 0)
    scoring = scoreStep(scoring, { kind: "score_update", ticket: "t-1", follow_up: "t-9" }, 0)
    scoring = scoreStep(scoring, { kind: "score_update", ticket: "t-1", follow_up: "t-9" }, 0)
    scoring = scoreStep(
      scoring,
      { kind: "score_update", ticket: "t-1", revert: "abcdef1234", by: "t-4" },
      0,
    )
    expect(scoring.scores.get("t-1")).toMatchObject({
      follow_ups: ["t-9"],
      reverts: ["abcdef1234"],
    })
  })

  test("sizes fall in classes of 0–1, 2–3, 4–7, 8–15 and 16 or more files", () => {
    expect([0, 1, 2, 3, 4, 7, 8, 15, 16, 400].map(sizeClass)).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4, 4,
    ])
    expect(sizeClass(undefined)).toBe(-1)
  })
})

/** The scores the stream gives `events`, the latest of each ticket. */
const scoresOf = (events: ReadonlyArray<Event>): ReadonlyArray<Score> => [
  ...events
    .reduce((figures, each, i) => {
      const added = addRecord(figures, each, i)
      const score = scoreAfter(added, each)
      return score === undefined ? added : addRecord(added, score, i)
    }, noFigures)
    .scoring.scores.values(),
]

/** Whether `a` is no better than `b` by the ranking's parts, compared in their order. */
const noBetter = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

/** The cells of a Markdown table's row: split at pipes no backslash escapes. */
const cellsOf = (row: string): ReadonlyArray<string> => row.split(/(?<!\\)\|/).slice(1, -1)

describe("the report's scorecards", () => {
  test("rank every ticket once, worst first by their parts in order", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), (events) => {
        const scores = scoresOf(events)
        const order = ranked(scores)
        expect(order.map((each) => each.score.ticket).sort()).toEqual(
          scores.map((each) => each.ticket).sort(),
        )
        for (let i = 1; i < order.length; i++) {
          const before = order[i - 1]
          const after = order[i]
          if (before === undefined || after === undefined) continue
          expect(
            noBetter(badness(before.score, before.median), badness(after.score, after.median)),
          ).toBe(true)
        }
      }),
    )
  })

  test("a revert ranks worst, then an outcome set aside, then hand-backs", () => {
    const score = (t: string, fields: Partial<Score>): Score => ({
      ...scoreOf(noScoring, ticketEnd(t)),
      ...fields,
    })
    const order = ranked([
      score("a-1", {}),
      score("a-2", { hand_backs: { resolve: 1, fix: 0 } }),
      score("a-3", { outcome: "set_aside", phase: "Review", why: "CHECKS_FAILED" }),
      score("a-4", { reverts: ["abcdef1"] }),
    ]).map((each) => each.score.ticket)
    expect(order).toEqual(["a-4", "a-3", "a-2", "a-1"])
  })

  test("a run with no more than twice shownEach tickets shows them all, worst first", () => {
    const scores = scoresOf([
      ticketEnd("t-1", { cost_usd: 1, phases: { working: 600 } }),
      ticketEnd("t-2", {
        outcome: "set_aside",
        phase: "Review",
        why: "CHECKS_FAILED",
        hand_backs: { resolve: 0, fix: 2 },
        phases: { working: 1200, fixing: 300 },
        cost_usd: 3,
      }),
    ])
    const report = scorecardsReport(scores)
    expect(report).toStartWith("\n## Scorecards\n\n")
    expect(report).not.toContain("### Worst")
    const rows = report.split("\n").filter((each) => each.startsWith("| t-"))
    expect(rows).toEqual([
      "| t-2 | set aside (CHECKS\\_FAILED) | none | 0 resolve, 2 fix (5m) | 0 | 0 | 0 | 20m (1.3×) | $3.00 (1.5×) |  |",
      "| t-1 | merged | none | 0 | 0 | 0 | 0 | 10m (0.7×) | $1.00 (0.5×) |  |",
    ])
    expect(scorecardsReport([])).toBe("")
  })

  test("a larger run shows its worst and best shownEach", () => {
    const ends = Array.from({ length: 2 * shownEach + 3 }, (_, i) =>
      ticketEnd(`t-${i + 10}`, { hand_backs: { resolve: 0, fix: i } }),
    )
    const report = scorecardsReport(scoresOf(ends))
    const [, worst = "", best = ""] = report.split(/### (?:Worst|Best)/)
    const ids = (part: string) => [...part.matchAll(/^\| (t-\d+) \|/gm)].map((m) => m[1])
    expect(ids(worst)).toEqual(["t-22", "t-21", "t-20", "t-19", "t-18"])
    expect(ids(best)).toEqual(["t-10", "t-11", "t-12", "t-13", "t-14"])
  })

  test("the table keeps its columns whatever a ticket's ID or why says", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.string({ maxLength: 60 }), (id, why) => {
        const report = scorecardsReport(
          scoresOf([ticketEnd(id, { outcome: "stopped", phase: "Stopped", why })]),
        )
        const rows = report.split("\n").filter((each) => each.startsWith("|"))
        expect(rows).toHaveLength(3)
        for (const row of rows) expect(cellsOf(row)).toHaveLength(10)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the property is their absence.
        expect(report).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
      }),
    )
  })

  test("the reviewer's lines give every ticket, best first, the worst last", () => {
    const scores = scoresOf([
      ticketEnd("t-1"),
      ticketEnd("t-2", { outcome: "set_aside", phase: "Review", why: "CHECKS_FAILED" }),
    ])
    const lines = scorecardsEvidence(scores)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toStartWith("t-1: merged; verifier none; hand-backs 0;")
    expect(lines[1]).toStartWith("t-2: set aside (CHECKS_FAILED);")
    expect(lines[1]).toContain("; footprint unknown")
  })
})

const issueOf = (
  id: string,
  dependencies: ReadonlyArray<{ readonly id: string; readonly type: DependencyType }>,
  createdAt: string,
): Issue => ({
  id: id as TicketId,
  title: id,
  description: "",
  design: "",
  acceptance: "",
  notes: "",
  status: "open",
  type: "task",
  assignee: "",
  labels: [],
  dependencies: dependencies.map((each) => ({ id: each.id as TicketId, type: each.type })),
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt,
  closeReason: "",
})

describe("follow-ups", () => {
  const took = Date.parse("2026-11-03T10:00:00Z")
  const scoring = scoreStep(
    noScoring,
    { kind: "phase", ticket: "t-1", to: "Working", cause: "Dispatched" },
    took,
  )

  test("a ticket discovered from another is a follow-up of it, whenever it was filed", () => {
    const issue = issueOf("t-2", [{ id: "t-1", type: "discovered-from" }], "2026-01-01T00:00:00Z")
    expect(followUpsOf(issue, scoring)).toEqual(["t-1"])
    expect(followUpsOf(issue, noScoring)).toEqual(["t-1"])
  })

  test("one blocked by another is, only when filed after the run took that one up", () => {
    const after = issueOf("t-2", [{ id: "t-1", type: "blocks" }], "2026-11-03T10:05:00Z")
    const before = issueOf("t-2", [{ id: "t-1", type: "blocks" }], "2026-11-03T09:00:00Z")
    expect(followUpsOf(after, scoring)).toEqual(["t-1"])
    expect(followUpsOf(before, scoring)).toEqual([])
    expect(followUpsOf(after, noScoring)).toEqual([])
  })

  test("a parent, a related ticket, itself or one already named is none", () => {
    const issue = issueOf(
      "t-2",
      [
        { id: "t-1", type: "parent-child" },
        { id: "t-3", type: "related" },
        { id: "t-2", type: "discovered-from" },
      ],
      "2026-11-03T10:05:00Z",
    )
    expect(followUpsOf(issue, scoring)).toEqual([])
    const named = scoreStep(scoring, { kind: "score_update", ticket: "t-1", follow_up: "t-2" }, 0)
    const again = issueOf("t-2", [{ id: "t-1", type: "discovered-from" }], "2026-11-03T10:05:00Z")
    expect(followUpsOf(again, named)).toEqual([])
  })
})

describe("reverts", () => {
  const commit = (subject: string) => ({ hash: "abcdef1234" as Sha, subject })

  test("a commit whose subject starts with Revert names the tickets in its parentheses", () => {
    expect(revertsIn([commit('Revert "Add the stream (tutti-5fs7.1)"')], "tutti-9")).toEqual([
      { ticket: "tutti-5fs7.1", commit: "abcdef1234" },
    ])
    expect(
      revertsIn([commit('Revert "Two (a-1, a-2)"')], "a-3").map((each) => each.ticket),
    ).toEqual(["a-1", "a-2"])
  })

  test("none for another commit, the merging ticket itself, or words that aren't an ID", () => {
    expect(revertsIn([commit("Add the stream (tutti-5fs7.1)")], "tutti-9")).toEqual([])
    expect(revertsIn([commit('Revert "Mine (tutti-9)"')], "tutti-9")).toEqual([])
    expect(revertsIn([commit('Revert "Oops (see the docs)"')], "tutti-9")).toEqual([])
  })

  test("reads any subject a worker wrote: only revert subjects, only IDs they name", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 80 }), { maxLength: 5 }),
        ticket,
        (subjects, by) => {
          const found = revertsIn(subjects.map(commit), by)
          for (const each of found) {
            expect(each.ticket).not.toBe(by)
            expect(subjects.some((s) => /^\s*Revert\b/.test(s) && s.includes(each.ticket))).toBe(
              true,
            )
            expect(each.ticket).toMatch(/^[A-Za-z0-9_]+(-[A-Za-z0-9_]+)+(\.[0-9]+)*$/)
          }
        },
      ),
    )
  })
})

describe("the verifier's verdict", () => {
  const answer = (text: string) => ({
    agentId: "a",
    content: [{ type: "text", text }],
    totalToolUseCount: 3,
  })

  test("is the PASS or FAIL its answer starts with", () => {
    expect(verdictOf(answer("PASS\n\nNo gaps."))).toBe("pass")
    expect(verdictOf(answer("**FAIL**: two gaps"))).toBe("fail")
    expect(verdictOf(answer("## PASS"))).toBe("pass")
    expect(verdictOf("FAIL - src/a.ts:3")).toBe("fail")
  })

  test("is on the round's end, as the verifier's PostToolUse gives its answer", () => {
    const hook = (event: string, response?: unknown) =>
      ({
        hook_event_name: event,
        session_id: "s",
        transcript_path: "/t",
        cwd: "/w",
        tool_name: "Agent",
        tool_input: { subagent_type: "verifier", prompt: "Verify t-1" },
        tool_use_id: "toolu_1",
        ...(response === undefined ? {} : { tool_response: response }),
        ...(event === "PostToolUseFailure" ? { error: "interrupted" } : {}),
      }) as HookInput
    expect(verifierEvent(hook("PostToolUse", answer("FAIL\n- src/a.ts:3")))).toEqual(
      VerifierEvent.Ended({ call: "toolu_1", verdict: "fail" }),
    )
    expect(verifierEvent(hook("PostToolUse", answer("Looks fine")))).toEqual(
      VerifierEvent.Ended({ call: "toolu_1" }),
    )
    expect(verifierEvent(hook("PostToolUseFailure"))).toEqual(
      VerifierEvent.Ended({ call: "toolu_1" }),
    )
  })

  test("is none for an answer starting otherwise, or no answer", () => {
    expect(verdictOf(answer("PASSING all checks"))).toBeUndefined()
    expect(verdictOf(answer("The verdict: PASS"))).toBeUndefined()
    expect(verdictOf({ content: [] })).toBeUndefined()
    expect(verdictOf(undefined)).toBeUndefined()
    expect(verdictOf(42)).toBeUndefined()
  })

  test("reads whatever the call gives back, and only its first word", () => {
    fc.assert(
      fc.property(fc.anything(), (response) => {
        expect(["pass", "fail", undefined]).toContain(verdictOf(response))
      }),
    )
    fc.assert(
      fc.property(
        fc.constantFrom("PASS", "FAIL"),
        fc.constantFrom(" ", "\n", ": ", " — "),
        fc.string({ maxLength: 200 }),
        (word, after, rest) => {
          expect(verdictOf(answer(`${word}${after}${rest}`))).toBe(
            word === "PASS" ? "pass" : "fail",
          )
        },
      ),
    )
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        fc.pre(!/PASS|FAIL/.test(text))
        expect(verdictOf(answer(text))).toBeUndefined()
      }),
    )
  })
})

describe("follow-ups the run reads as it ends", () => {
  const took = Date.parse("2026-11-03T10:00:00Z")
  const scoring = scoreStep(
    noScoring,
    { kind: "phase", ticket: "t-1", to: "Working", cause: "Dispatched" },
    took,
  )
  const dependent = (
    id: string,
    type: DependencyType,
    createdAt: string,
    labels: string[] = [],
  ) => ({
    id: id as TicketId,
    type,
    issue: { ...issueOf(id, [], createdAt), labels },
  })
  const scored = (dependents: Issue["dependents"]): Issue => ({
    ...issueOf("t-1", [], "2026-11-01T00:00:00Z"),
    ...(dependents === undefined ? {} : { dependents }),
  })

  test("are those it blocks filed after the run took it up, and those discovered from it", () => {
    expect(
      dependentFollowUps(
        scored([
          dependent("t-2", "blocks", "2026-11-03T10:05:00Z"),
          dependent("t-3", "blocks", "2026-11-02T10:05:00Z"),
          dependent("t-4", "discovered-from", "2026-11-02T10:05:00Z"),
          dependent("t-5", "related", "2026-11-03T10:05:00Z"),
          dependent("t-6", "parent-child", "2026-11-03T10:05:00Z"),
        ]),
        scoring,
      ),
    ).toEqual(["t-2", "t-4"])
  })

  test("leave out a question for the maintainer, one named already, and a ticket with none", () => {
    const named = scoreStep(scoring, { kind: "score_update", ticket: "t-1", follow_up: "t-2" }, 0)
    expect(
      dependentFollowUps(
        scored([
          dependent("t-2", "blocks", "2026-11-03T10:05:00Z"),
          dependent("q-1", "blocks", "2026-11-03T10:05:00Z", ["human"]),
        ]),
        named,
      ),
    ).toEqual([])
    expect(dependentFollowUps(scored(undefined), scoring)).toEqual([])
  })
})

describe("the summary's Scores line", () => {
  const scoring = (events: ReadonlyArray<Event>) =>
    events.reduce((figures, each, i) => {
      const added = addRecord(figures, each, i)
      const score = scoreAfter(added, each)
      return score === undefined ? added : addRecord(added, score, i)
    }, noFigures).scoring

  test("says how many merged first time, what failed or came later, and the worst", () => {
    const parts = scoresParts(
      scoring([
        { kind: "verifier", ticket: "t-2", detail: "began" },
        { kind: "verifier", ticket: "t-2", detail: "ended", verdict: "fail" },
        ticketEnd("t-1"),
        ticketEnd("t-2", { hand_backs: { resolve: 0, fix: 1 } }),
        { kind: "score_update", ticket: "t-1", follow_up: "t-9" },
      ]),
    ).map((part) => part.text)
    expect(parts).toEqual([
      "1 of 2 merged first time",
      "1 verifier FAIL",
      "1 follow-up",
      "worst t-2",
    ])
  })

  test("names no worst when nothing is against any, and is left out with no ticket ended", () => {
    expect(scoresParts(scoring([ticketEnd("t-1"), ticketEnd("t-2")])).map((p) => p.text)).toEqual([
      "2 of 2 merged first time",
    ])
    expect(scoresParts(noScoring)).toEqual([])
  })
})
