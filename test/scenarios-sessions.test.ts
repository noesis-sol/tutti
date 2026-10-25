// Session scenarios (§ 14 M6): quit mid-run and resume, every worker carrying on. Each is two whole
// runs under TestClock in one world, a run and the next one in the same repository: the in-memory
// Beads and Git, state.json and the scripted sessions carry over from the first run to the second,
// and each ticket's script plays its next session as the second run resumes it. Each asserts both
// runs' log lines, event records, phases (with no PHASE_BUG) and exit codes, and that neither left
// a fiber or a process behind it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Fiber, Queue, type Scope } from "effect"
import type { MessageUuid } from "../src/agent/AgentHost.ts"
import { Attention, type Policy } from "../src/agent/Attention.ts"
import { askedWhy, questionKey } from "../src/run/carry.ts"
import { UiCommand } from "../src/run/commands.ts"
import type { EventRecord } from "../src/run/events.ts"
import { type Left, RunFibers } from "../src/run/fibers.ts"
import { line } from "../src/run/log.ts"
import type { PhaseTag } from "../src/run/phase.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { answeredText, goneText, nudgeText, resumedText } from "../src/run/told.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store } from "../src/services/Store.ts"
import {
  awaitInterrupt,
  bash,
  canUseTool,
  gone,
  interruptedResult,
  Recording,
  result,
  type Sent,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { allowAll } from "../src/testing/Attention.ts"
import type { Seed } from "../src/testing/Beads.ts"
import type { Script as ChecksScript } from "../src/testing/Checks.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectLog,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-scenarios-sessions-${name}-`)))

const defaults = appConfig().settings
type Settings = typeof defaults

const ctrlC = quitBy("SIGINT")

/** Where the runs' main checkout and worktrees are, for the workers' scripts. */
interface Places {
  readonly repo: string
  readonly root: string
}

// The workers.

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What a ticket's worker's commands do to the in-memory Beads and Git. */
const commands = (world: World, places: Places, id: TicketId) => ({
  claim: bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
  commit: bash(
    `git commit -am "Change (${id})"`,
    orDie(
      world.repository.commit(join(places.root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
    ),
  ),
  close: bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
})

/** Waits, in real time, until `id`'s worker has claimed it, or closed it: the run dispatched it. */
const untilClaimed = (world: World, id: TicketId) =>
  Effect.orDie(
    Effect.gen(function* () {
      for (let i = 0; i < 2000; i++) {
        if ((yield* world.beads.show(id)).status !== "open") return
        yield* Effect.promise(() => Bun.sleep(2))
      }
      throw new Error(`${id} was never claimed`)
    }),
  )

/**
 * Sleeps `duration` on TestClock, adding `id` to `asleep` as it starts, so that a `during` can wait
 * for the sleep before it moves the clock: moved before, the clock would never wake it.
 */
const sleepsAs = (asleep: Set<string>, id: string, duration: Duration.Input) =>
  step(
    Effect.andThen(
      Effect.sync(() => asleep.add(id)),
      Effect.sleep(duration),
    ),
  )

/** A turn that commits the ticket's change and closes it, after `first`, as a worker does. */
const finishes = (
  world: World,
  places: Places,
  id: TicketId,
  first: ReadonlyArray<SessionScript[number]> = [],
): SessionScript => {
  const c = commands(world, places, id)
  return turn([...first, ...c.commit, ...c.close], result(`Closed ${id}.`))
}

/** A turn that claims the ticket, does `meanwhile`, and is at work until it is interrupted. */
const atWork = (
  world: World,
  places: Places,
  id: TicketId,
  meanwhile: ReadonlyArray<SessionScript[number]> = [],
): SessionScript =>
  turn([...commands(world, places, id).claim, ...meanwhile, awaitInterrupt], interruptedResult)

/** Bash `rm -rf build`, which needs asking. */
const rm = canUseTool("Bash", { command: "rm -rf build" })

// The two runs.

/** What a run's `during` can do beside it. */
interface During {
  /** The run's requests to quit: SIGINT's, SIGTERM's, SIGHUP's. */
  readonly quits: Queue.Queue<QuitRequest>
  /** Offers a command as the dashboard would, and waits for the run to take it. */
  readonly command: (command: UiCommand) => Effect.Effect<void, never, Env>
  /** Whether the run has ended. */
  readonly ended: Effect.Effect<boolean>
}

/** One of the two runs. */
interface RunPlan {
  /** With a dashboard; plain otherwise. */
  readonly dashboard?: boolean
  /** Runs beside the run, before it is joined. */
  readonly during?: (during: During) => Effect.Effect<void, unknown, Env>
}

interface Plan {
  readonly backlog: ReadonlyArray<Seed>
  /** The tickets whose worktrees are made in git before the first run. */
  readonly worktrees: ReadonlyArray<string>
  /** Laid over the settings: the defaults with 3 workers. */
  readonly settings?: Partial<Settings>
  readonly checks?: ChecksScript
  /** How Attention answers requests as they open, in either run. */
  readonly policy: Policy
  /** Each ticket's sessions in both runs, in the order they start or resume. */
  readonly scripts: (world: World, places: Places) => Scripts
  /** Runs before the first run starts. */
  readonly before?: (places: Places) => Effect.Effect<void, unknown, Env>
  readonly first: RunPlan
  /** Runs between the runs: what you do meanwhile. */
  readonly between?: (places: Places) => Effect.Effect<void, unknown, Env>
  readonly second: RunPlan
}

/** What one of the runs left. */
interface Run {
  readonly outcome: Outcome
  /** state.json at its end. */
  readonly state: State
  /** Its log's lines, without their time. */
  readonly log: ReadonlyArray<string>
  readonly events: ReadonlyArray<EventRecord>
  /** What its workers were sent, in order. */
  readonly sent: ReadonlyArray<Sent>
  /** The FiberSets still holding fibers once its scope had closed. */
  readonly left: ReadonlyArray<Left>
}

interface Both {
  readonly first: Run
  readonly second: Run
}

/** Waits, in real time, until `ready` holds: for what happens outside the TestClock. */
const until = <E, R>(what: string, ready: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000; i++) {
      if (yield* ready) return
      yield* Effect.promise(() => Bun.sleep(1))
    }
    throw new Error(`waited in vain for ${what}:\n${(yield* texts).join("\n")}`)
  })

/** Moves TestClock on by `total`, a minute at a time, letting the run catch up after each. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const minutes = Duration.toMinutes(Duration.fromInputUnsafe(total))
    for (let i = 0; i < minutes; i++) {
      yield* advance("1 minute")
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

/** One whole run on main, in its own scope, and what it left. */
const once = (plan: RunPlan): Effect.Effect<Run, unknown, Env> =>
  Effect.gen(function* () {
    const logged = (yield* texts).length
    const captured = yield* Captured
    const recorded = (yield* captured.records).length
    const recording = yield* Recording
    const sentBefore = (yield* recording.all).length
    const quits = yield* Queue.unbounded<QuitRequest>()
    let shown: ScreenInputs | undefined
    const dashboard: Dashboard = (inputs) =>
      Effect.sync(() => {
        shown = inputs
      })
    const fiber = yield* Effect.forkChild(
      Effect.scoped(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          quits,
          ...(plan.dashboard === true ? { dashboard } : {}),
        }),
      ),
    )
    if (plan.during !== undefined) {
      yield* plan.during({
        quits,
        command: (command) =>
          Effect.gen(function* () {
            yield* until(
              "the dashboard",
              Effect.sync(() => shown !== undefined),
            )
            const commands = (shown as ScreenInputs).commands
            yield* Queue.offer(commands, command)
            yield* until(
              "the command to be taken",
              Effect.map(Queue.size(commands), (n) => n === 0),
            )
            yield* Effect.promise(() => Bun.sleep(10))
          }),
        ended: Effect.sync(() => fiber.pollUnsafe() !== undefined),
      })
    }
    const outcome = yield* Fiber.join(fiber)
    return {
      outcome,
      state: yield* (yield* Store).state,
      log: (yield* texts).slice(logged),
      events: (yield* captured.records).slice(recorded),
      sent: (yield* recording.all).slice(sentBefore),
      left: yield* (yield* RunFibers).left,
    } satisfies Run
  })

