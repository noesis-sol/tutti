// --auto-answer and a question it took at once that the run leaves open (autoAnswer.ts's
// notifyLeftOpen, § 7.9): its asked record notified nothing, as tutti was to answer it at the next
// look; a run that winds down or ends first, answering none, notifies it then, once.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Queue } from "effect"
import {
  AutoAnswer,
  makeAutoAnswering,
  notifyLeftOpen,
  takenAtOnce,
} from "../src/run/autoAnswer.ts"
import type { DrainRequest } from "../src/run/drain.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { Beads, TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import type { Notifier } from "../src/services/Notifier.ts"
import { filesQuestion } from "../src/testing/AgentHost.ts"
import { appConfig, layer as appConfigLayer } from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer } from "../src/testing/Beads.ts"
import { Captured as Records } from "../src/testing/EventStream.ts"
import { Captured, layer as notifierLayer } from "../src/testing/Notifier.ts"
import { backlog, expectPhases, type Ran, scenario, type World } from "./harness.ts"

const id = "t-1" as TicketId

/** Runs `effect` with bare --auto-answer, the backlog holding `seeds`. */
const withAuto = <A>(
  effect: Effect.Effect<A, never, Beads | Notifier | Captured>,
  seeds: Parameters<typeof beadsLayer>[0],
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const auto = yield* makeAutoAnswering(Duration.zero, 0)
      return yield* Effect.provideService(effect, AutoAnswer, auto)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), notifierLayer.pipe(Layer.provide(appConfigLayer()))),
      ),
    ),
  )

describe("notifyLeftOpen", () => {
  test("notifies each question taken at once still open, once; not one you answered", async () => {
    const notices = await withAuto(
      Effect.gen(function* () {
        yield* takenAtOnce(id, "q-1" as TicketId, "Which store?")
        yield* takenAtOnce("t-2" as TicketId, "q-2" as TicketId, "Which port?")
        yield* notifyLeftOpen
        yield* notifyLeftOpen
        return yield* (yield* Captured).notices
      }),
      [
        { id: "q-1", title: "Which store?", labels: ["human"] },
        { id: "q-2", title: "Which port?", labels: ["human"], status: "closed" },
      ],
    )
    expect(notices).toEqual(["t-1 needs your answer · Which store?"])
  })

  test("one bd can't show notifies anyway", async () => {
    const notices = await withAuto(
      Effect.gen(function* () {
        yield* takenAtOnce(id, "q-9" as TicketId, "Which store?")
        yield* notifyLeftOpen
        return yield* (yield* Captured).notices
      }),
      [],
    )
    expect(notices).toEqual(["t-1 needs your answer · Which store?"])
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-auto-answer-left-open-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A question's metadata: two options, the second recommended. */
const withOptions = {
  options: [
    { label: "Postgres", description: "a server to run" },
    { label: "SQLite", description: "one file" },
  ],
  recommended: 1,
}

/** t-1's worker files a question `Which store?`, and puts t-1 back to open. */
const asks = (world: World) =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        world.beads.create({
          title: "Which store?",
          labels: ["human"],
          blocks: [id],
          metadata: withOptions,
        }),
        world.beads.update(id, { status: "open" }),
      ),
    ),
  })

/**
 * A whole run of t-1, whose worker asks, with bare --auto-answer and bd refusing every answer: the
 * run is told to wind down, as SIGUSR1 does, once bd has first refused, before a look tries again.
 */
const drainedBeforeTheAnswer = (): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const drains = Effect.runSync(Queue.unbounded<DrainRequest>())
  return scenario(
    {
      config: { repo, autoAnswer: Duration.zero, settings: { ...appConfig().settings } },
      backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => ({ [id]: [asks(world)] }),
    },
    Effect.gen(function* () {
      mkdirSync(join(root, id), { recursive: true })
      yield* (yield* Git).addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      yield* (yield* Backlog).fail("human respond", { stderr: "Error: busy", times: Infinity })
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main", drains }))
      const records = (yield* Records).records
      const refused = Effect.map(records, (all) =>
        all.some((record) => record.kind === "warn" && record.text.includes("could not answer")),
      )
      while (!(yield* refused)) yield* Effect.promise(() => Bun.sleep(2))
      yield* Queue.offer(drains, { on: true, how: "by SIGUSR1" })
      return yield* Fiber.join(fiber)
    }),
  )
}

describe("--auto-answer and a question the run leaves open", () => {
  test("taken at once, then a drain before it is answered: notifies once", async () => {
    const ran = await drainedBeforeTheAnswer()
    expectPhases(ran, { [id]: "Asked" })
    expect(ran.events.filter((record) => record.kind === "asked")).toEqual([
      expect.objectContaining({ ticket: id, auto_answering: true }),
    ])
    expect(ran.events.some((record) => record.kind === "auto_answered")).toBe(false)
    expect(ran.notices.filter((text) => text.includes("needs your answer"))).toEqual([
      "t-1 needs your answer · Which store?",
    ])
  })
})
