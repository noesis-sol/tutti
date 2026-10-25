// --auto-answer for question tickets in whole runs (src/run/autoAnswer.ts, § 5.1 Asked → Working):
// a question filed during the run, with options and one recommended, answered with that one by bd
// human respond, labelled auto-answered, and its ticket resumed; with a time, only once it has
// waited that long, the maintainer's answer before it winning; maintainer_only, one without
// options and one open before the run left to the maintainer, each line saying why.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { autoAnsweredLabel, responseText } from "../src/run/autoAnswer.ts"
import { askedWhy, questionKey } from "../src/run/carry.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import { answeredText } from "../src/run/told.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import type { TicketRecord } from "../src/services/Store.ts"
import { bash, filesQuestion, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1" as TicketId

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-auto-answer-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A question's metadata: three options, the second recommended, as the worker prompt asks. */
const withOptions = {
  options: [
    { label: "Postgres", description: "a server to run" },
    { label: "SQLite", description: "one file" },
    { label: "Files", description: "no queries" },
  ],
  recommended: 1,
}

/** t-1's worker files a question `Which store?` with `metadata`, and puts t-1 back to open. */
const asks = (world: World, metadata: Readonly<Record<string, unknown>> = withOptions) =>
  filesQuestion(id, {
    claim: orDie(world.beads.update(id, { claim: true })),
    file: orDie(
      Effect.andThen(
        world.beads.create({ title: "Which store?", labels: ["human"], blocks: [id], metadata }),
        world.beads.update(id, { status: "open" }),
      ),
    ),
  })

/** t-1's worker, resumed, commits and closes t-1. */
const finishes = (world: World, root: string): SessionScript =>
  turn([
    ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
    ...bash(
      `git commit -am "Change (${id})"`,
      orDie(world.repository.commit(join(root, id), `Change (${id})`, { "a.txt": "a\n" })),
    ),
    ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
  ])

/** The open questions blocking t-1, as bd shows them. */
const openQuestions = (beads: Beads["Service"]) =>
  Effect.map(Effect.orDie(beads.show(id)), (issue) =>
    issue.dependencies.flatMap((dependency) =>
      dependency.issue !== undefined &&
      dependency.issue.status !== "closed" &&
      dependency.issue.labels.includes("human")
        ? [dependency.issue]
        : [],
    ),
  )

/** The question titled `title`, as the run left it. */
const questionIn = (ran: Ran<unknown>, title = "Which store?") => {
  const found = ran.issues.find((issue) => issue.title === title)
  if (found === undefined) throw new Error(`no question ${title}`)
  return found
}

/** The messages t-1's worker was sent, as text. */
const sentTexts = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === id ? [String(sent.message.message.content)] : [],
  )

interface Plan {
  /** --auto-answer's value: Duration.zero for at once. */
  readonly after: Duration.Duration | null
  readonly backlog?: ReadonlyArray<Seed>
  readonly scripts?: (world: World, root: string) => ReadonlyArray<SessionScript>
  /** What the last run saved, by ticket, each worktree under `root`. */
  readonly saved?: (root: string) => Readonly<Record<string, TicketRecord>>
  /** Runs beside the run, before it is joined. */
  readonly during?: Effect.Effect<void, never, Env>
  /** Before the run starts. */
  readonly before?: Effect.Effect<void, never, Env>
}

/** A whole plain run on main of t-1, with --auto-answer as `plan.after` says. */
const runs = (plan: Plan): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: { repo, autoAnswer: plan.after, settings: { ...appConfig().settings } },
      backlog: plan.backlog ?? backlog().ticket(id, { title: "One ticket" }).seeds,
      git: { dir: repo },
      worktrees: { root },
      ...(plan.saved === undefined ? {} : { state: { version: 1, tickets: plan.saved(root) } }),
      scripts: (world: World) => ({ [id]: [...(plan.scripts?.(world, root) ?? [])] }),
    },
    Effect.gen(function* () {
      mkdirSync(join(root, id), { recursive: true })
      yield* (yield* Git).addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      if (plan.before !== undefined) yield* plan.before
      const fiber = yield* Effect.forkChild(run({ version: "0.1.0-test", base: "main" }))
      if (plan.during !== undefined) yield* plan.during
      return yield* Fiber.join(fiber)
    }),
  )
}

/** Advances the clock a ready poll at a time, `n` times, the fibers given a moment each time. */
const polls = (n: number) =>
  Effect.forEach(
    Array.from({ length: n }),
    () =>
      Effect.andThen(
        Effect.promise(() => Bun.sleep(3)),
        advance(readyPoll),
      ),
    { discard: true },
  )