/** A run on main that is quit or ends, then the next one, each ticket's worktree made first. */
const runs = (plan: Plan): Promise<Ran<Both> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  return scenario(
    {
      config: {
        repo: places.repo,
        settings: { ...defaults, concurrent: 3, ...plan.settings },
      },
      backlog: plan.backlog,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      policy: plan.policy,
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) => plan.scripts(world, places),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.worktrees) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      if (plan.before !== undefined) yield* plan.before(places)
      const first = yield* once(plan.first)
      if (plan.between !== undefined) yield* plan.between(places)
      const second = yield* once(plan.second)
      return { first, second } satisfies Both
    }) as Effect.Effect<Both, unknown, Env | Scope.Scope>,
  ).then((ran) => ({ ...ran, ...places }))
}

// What each scenario asserts.

const bothOf = (ran: Ran<Both>): Both => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the runs failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/**
 * The run ended with `code`, each ticket in the phase named, its end record last, with no
 * PHASE_BUG logged and no fiber left in a FiberSet of the run's.
 */
const expectRun = (each: Run, code: number, phases: Readonly<Record<string, PhaseTag>>) => {
  expect(each.outcome.exitCode).toBe(code)
  expect(
    Object.fromEntries(Object.entries(each.outcome.phases).map(([id, p]) => [id, p._tag])),
  ).toEqual({ ...phases })
  expect(each.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(each.events.at(-1)).toMatchObject({ kind: "end", code })
  expect(each.left).toEqual([])
}

/** The run's log has these lines in this order, with any others between them. */
const expectLines = (each: Run, lines: ReadonlyArray<string | RegExp>) =>
  expectLog({ log: each.log } as Ran<unknown>, lines)

/** The run's event stream has records of these kinds in this order, with any others between them. */
const expectKinds = (each: Run, kinds: ReadonlyArray<EventRecord["kind"]>) =>
  expectEvents({ events: each.events } as Ran<unknown>, kinds)

/** The kinds of what the ticket's worker was sent in the run, in order. */
const sentTo = (each: Run, ticket: string) =>
  each.sent.filter((sent) => sent.ticket === ticket).map((sent) => sent._tag)

/** The ticket's sessions as the run started and resumed them: `Started s` or `Resumed s`. */
const sessionsOf = (each: Run, ticket: string) =>
  each.sent.flatMap((sent) =>
    (sent._tag === "Started" || sent._tag === "Resumed") && sent.ticket === ticket
      ? [`${sent._tag} ${sent.session.sessionId}`]
      : [],
  )

/** The messages the ticket's worker was sent in the run, as text. */
const textsOf = (each: Run, ticket: string) =>
  each.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === ticket ? [String(sent.message.message.content)] : [],
  )

