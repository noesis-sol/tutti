import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Arbitrary, Effect, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import {
  decodeLine,
  type Event,
  type EventRecord,
  encodeLine,
  type Kind,
  kinds,
} from "../src/run/events.ts"
import { EventStream, eventsFile, notRecorded } from "../src/run/eventstream.ts"
import { timestamp } from "../src/run/localTime.ts"
import { Captured, layer as capturedLayer, testRun } from "../src/testing/EventStream.ts"

const run = "2026-10-02T09:12:03.98+02:00"
const head = { v: 1, time: "2026-10-02T09:12:04.51+02:00", run } as const

// One record of each kind, with its optional fields where it has them.
const examples: { readonly [K in Kind]: ReadonlyArray<Extract<EventRecord, { kind: K }>> } = {
  start: [
    {
      ...head,
      kind: "start",
      version: "0.1.0",
      repo: "/Users/me/kinieta",
      branch: "main",
      scope: "kinieta-kco",
      feature: "Open the property model",
      concurrency: 3,
      billing: "subscription",
      permission_mode: "auto",
    },
    {
      ...head,
      kind: "start",
      version: "0.1.0",
      repo: "/r",
      branch: "main",
      concurrency: 1,
      billing: "api",
      permission_mode: "default",
    },
  ],
  info: [{ ...head, kind: "info", text: "START" }],
  dispatch: [
    {
      ...head,
      kind: "dispatch",
      ticket: "kinieta-kco",
      title: "Open the property model",
      n: 1,
      limit: 40,
      queued: 12,
      held: 4,
      held_by: { overlap: 3, merge: 1 },
      unclosed: 31,
      solo: { ticket: "kinieta-q1z", next: true },
      text: "[1/40] kinieta-kco dispatching: Open the property model",
    },
  ],
  queue: [
    { ...head, kind: "queue", queued: 0 },
    { ...head, kind: "queue", queued: 2, machine_full: true },
  ],
  closed: [
    {
      ...head,
      kind: "closed",
      ticket: "kinieta-kco",
      title: "Open the property model",
      detail: "ffd6ce4 merged into main",
      text: "  kinieta-kco closed",
    },
  ],
  deferred: [
    { ...head, kind: "deferred", ticket: "a-1", title: "T", detail: "by the worker", text: "x" },
  ],
  asked: [{ ...head, kind: "asked", ticket: "a-1", title: "T", detail: "a-2: Which?", text: "x" }],
  answered: [{ ...head, kind: "answered", ticket: "a-1", title: "T", text: "x" }],
  waits: [{ ...head, kind: "waits", ticket: "a-1", title: "T", detail: "a-2, a-3", text: "x" }],
  reopened: [
    {
      ...head,
      kind: "reopened",
      ticket: "a-1",
      detail: "the run held for the environment",
      text: "x",
    },
  ],
  triage: [
    {
      ...head,
      kind: "triage",
      ticket: "a-1",
      title: "flaky",
      detail: "environment · high",
      text: "x",
    },
  ],
  warn: [
    {
      ...head,
      kind: "warn",
      ticket: "a-1",
      aside: true,
      detail: "checks failed",
      blocked: "merge conflict in a.go",
      text: "  CHECKS_FAILED: a-1",
    },
    { ...head, kind: "warn", text: "LIKELY_CONFLICT" },
  ],
  hold: [
    { ...head, kind: "hold", text: "HOLD: USAGE_LIMIT (five-hour)", lifted: true },
    {
      ...head,
      kind: "hold",
      ticket: "a-1",
      blocked: "main checkout dirty",
      text: "HOLD: DIRTY_TREE",
    },
  ],
  drain: [{ ...head, kind: "drain", text: "DRAIN" }],
  resume: [{ ...head, kind: "resume", text: "RESUME" }],
  probed: [{ ...head, kind: "probed", text: "PROBE_OK" }],
  shared_machine: [
    {
      ...head,
      kind: "shared_machine",
      shared: 1,
      text: "SHARED_MACHINE: another orchestra run is going in /work/other with 2 workers; their checks slow each other down",
    },
    {
      ...head,
      kind: "shared_machine",
      shared: 0,
      text: "  the other orchestra run in /work/other has ended",
    },
  ],
  machine_hold: [{ ...head, kind: "machine_hold", text: "HOLD: MACHINE: …" }],
  stop: [
    {
      ...head,
      kind: "stop",
      detail: "AGENT_FAILED",
      ticket: "a-1",
      blocked: "b",
      text: "AGENT_FAILED: …",
    },
  ],
  done: [{ ...head, kind: "done", text: "READY_EMPTY after 12 tickets" }],
  full_check: [
    {
      ...head,
      kind: "full_check",
      detail: "failed",
      suite: "e2e",
      output: "/r/.tutti/run/check-full.log",
      ticket: "a-9",
      text: "  FULL_CHECK_FAILED",
    },
    { ...head, kind: "full_check", detail: "not run", text: "x" },
  ],
  end: [
    { ...head, kind: "end", code: 0 },
    {
      ...head,
      kind: "end",
      code: 0,
      tokens: { "claude-opus-5-5": { input: 1, output: 2, cache_write: 3, cache_read: 4 } },
      cost_usd: 1.25,
      organs: { calls: 3, turns: 5, cost_usd: 0.0456 },
    },
  ],
  check: [
    {
      ...head,
      kind: "check",
      suite: "merge",
      ticket: "a-1",
      command: "scripts/check-fast.sh",
      seconds: 133.2,
      result: "failed",
      output: "/w/.tutti/run/check.log",
      train: true,
    },
    { ...head, kind: "check", suite: "full", command: "c", seconds: 0, result: "passed" },
  ],
  turn: [
    {
      ...head,
      kind: "turn",
      ticket: "a-1",
      session: "s-1",
      subtype: "error_during_execution",
      is_error: true,
      cost_usd: 0.0123,
      turns: 4,
      duration_ms: 5000,
      api_ms: 4000,
      tokens: { "claude-opus-5-5": { input: 1, output: 2, cache_write: 3, cache_read: 4 } },
    },
    {
      ...head,
      kind: "turn",
      ticket: "a-1",
      session: "s-1",
      subtype: "success",
      cost_usd: 0,
      turns: 1,
      duration_ms: 0,
      api_ms: 0,
    },
  ],
  organ: [
    {
      ...head,
      kind: "organ",
      organ: "triage",
      ticket: "a-1",
      outcome: "answered",
      cost_usd: 0.0123,
      turns: 1,
      duration_ms: 4200,
      session: "s-2",
    },
    { ...head, kind: "organ", organ: "scout", outcome: "no_result", duration_ms: 180000 },
  ],
  ticket_end: [
    {
      ...head,
      kind: "ticket_end",
      ticket: "a-1",
      outcome: "merged",
      phase: "Done",
      seconds: 1247.4,
      turns: 31,
      phases: { working: 812.4, waiting: 41, merging: 133.2, fixing: 260.8 },
      hand_backs: { resolve: 0, fix: 1 },
      carried: true,
      tokens: { "claude-opus-5-5": { input: 1, output: 2, cache_write: 3, cache_read: 4 } },
      cost_usd: 2.5,
    },
    {
      ...head,
      kind: "ticket_end",
      ticket: "a-2",
      outcome: "needs_you",
      phase: "Asked",
      why: "a-9",
      seconds: 0,
      turns: 0,
    },
  ],
  phase: [
    { ...head, kind: "phase", ticket: "a-1", to: "Queued", cause: "ready" },
    {
      ...head,
      kind: "phase",
      ticket: "a-1",
      from: "Working",
      to: "ToMerge",
      cause: "settled",
      place: 2,
    },
    {
      ...head,
      kind: "phase",
      ticket: "a-1",
      from: "ToMerge",
      to: "Merging",
      cause: "turn",
      step: "fast-forward",
    },
    {
      ...head,
      kind: "phase",
      ticket: "a-1",
      from: "Merging",
      to: "Fixing",
      cause: "check",
      attempt: 1,
    },
    {
      ...head,
      kind: "phase",
      ticket: "a-1",
      from: "Merging",
      to: "Blocked",
      cause: "c",
      why: "GIT_FAILED",
      text: "x",
    },
  ],
  attention: [
    {
      ...head,
      kind: "attention",
      ticket: "a-1",
      request: "r-1",
      type: "permission",
      tool: "Bash",
      summary: "rm -rf build",
      default_to_no: true,
    },
    {
      ...head,
      kind: "attention",
      ticket: "a-1",
      request: "r-2",
      type: "question",
      questions: [
        {
          question: "Which?",
          header: "Pick",
          options: [{ label: "A", description: "the first" }, { label: "B" }],
          multi_select: false,
        },
      ],
      default_to_no: false,
    },
    {
      ...head,
      kind: "attention",
      ticket: "a-1",
      request: "r-3",
      type: "elicitation",
      default_to_no: false,
    },
  ],
  attention_answered: [
    {
      ...head,
      kind: "attention_answered",
      ticket: "a-1",
      request: "r-1",
      answer: "allow_run",
      via: "answer_command",
      after_ms: 1500,
    },
    {
      ...head,
      kind: "attention_answered",
      ticket: "a-1",
      request: "r-2",
      answer: ["A"],
      via: "screen",
      after_ms: 0,
    },
    {
      ...head,
      kind: "attention_answered",
      ticket: "a-1",
      request: "r-3",
      after_ms: 9,
      cancelled: true,
    },
  ],
  denied: [
    {
      ...head,
      kind: "denied",
      ticket: "a-1",
      tool: "Bash",
      reason_type: "classifier",
      reason: "no",
    },
  ],
  usage_limit: [
    {
      ...head,
      kind: "usage_limit",
      status: "warning",
      limit: "five_hour",
      resets_at: "2026-10-02T14:05:00+02:00",
      utilization: 0.85,
    },
    { ...head, kind: "usage_limit", status: "lifted", limit: "seven_day" },
  ],
  message: [{ ...head, kind: "message", ticket: "a-1", length: 42 }],
  steered: [{ ...head, kind: "steered", ticket: "a-1" }],
  released: [{ ...head, kind: "released", ticket: "a-1", text: "RELEASED" }],
  suspended: [{ ...head, kind: "suspended", ticket: "a-1", session: "s-1", why: "quit" }],
  resumed: [{ ...head, kind: "resumed", ticket: "a-1", session: "s-1", why: "hand_back" }],
}

