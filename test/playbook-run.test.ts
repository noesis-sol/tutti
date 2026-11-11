// The playbook in the run (src/run/playbookRun.ts): what a ticket is given, its scorecard counted as
// it ends, the reflections and what the gate makes of them; `tutti playbook` (src/cli/playbook.ts).
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Clock, Effect, Fiber, Layer, Option, type Schema, type Scope } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Transcripts } from "../src/agent/Transcripts.ts"
import { playbookAct, playbook as playbookCommand } from "../src/cli/playbook.ts"
import { line } from "../src/core/log.ts"
import { Organs } from "../src/organs/Organs.ts"
import { reflector } from "../src/organs/reflector.ts"
import { Ledger } from "../src/run/ledger.ts"
import { overnightWhy } from "../src/run/overnightAside.ts"
import { Move } from "../src/run/phase.ts"
import { armOf, type Lesson, parsePlaybook, playbookFile } from "../src/run/playbook.ts"
import {
  admit,
  closely,
  clusterFailures,
  make as makePlaybook,
  measure,
  namedFootprint,
  off,
  type RunPlaybook,
  triggerOf,
} from "../src/run/playbookRun.ts"
import { run } from "../src/run/run.ts"
import { lessonsKey, resume } from "../src/run/sessions.ts"
import { start } from "../src/run/start.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { EventStream } from "../src/services/EventStream.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { recordRef, type Score } from "../src/services/scorecard.ts"
import { bash, result, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository } from "../src/testing/Git.ts"
import { type Answers, layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { backlog, type Env, expectExitCode, scenario } from "./harness.ts"

type Json = Schema.Json

const folder = (name = "repo") =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-playbook-run-${name}-`)))

const lesson = (id: string, fields: Partial<Lesson> = {}): Lesson => ({
  id,
  text: `Lesson ${id} about the parser's handling of ${id} tokens.`,
  scope: ["src/parse/**"],
  kind: "pitfall",
  evidence: [{ ticket: "t-0", event: "check@1" }],
  state: "active",
  helpful: 0,
  harmful: 0,
  held_clean: 0,
  held_bad: 0,
  measured: [],
  admitted_at: "2026-11-06T09:00:00Z",
  version: Number(id.slice(1)) || 1,
  ...fields,
})

const score = (ticket: string, fields: Partial<Score> = {}): Score => ({
  kind: "score",
  ticket,
  outcome: "merged",
  phase: "Done",
  verifier: { rounds: 1, passed: 1, failed: 0 },
  hand_backs: { resolve: 0, fix: 0 },
  resolving: 0,
  fixing: 0,
  working: 600,
  seconds: 700,
  checks: { failed: 0, timed_out: 0 },
  flaky: 0,
  denied: 0,
  asked: 0,
  ...fields,
})

const bad: Partial<Score> = { hand_backs: { resolve: 0, fix: 1 } }

const writeLessons = (repo: string, lessons: ReadonlyArray<Lesson>) => {
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  writeFileSync(
    join(repo, playbookFile),
    lessons.map((each) => `${JSON.stringify(each)}\n`).join(""),
  )
}

const readLessons = (repo: string): ReadonlyArray<Lesson> =>
  parsePlaybook(readFileSync(join(repo, playbookFile), "utf8")).lessons

const ticketIn = (id: string, shown: boolean): TicketId => {
  for (let i = 0; ; i++) {
    if (armOf(id, `t-${i}`) === shown) return `t-${i}` as TicketId
  }
}

