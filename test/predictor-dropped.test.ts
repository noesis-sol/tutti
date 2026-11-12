// The predictor is gone (tutti-wxvk): a run guesses no ticket's files, and writes no
// `predicted_files`. Since tutti-k4if.1 a shared file holds no ticket back, so a guess of files
// could only warn LIKELY_CONFLICT, which two running tickets changing one file get from their
// worktrees anyway. The `predicted_files` a ticket already carries (orchestra's predictor writes
// it, as did tutti's before) is still read as its footprint, marked (predicted), for a ticket
// naming nothing else.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Tag } from "../src/core/log.ts"
import { Organs, organNames } from "../src/organs/Organs.ts"
import { ticketText } from "../src/organs/ticketText.ts"
import { footprintOf, showFootprint } from "../src/run/footprint.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type SessionScript, run as step, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Backlog, type Seed } from "../src/testing/Beads.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const tracked = ["README.md", "src/a.ts", "src/b.ts"]
const repository = repoFiles(tracked)

const bare: Issue = {
  id: "t-1" as TicketId,
  title: "Make the greeting friendlier",
  description: "Say hello by name.",
  design: "",
  acceptance: "The greeting names you.",
  notes: "",
  status: "open",
  priority: 2,
  type: "task",
  assignee: "",
  labels: ["ui"],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "2026-10-17T00:00:00Z",
  closeReason: "",
}

describe("the organs", () => {
  test("have no predictor, and the log no PREDICT_FAILED tag", () => {
    expect([...organNames]).not.toContain("predictor")
    expect(Object.values(Tag)).not.toContain("PREDICT_FAILED")
  })

  test("read a ticket as bd show gives it: its ID and title, then each text with words", () => {
    expect(ticketText(bare)).toBe(
      "t-1: Make the greeting friendlier\nStatus: open · Priority: P2 · Type: task\nLabels: ui\n\n" +
        "Description:\nSay hello by name.\n\nAcceptance criteria:\nThe greeting names you.",
    )
  })
})

describe("a ticket's footprint", () => {
  test("is its predicted_files, marked predicted, only for a ticket naming nothing else", () => {
    const carried = { ...bare, predictedFiles: ["src/a.ts", "nowhere.ts"] }
    expect(showFootprint(footprintOf(bare, repository))).toBe("nothing named")
    expect(showFootprint(footprintOf(carried, repository))).toBe("src/a.ts (predicted)")
    expect(showFootprint(footprintOf({ ...carried, files: ["src/b.ts"] }, repository))).toBe(
      "src/b.ts",
    )
    expect(showFootprint(footprintOf(carried, repository, ["src/b.ts"]))).toBe(
      "src/b.ts (from its branch)",
    )
  })
})

// A whole run with organs, the queue's footprint on and more than one slot: where the predictor
// used to start. The fill reads the footprints' files for real, so the workers wait for the log
// lines they need rather than for TestClock, which a ready poll at a time moves on meanwhile.

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-predictor-dropped-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A ticket naming the files it works on. */
const touching = (...files: ReadonlyArray<string>): Omit<Seed, "id"> => ({ metadata: { files } })

/** Claims `id`, commits a file of its own in its worktree, waits for `after`, then closes it. */
const works = (
  world: World,
  root: string,
  id: TicketId,
  after?: Effect.Effect<void>,
): SessionScript =>
  turn([
    step(orDie(world.beads.update(id, { claim: true }))),
    step(
      orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
    ),
    ...(after === undefined ? [] : [step(after)]),
    step(orDie(world.beads.close(id, "done"))),
  ])

interface Organed {
  readonly calls: ReadonlyArray<OrganCallRecord>
  /** Each ticket's predicted_files metadata at the end of the run. */
  readonly kept: Readonly<Record<string, string | undefined>>
}

/**
 * A whole plain run on main of `seeds`, `concurrent` at a time with the queue's footprint on, with
 * organs whose every answer is a prediction, were one asked; src/a.ts and src/b.ts are in the
 * repository.
 */