const encoded = (record: EventRecord): string => {
  const line = encodeLine(record)
  if (Result.isFailure(line)) throw new Error(line.failure.message)
  return line.success
}

const decoded = (line: string): EventRecord => {
  const record = decodeLine(line)
  if (Result.isFailure(record)) throw new Error(record.failure.message)
  return record.success
}

const kindNames = Object.keys(kinds) as ReadonlyArray<Kind>

// A character a terminal may act on or reorder: C0 and C1 controls, DEL, line separators, bidi.
const actedOn = (c: string): boolean => {
  const code = c.charCodeAt(0)
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

describe("the records", () => {
  test("§ 10's kinds, orchestra's and tutti's, each have a schema", () => {
    expect([...kindNames].sort() as Array<string>).toEqual(
      [
        ...["start", "info", "dispatch", "queue", "closed", "deferred", "asked", "answered"],
        ...["waits", "reopened", "triage", "warn", "hold", "drain", "resume", "probed", "stop"],
        ...["shared_machine", "machine_hold"],
        ...["done", "full_check", "end", "phase", "attention", "attention_answered", "denied"],
        ...["usage_limit", "message", "steered", "released", "suspended", "resumed"],
        ...["check", "turn", "organ", "ticket_end"],
      ].sort(),
    )
  })

  for (const kind of kindNames) {
    test(`${kind} encodes as one line and decodes back`, () => {
      for (const record of examples[kind]) {
        const line = encoded(record)
        expect(line).not.toContain("\n")
        expect(JSON.parse(line)).toEqual(record)
        expect(decoded(line)).toEqual(record)
      }
    })

    test(`${kind} round-trips whatever its schema allows`, () => {
      const samples = Effect.runSync(
        Arbitrary.sampleEffect(Arbitrary.schema(kinds[kind]), { count: 50, seed: kind }),
      )
      for (const record of samples) {
        const line = encoded(record)
        expect(line).not.toContain("\n")
        expect(decoded(line)).toEqual(record)
      }
    })
  }

  test("a record begins with v, time, run and kind, and keeps no empty optional field", () => {
    const line = encoded({ ...head, kind: "phase", ticket: "a-1", to: "Queued", cause: "ready" })
    expect(line).toBe(
      `{"v":1,"time":"${head.time}","run":"${run}","kind":"phase","ticket":"a-1","to":"Queued","cause":"ready"}`,
    )
  })

  test("orchestra's records, with v, decode", () => {
    const orchestra = [
      `{"time":"2026-10-02T09:12:06.2+02:00","run":"${run}","kind":"dispatch","ticket":"kinieta-kco","title":"Open the property model","text":"[1/40] kinieta-kco dispatching: Open the property model","n":1,"limit":40,"queued":12,"unclosed":31}`,
      `{"time":"2026-10-02T09:31:40.07+02:00","run":"${run}","kind":"closed","ticket":"kinieta-kco","detail":"ffd6ce4 merged into batch/2026-10-02","text":"  kinieta-kco closed","title":"Open the property model"}`,
      `{"time":"2026-10-02T11:02:13.6+02:00","run":"${run}","kind":"done","text":"READY_EMPTY after 12 tickets"}`,
      `{"time":"2026-10-02T11:14:40.3+02:00","run":"${run}","kind":"full_check","ticket":"kinieta-q1z","detail":"failed","text":"  FULL_CHECK_FAILED","suite":"e2e","output":"/Users/me/kinieta/.orchestra/run/check-full.log"}`,
      `{"time":"2026-10-02T11:03:55.1+02:00","run":"${run}","kind":"end","code":0}`,
    ]
    for (const line of orchestra) {
      const record = decoded(`{"v":1,${line.slice(1)}`)
      expect(record).toEqual({ v: 1, ...JSON.parse(line) })
    }
  })

  test("unknown fields are skipped; an unknown kind, a missing field, a bad time or another v is refused", () => {
    expect(
      decoded(`{"v":1,"time":"${head.time}","run":"${run}","kind":"end","code":2,"new":1}`),
    ).toEqual({ ...head, kind: "end", code: 2 })
    for (const line of [
      `{"v":1,"time":"${head.time}","run":"${run}","kind":"later","code":2}`,
      `{"v":1,"time":"${head.time}","run":"${run}","kind":"end"}`,
      `{"v":2,"time":"${head.time}","run":"${run}","kind":"end","code":2}`,
      `{"v":1,"time":"yesterday","run":"${run}","kind":"end","code":2}`,
      `{"v":1,"time":"${head.time}","run":"${run}","kind":"stop","detail":"PAUSED"}`,
    ]) {
      expect(Result.isFailure(decodeLine(line))).toBe(true)
    }
  })

  test("untrusted text is kept as it came, on one line, with nothing a terminal acts on", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.string({ unit: "grapheme" }), (title, text) => {
        const record: EventRecord = { ...head, kind: "closed", ticket: "a-1", title, text }
        const line = encoded(record)
        expect([...line].filter(actedOn)).toEqual([])
        expect(decoded(line)).toEqual(record)
      }),
    )
  })

  test("controls, separators and bidi overrides are escaped, and decode as they were", () => {
    const text = "\u001b[2J\u009b2J\u007f\u0085\u2028\u202eabc\u2066"
    const record: EventRecord = { ...head, kind: "info", text }
    const line = encoded(record)
    expect(line).toContain(String.raw`"text":"\u001b[2J\u009b2J\u007f\u0085\u2028\u202eabc\u2066"`)
    expect(decoded(line)).toEqual(record)
  })

  test("a record that doesn't fit its schema isn't encoded", () => {
    expect(Result.isFailure(encodeLine({ ...head, kind: "end", code: -1 }))).toBe(true)
  })
})

