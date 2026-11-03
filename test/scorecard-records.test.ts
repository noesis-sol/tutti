// The records a ticket's scorecard is made from, as the run writes them (src/run/scorecard.ts): its
// footprint's size on its dispatch, a follow-up's score_update as the run takes it up, a revert's as
// a merge brings it, and the live stream's score after each ticket_end, in the file.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { decodeLine, type EventRecord } from "../src/run/events.ts"
import { EventStream, eventsFile } from "../src/run/eventstream.ts"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { figuresText } from "../src/run/figures.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { run } from "../src/run/run.ts"
import { type Footprints, make } from "../src/run/schedule.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { Repository } from "../src/testing/Git.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { advance, backlog, type Env, scenario, type World } from "./harness.ts"

const footprints: Footprints = {
  repo: Effect.succeed(repoFiles(["src/a.ts", "src/b.ts", "src/run/loop.ts"])),
  changed: () => Effect.succeed([]),
  mentions: () => Effect.succeed(() => false),
}

/** The records of one fill over `seeds`, each ticket started running until the test ends. */
const recordsOfFill = (
  seeds: ReadonlyArray<Seed>,
  options: { readonly footprints?: Footprints } = {},
): Promise<ReadonlyArray<EventRecord>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const schedule = yield* make({
        concurrent: 3,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        ...options,
        start: { start: () => Effect.never },
      })
      yield* schedule.fillTrying
      return yield* (yield* Captured).records
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

describe("a dispatch", () => {
  test("says how many files the ticket's footprint names, where the run read one", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0, metadata: { files: ["src/a.ts", "src/b.ts"] } },
    ]
    const read = await recordsOfFill(seeds, { footprints })
    expect(read.find((each) => each.kind === "dispatch")).toMatchObject({
      ticket: "t-1",
      footprint: 2,
    })
    const unread = await recordsOfFill(seeds)
    const dispatch = unread.find((each) => each.kind === "dispatch")
    expect(dispatch).toBeDefined()
    expect(dispatch && "footprint" in dispatch).toBe(false)
  })

  test("of a ticket discovered from another names it that one's follow-up, once", async () => {
    // t-1 merged in an earlier run: the run holds a ticket back until the one it came from merges.
    const records = await recordsOfFill([
      { id: "t-1", status: "closed" },
      { id: "t-2", dependencies: [{ id: "t-1", type: "discovered-from" }] },
    ])
    expect(records.filter((each) => each.kind === "score_update")).toEqual([
      expect.objectContaining({ kind: "score_update", ticket: "t-1", follow_up: "t-2" }),
    ])
  })

  test("of a ticket only related to another names no follow-up", async () => {
    const records = await recordsOfFill([
      { id: "t-1", priority: 0 },
      { id: "t-2", priority: 1, dependencies: [{ id: "t-1", type: "related" }] },
    ])
    expect(records.filter((each) => each.kind === "score_update")).toEqual([])
  })
})

