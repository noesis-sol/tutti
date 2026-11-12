// A defect while triaging one ticket loses that ticket's verdict, not the loop: it is TRIAGE_FAILED
// in the log, the next ticket is still taken, and the run still ends.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Fiber, Layer } from "effect"
import { causeWhy, line } from "../src/core/log.ts"
import { Organs } from "../src/organs/Organs.ts"
import type { Verdict as HoldVerdict } from "../src/run/environment.ts"
import { run } from "../src/run/run.ts"
import { type Deferral, make as makeTriage } from "../src/run/triage.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Answers, layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import {
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  scenario,
  type World,
} from "./harness.ts"

const verdict = (summary: string) => ({
  cause: "problem" as const,
  confidence: "medium" as const,
  summary,
  recommendation: "Rerun it.",
})

/** Organs over canned `answers`, every call recorded in `calls`. */
const organsLayer = (answers: Answers, calls: Array<OrganCallRecord> = []) =>
  Organs.layer.pipe(Layer.provide(cannedLayer(answers, calls)))

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 300; i++) yield* Effect.yieldNow
})

const deferral = (ticket: TicketId): Deferral => ({
  ticket,
  how: "the worker deferred it",
  worktree: `/repo-worktrees/${ticket}`,
})

describe("causeWhy", () => {
  test("says a defect's message on one line, or the cause told", () => {
    expect(causeWhy(Cause.die(new Error("boom\nat somewhere")))).toBe("boom")
    expect(causeWhy(Cause.die("a string"))).toBe("a string")
    expect(causeWhy(Cause.die(new TypeError("")))).toBe("TypeError")
    expect(causeWhy(Cause.fail("an error"))).not.toBe("")
  })
})

describe("a defect in one ticket's triage", () => {
  const id = "t-1" as TicketId

  test("from the organ is TRIAGE_FAILED, and the next ticket is still triaged", async () => {
    const calls: Array<OrganCallRecord> = []
    const blamed: Array<HoldVerdict> = []
    let done = 0
    const ran = await scenario(
      { backlog: backlog().ticket(id).ticket("t-2").seeds, git: { dir: "/repo" } },
      Effect.gen(function* () {
        const triaging = yield* makeTriage({
          base: "main",
          hold: {
            generation: Effect.succeed(1),
            blamed: (v) => Effect.sync(() => void blamed.push(v)),
          },
          done: Effect.sync(() => void done++),
        })
        yield* triaging.deferred(deferral(id))
        yield* flush
        yield* triaging.deferred(deferral("t-2" as TicketId))
        yield* flush
        return yield* triaging.pending
      }).pipe(
        Effect.provide(
          organsLayer(
            { triage: [Effect.die(new Error("rowText broke\nat x")), verdict("Second.")] },
            calls,
          ),
        ),
      ),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: 0 })
    expect(calls).toHaveLength(2)
    expectLog(ran, [
      "  TRIAGE_FAILED for t-1: rowText broke",
      "  triage t-2: problem (medium confidence) - Second.",
    ])
    expect(ran.events.find((r) => r.kind === "warn")).toMatchObject({ ticket: id })
    expect(blamed.map((v) => v.ticket)).toEqual(["t-2" as TicketId])
    expect(done).toBe(2)
  })

  test("from the hold is TRIAGE_FAILED after its verdict, and the next ticket is still triaged", async () => {
    const blamed: Array<string> = []
    const ran = await scenario(
      { backlog: backlog().ticket(id).ticket("t-2").seeds, git: { dir: "/repo" } },
      Effect.gen(function* () {
        const triaging = yield* makeTriage({
          base: "main",
          hold: {
            generation: Effect.succeed(1),
            blamed: (v) =>
              v.ticket === id
                ? Effect.die(new Error("the hold fell over"))
                : Effect.sync(() => void blamed.push(v.ticket)),
          },
        })
        yield* triaging.deferred(deferral(id))
        yield* triaging.deferred(deferral("t-2" as TicketId))
        yield* flush
        return yield* triaging.pending
      }).pipe(Effect.provide(organsLayer({ triage: verdict("Both.") }))),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: 0 })
    expectLog(ran, [
      "  triage t-1: problem (medium confidence) - Both.",
      "  TRIAGE_FAILED for t-1: the hold fell over",
      "  triage t-2: problem (medium confidence) - Both.",
    ])
    expect(blamed).toEqual(["t-2"])
  })

  test("while its evidence is gathered is TRIAGE_FAILED, nothing asked and nothing pending", async () => {
    const calls: Array<OrganCallRecord> = []
    let done = 0
    const ran = await scenario(
      { backlog: backlog().ticket(id).seeds, git: { dir: "/repo" } },
      Effect.gen(function* () {
        const beads = yield* Beads
        const triaging = yield* makeTriage({
          base: "main",
          hold: { generation: Effect.succeed(1), blamed: () => Effect.void },
          done: Effect.sync(() => void done++),
        }).pipe(
          Effect.provideService(Beads, { ...beads, show: () => Effect.die(new Error("bd broke")) }),
        )
        yield* triaging.deferred(deferral(id))
        yield* flush
        return yield* triaging.pending
      }).pipe(Effect.provide(organsLayer({ triage: verdict("Never.") }, calls))),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: 0 })
    expect(calls).toEqual([])
    expectLog(ran, ["  TRIAGE_FAILED for t-1: bd broke"])
    expect(done).toBe(1)
  })
})

describe("a run whose triage dies on one ticket", () => {
  const folder = (name: string) =>
    realpathSync(mkdtempSync(join(tmpdir(), `tutti-organ-defects-${name}-`)))

  /** Claims its ticket and defers it. */
  const defers = (world: World, id: TicketId): SessionScript =>
    turn(
      [
        ...bash(`bd update ${id} --claim`, Effect.orDie(world.beads.update(id, { claim: true }))),
        ...bash(
          `bd defer ${id}`,
          Effect.asVoid(Effect.orDie(world.beads.defer(id, { reason: "stuck" }))),
        ),
      ],
      result(`Deferred ${id}.`),
    )

  test("still triages the next ticket and ends", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const tickets = ["t-1" as TicketId, "t-2" as TicketId]
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => Object.fromEntries(tickets.map((id) => [id, [defers(world, id)]])),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti`] }),
        )
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(
          organsLayer({ triage: [Effect.die(new Error("boom")), verdict("The second one.")] }),
        ),
      ),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Deferred", "t-2": "Deferred" })
    expect(ran.log).toContain("  TRIAGE_FAILED for t-1: boom")
    expect(ran.log).toContain("  triage t-2: problem (medium confidence) - The second one.")
  })
})
