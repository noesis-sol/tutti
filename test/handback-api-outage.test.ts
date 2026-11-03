// A hand-back whose worker's turn fails as Claude's API is unavailable (handback.ts's give,
// apiOutage.ts), as a whole run under TestClock: the time it waits for the API doesn't count toward
// resolve_timeout, and once a probe finds the API answering, its worker carries on with the
// hand-back, which merges, rather than the hand-back ending late and its ticket set aside.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { ProbeAnswer } from "../src/agent/UsageProbe.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { apiBackText } from "../src/run/told.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  apiErrorResult,
  apiRetry,
  bash,
  init,
  result,
  type SessionScript,
  type Step,
  sessionState,
  run as step,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

// Whole runs waiting out a hold take up to a second on an idle machine.
setDefaultTimeout(30_000)

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

interface Places {
  readonly repo: string
  readonly root: string
}

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-handback-outage-${name}-`)))

/** Claims its ticket, does `first`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  places: Places,
  id: TicketId,
  files: Files,
  first: ReadonlyArray<Step> = [],
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...first,
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(world.repository.commit(join(places.root, id), `Change (${id})`, files)),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** The worker resolving its rebase's conflicts, writing `files`. */
const continues = (world: World, places: Places, id: string, files: Files) =>
  bash(
    "git add -A && git rebase --continue",
    Effect.asVoid(world.repository.continueRebase(join(places.root, id), files)),
  )

/** A turn that fails with a 529 after Claude Code's retries, as the API overloaded gives it. */
const overloadedTurn: SessionScript = [
  wait,
  init(),
  sessionState("running"),
  apiRetry(1, 529),
  apiErrorResult("API Error: 529 Overloaded", 529),
  sessionState("idle"),
]

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** Waits, in real time, until `count` log lines match `pattern`. */
const untilCounted = (pattern: RegExp, count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).filter((text) => pattern.test(text)).length >= count) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no ${count} log lines matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** Waits, in real time, until `id` is claimed: the run has dispatched it. */
const untilClaimed = (world: World, id: TicketId) =>
  Effect.orDie(
    Effect.gen(function* () {
      for (let i = 0; i < 2000; i++) {
        if ((yield* world.beads.show(id)).status === "in_progress") return
        yield* Effect.promise(() => Bun.sleep(2))
      }
      throw new Error(`${id} was never claimed`)
    }),
  )

/** Waits, in real time, until main holds `files`. */
const untilOnMain = (world: World, files: Files) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const tree = yield* world.repository.tree("main")
      if (Object.entries(files).every(([path, text]) => tree.get(path) === text)) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`main never held ${Object.keys(files).join(", ")}`)
  }).pipe(Effect.orDie)

/**
 * a lands first, b after it, writing `aFiles` and `bFiles`; `rest` is b's turns after its first,
 * its hand-backs'.
 */
const aThenB = (
  world: World,
  places: Places,
  aFiles: Files,
  bFiles: Files,
  rest: SessionScript,
): Scripts => ({
  a: [works(world, places, "a" as TicketId, aFiles, [step(untilClaimed(world, "b" as TicketId))])],
  b: [
    [...works(world, places, "b" as TicketId, bFiles, [step(untilOnMain(world, aFiles))]), ...rest],
  ],
})

/** a and b conflicting in shared.txt: b's rebase onto a's merge stops, and is handed back. */
const conflicting = (world: World, places: Places, rest: SessionScript): Scripts =>
  aThenB(world, places, { "shared.txt": "a\n" }, { "shared.txt": "b\n" }, rest)

interface Plan {
  readonly scripts: (world: World, places: Places) => Scripts
  /** What the hold's probes of the API are answered, in order; answered once they run out. */
  readonly probes?: ReadonlyArray<ProbeAnswer>
  /** Runs beside the run, before it is joined. */
  readonly during?: Effect.Effect<void, unknown, Env>
}

/** A whole run of a and b on main, two at a time, each worktree made in git first. */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  return scenario(
    {
      config: {
        repo: places.repo,
        settings: {
          ...defaults,
          concurrent: 2,
          checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
        },
      },
      backlog: backlog().ticket("a").ticket("b").seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      ...(plan.probes === undefined ? {} : { usageProbe: plan.probes }),
      scripts: (world: World) => plan.scripts(world, places),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ["a", "b"]) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      yield* plan.during ?? Effect.void
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** The client_composed messages b's worker was sent after its ticket's prompt. */
const composed = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.sent
    .flatMap((item) =>
      item._tag === "Message" && item.ticket === "b" && item.message.client_composed === true
        ? [String(item.message.message.content)]
        : [],
    )
    .slice(1)

/** Whether b's worker was interrupted. */
const interrupted = (ran: Ran<unknown>): boolean =>
  ran.sent.some((item) => item._tag === "Interrupted" && item.ticket === "b")

const expectClean = (ran: Ran<Outcome>, code: number) => {
  expectExitCode(ran, code)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
}

const closedLine = (id: string) =>
  new RegExp(
    `^ {2}${id} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
  )

const resolvingLine =
  "  RESOLVING: tutti/b conflicts with main in shared.txt; handed back to its worker to resolve (up to 20m)"

describe("Claude's API unavailable during a hand-back", () => {
  test("its wait doesn't count toward resolve_timeout, and the worker carries on with the hand-back", async () => {
    const unanswered = ProbeAnswer.Unanswered({ reason: "API Error: 529 Overloaded" })
    const ran = await runs({
      // Four probes go unanswered: 1m, 2m, 4m and 8m, then 15m to the fifth, 30m in all.
      probes: [unanswered, unanswered, unanswered, unanswered],
      scripts: (world, places) =>
        conflicting(world, places, [
          ...overloadedTurn,
          ...turn(continues(world, places, "b", { "shared.txt": "a and b\n" })),
        ]),
      during: Effect.gen(function* () {
        yield* untilLogged(/^API_UNAVAILABLE: b's turn failed/)
        for (const [minutes, probes] of [
          [1, 1],
          [2, 2],
          [4, 3],
          [8, 4],
        ] as const) {
          yield* advance(`${minutes} minutes`)
          yield* untilCounted(/got no answer either/, probes)
        }
        yield* advance("15 minutes")
        yield* untilLogged(/^API_UNAVAILABLE: lifted: /)
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(pathOf(ran, "b")).toEqual([
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expectLog(ran, [
      closedLine("a"),
      resolvingLine,
      "  b's worker waits for Claude's API on its hand-back: it carries on once the API answers, the wait not counting toward the 20m",
      "API_UNAVAILABLE: lifted: Claude's API answered a probe 30m after the hold",
      "  b: Claude's API answers again; its worker carries on",
      `  b's worker finished the rebase; checking it with '${check}'`,
      closedLine("b"),
    ])
    // The hand-back's own line and the hold's come from fibers of their own, in either order.
    expect(ran.log.some((text) => text.startsWith("API_UNAVAILABLE: b's turn failed"))).toBe(true)
    const [handBack, ...after] = composed(ran)
    expect(handBack).toContain("rebasing tutti/b onto it stopped on conflicts in shared.txt")
    expect(after).toEqual([apiBackText])
    expect(interrupted(ran)).toBe(false)
  })
})