describe("--auto-answer and a question ticket", () => {
  test("filed with options: answered at once with the recommended one, its ticket resumed", async () => {
    const ran = await runs({
      after: Duration.zero,
      scripts: (world, root) => [asks(world), finishes(world, root)],
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { [id]: "Done" })
    const question = questionIn(ran)
    expect(question.status).toBe("closed")
    expect(question.labels).toContain(autoAnsweredLabel)
    const comments = ran.comments[question.id]
    expect(comments).toEqual([responseText("SQLite")])
    expect(responseText("SQLite")).toBe(
      "SQLite (the recommended option, chosen by tutti --auto-answer, not by the maintainer)",
    )
    const q = question.id
    expectLog(ran, [
      new RegExp(
        `^ {2}ASKED: t-1 waits on your answer to ${q} \\(Which store\\?\\); answer with: bd human respond ${q}; worktree \\S+ left open$`,
      ),
      `  AUTO_ANSWERED: ${q} (Which store?), which t-1 waits on, answered with its recommended option by --auto-answer, not by you: SQLite`,
      `  ANSWERED: ${q} (Which store?) is answered by --auto-answer, so t-1 comes back`,
      /^ {2}RESUMED: t-1's question \S+ is answered; resuming its session/,
      /^ {2}t-1 closed \(.*\); merged into main/,
      "  Answered by --auto-answer, not by you:",
      `    ${q} (Which store?), for t-1 → SQLite`,
      "    find them later with: bd list --all --label auto-answered",
    ])
    // The resumed worker is told which option, and that tutti chose it.
    expect(sentTexts(ran)).toContain(
      answeredText({ id, question: q, title: "Which store?", auto: "SQLite" }),
    )
    expect(ran.events.filter((record) => record.kind === "auto_answered")).toEqual([
      expect.objectContaining({ ticket: id, question: q, title: "Which store?", option: "SQLite" }),
    ])
  })

  test("with a time: answered only once the question has waited it", async () => {
    let at9: ReadonlyArray<string> = []
    const ran = await runs({
      after: Duration.minutes(10),
      scripts: (world, root) => [asks(world), finishes(world, root)],
      during: Effect.gen(function* () {
        const beads = yield* Beads
        yield* polls(18)
        at9 = (yield* openQuestions(beads)).map((issue) => issue.title)
        yield* polls(6)
      }),
    })
    expectExitCode(ran, 0)
    // Still open at 9 minutes: the run waited for it rather than end on it.
    expect(at9).toEqual(["Which store?"])
    expectPhases(ran, { [id]: "Done" })
    expect(questionIn(ran).labels).toContain(autoAnsweredLabel)
    expectLog(ran, [/AUTO_ANSWERED: \S+ \(Which store\?\)/, /ANSWERED: .* by --auto-answer/])
  })

  test("with a time, the maintainer's answer before it wins", async () => {
    const ran = await runs({
      after: Duration.minutes(10),
      scripts: (world, root) => [asks(world), finishes(world, root)],
      during: Effect.gen(function* () {
        const beads = yield* Beads
        yield* polls(6)
        for (const question of yield* openQuestions(beads)) {
          yield* Effect.orDie(beads.close(question.id, "Use Files"))
        }
        yield* polls(30)
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { [id]: "Done" })
    const question = questionIn(ran)
    expect(question.closeReason).toBe("Use Files")
    expect(question.labels).not.toContain(autoAnsweredLabel)
    expect(ran.comments[question.id]).toBeUndefined()
    expect(ran.log.some((text) => text.includes("AUTO_ANSWERED"))).toBe(false)
    expectLog(ran, [
      new RegExp(
        `^ {2}ANSWERED: ${question.id} \\(Which store\\?\\) is answered, so t-1 comes back$`,
      ),
    ])
  })

  test("maintainer_only: left to you, its line saying why", async () => {
    const ran = await runs({
      after: Duration.zero,
      scripts: (world) => [asks(world, { ...withOptions, maintainer_only: true })],
    })
    expectPhases(ran, { [id]: "Asked" })
    expect(questionIn(ran).status).toBe("open")
    expectLog(ran, [
      /^ {2}ASKED: t-1 waits on your answer to \S+ \(Which store\?\); answer with: bd human respond \S+; worktree \S+ left open; --auto-answer leaves it to you: it asks you to do something only you can$/,
    ])
    expect(ran.log.some((text) => text.includes("AUTO_ANSWERED"))).toBe(false)
  })

  test("without well-formed options: left to you, its line saying why", async () => {
    const ran = await runs({
      after: Duration.zero,
      scripts: (world) => [asks(world, { options: withOptions.options, recommended: 7 })],
    })
    expectPhases(ran, { [id]: "Asked" })
    expect(questionIn(ran).status).toBe("open")
    expectLog(ran, [/; --auto-answer leaves it to you: it gives no options$/])
  })

  test("open before the run: left to you, the carried ticket's line saying why", async () => {
    const ran = await runs({
      after: Duration.zero,
      backlog: backlog()
        .ticket("q-1", { labels: ["human"], title: "Which way?", metadata: withOptions })
        .ticket(id, { blockedBy: ["q-1"] }).seeds,
      saved: (root) => ({
        [id]: {
          session: `session-${id}`,
          worktree: join(root, id),
          branch: `tutti/${id}`,
          suspended: askedWhy,
          phase: "Asked",
          resumes: 0,
          metadata: { [questionKey]: "q-1" },
        },
      }),
      // The run begins a minute after the question was filed.
      before: advance("1 minute"),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { [id]: "Asked" })
    expect(questionIn(ran, "Which way?").status).toBe("open")
    expectLog(ran, [
      "  t-1, carried over from the last run, still waits on your answer to q-1 (Which way?); answer with: bd human respond q-1; --auto-answer leaves it to you: it was open before the run",
    ])
  })

  test("without --auto-answer: left to you, and the ASKED line says nothing of it", async () => {
    const ran = await runs({ after: null, scripts: (world) => [asks(world)] })
    expectPhases(ran, { [id]: "Asked" })
    expect(questionIn(ran).status).toBe("open")
    expect(ran.log.some((text) => text.includes("--auto-answer"))).toBe(false)
  })
})
