// A conflict set aside as the run's last ticket keeps a dashboard run open (§ 4.3, § 5 item 14), as a
// hand-back waiting does: the end-of-run box names it, until you hand it back, its branch rebased by
// hand merges, or `q` ends the run, leaving it Blocked. A plain run and an overnight one end at once;
// so does one that winds down, as neither `h` nor a rebase would merge it then as the box says.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Queue, type Scope, SubscriptionRef } from "effect"
import { line, Tag } from "../src/core/log.ts"
import { UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import { decide, End, endOfRunBox, type Snapshot } from "../src/run/runEnd.ts"
import {
  conflictSetAside,
  conflictWaits,
  emptyStatus,
  project,
  type RunView,
} from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { result, run, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import { endOfRunAside, endOfRunConflict, endOfRunLines } from "../src/ui/EndOfRunBox.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { advance, backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

const a = "a" as TicketId
const blocked = TicketPhase.Blocked({ why: Tag.mergeConflict })

const look = (over: Partial<Snapshot> = {}): Snapshot => ({
  mergedBefore: true,
  running: new Set(),
  tickets: new Map([[a, { ticket: a, phase: blocked, handBack: false }]]),
  overLimit: new Set(),
  asking: [],
  canTake: true,
  resuming: false,
  answering: false,
  settled: true,
  triagePending: 0,
  dashboard: true,
  held: false,
  usageHeld: false,
  endAsked: false,
  setAside: [a],
  ...over,
})

describe("what the run does with a conflict set aside", () => {
  test("with a dashboard, it waits, the box naming it", () => {
    expect(decide(look())).toEqual(End.WaitOnYou({ tickets: [a] }))
    expect(endOfRunBox(look())).toEqual([a])
  })

  test("the box's q ends the run", () => {
    expect(decide(look({ endAsked: true }))).toEqual(End.Done({ asked: true }))
  })

  test("plain or overnight, it ends", () => {
    expect(decide(look({ dashboard: false }))).toEqual(End.Done({ asked: false }))
    expect(decide(look({ overnight: true }))).toEqual(End.Done({ asked: false }))
    expect(endOfRunBox(look({ overnight: true }))).toBeNull()
  })

  test("none set aside now, as with the merges stopped, it ends", () => {
    expect(decide(look({ setAside: [] }))).toEqual(End.Done({ asked: false }))
    const { setAside: _, ...none } = look()
    expect(decide(none)).toEqual(End.Done({ asked: false }))
  })

  test("a ticket gone on from Blocked since it was set aside isn't waited for", () => {
    const of = (phase: TicketPhase) =>
      decide(look({ tickets: new Map([[a, { ticket: a, phase, handBack: false }]]) }))
    expect(of(TicketPhase.Done({ outcome: { _tag: "NoChange" } }))).toEqual(
      End.Done({ asked: false }),
    )
    expect(of(TicketPhase.Blocked({ why: "a reason" }))).toEqual(End.Done({ asked: false }))
  })

  test("a ticket not set aside, Blocked on its conflict all the same, isn't waited for", () => {
    expect(decide(look({ setAside: ["b" as TicketId] }))).toEqual(End.Done({ asked: false }))
  })

  test("one whose hand-back waits as well is named once", () => {
    const tickets = new Map([[a, { ticket: a, phase: blocked, handBack: true }]])
    expect(decide(look({ tickets }))).toEqual(End.WaitOnYou({ tickets: [a] }))
  })

  test("with something else running it is still busy", () => {
    expect(decide(look({ settled: false }))).toEqual(End.Busy())
  })
})

const viewOf = (handBack: boolean) =>
  project({
    ledger: {
      tickets: new Map([
        [
          a,
          {
            ticket: a,
            title: "Ticket a",
            phase: blocked,
            since: 0,
            worker: null,
            row: 0,
            rechecking: false,
            steered: false,
            lastMessage: null,
            handBack,
            tallies: emptyTallies,
          },
        ],
      ]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, branch: "main", concurrency: 1, endOfRun: [a] },
  })

describe("the box", () => {
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
  const text = (waiting: NonNullable<RunView["endOfRun"]>, height?: number) =>
    endOfRunLines(waiting, theme, 400, height)
      .map((each) => each.map((part) => part.text).join(""))
      .join("\n")

  test("names a conflict set aside by its own words, a hand-back waiting by its", () => {
    expect(viewOf(false).endOfRun).toEqual([{ ticket: "a", asks: [conflictSetAside] }])
    expect(viewOf(true).endOfRun).toEqual([{ ticket: "a", asks: [conflictWaits] }])
  })

  test("says what h, a rebase and q do for one, and only for one", () => {
    const aside = text([{ ticket: "a", asks: [conflictSetAside] }])
    expect(aside).toContain(`a (${conflictSetAside})`)
    expect(aside).toContain(endOfRunAside)
    expect(aside).not.toContain(endOfRunConflict)
    const waits = text([{ ticket: "a", asks: [conflictWaits] }])
    expect(waits).toContain(endOfRunConflict)
    expect(waits).not.toContain(endOfRunAside)
    expect(text([{ ticket: "a", asks: ["a question"] }])).not.toContain(endOfRunAside)
  })

  test("says both for both, and leaves them out when short of room", () => {
    const both = [
      { ticket: "a", asks: [conflictSetAside] },
      { ticket: "b", asks: [conflictWaits] },
    ]
    expect(text(both)).toContain(endOfRunAside)
    expect(text(both)).toContain(endOfRunConflict)
    const short = text(both, 4)
    expect(short).not.toContain(endOfRunAside)
    expect(short).toContain("q ends the run")
  })
})

// Whole runs: a's worker finishes with a conflict with main, whose hand-backs are turned off, so it
// is set aside at once, and nothing else is left of the run.

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-conflict-aside-${name}-`)))

const defaults = appConfig().settings

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

const scripts = (world: World, repo: string, worktree: string) => {
  const first: SessionScript = turn(
    [
      run(orDie(world.beads.update(a, { claim: true }))),
      run(orDie(world.repository.commit(repo, "Land something else", { "a.txt": "main's a\n" }))),
      run(orDie(world.repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" }))),
      run(orDie(world.beads.close(a, "done"))),
    ],
    result("Closed a."),
  )
  return { a: [first] }
}

interface Seen {
  readonly outcome: Outcome
  /** RunView once it waits; null for a run that never showed the box. */
  readonly waiting: RunView | null
  /** Whether the run had ended 10 minutes after that. */
  readonly endedThen: boolean
  /** The log, as the run ended. */
  readonly lines: ReadonlyArray<string>
}

interface Do {
  readonly send: (command: UiCommand) => Effect.Effect<void, never, Env>
  readonly worktree: string
}

const passes = (n: number, every: "1 second" | "1 minute") =>
  Effect.gen(function* () {
    for (let i = 0; i < n; i++) {
      yield* advance(every)
      yield* Effect.promise(() => Bun.sleep(3))
    }
  })

/** The run up to its box, or its end: then `then`, what you do about it. */
const aside = (
  then: (at: Do) => Effect.Effect<void, unknown, Env>,
  given: { readonly overnight?: boolean; readonly dashboard?: boolean } = {},
): Promise<Ran<Seen>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const worktree = join(root, "a")
  const check = "scripts/check-fast.sh"
  return scenario(
    {
      config: {
        repo,
        overnight: given.overnight === true,
        settings: {
          ...defaults,
          concurrent: 1,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
          merge: { ...defaults.merge, resolve_conflicts: false },
        },
      },
      backlog: backlog().ticket("a").seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => scripts(world, repo, worktree),
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, worktree, { branch: "tutti/a", base: "main" })
      let shown: ScreenInputs | undefined
      const dashboard: Dashboard = (inputs) =>
        Effect.sync(() => {
          shown = inputs
        })
      const fiber = yield* Effect.forkChild(
        runTutti({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          ...(given.dashboard === false ? {} : { dashboard }),
        }),
      )
      let waiting: RunView | null = null
      for (let i = 0; i < 300 && waiting === null && fiber.pollUnsafe() === undefined; i++) {
        yield* passes(1, "1 second")
        if (shown !== undefined) {
          const view = yield* SubscriptionRef.get(shown.view)
          if (view.endOfRun !== null) waiting = view
        }
      }
      yield* passes(10, "1 minute")
      const endedThen = fiber.pollUnsafe() !== undefined
      const inputs = shown
      const send = (command: UiCommand) =>
        Effect.gen(function* () {
          if (inputs === undefined) return
          yield* Queue.offer(inputs.commands, command)
          yield* Effect.promise(() => Bun.sleep(20))
          yield* advance("1 second")
        })
      if (!endedThen) yield* then({ send, worktree })
      const outcome = yield* Fiber.join(fiber)
      return { outcome, waiting, endedThen, lines: yield* texts } satisfies Seen
    }) as Effect.Effect<Seen, unknown, Env | Scope.Scope>,
  )
}

const seenOf = (ran: Ran<Seen>): Seen => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const expectWaiting = (seen: Seen) => {
  expect(seen.waiting?.endOfRun).toEqual([{ ticket: "a", asks: [conflictSetAside] }])
  expect(seen.endedThen).toBe(false)
}

/** You rebase a's branch by hand, resolving its conflict. */
const rebaseByHand = (worktree: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    yield* Effect.exit(git.rebase(worktree, "main"))
    yield* repository.continueRebase(worktree, { "a.txt": "by hand\n" })
  })

describe("a run whose last ticket's conflict is set aside", () => {
  test("waits until the box's q ends it, leaving it Blocked", async () => {
    const seen = seenOf(await aside(({ send }) => send(UiCommand.EndRun())))
    expectWaiting(seen)
    expect(seen.outcome.phases.a).toEqual(blocked)
  }, 30_000)

  test("waits until its branch, rebased by hand, merges", async () => {
    const seen = seenOf(
      await aside(({ worktree }) => Effect.andThen(rebaseByHand(worktree), passes(10, "1 minute"))),
    )
    expectWaiting(seen)
    expect(seen.outcome.phases.a?._tag).toBe("Done")
    expect(seen.outcome.exitCode).toBe(0)
  }, 30_000)

  test("waits until h, after a rebase by hand, merges it", async () => {
    const seen = seenOf(
      await aside(({ send, worktree }) =>
        Effect.gen(function* () {
          yield* rebaseByHand(worktree)
          yield* send(UiCommand.HandBackNow({ ticket: a }))
          yield* passes(10, "1 minute")
        }),
      ),
    )
    expectWaiting(seen)
    expect(seen.outcome.phases.a?._tag).toBe("Done")
  }, 30_000)

  test("h blocking it again keeps it waiting, until q", async () => {
    const seen = seenOf(
      await aside(({ send }) =>
        Effect.gen(function* () {
          yield* send(UiCommand.HandBackNow({ ticket: a }))
          yield* passes(10, "1 minute")
          yield* send(UiCommand.EndRun())
        }),
      ),
    )
    expectWaiting(seen)
    expect(seen.outcome.phases.a).toEqual(blocked)
    expect(seen.lines.some((each) => each.includes("you handed a back"))).toBe(true)
  }, 30_000)

  test("winding down, ends: neither h nor a rebase would merge it as the box says", async () => {
    const seen = seenOf(
      await aside(({ send }) =>
        Effect.gen(function* () {
          yield* send(UiCommand.Drain())
          yield* passes(5, "1 minute")
        }),
      ),
    )
    expectWaiting(seen)
    expect(seen.outcome.phases.a).toEqual(blocked)
  }, 30_000)

  test("overnight, ends at once", async () => {
    const seen = seenOf(await aside(() => Effect.void, { overnight: true }))
    expect(seen.waiting).toBeNull()
    expect(seen.endedThen).toBe(true)
  }, 30_000)

  test("plain, ends at once", async () => {
    const seen = seenOf(await aside(() => Effect.void, { dashboard: false }))
    expect(seen.waiting).toBeNull()
    expect(seen.endedThen).toBe(true)
    expect(seen.outcome.phases.a).toEqual(blocked)
  }, 30_000)
})