const records = <K extends EventRecord["kind"]>(each: Run, kind: K) =>
  each.events.filter((record): record is Extract<EventRecord, { kind: K }> => record.kind === kind)

/** The phases the ticket moved through in the run, from its `phase` records. */
const pathOf = (each: Run, ticket: string) =>
  records(each, "phase").flatMap((record) =>
    record.ticket === ticket ? [record.to ?? "outside"] : [],
  )

const suspendedOf = (each: Run) =>
  records(each, "suspended").map((record) => `${record.ticket} ${record.why}`)

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

const resumedLine = (id: string, why: string) =>
  new RegExp(
    `^ {2}RESUMED: ${id} was suspended as the last run ended \\(${why}\\); resuming its session [0-9a-f-]+ \\(worktree .*/${id}\\)$`,
  )

// The scenarios.

describe("quit mid-run, and the next run", () => {
  test("resumes the worker at work and the one waiting on you, and merges the one merging", async () => {
    let checking = false
    let answering = false
    const asleep = new Set<string>()
    // c's check, on its branch rebased onto main, is under way when you quit, and never ends.
    const hanging = Effect.gen(function* () {
      checking = true
      return yield* Effect.never
    })
    const ran = await runs({
      backlog: backlog().ticket("a").ticket("b").ticket("c").seeds,
      worktrees: ["a", "b", "c"],
      checks: { fast: [hanging] },
      // Nobody answers in the first run; in the second, everything is allowed.
      policy: (request) => (answering ? allowAll(request) : undefined),
      scripts: (world, places) => ({
        // Resumed, a takes a minute and b two, so c merges first in the next run, then a, then b.
        a: [
          atWork(world, places, "a" as TicketId),
          finishes(world, places, "a" as TicketId, [sleepsAs(asleep, "a", "1 minute")]),
        ],
        // b asks once c is dispatched, so that all three are dispatched before its request.
        b: [
          atWork(world, places, "b" as TicketId, [step(untilClaimed(world, "c" as TicketId)), rm]),
          finishes(world, places, "b" as TicketId, [
            sleepsAs(asleep, "b", "2 minutes"),
            rm,
            ...bash("rm -rf build"),
          ]),
        ],
        c: [
          finishes(world, places, "c" as TicketId, commands(world, places, "c" as TicketId).claim),
        ],
      }),
      // main moves on while c runs, so its merge rebases it and checks it.
      before: () =>
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        }),
      first: {
        during: ({ quits }) =>
          Effect.gen(function* () {
            const attention = yield* Attention
            yield* until(
              "b's request and c's check",
              Effect.map(
                attention.current,
                (open) => checking && open.some((request) => request.ticket === "b"),
              ),
            )
            yield* Queue.offer(quits, ctrlC)
          }),
      },
      between: () =>
        Effect.sync(() => {
          answering = true
        }),
      // c's merge needs no time to pass. The clock moves once c has merged and a and b are asleep,
      // so that it doesn't pass their minutes before they sleep through them; its second minute,
      // b's, once a has merged.
      second: {
        during: () =>
          Effect.gen(function* () {
            const merged = (id: string) =>
              until(
                `${id}'s merge`,
                Effect.map(texts, (lines) => lines.some((text) => closedLine(id).test(text))),
              )
            yield* merged("c")
            yield* until(
              "a and b to sleep",
              Effect.sync(() => asleep.size === 2),
            )
            yield* passes("1 minute")
            yield* merged("a")
            yield* passes("1 minute")
          }),
      },
    })
    const { first, second } = bothOf(ran)

    // The first run: quit with Ctrl+C, every worker interrupted, its session saved.
    expectRun(first, 130, { a: "Stopped", b: "Stopped", c: "Stopped" })
    expectLines(first, [
      "QUIT with Ctrl+C: no new tickets; interrupting the workers of a, b, c and saving their sessions for the next run",
      "INTERRUPTED: quit with Ctrl+C; the sessions of a, b, c are saved for the next run",
    ])
    expect(sentTo(first, "a")).toEqual(["Started", "Message", "Interrupted", "Closed"])
    expect(sentTo(first, "b")).toEqual(["Started", "Message", "Interrupted", "Answered", "Closed"])
    // c's merge was cut short: its check killed, it went back in line, to merge next run.
    expect(pathOf(first, "c")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "ToMerge",
      "Stopped",
    ])
    expect(records(first, "phase")).toContainEqual(
      expect.objectContaining({ ticket: "c", cause: "MergeInterrupted" }),
    )
    expect(suspendedOf(first).sort()).toEqual(["a quit", "b quit", "c quit"])
    expectKinds(first, ["dispatch", "dispatch", "dispatch", "attention", "warn", "stop", "end"])
    for (const id of ["a", "b", "c"]) {
      expect(first.state.tickets[id]).toMatchObject({ suspended: "quit", phase: "Stopped" })
    }
    const asked = records(first, "attention").filter((record) => record.ticket === "b")
    expect(asked).toHaveLength(1)

    // The second run: a and b resumed and told to carry on, c merged after its check.
    expectRun(second, 0, { a: "Done", b: "Done", c: "Done" })
    for (const id of ["a" as TicketId, "b" as TicketId]) {
      expect(sessionsOf(second, id)).toEqual([`Resumed ${first.state.tickets[id]?.session}`])
      expect(textsOf(second, id)).toEqual([resumedText(id, "quit")])
    }
    expect(sessionsOf(second, "c")).toEqual([])
    expect(records(second, "dispatch")).toEqual([])
    expect(
      records(second, "resumed")
        .map((record) => `${record.ticket} ${record.why}`)
        .sort(),
    ).toEqual(["a suspended", "b suspended"])
    // b's request, cut off by the quit, is asked again as a new one, and answered.
    const again = records(second, "attention").filter((record) => record.ticket === "b")
    expect(again).toHaveLength(1)
    expect(again[0]?.request).not.toBe(asked[0]?.request)
    expect(sentTo(second, "b")).toContain("Answered")
    expectLines(second, [
      resumedLine("a", "quit"),
      resumedLine("b", "quit"),
      "  c, carried over from the last run, is closed, so it waits to merge",
      closedLine("c"),
      closedLine("a"),
      closedLine("b"),
      "READY_EMPTY after 0 tickets",
    ])
    expectKinds(second, ["resumed", "resumed", "closed", "closed", "closed", "end"])
    // c's branch, rebased onto main before the quit, was checked again before it merged, though
    // main hadn't moved since; a's and b's, rebased onto main as c moved it, as they merged.
    expect(ran.checkRuns.map((each) => each.cwd)).toEqual(
      ["c", "c", "a", "b"].map((id) => join(ran.root, id)),
    )
    expect(second.log.filter((text) => text.startsWith("  rebased tutti/c"))).toEqual([])
    expect(ran.issues.find((issue) => issue.id === "c")?.labels ?? []).not.toContain("unmerged")
    expect(second.state.tickets).toEqual({})
  }, 30_000)
})