const runs = (plan: {
  readonly seeds: ReadonlyArray<Seed>
  readonly concurrent: number
  readonly scripts: (world: World, root: string) => Readonly<Record<string, SessionScript[]>>
}): Promise<Ran<Outcome & Organed>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = appConfig().settings
  const calls: Array<OrganCallRecord> = []
  const organs = Organs.layer.pipe(
    Layer.provideMerge(cannedLayer({ predictor: { files: ["src/a.ts"] } }, calls)),
  )
  return scenario(
    {
      config: {
        repo,
        worktrees: root,
        settings: {
          ...settings,
          concurrent: plan.concurrent,
          queue: { ...settings.queue, footprint: true },
        },
      },
      backlog: plan.seeds,
      git: {
        dir: repo,
        files: { "README.md": "# r\n", "src/a.ts": "// a\n", "src/b.ts": "// b\n" },
      },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const seed of plan.seeds) {
        yield* git.addWorktree(repo, join(root, seed.id), {
          branch: `tutti/${seed.id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main" }))
      // A ready poll every few milliseconds, until the run ends.
      const clock = yield* Effect.forkChild(
        Effect.forever(
          Effect.andThen(
            Effect.promise(() => Bun.sleep(5)),
            advance(readyPoll),
          ),
        ),
      )
      const outcome = yield* Fiber.join(fiber)
      yield* Fiber.interrupt(clock)
      const backlog = yield* Backlog
      const kept: Record<string, string | undefined> = {}
      for (const seed of plan.seeds) {
        const files = (yield* Effect.orDie(backlog.get(seed.id)))?.metadata.predicted_files
        kept[seed.id] = typeof files === "string" ? files : undefined
      }
      return { ...outcome, calls, kept }
    }).pipe(Effect.provide(organs)),
  )
}

const value = <A>(ran: Ran<A>): A => {
  if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
  return ran.exit.value
}

describe("a run with organs, footprints on and more than one slot", () => {
  test("guesses no ticket's files: a ticket naming nothing starts beside any, unwarned", async () => {
    const ran = await runs({
      seeds: backlog()
        .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
        .ticket("t-2", { priority: 1, title: "Make the greeting friendlier" }).seeds,
      concurrent: 2,
      scripts: (world, root) => ({
        "t-1": [works(world, root, "t-1" as TicketId)],
        "t-2": [works(world, root, "t-2" as TicketId)],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expectLog(ran, [/t-1 dispatching/, /^ {2}t-2 footprint: nothing named$/])
    expect(
      ran.log.filter((text) => /footprint predicted|LIKELY_CONFLICT|skipping/.test(text)),
    ).toEqual([])
    const { calls, kept } = value(ran)
    expect(calls).toEqual([])
    expect(kept).toEqual({ "t-1": undefined, "t-2": undefined })
  }, 30_000)

  test("still reads the predicted_files a ticket carries: it starts warned beside a ticket on them", async () => {
    const ran = await runs({
      seeds: backlog()
        .ticket("t-1", { priority: 0, ...touching("src/a.ts") })
        .ticket("t-2", {
          priority: 1,
          title: "Make the greeting friendlier",
          metadata: { predicted_files: '["src/a.ts"]' },
        }).seeds,
      concurrent: 2,
      scripts: (world, root) => ({
        "t-1": [works(world, root, "t-1" as TicketId)],
        "t-2": [works(world, root, "t-2" as TicketId)],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expectLog(ran, [
      /t-2 dispatching/,
      /^ {2}t-2 footprint: src\/a\.ts \(predicted\)$/,
      /^ {2}LIKELY_CONFLICT: t-2 starts beside t-1, both working on src\/a\.ts; the second to merge may conflict$/,
    ])
    expect(ran.log.some((text) => text.includes("skipping"))).toBe(false)
    const { calls, kept } = value(ran)
    expect(calls).toEqual([])
    expect(kept).toEqual({ "t-1": undefined, "t-2": '["src/a.ts"]' })
  }, 30_000)
})
