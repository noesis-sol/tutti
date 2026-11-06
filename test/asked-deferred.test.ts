// A ticket whose worker both filed a question and deferred it (tutti-20rn; § 4.8's The other
// carry-over cases, § 5.1's Working → Asked): the question is why it stopped, so the run takes it
// Asked, the next run carries it Asked rather than drop it as deferred, and it comes back with its
// answer, put back in progress.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { askedDeferralNote } from "../src/run/asked.ts"
import { askedWhy, questionKey } from "../src/run/carry.ts"
import { run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { answeredText } from "../src/run/told.ts"
import type { Status, TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import type { State, TicketRecord } from "../src/services/Store.ts"
import { Store } from "../src/services/Store.ts"
import {
  bash,
  filesQuestion,
  result,
  type SessionScript,
  sleep,
  run as step,
  turn,
  withoutNotes,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1" as TicketId

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-asked-deferred-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What the last run saved of t-1, its worktree under `root`. */
const savedRecord = (root: string, fields: Partial<TicketRecord>): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  resumes: 0,
  metadata: {},
  ...fields,
})

/** As saveAsked saves a ticket waiting on question q-1. */
const askedRecord = (root: string) =>
  savedRecord(root, {
    suspended: askedWhy,
    phase: "Asked",
    metadata: { [questionKey]: "q-1" },
  })

/** A whole plain run on main with `saved` in state.json, t-1's worktree there if it is saved. */
const runs = async (plan: {
  readonly seeds: ReadonlyArray<Seed>
  readonly saved: (root: string) => Readonly<Record<string, TicketRecord>>
  readonly scripts?: (world: World, root: string) => Scripts
  /** The tickets whose worktrees are there as the run starts: those saved, by default. */
  readonly worktrees?: ReadonlyArray<string>
  /** The ready polls to run through, a poll's time apart, for a run that outlives its first look. */
  readonly polls?: number
}) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let state: State | undefined
  const ran = await scenario(
    {
      backlog: plan.seeds,
      config: { repo, settings: { ...appConfig().settings, concurrent: 2 } },
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, tickets: plan.saved(root) },
      scripts: (world: World) => plan.scripts?.(world, root) ?? {},
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const each of plan.worktrees ?? Object.keys(plan.saved(root))) {
        mkdirSync(join(root, each), { recursive: true })
        yield* git.addWorktree(repo, join(root, each), { branch: `tutti/${each}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      for (let i = 0; i < (plan.polls ?? 0); i++) {
        for (let j = 0; j < 200; j++) yield* Effect.yieldNow
        yield* advance(readyPoll)
        for (let j = 0; j < 200; j++) yield* Effect.yieldNow
      }
      const outcome = yield* Fiber.join(fiber)
      state = yield* (yield* Store).state
      return outcome
    }),
  )
  if (state === undefined) throw new Error(`the run failed: ${ran.exit}`)
  return { ran, state }
}

const sessionsOf = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    (sent._tag === "Started" || sent._tag === "Resumed") && sent.ticket === id
      ? [`${sent._tag} ${sent.session.sessionId}`]
      : [],
  )

const textsOf = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id
      ? [withoutNotes(String(sent.message.message.content))]
      : [],
  )

/** Commits a change naming `ticket` and closes it, having noted the status its worker found. */
const finishes = (
  world: World,
  root: string,
  ticket: TicketId,
  found: (status: Status) => void = () => {},
  meanwhile: ReadonlyArray<SessionScript[number]> = [],
): SessionScript =>
  turn(
    [
      step(
        Effect.orDie(world.beads.show(ticket)).pipe(
          Effect.flatMap((issue) => Effect.sync(() => found(issue.status))),
        ),
      ),
      ...meanwhile,
      ...bash(
        `git commit -am "Change (${ticket})"`,
        orDie(
          world.repository.commit(join(root, ticket), `Change (${ticket})`, {
            [`${ticket}.txt`]: "x\n",
          }),
        ),
      ),
      ...bash(`bd close ${ticket}`, orDie(world.beads.close(ticket, "done"))),
    ],
    result(`Finished ${ticket}.`),
  )

/** Files a question blocking t-1, and defers t-1 as well. */
const asksAndDefers = (world: World): SessionScript =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        world.beads.create({ title: "Which way?", labels: ["human"], blocks: [id] }),
        world.beads.defer(id, { reason: "Asked the maintainer" }),
      ),
    ),
  })

/** Closes the questions blocking t-1. */
const answers = (world: World): Effect.Effect<void> =>
  orDie(
    Effect.gen(function* () {
      for (const dependency of (yield* world.beads.show(id)).dependencies) {
        if (dependency.issue?.labels.includes("human") === true) {
          yield* world.beads.close(dependency.id, "answered")
        }
      }
    }),
  )

describe("carry-over: a ticket deferred as well as asked about", () => {
  test("saved Asked, its question closed: resumed with the answered message, in progress", async () => {
    let found: Status | undefined
    const { ran, state } = await runs({
      seeds: backlog()
        .ticket("q-1", { labels: ["human"], title: "Which way?", status: "closed" })
        .ticket(id, { status: "deferred", blockedBy: ["q-1"] }).seeds,
      saved: (root) => ({ [id]: askedRecord(root) }),
      scripts: (world, root) => ({
        [id]: [
          finishes(world, root, id, (status) => {
            found = status
          }),
        ],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { [id]: "Done" })
    expect(sessionsOf(ran)).toEqual([`Resumed session-${id}`])
    expect(textsOf(ran)).toEqual([answeredText({ id, question: "q-1", title: "Which way?" })])
    expect(found).toBe("in_progress")
    expect(ran.log.some((text) => text.includes("is deferred since"))).toBe(false)
    expectLog(ran, [
      /waited on q-1, which is answered since/,
      /ANSWERED: q-1 \(Which way\?\) is answered, so t-1 comes back/,
      "  t-1: deferred while it waited on its question; back in progress, as that is answered",
    ])
    expect(state.tickets[id]).toBeUndefined()
  })

  test("saved Asked, its question still open: Asked again and saved, its answer yet to come", async () => {
    const { ran, state } = await runs({
      seeds: backlog()
        .ticket("q-1", { labels: ["human"], title: "Which way?" })
        .ticket(id, { status: "deferred", blockedBy: ["q-1"] }).seeds,
      saved: (root) => ({ [id]: askedRecord(root) }),
    })
    expectPhases(ran, { [id]: "Asked" })
    expect(sessionsOf(ran)).toEqual([])
    expect(ran.log.some((text) => text.includes("is deferred since"))).toBe(false)
    expect(state.tickets[id]).toEqual(
      expect.objectContaining({
        suspended: askedWhy,
        phase: "Asked",
        metadata: { [questionKey]: "q-1" },
      }),
    )
  })

  test("suspended working, with a question open: Asked, as a settled worker's reading is", async () => {
    const { ran } = await runs({
      seeds: backlog()
        .ticket("q-1", { labels: ["human"], title: "Which way?" })
        .ticket(id, { status: "deferred", blockedBy: ["q-1"] }).seeds,
      saved: (root) => ({ [id]: savedRecord(root, { suspended: "quit", phase: "Stopped" }) }),
    })
    expectPhases(ran, { [id]: "Asked" })
    expect(sessionsOf(ran)).toEqual([])
  })

  test("suspended working, no question waiting: deferred since, and dropped", async () => {
    const { ran, state } = await runs({
      seeds: backlog()
        .ticket("q-1", { labels: ["human"], title: "Which way?", status: "closed" })
        .ticket(id, { status: "deferred", blockedBy: ["q-1"] }).seeds,
      saved: (root) => ({ [id]: savedRecord(root, { suspended: "quit", phase: "Stopped" }) }),
    })
    expect(sessionsOf(ran)).toEqual([])
    expect(ran.log.some((text) => text.includes("is deferred since"))).toBe(true)
    expect(state.tickets[id]).toBeUndefined()
  })
})

describe("within a run: a worker that asks and defers its ticket", () => {
  test("is taken Asked, and once answered comes back in progress, with a note", async () => {
    let found: Status | undefined
    let notes: string | undefined
    const other = "t-2" as TicketId
    const { ran } = await runs({
      seeds: backlog().ticket(id).ticket(other).seeds,
      saved: () => ({}),
      worktrees: [id, other],
      polls: 12,
      scripts: (world, root) => ({
        [id]: [
          asksAndDefers(world),
          finishes(
            world,
            root,
            id,
            (status) => {
              found = status
            },
            [
              step(
                Effect.orDie(world.beads.show(id)).pipe(
                  Effect.flatMap((issue) =>
                    Effect.sync(() => {
                      notes = issue.notes
                    }),
                  ),
                ),
              ),
            ],
          ),
        ],
        // t-2 answers t-1's question, then goes on past ready polls.
        [other]: [
          finishes(world, root, other, undefined, [
            sleep(Duration.times(readyPoll, 2)),
            step(answers(world)),
            sleep(Duration.times(readyPoll, 3)),
          ]),
        ],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { [id]: "Done", [other]: "Done" })
    expect(found).toBe("in_progress")
    expect(notes).toContain(askedDeferralNote)
    const told = textsOf(ran).at(-1) ?? ""
    expect(told).toMatch(/your question \S+ \(Which way\?\) is answered/)
    expect(sessionsOf(ran).map((each) => each.split(" ")[0])).toEqual(["Started", "Resumed"])
    expectLog(ran, [
      /ASKED: t-1 waits on your answer/,
      /ANSWERED: \S+ \(Which way\?\) is answered, so t-1 comes back/,
      "  t-1: deferred while it waited on its question; back in progress, as that is answered",
    ])
  })
})