/** A ticket its worker finished with `subjects` committed in order, closed in Beads. */
const finished = (id: TicketId, subjects: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    for (const [n, subject] of subjects.entries()) {
      yield* repository.commit(worktree.path, subject, { [`${id}-${n}.txt`]: `${n}\n` })
    }
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

describe("a merge", () => {
  test("that brings a commit reverting another ticket puts it on that ticket's scorecard", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("t-1").ticket("t-2").seeds },
      Effect.gen(function* () {
        const queue = yield* makeQueue({ repo: "/repo", base: "main" })
        yield* queue.offer(yield* finished("t-1" as TicketId, ["Do t-1 (t-1)"]))
        yield* queue.settled
        yield* queue.offer(
          yield* finished("t-2" as TicketId, ['Revert "Do t-1 (t-1)"', "Do t-2 (t-2)"]),
        )
        yield* queue.settled
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<void, unknown, Env | Scope.Scope>,
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const updates = ran.events.filter((each) => each.kind === "score_update")
    expect(updates).toEqual([
      expect.objectContaining({ ticket: "t-1", by: "t-2", revert: expect.any(String) }),
    ])
    const at = (kind: string, ticket: string) =>
      ran.events.findIndex(
        (each) => each.kind === kind && "ticket" in each && each.ticket === ticket,
      )
    // It comes as t-2 merges, before its closed record, after t-1's score.
    expect(at("score_update", "t-1")).toBeGreaterThan(at("score", "t-1"))
    expect(at("score_update", "t-1")).toBeLessThan(at("closed", "t-2"))
    expect(ran.events.filter((each) => each.kind === "score").map((each) => each.ticket)).toEqual([
      "t-1",
      "t-2",
    ])
  })
})

describe("the live stream", () => {
  test("writes each ticket_end's score on the next line of the file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tutti-scorecard-"))
    mkdirSync(join(repo, ".tutti"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const stream = yield* EventStream
        yield* stream.emit({ kind: "verifier", ticket: "t-1", detail: "began" })
        yield* stream.emit({ kind: "verifier", ticket: "t-1", detail: "ended", verdict: "pass" })
        yield* stream.emit({
          kind: "ticket_end",
          ticket: "t-1",
          outcome: "merged",
          phase: "Done",
          seconds: 30,
          turns: 2,
          hand_backs: { resolve: 0, fix: 0 },
          phases: { working: 25 },
          cost_usd: 0.4,
        })
        yield* stream.emit({ kind: "done", text: "READY_EMPTY after 1 tickets" })
      }).pipe(
        Effect.scoped,
        Effect.provide(EventStream.layer({ repo, run: "2026-11-03T10:00:00.000+02:00" })),
      ),
    )
    const lines = readFileSync(join(repo, eventsFile), "utf8").trimEnd().split("\n")
    expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
      "verifier",
      "verifier",
      "ticket_end",
      "score",
      "done",
    ])
    const score = decodeLine(lines[3] ?? "")
    expect(score._tag).toBe("Success")
    expect(JSON.parse(lines[3] ?? "")).toMatchObject({
      ticket: "t-1",
      outcome: "merged",
      verifier: { rounds: 1, passed: 1, failed: 0, last: "pass", last_fix_verified: true },
      working: 25,
      cost_usd: 0.4,
    })
  })
})

describe("the run's end", () => {
  test("puts a follow-up its worker filed and the run didn't take up on its ticket's scorecard", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-scorecard-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-scorecard-run-")))
    const id = "t-1" as TicketId
    const ran = await scenario(
      {
        // Scoped to t-1: the follow-up, filed outside the scope, is left for a later run.
        config: { ticket: id, repo },
        backlog: backlog().ticket(id).seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          [id]: [
            claimsAndCloses(id, {
              claim: Effect.asVoid(
                Effect.orDie(
                  Effect.gen(function* () {
                    yield* world.beads.update(id, { claim: true })
                    yield* advance("1 second")
                    yield* world.beads.create({ title: "Follow it up", blockedBy: [id] })
                  }),
                ),
              ),
              commit: Effect.asVoid(
                Effect.orDie(
                  world.repository.commit(join(root, id), `Change (${id})`, { "a.txt": "x\n" }),
                ),
              ),
              close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
            }),
          ],
        }),
      },
      Effect.gen(function* () {
        mkdirSync(join(root, id), { recursive: true })
        yield* (yield* Git).addWorktree(repo, join(root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
        const fiber = yield* Effect.forkChild(
          Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
        )
        return yield* Fiber.join(fiber)
      }),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const follow = ran.issues.find((issue) => issue.title === "Follow it up")
    expect(follow).toBeDefined()
    const updates = ran.events.filter((each) => each.kind === "score_update")
    expect(updates).toEqual([expect.objectContaining({ ticket: id, follow_up: follow?.id })])
    // Before the run's end record, after the ticket's score.
    const at = (kind: string) => ran.events.findIndex((each) => each.kind === kind)
    expect(at("score_update")).toBeGreaterThan(at("score"))
    expect(at("score_update")).toBeLessThan(at("end"))
    // The summary's Scores line counts it.
    expect(ran.exit.value.summary.figures.map(figuresText)).toContain(
      "Scores  1 of 1 merged first time · 1 follow-up",
    )
  })
})
