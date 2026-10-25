// A crashed run's workers carried over though the next run has written state.json before carry-over
// (§ 4.8): the live Store stamps this run on every commit, so carry-over judges by the run
// state.json named as the Store read it, its previousRun, not by the file's own stamp.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Context, Effect, Fiber, Layer } from "effect"
import { carriedTickets, crashedWhy } from "../src/run/carry.ts"
import { run } from "../src/run/run.ts"
import { resumedText } from "../src/run/told.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  type RunStamp,
  type State,
  Store,
  statePath,
  stateText,
  type TicketRecord,
} from "../src/services/Store.ts"
import { claimsAndCloses, withoutNotes } from "../src/testing/AgentHost.ts"
import { backlog, expectPhases, scenario } from "./harness.ts"

/** A new folder, its real path. */
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-carry-${name}-`)))

/** The pid of a process that has ended. */
const endedPid = (): number => Bun.spawnSync(["true"]).pid

/** The run that crashed, having written state.json last. */
const crashed: RunStamp = { pid: endedPid(), started: "2026-10-19T08:00:00Z", version: "0.1.0" }

/** This run, as the live Store stamps it. */
const thisRun: RunStamp = { pid: process.pid, started: "2026-10-23T09:00:00Z", version: "0.2.0" }

/** What a run that crashed left of a ticket it had in progress: no suspension, no phase. */
const crashRecord = (root: string, id: string): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  resumes: 0,
  metadata: { checked_ahead: { orig: "0123456" } },
})

/** Writes state.json in `repo` as the crashed run left it, with crash records of `ids`. */
const leave = (repo: string, root: string, ids: ReadonlyArray<string>, stamp?: RunStamp) => {
  const state: State = {
    version: 1,
    ...(stamp === undefined ? {} : { run: stamp }),
    tickets: Object.fromEntries(ids.map((id) => [id, crashRecord(root, id)])),
  }
  mkdirSync(join(repo, ".tutti", "run"), { recursive: true })
  writeFileSync(statePath(repo), stateText(state))
}

/** The live Store of `repo`, writing as this run. */
const liveStore = (repo: string) =>
  Store.layer({ repo, run: thisRun }).pipe(Layer.provide(BunFileSystem.layer))

describe("a crashed run's records after the next run's first write", () => {
  test("are still carried over, the Store keeping the stamp it read", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    leave(repo, root, ["t-1", "t-2"], crashed)
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const before = yield* carriedTickets
        yield* store.unsetMetadata("t-1" as TicketId, "checked_ahead")
        const after = yield* carriedTickets
        return { before, after, previous: store.previousRun, stamped: (yield* store.state).run }
      }).pipe(Effect.provide(liveStore(repo))),
    )
    expect([...seen.before].sort()).toEqual(["t-1" as TicketId, "t-2" as TicketId])
    expect([...seen.after].sort()).toEqual(["t-1" as TicketId, "t-2" as TicketId])
    expect(seen.previous).toEqual(crashed)
    expect(seen.stamped).toEqual(thisRun)
  })

  test("are not taken for a crash's when state.json named no run", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    leave(repo, root, ["t-1"])
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.unsetMetadata("t-1" as TicketId, "checked_ahead")
        return { carried: yield* carriedTickets, previous: store.previousRun }
      }).pipe(Effect.provide(liveStore(repo))),
    )
    expect([...seen.carried]).toEqual([])
    expect(seen.previous).toBeUndefined()
  })

  test("a ticket in progress is resumed by the run, after a write before carry-over", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    leave(repo, root, ["t-1"], crashed)
    const ran = await scenario(
      {
        backlog: backlog().ticket("t-1", { status: "in_progress" }).seeds,
        config: { repo },
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => ({
          "t-1": [
            claimsAndCloses("t-1" as TicketId, {
              claim: Effect.asVoid(
                Effect.orDie(world.beads.update("t-1" as TicketId, { claim: true })),
              ),
              commit: Effect.asVoid(
                Effect.orDie(
                  world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
                ),
              ),
              close: Effect.asVoid(Effect.orDie(world.beads.close("t-1" as TicketId, "done"))),
            }),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        mkdirSync(join(root, "t-1"), { recursive: true })
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        // The live Store, built in the scenario's scope, so its writer goes on for the run.
        const store = Context.get(yield* Layer.build(liveStore(repo)), Store)
        // A write before carry-over, as putBackLeft's clearing of a train's mark is.
        yield* store.unsetMetadata("t-1" as TicketId, "checked_ahead")
        const fiber = yield* Effect.forkChild(
          Effect.scoped(run({ version: "0.2.0", base: "main" })).pipe(
            Effect.provideService(Store, store),
          ),
        )
        return yield* Fiber.join(fiber)
      }),
    )
    expectPhases(ran, { "t-1": "Done" })
    const resumed = ran.sent.flatMap((sent) =>
      sent._tag === "Resumed" && sent.ticket === "t-1" ? [sent.session.sessionId] : [],
    )
    expect(resumed).toEqual(["session-t-1"])
    const texts = ran.sent.flatMap((sent) =>
      sent._tag === "Message" && sent.ticket === "t-1"
        ? [withoutNotes(String(sent.message.message.content))]
        : [],
    )
    expect(texts).toEqual([resumedText("t-1" as TicketId, crashedWhy)])
  })
})