describe("what calls for a reflection", () => {
  test("every so many judged ends", () => {
    const clean = ["a", "b", "c", "d"].map((t) => score(t))
    expect(triggerOf(clean, 5)).toBeUndefined()
    expect(triggerOf([...clean, score("e")], 5)).toBe("every")
    expect(triggerOf([...clean, score("e")], 0)).toBeUndefined()
  })

  test("a cluster of failures, before its number comes up, and with the number off", () => {
    const failing = Array.from({ length: clusterFailures }, (_, i) => score(`b-${i}`, bad))
    expect(triggerOf(failing.slice(1), 5)).toBeUndefined()
    expect(triggerOf(failing, 5)).toBe("failures")
    expect(triggerOf(failing, 0)).toBe("failures")
  })

  test("the worst and the best are read closely, no ticket twice", () => {
    const scores = [score("a"), score("b", bad), score("c"), score("d", bad)]
    expect(closely(scores)).toEqual([
      { ticket: "b", standing: "worst" },
      { ticket: "d", standing: "worst" },
      { ticket: "c", standing: "best" },
    ])
    expect(closely([score("a")])).toEqual([{ ticket: "a", standing: "worst" }])
    expect(closely([])).toEqual([])
  })
})

describe("the deltas of a run", () => {
  test("the gate goes through a reflection in turn, each against what the last left", () => {
    const good = {
      text: "The parser keeps a cursor per file: reset it between files.",
      kind: "pitfall" as const,
      scope: ["src/parse/**"],
      evidence: [{ ticket: "t-1", event: "check@1" }],
    }
    const { lessons, result } = admit(
      [],
      [
        good,
        good,
        { ...good, text: "Plan the parser's states out first.", kind: "strategy" },
        { ...good, text: "Skip the slow tests.", kind: "strategy" },
      ],
      {
        known: (ticket, event) => ticket === "t-1" && event === "check@1",
        transcripts: [],
        cap: 30,
        at: "2026-11-06T10:00:00Z",
      },
    )
    expect(lessons.map((each) => [each.id, each.state])).toEqual([
      ["L1", "active"],
      ["L2", "proposed"],
    ])
    expect(result.map((each) => [each.id, each.state, each.refused])).toEqual([
      ["L1", "active", undefined],
      [undefined, undefined, "duplicate"],
      ["L2", "proposed", undefined],
      [undefined, undefined, "weakens_checks"],
    ])
  })

  test("a cap of none refuses what passes the gate", () => {
    const { lessons, result } = admit(
      [],
      [
        {
          text: "Reset the parser's cursor between files.",
          kind: "pitfall",
          scope: ["src/**"],
          evidence: [{ ticket: "t-1", event: "check@1" }],
        },
      ],
      { known: () => true, transcripts: [], cap: 0, at: "now" },
    )
    expect(lessons).toEqual([])
    expect(result[0]?.refused).toBe("capped")
  })

  test("a ticket counts for both arms, only for what it was given, and only once", () => {
    const pool = [lesson("L1"), lesson("L2"), lesson("L3")]
    const given = { lessons: [pool[0] as Lesson], held: [pool[1] as Lesson] }
    const once = measure(pool, given, "t-1", true, 10)
    expect(once.lessons.map((each) => [each.helpful, each.held_clean])).toEqual([
      [1, 0],
      [0, 1],
      [0, 0],
    ])
    expect(once.result.map((each) => [each.id, each.shown])).toEqual([
      ["L1", true],
      ["L2", false],
    ])
    const twice = measure(once.lessons, given, "t-1", false, 10)
    expect(twice.lessons).toBe(once.lessons)
    expect(twice.result).toEqual([])
  })

  test("what the count judges is retired, at the next version; a retired lesson isn't counted", () => {
    const pool = [lesson("L1", { helpful: 6, harmful: 3, held_clean: 7, held_bad: 3, version: 4 })]
    const { lessons, result } = measure(pool, { lessons: pool, held: [] }, "t-1", true, 10)
    expect(lessons[0]).toMatchObject({ state: "retired", retired: "no_effect", version: 5 })
    expect(result[0]).toMatchObject({ retired: "no_effect", helpful: 7 })
    const after = measure(lessons, { lessons: pool, held: [] }, "t-2", true, 10)
    expect(after.lessons).toBe(lessons)
  })

  test("one that measurably hurts goes at once", () => {
    const pool = [lesson("L1", { harmful: 3, held_clean: 4 })]
    const { lessons, result } = measure(pool, { lessons: pool, held: [] }, "t-1", false, 10)
    expect(lessons[0]).toMatchObject({ state: "retired", retired: "harmful" })
    expect(result[0]).toMatchObject({ retired: "harmful" })
  })

  test("a ticket with no footprint read goes by the files its metadata names", () => {
    expect(
      namedFootprint({ files: ["src/a.ts", "src/*.tsx"], predictedFiles: ["src/b.ts"] }),
    ).toEqual({ files: ["src/a.ts", "src/b.ts"], globs: ["src/*.tsx"] })
  })
})