describe("timestamp", () => {
  test("is RFC 3339 in local time, the same instant, with a trimmed fraction", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (millis) => {
        const text = timestamp(new Date(millis))
        expect(text).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d*[1-9])?(Z|[+-]\d{2}:\d{2})$/,
        )
        expect(new Date(text).getTime()).toBe(millis)
      }),
    )
  })

  test("leaves the fraction out on a whole second", () => {
    expect(timestamp(new Date(Date.UTC(2026, 9, 2, 7, 12, 4)))).not.toContain(".")
    expect(timestamp(new Date(Date.UTC(2026, 9, 2, 7, 12, 4, 510)))).toMatch(/:04\.51(Z|[+-])/)
  })
})

const tempRepo = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-events-")))

const lines = (repo: string) =>
  readFileSync(join(repo, eventsFile), "utf8").split("\n").slice(0, -1)

/** Runs `effect` with the stream in `repo`, collecting its warnings. */
const withStream = (repo: string, effect: Effect.Effect<void, never, EventStream>) => {
  const warnings: Array<string> = []
  Effect.runSync(
    effect.pipe(
      Effect.provide(
        EventStream.layer({
          repo,
          run,
          warn: (message) => Effect.sync(() => warnings.push(message)),
        }),
      ),
    ),
  )
  return warnings
}