describe("an asked ticket", () => {
  test("answered between runs: the next run resumes its worker, told so, and it merges", async () => {
    let question = "" as TicketId
    const ran = await runs({
      backlog: backlog().ticket("t", { title: "Pick a way" }).seeds,
      worktrees: ["t"],
      policy: allowAll,
      scripts: (world, places) => ({
        t: [
          // It files a question for you, blocking its ticket, and puts the ticket back to open.
          turn(
            [
              ...commands(world, places, "t" as TicketId).claim,
              ...bash(
                'bd create --type=task --labels human --deps blocks:t --title "Which way?"',
                orDie(
                  Effect.andThen(
                    world.beads.create({
                      title: "Which way?",
                      labels: ["human"],
                      blocks: ["t" as TicketId],
                    }),
                    world.beads.update("t" as TicketId, { status: "open" }),
                  ),
                ),
              ),
            ],
            result("Asked about t."),
          ),
          finishes(world, places, "t" as TicketId),
        ],
      }),
      first: {},
      // You answer it: bd human respond closes the question.
      between: () =>
        Effect.gen(function* () {
          const saved = (yield* (yield* Store).state).tickets.t?.metadata[questionKey]
          question = String(saved) as TicketId
          yield* (yield* Beads).close(question, "The left one.")
        }),
      second: {},
    })
    const { first, second } = bothOf(ran)

    expectRun(first, 0, { t: "Asked" })
    expect(first.state.tickets.t).toMatchObject({
      suspended: askedWhy,
      phase: "Asked",
      metadata: { [questionKey]: question },
    })
    // Its turn ended: its session closed, keeping its ID.
    expect(sentTo(first, "t")).toEqual(["Started", "Message", "Closed"])
    expect(records(first, "asked")).toEqual([expect.objectContaining({ ticket: "t" })])
    expectLines(first, [
      new RegExp(
        `^ {2}ASKED: t waits on your answer to ${question} \\(Which way\\?\\); answer with: bd human respond ${question};`,
      ),
      "READY_EMPTY after 1 tickets",
    ])
    expectKinds(first, ["dispatch", "asked", "end"])

    expectRun(second, 0, { t: "Done" })
    expect(sessionsOf(second, "t")).toEqual([`Resumed ${first.state.tickets.t?.session}`])
    expect(textsOf(second, "t")).toEqual([
      answeredText({ id: "t" as TicketId, question, title: "Which way?" }),
    ])
    expect(records(second, "resumed")).toEqual([
      expect.objectContaining({ ticket: "t", why: "answered" }),
    ])
    expect(records(second, "dispatch")).toEqual([])
    expectLines(second, [
      `  ANSWERED: ${question} (Which way?) is answered, so t comes back`,
      new RegExp(`^ {2}RESUMED: t's question ${question} is answered; resuming its session `),
      closedLine("t"),
      "READY_EMPTY after 0 tickets",
    ])
    expectKinds(second, ["answered", "resumed", "closed", "end"])
    expect(second.state.tickets).toEqual({})
  }, 30_000)
})