describe("the playbook in a run", () => {
  const id = ticketIn("L1", true)
  const issueFields = { title: "Parse inputs", metadata: { files: ["src/parse/run.ts"] } }

  const organsLayer = (answers: Answers, calls: Array<OrganCallRecord>) =>
    Organs.layer.pipe(Layer.provide(cannedLayer(answers, calls)))

  const settle = (book: RunPlaybook) =>
    Effect.gen(function* () {
      for (let i = 0; i < 5000; i++) {
        if ((yield* book.pending) === 0) return
        yield* Effect.yieldNow
      }
      throw new Error("the reflection never ended")
    })

  const withPlaybook = (
    repo: string,
    fields: Partial<ReturnType<typeof appConfig>["settings"]["playbook"]> = {},
  ) => {
    const settings = appConfig().settings
    return {
      repo,
      settings: { ...settings, playbook: { ...settings.playbook, ...fields } },
    }
  }

  test("a ticket's lessons are chosen once, noted on it, and its section stays", async () => {
    const repo = folder()
    writeLessons(repo, [lesson("L1", { version: 3 })])
    const ran = await scenario(
      { config: withPlaybook(repo), backlog: backlog().ticket(id, issueFields).seeds },
      Effect.gen(function* () {
        const book = yield* makePlaybook({ repo, organs: Option.none() })
        const issue = {
          ...issueFields,
          id,
          files: ["src/parse/run.ts"],
          predictedFiles: [],
        } as never
        const first = yield* book.choose(issue)
        writeLessons(repo, [lesson("L1", { version: 3 }), lesson("L2", { version: 4 })])
        const again = yield* book.choose(issue)
        return {
          first,
          again,
          section: yield* book.section(id),
          none: yield* book.section("x" as TicketId),
        }
      }),
    )
    expect(ran.exit).toMatchObject({
      _tag: "Success",
      value: {
        first: { version: 3, lessons: ["L1"], held: [] },
        again: { version: 3, lessons: ["L1"], held: [] },
        none: "",
      },
    })
    if (ran.exit._tag === "Success") {
      expect(ran.exit.value.section).toContain("playbook, version 3")
      expect(ran.exit.value.section).toContain("Lesson L1")
    }
    expect(ran.issues.find((issue) => issue.id === id)?.metadata).toMatchObject({
      playbook_version: "3",
      playbook_lessons: "L1",
    })
  })

  test("a ticket with nothing in its scope isn't touched, nor is a project with no playbook", async () => {
    const repo = folder()
    const ran = await scenario(
      { config: withPlaybook(repo), backlog: backlog().ticket(id, issueFields).seeds },
      Effect.gen(function* () {
        const book = yield* makePlaybook({ repo, organs: Option.none() })
        return yield* book.choose({ id, files: ["a.ts"], predictedFiles: [] } as never)
      }),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: undefined })
    expect(ran.issues.find((issue) => issue.id === id)?.metadata.playbook_version).toBeUndefined()
  })

  test("off with playbook.enabled false", async () => {
    const repo = folder()
    writeLessons(repo, [lesson("L1")])
    const ran = await scenario(
      { config: withPlaybook(repo, { enabled: false }), backlog: backlog().seeds },
      makePlaybook({ repo, organs: Option.none() }),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: off })
  })

  test("a ticket's end counts its scorecard for its lessons, with a record and a line", async () => {
    const repo = folder()
    const held = ticketIn("L2", false)
    writeLessons(repo, [lesson("L1", { version: 1 }), lesson("L2", { version: 2 })])
    const ran = await scenario(
      { config: withPlaybook(repo), backlog: backlog().ticket(held, issueFields).seeds },
      Effect.gen(function* () {
        const book = yield* makePlaybook({ repo, organs: Option.none() })
        const events = yield* EventStream
        yield* book.choose({
          ...issueFields,
          id: held,
          files: ["src/parse/run.ts"],
          predictedFiles: [],
        } as never)
        yield* events.emit(score(held, bad))
        yield* book.ended({ ticket: held, outcome: "merged" })
        // Stopped or waiting says nothing of how it went.
        yield* book.ended({ ticket: held, outcome: "stopped" })
      }),
    )
    expect(ran.exit._tag).toBe("Success")
    const after = readLessons(repo)
    expect(after.find((each) => each.id === "L2")).toMatchObject({
      held_bad: 1,
      measured: [held],
    })
    const record = ran.events.find((each) => each.kind === "lesson_measure")
    expect(record).toMatchObject({ ticket: held, clean: false })
    expect(ran.log.some((each) => each.startsWith(`  lessons for ${held}: not clean;`))).toBe(true)
  })

  test("every so many ends a reflection reads the worst and the best, and the gate decides", async () => {
    const repo = folder()
    const calls: Array<OrganCallRecord> = []
    const tickets = ["t-1", "t-2", "t-3"] as unknown as ReadonlyArray<TicketId>
    let cited = ""
    const answer = Effect.sync(() => ({
      lessons: [
        {
          text: "The parser keeps a cursor per file: reset it between files.",
          kind: "pitfall",
          scope: ["src/parse/"],
          evidence: [{ ticket: "t-1", event: cited }],
        },
        {
          text: "Plan the parser's states out on paper first.",
          kind: "strategy",
          scope: ["src/parse/"],
          evidence: [{ ticket: "t-1", event: cited }],
        },
        {
          text: "Skip the slow tests in this folder.",
          kind: "pitfall",
          scope: ["src/parse/"],
          evidence: [{ ticket: "t-1", event: cited }],
        },
        {
          text: "A lesson with evidence nobody can find anywhere.",
          kind: "pitfall",
          scope: ["src/parse/"],
          evidence: [{ ticket: "t-1", event: "check@never" }],
        },
      ],
    }))
    const ran = await scenario(
      {
        config: withPlaybook(repo, { reflect_every: 3, lessons_proposed: 4 }),
        backlog: backlog()
          .ticket("t-1", issueFields)
          .ticket("t-2", issueFields)
          .ticket("t-3", issueFields).seeds,
      },
      Effect.gen(function* () {
        const organs = yield* Organs
        const book = yield* makePlaybook({ repo, organs: Option.some(organs) })
        const events = yield* EventStream
        const transcripts = yield* Transcripts
        for (const ticket of tickets) {
          yield* transcripts.record(ticket, {
            session: "s-1",
            message: {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: `Working on ${ticket}.` }],
              },
              parent_tool_use_id: null,
            } as unknown as SDKMessage,
          })
        }
        const at = yield* Clock.currentTimeMillis
        cited = recordRef("score", at)
        yield* events.emit(score("t-1", bad))
        yield* book.ended({ ticket: tickets[0] as TicketId, outcome: "merged" })
        yield* events.emit(score("t-2"))
        yield* book.ended({ ticket: tickets[1] as TicketId, outcome: "merged" })
        expect(yield* book.pending).toBe(0)
        yield* events.emit(score("t-3"))
        yield* book.ended({ ticket: tickets[2] as TicketId, outcome: "merged" })
        yield* settle(book)
        return yield* book.report
      }).pipe(Effect.provide(organsLayer({ reflector: answer }, calls))),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.call).toMatchObject({ organ: "reflector", effort: "medium" })
    expect(calls[0]?.system).toContain(reflector.system)
    const input = calls[0]?.input ?? ""
    expect(input).toContain("Ticket t-1, among the worst (bd show)")
    expect(input).toContain("Ticket t-3, among the best (bd show)")
    expect(input).toContain("Working on t-1.")
    expect(input).toContain(cited)
    expect(input).toEndWith("Propose at most 4 lessons, or none.\n")

    const after = readLessons(repo)
    expect(after.map((each) => [each.id, each.kind, each.state, each.scope])).toEqual([
      ["L1", "pitfall", "active", ["src/parse/**"]],
      ["L2", "strategy", "proposed", ["src/parse/**"]],
    ])
    const record = ran.events.find((each) => each.kind === "reflection")
    expect(record).toMatchObject({
      trigger: "every",
      tickets: ["t-1", "t-2", "t-3"],
      version: 2,
    })
    expect(record?.kind === "reflection" && record.lessons.map((each) => each.refused)).toEqual([
      undefined,
      undefined,
      "weakens_checks",
      "no_evidence",
    ])
    expect(ran.log).toContain(
      "  reflection: 4 lessons; active L1; proposed L2; refused 1 weakens_checks, 1 no_evidence",
    )
    if (ran.exit._tag === "Success") {
      expect(ran.exit.value).toContain("### Proposed, waiting for you")
      expect(ran.exit.value).toContain("Plan the parser")
    }
  })

  test("a reflection's failure is REFLECT_FAILED and changes nothing", async () => {
    const repo = folder()
    const ran = await scenario(
      {
        config: withPlaybook(repo, { reflect_every: 1 }),
        backlog: backlog().ticket("t-1", issueFields).seeds,
      },
      Effect.gen(function* () {
        const organs = yield* Organs
        const book = yield* makePlaybook({ repo, organs: Option.some(organs) })
        const transcripts = yield* Transcripts
        yield* transcripts.record("t-1" as TicketId, {
          session: "s-1",
          message: {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Working." }] },
            parent_tool_use_id: null,
          } as unknown as SDKMessage,
        })
        yield* (yield* EventStream).emit(score("t-1"))
        yield* book.ended({ ticket: "t-1" as TicketId, outcome: "merged" })
        yield* settle(book)
      }).pipe(Effect.provide(organsLayer({}, []))),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(ran.log.some((each) => each.includes("REFLECT_FAILED"))).toBe(true)
    expect(ran.events.some((each) => each.kind === "reflection")).toBe(false)
  })

  test("a file that can't be used warns once, and workers go without", async () => {
    const repo = folder()
    mkdirSync(join(repo, ".tutti", playbookFile.split("/")[1] as string), { recursive: true })
    const ran = await scenario(
      { config: withPlaybook(repo), backlog: backlog().ticket(id, issueFields).seeds },
      Effect.gen(function* () {
        const book = yield* makePlaybook({ repo, organs: Option.none() })
        const issue = {
          ...issueFields,
          id,
          files: ["src/parse/run.ts"],
          predictedFiles: [],
        } as never
        return [yield* book.choose(issue), yield* book.choose(issue)]
      }),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: [undefined, undefined] })
    expect(ran.log.filter((each) => each.includes("PLAYBOOK_FAILED"))).toHaveLength(1)
  })

  test("a whole run gives its worker the lessons, says so on dispatch, and counts its end", async () => {
    const repo = folder()
    const root = folder("worktrees")
    writeLessons(repo, [lesson("L1", { version: 6 })])
    const settings = appConfig().settings
    const ticket = id
    const ran = await scenario(
      {
        config: { repo, settings: { ...settings, concurrent: 1 } },
        backlog: backlog().ticket(ticket, issueFields).seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => ({
          [ticket]: [
            turn(
              [
                ...bash(
                  "bd defer",
                  Effect.asVoid(Effect.orDie(world.beads.defer(ticket, { reason: "stuck" }))),
                ),
              ],
              result("Deferred."),
            ),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, ticket), {
          branch: `tutti/${ticket}`,
          base: "main",
        })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti`] }),
        )
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(
          organsLayer(
            {
              triage: {
                cause: "problem",
                confidence: "low",
                summary: "Stuck.",
                recommendation: "Look.",
              },
            },
            [],
          ),
        ),
      ),
    )
    expectExitCode(ran, 0)
    expect(ran.events.find((each) => each.kind === "dispatch")).toMatchObject({
      ticket,
      playbook: { version: 6, lessons: ["L1"], held: [] },
    })
    expect(ran.issues.find((each) => each.id === ticket)?.metadata).toMatchObject({
      playbook_version: "6",
      playbook_lessons: "L1",
    })
    const started = ran.sent.find((each) => each._tag === "Started" && each.ticket === ticket)
    expect(started?._tag === "Started" && started.session.lessons).toContain("Lesson L1")
    const kinds = ran.events.map((each) => each.kind)
    expect(kinds.indexOf("lesson_measure")).toBeGreaterThan(kinds.indexOf("score"))
    expect(readLessons(repo)[0]).toMatchObject({ harmful: 1, measured: [ticket] })
  })
})

describe("the run's last end, and a session again", () => {
  const issueFields = { title: "Parse inputs", metadata: { files: ["src/parse/run.ts"] } }
  const organsLayer = (answers: Answers, calls: Array<OrganCallRecord>) =>
    Organs.layer.pipe(Layer.provide(cannedLayer(answers, calls)))

  test("a run's last end is counted and reflected on before the run ends", async () => {
    const repo = folder()
    const root = folder("worktrees")
    const ticket = ticketIn("L1", true)
    writeLessons(repo, [lesson("L1")])
    const settings = appConfig().settings
    const calls: Array<OrganCallRecord> = []
    const ran = await scenario(
      {
        config: {
          repo,
          settings: {
            ...settings,
            concurrent: 1,
            playbook: { ...settings.playbook, reflect_every: 1 },
          },
        },
        backlog: backlog().ticket(ticket, issueFields).seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => ({
          [ticket]: [
            turn(
              [...bash("bd close", Effect.asVoid(Effect.orDie(world.beads.close(ticket, "done"))))],
              result("Closed."),
            ),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, ticket), {
          branch: `tutti/${ticket}`,
          base: "main",
        })
        yield* (yield* Transcripts).record(ticket, {
          session: "s-1",
          message: {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
            parent_tool_use_id: null,
          } as unknown as SDKMessage,
        })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti`] }),
        )
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(organsLayer({ reflector: { lessons: [] } }, calls))),
    )
    expectExitCode(ran, 0)
    expect(calls.map((each) => each.call.organ)).toEqual(["reflector"])
    const kinds = ran.events.map((each) => each.kind)
    expect(kinds.indexOf("lesson_measure")).toBeGreaterThan(-1)
    expect(kinds.indexOf("lesson_measure")).toBeLessThan(kinds.indexOf("done"))
    expect(kinds.indexOf("reflection")).toBeGreaterThan(-1)
    expect(kinds.indexOf("reflection")).toBeLessThan(kinds.indexOf("done"))
  })

  test("an end the ledger hasn't told of yet is taken in by the run's look", async () => {
    const repo = folder()
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings } },
        backlog: backlog().seeds,
      },
      Effect.gen(function* () {
        const organs = yield* Organs
        const book = yield* makePlaybook({ repo, organs: Option.some(organs) })
        const transcripts = yield* Transcripts
        for (const each of ["a", "b", "c"]) {
          yield* transcripts.record(each as TicketId, {
            session: "s-1",
            message: {
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "Working." }] },
              parent_tool_use_id: null,
            } as unknown as SDKMessage,
          })
          yield* (yield* EventStream).emit(score(each, bad))
        }
        const pending = yield* book.pending
        for (let i = 0; i < 5000 && (yield* book.pending) > 0; i++) yield* Effect.yieldNow
        return pending
      }).pipe(Effect.provide(organsLayer({ reflector: { lessons: [] } }, []))),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: 1 })
    expect(ran.events.find((each) => each.kind === "reflection")).toMatchObject({
      trigger: "failures",
      tickets: ["a", "b", "c"],
    })
  })

  test("a start keeps the worker's lessons, and a resume of its session is given them", async () => {
    const root = folder("worktrees")
    const id = "t-1" as TicketId
    const session = turn([], result("Going."))
    const ran = await scenario(
      {
        backlog: backlog().ticket(id, issueFields).seeds,
        worktrees: { root },
        scripts: { [id]: [session, session] },
      },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const repository = yield* Repository
        yield* (yield* Git).addWorktree(repository.dir, join(root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
        yield* ledger.transition(id, Move.Ready(), { title: "Parse inputs" })
        yield* ledger.transition(id, Move.Dispatched())
        yield* start(
          { id, title: "Parse inputs", metadata: {}, lessons: Effect.succeed("\n\n## Lessons\n") },
          "main",
        )
        const kept = (yield* (yield* Store).metadata(id))[lessonsKey]
        yield* (yield* AgentHost).close(id)
        yield* resume({ ticket: id, why: "hand_back", message: "Go on.", what: line`going on` })
        return kept
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
        Json | undefined,
        unknown,
        Env | Scope.Scope
      >,
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: "\n\n## Lessons\n" })
    const sessions = ran.sent.flatMap((each) =>
      each._tag === "Started" || each._tag === "Resumed" ? [each] : [],
    )
    expect(sessions.map((each) => [each._tag, each.session.lessons])).toEqual([
      ["Started", "\n\n## Lessons\n"],
      ["Resumed", "\n\n## Lessons\n"],
    ])
  })

  test("a session kept by an overnight aside is told the lessons chosen for this dispatch", async () => {
    const root = folder("worktrees")
    const id = "t-1" as TicketId
    const section = "\n\n## Lessons\n"
    const ran = await scenario(
      {
        backlog: backlog().ticket(id, issueFields).seeds,
        worktrees: { root },
        scripts: { [id]: [turn([], result("Going."))] },
      },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const store = yield* Store
        const path = join(root, id)
        mkdirSync(path, { recursive: true })
        yield* store.saveSession(id, { session: "s-old", worktree: path, branch: `tutti/${id}` })
        yield* store.suspend(id, overnightWhy("BLOCKED"), "Deferred")
        yield* ledger.transition(id, Move.Ready(), { title: "Parse inputs" })
        yield* ledger.transition(id, Move.Dispatched())
        yield* start(
          { id, title: "Parse inputs", metadata: {}, lessons: Effect.succeed(section) },
          "main",
        )
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<void, unknown, Env | Scope.Scope>,
    )
    const resumed = ran.sent.find((each) => each._tag === "Resumed")
    expect(resumed?._tag === "Resumed" && resumed.session).toMatchObject({
      sessionId: "s-old",
      lessons: section,
    })
    const messages = ran.sent.flatMap((each) =>
      each._tag === "Message" ? [JSON.stringify(each)] : [],
    )
    expect(messages.some((each) => each.includes("## Lessons"))).toBe(true)
  })

  test("a session with no lessons kept is given none", async () => {
    const id = "t-1" as TicketId
    const ran = await scenario(
      {
        backlog: backlog().ticket(id, issueFields).seeds,
        scripts: { [id]: [turn([], result("Going."))] },
      },
      Effect.gen(function* () {
        yield* (yield* Store).saveSession(id, { session: "s-1", worktree: "/wt", branch: "b" })
        yield* resume({ ticket: id, why: "hand_back", message: "Go on.", what: line`going on` })
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<void, unknown, Env | Scope.Scope>,
    )
    const resumed = ran.sent.find((each) => each._tag === "Resumed")
    expect(resumed?._tag === "Resumed" && resumed.session).toEqual({
      sessionId: "s-1",
      cwd: "/wt",
    })
  })
})

describe("tutti playbook", () => {
  const sayer = () => {
    const out: Array<string> = []
    const error: Array<string> = []
    return {
      say: { out: (l: string) => void out.push(l), error: (l: string) => void error.push(l) },
      out,
      error,
    }
  }
  const pool = [
    lesson("L1", { helpful: 3, harmful: 1, held_clean: 1, held_bad: 1 }),
    lesson("L2", { state: "proposed", kind: "strategy", scope: [], version: 2 }),
    lesson("L3", { state: "retired", retired: "no_effect", version: 3 }),
  ]

  test("reads its arguments", () => {
    expect(playbookAct(undefined, undefined, undefined)).toEqual({ _tag: "List" })
    expect(playbookAct("approve", "L1", undefined)).toEqual({ _tag: "Approve", id: "L1" })
    expect(playbookAct("retire", "L1", undefined)).toEqual({ _tag: "Retire", id: "L1" })
    expect(playbookAct("edit", "L1", "New words")).toEqual({
      _tag: "Edit",
      id: "L1",
      text: "New words",
    })
    expect(typeof playbookAct("edit", "L1", undefined)).toBe("string")
    expect(typeof playbookAct("approve", undefined, undefined)).toBe("string")
    expect(typeof playbookAct("approve", "L1", "extra")).toBe("string")
    expect(typeof playbookAct("merge", "L1", undefined)).toBe("string")
  })

  test("lists the lessons, those proposed first, with counts and effect", async () => {
    const repo = folder()
    writeLessons(repo, pool)
    const { say, out } = sayer()
    expect(await Effect.runPromise(playbookCommand(repo, { _tag: "List" }, say))).toBe(0)
    expect(out[0]).toBe("Playbook version 3:")
    expect(out[1]).toStartWith("L2 proposed strategy [the whole project]")
    expect(out[2]).toStartWith("L1 active pitfall [src/parse/**] helpful 3, harmful 1")
    expect(out[2]).toContain("effect 25 points")
    expect(out[3]).toStartWith("L3 retired (no_effect)")
  })

  test("says when there are no lessons", async () => {
    const { say, out } = sayer()
    expect(await Effect.runPromise(playbookCommand(folder(), { _tag: "List" }, say))).toBe(0)
    expect(out).toEqual(["The playbook has no lessons yet."])
  })

  test("approve makes a proposed lesson active, at the next version", async () => {
    const repo = folder()
    writeLessons(repo, pool)
    const { say, out } = sayer()
    expect(await Effect.runPromise(playbookCommand(repo, { _tag: "Approve", id: "L2" }, say))).toBe(
      0,
    )
    expect(out).toEqual(["L2 approved."])
    expect(readLessons(repo)[1]).toMatchObject({ state: "active", version: 4 })
  })

  test("retire takes one out; edit gives new words and begins its counts again", async () => {
    const repo = folder()
    writeLessons(repo, pool)
    const { say } = sayer()
    await Effect.runPromise(playbookCommand(repo, { _tag: "Retire", id: "L2" }, say))
    expect(readLessons(repo)[1]).toMatchObject({ state: "retired", retired: "by_you" })
    await Effect.runPromise(
      playbookCommand(repo, { _tag: "Edit", id: "L1", text: "Reset\nthe cursor." }, say),
    )
    expect(readLessons(repo)[0]).toMatchObject({
      text: "Reset the cursor.",
      helpful: 0,
      measured: [],
    })
  })

  test("refuses what can't be done, and leaves the file as it was", async () => {
    const repo = folder()
    writeLessons(repo, pool)
    const before = readFileSync(join(repo, playbookFile), "utf8")
    const refused = [
      [{ _tag: "Approve", id: "L9" }, "no lesson L9"],
      [{ _tag: "Approve", id: "L1" }, "L1 is active already"],
      [{ _tag: "Retire", id: "L3" }, "L3 is retired"],
      [{ _tag: "Edit", id: "L1", text: "Skip the slow tests." }, "doesn't name a check"],
      [{ _tag: "Edit", id: "L1", text: "Run git rebase first." }, "git or bd"],
      [{ _tag: "Edit", id: "L1", text: " " }, "empty"],
      [{ _tag: "Edit", id: "L1", text: "a".repeat(400) }, "at most 300"],
    ] as const
    for (const [act, said] of refused) {
      const { say, error } = sayer()
      expect(await Effect.runPromise(playbookCommand(repo, act, say))).toBe(2)
      expect(error[0]).toContain(said)
    }
    expect(readFileSync(join(repo, playbookFile), "utf8")).toBe(before)
  })
})