const emit = (event: Event) =>
  Effect.gen(function* () {
    yield* (yield* EventStream).emit(event)
  })

const info = (text: string): Event => ({ kind: "info", text })

describe("EventStream", () => {
  test("appends one line per record, made with the run and the time, and keeps every run", () => {
    const repo = tempRepo()
    const first = withStream(repo, Effect.all([emit(info("one")), emit({ kind: "end", code: 0 })]))
    const second = withStream(repo, emit(info("two\nlines \u001b]52;c;x\u0007")))
    expect([...first, ...second]).toEqual([])
    const records = lines(repo).map(decoded)
    expect(records.map((r) => r.kind)).toEqual(["info", "end", "info"])
    expect(records.every((r) => r.v === 1 && r.run === run)).toBe(true)
    expect(records[2]).toMatchObject({ text: "two\nlines \u001b]52;c;x\u0007" })
  })

  test("records emitted at once each stay whole on their own line", () => {
    const repo = tempRepo()
    const texts = Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(i * 50)}`)
    withStream(
      repo,
      Effect.asVoid(
        Effect.all(
          texts.map((text) => emit(info(text))),
          { concurrency: "unbounded" },
        ),
      ),
    )
    expect(
      lines(repo)
        .map(decoded)
        .map((r) => (r.kind === "info" ? r.text : ""))
        .sort(),
    ).toEqual([...texts].sort())
  })

  test("a stream that can't be opened warns once, and the run goes on", () => {
    const repo = tempRepo()
    const outside = tempRepo()
    mkdirSync(join(repo, ".tutti"))
    symlinkSync(outside, join(repo, ".tutti", "run"))
    const warnings = withStream(
      repo,
      Effect.all([emit(info("one")), emit(info("two")), emit({ kind: "end", code: 1 })]).pipe(
        Effect.asVoid,
      ),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith(`events not recorded in ${eventsFile}: `)
    expect(warnings[0]).toContain(".tutti/run")
    expect(() => readFileSync(join(outside, "events.jsonl"))).toThrow()
  })

  test("nothing is made through a link in the stream's path", () => {
    const repo = tempRepo()
    const outside = tempRepo()
    symlinkSync(outside, join(repo, ".tutti"))
    expect(withStream(repo, emit(info("one")))).toHaveLength(1)
    expect(readdirSync(outside)).toEqual([])
  })

  test("a record that doesn't fit its schema warns once, and later records are still written", () => {
    const repo = tempRepo()
    const warnings = withStream(
      repo,
      Effect.asVoid(
        Effect.all([
          emit({ kind: "end", code: -1 }),
          emit({ kind: "queue", queued: -3 }),
          emit(info("after")),
        ]),
      ),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith(`events not recorded in ${eventsFile}: a end record`)
    expect(warnings[0]).toEndWith("; the run goes on, and later failures aren't logged")
    expect(lines(repo).map(decoded)).toMatchObject([{ kind: "info", text: "after" }])
  })

  test("the warning is orchestra's", () => {
    expect(notRecorded("EACCES")).toBe(
      "events not recorded in .tutti/run/events.jsonl: EACCES; the run goes on, and later failures aren't logged",
    )
  })
})

describe("the test layer", () => {
  test("captures each record with the run and the clock's time", async () => {
    const records = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 9, 2, 7, 12, 4, 510))
        yield* emit({
          kind: "phase",
          ticket: "a-1",
          from: "Queued",
          to: "Working",
          cause: "dispatched",
        })
        yield* emit({ kind: "message", ticket: "a-1", length: 5 })
        return yield* (yield* Captured).records
      }).pipe(Effect.provide(Layer.merge(capturedLayer(), TestClock.layer()))),
    )
    expect(records).toMatchObject([
      { v: 1, run: testRun, kind: "phase", to: "Working" },
      { v: 1, run: testRun, kind: "message", length: 5 },
    ])
    expect(new Date(records[0]?.time ?? "").getTime()).toBe(Date.UTC(2026, 9, 2, 7, 12, 4, 510))
  })

  test("refuses a record that doesn't fit its schema", () => {
    const exit = Effect.runSyncExit(
      emit({ kind: "end", code: -1 }).pipe(Effect.provide(capturedLayer())),
    )
    expect(exit._tag).toBe("Failure")
  })
})