describe("a worker gone", () => {
  test("is resumed once in a run; gone again, it waits for the next run, which resumes it", async () => {
    const goes = (first: ReadonlyArray<SessionScript[number]>): SessionScript =>
      turn([...first, sleep("1 minute"), gone("the process exited")])
    const ran = await runs({
      backlog: backlog().ticket("t").seeds,
      worktrees: ["t"],
      policy: allowAll,
      scripts: (world, places) => ({
        t: [
          goes(commands(world, places, "t" as TicketId).claim),
          goes([]),
          finishes(world, places, "t" as TicketId),
        ],
      }),
      first: { during: () => passes("3 minutes") },
      second: {},
    })
    const { first, second } = bothOf(ran)

    expectRun(first, 3, { t: "Stopped" })
    const session = first.state.tickets.t?.session
    // Gone once: resumed with the same session and told to carry on. Gone again: not resumed.
    expect(sessionsOf(first, "t")).toEqual([`Started ${session}`, `Resumed ${session}`])
    expect(textsOf(first, "t").slice(1)).toEqual([goneText("t" as TicketId)])
    expect(records(first, "resumed")).toEqual([
      expect.objectContaining({ ticket: "t", session, why: "gone" }),
    ])
    expect(suspendedOf(first)).toEqual(["t PAUSED"])
    expect(first.state.tickets.t).toMatchObject({ suspended: "PAUSED", phase: "Stopped" })
    expectLines(first, [
      /^ {2}RESUMED: t's worker is gone \(its session ended: the process exited\) with the ticket in progress; resuming its session /,
      /^PAUSED: t still in_progress, its worker is gone \(its session ended: the process exited\); its session was resumed once in this run already, and the next run resumes it again /,
    ])
    expectKinds(first, ["dispatch", "resumed", "stop", "suspended", "end"])

    // The next run resumes it again, and it finishes.
    expectRun(second, 0, { t: "Done" })
    expect(sessionsOf(second, "t")).toEqual([`Resumed ${session}`])
    expect(textsOf(second, "t")).toEqual([resumedText("t" as TicketId, "PAUSED")])
    expectLines(second, [resumedLine("t", "PAUSED"), closedLine("t")])
    expect(second.state.tickets).toEqual({})
  }, 30_000)
})

describe("the end of a run while a worker waits on you (D19)", () => {
  test("q suspends it; the next run resumes it, asks again, and it merges", async () => {
    let answering = false
    const asleep = new Set<string>()
    const ran = await runs({
      backlog: backlog().ticket("a").ticket("b").seeds,
      worktrees: ["a", "b"],
      policy: (request) => (answering ? allowAll(request) : undefined),
      scripts: (world, places) => ({
        // a asks once b is dispatched, so that both are dispatched before its request.
        a: [
          finishes(world, places, "a" as TicketId, [
            ...commands(world, places, "a" as TicketId).claim,
            step(untilClaimed(world, "b" as TicketId)),
            rm,
          ]),
          finishes(world, places, "a" as TicketId, [rm, ...bash("rm -rf build")]),
        ],
        b: [
          finishes(world, places, "b" as TicketId, [
            ...commands(world, places, "b" as TicketId).claim,
            sleepsAs(asleep, "b", "1 minute"),
          ]),
        ],
      }),
      first: {
        dashboard: true,
        during: ({ command, ended }) =>
          Effect.gen(function* () {
            // Moved before b sleeps, the clock would never wake it.
            yield* until(
              "b to sleep",
              Effect.sync(() => asleep.has("b")),
            )
            yield* passes("2 minutes")
            yield* until(
              "b to merge",
              Effect.map(texts, (log) => log.some((text) => closedLine("b").test(text))),
            )
            // Only a, waiting on you, is left: the run waits.
            yield* passes("1 minute")
            expect(yield* ended).toBe(false)
            yield* command(UiCommand.EndRun())
          }),
      },
      between: () =>
        Effect.sync(() => {
          answering = true
        }),
      second: {},
    })
    const { first, second } = bothOf(ran)

    expectRun(first, 0, { a: "Stopped", b: "Done" })
    expectLines(first, [closedLine("b"), "READY_EMPTY after 2 tickets"])
    expect(suspendedOf(first)).toEqual(["a waiting on you"])
    expect(first.state.tickets.a).toMatchObject({ suspended: "waiting on you", phase: "Stopped" })
    expect(sentTo(first, "a")).toEqual(["Started", "Message", "Closed"])
    const asked = records(first, "attention").filter((record) => record.ticket === "a")
    expect(asked).toHaveLength(1)
    expectKinds(first, ["dispatch", "dispatch", "attention", "closed", "suspended", "end"])

    expectRun(second, 0, { a: "Done" })
    expect(sessionsOf(second, "a")).toEqual([`Resumed ${first.state.tickets.a?.session}`])
    expect(textsOf(second, "a")).toEqual([resumedText("a" as TicketId, "waiting on you")])
    const again = records(second, "attention").filter((record) => record.ticket === "a")
    expect(again).toHaveLength(1)
    expect(again[0]?.request).not.toBe(asked[0]?.request)
    expectLines(second, [resumedLine("a", "waiting on you"), closedLine("a")])
    expect(second.state.tickets).toEqual({})
  }, 30_000)
})

describe("a steered worker", () => {
  test("gets no automatic message: no nudge, no resume when gone; the next run resumes it", async () => {
    const mine = "Leave the cache alone for now."
    const uuid = "11111111-2222-4333-8444-555555555555" as MessageUuid
    const ran = await runs({
      backlog: backlog().ticket("a").seeds,
      worktrees: ["a"],
      policy: allowAll,
      scripts: (world, places) => ({
        a: [
          [
            ...turn([...commands(world, places, "a" as TicketId).claim, sleep("1 minute")]),
            // Its answer to your message, with the ticket still in progress; then it goes.
            ...turn([]),
            sleep("1 minute"),
            gone("the process exited"),
          ],
          finishes(world, places, "a" as TicketId),
        ],
      }),
      first: {
        dashboard: true,
        during: ({ command }) =>
          Effect.gen(function* () {
            const recording = yield* Recording
            yield* until(
              "a's prompt",
              Effect.map(recording.messages("a" as TicketId), (sent) => sent.length > 0),
            )
            yield* command(UiCommand.SendMessage({ ticket: "a" as TicketId, text: mine, uuid }))
            yield* passes("3 minutes")
          }),
      },
      second: {},
    })
    const { first, second } = bothOf(ran)

    expectRun(first, 3, { a: "Stopped" })
    expectLines(first, ["  STEERED: a"])
    // Your message only: no continue nudge, and no carry-on once its session went.
    expect(textsOf(first, "a").slice(1)).toEqual([mine])
    expect(textsOf(first, "a")).not.toContain(nudgeText("a" as TicketId))
    expect(textsOf(first, "a")).not.toContain(goneText("a" as TicketId))
    expect(sessionsOf(first, "a")).toHaveLength(1)
    expect(records(first, "resumed")).toEqual([])
    expect(suspendedOf(first)).toEqual(["a PAUSED"])
    expectLines(first, [
      "  STEERED: a",
      `  MESSAGE: you → a (${mine.length} characters)`,
      /^PAUSED: a still in_progress, its worker is gone \(its session ended: the process exited\); you have steered it, so tutti did not resume it to carry on, and the next run resumes it /,
    ])
    expectKinds(first, ["dispatch", "steered", "message", "stop", "suspended", "end"])

    // The next run is the run's again: it resumes the worker and tells it to carry on.
    expectRun(second, 0, { a: "Done" })
    expect(sessionsOf(second, "a")).toEqual([`Resumed ${first.state.tickets.a?.session}`])
    expect(textsOf(second, "a")).toEqual([resumedText("a" as TicketId, "PAUSED")])
    expect(second.log.some((text) => text.includes("STEERED"))).toBe(false)
    expectLines(second, [resumedLine("a", "PAUSED"), closedLine("a")])
  }, 30_000)
})
