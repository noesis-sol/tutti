// An overnight run sets aside a ticket whose worker, handed back a conflict or a failed check, is
// blocked on a request (§ 5 item 10, tutti-bqr0): the hand-back ends early, its request denied and
// its worker told so, and the ticket is set aside as a hand-back not done in time is (Blocked
// MERGE_CONFLICT, Review CHECKS_FAILED), rather than holding the run with BLOCKED. What git shows
// done already is taken as it is. Whole runs under TestClock.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { Dashboard } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  result,
  type SessionScript,
  type Step,
  sleep,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import type { Script as ChecksScript } from "../src/testing/Checks.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

// Whole runs under TestClock, moved on a minute at a time, take a few seconds on a loaded machine.
setDefaultTimeout(30_000)

const check = "scripts/check-fast.sh"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-overnight-handback-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket, sleeps `takes`, commits `files` and closes it, as a worker does. */
const finishes = (
  world: World,
  root: string,
  id: TicketId,
  takes: Duration.Input,
  files: Files,
): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      sleep(takes),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** A hand-back turn: `first`, then a permission request it is left blocked on, then 2h of work. */
const asksOnHandBack = (first: ReadonlyArray<Step> = []): SessionScript =>
  turn([...first, canUseTool("Bash", { command: "rm -rf build" }), sleep("2 hours")])

/** The worker resolving its rebase's conflicts, writing `files`. */
const continues = (world: World, root: string, id: TicketId, files: Files) =>
  bash(
    "git add -A && git rebase --continue",
    Effect.asVoid(world.repository.continueRebase(join(root, id), files)),
  )

/** A failing check, its lines saying what failed. */
const failing = () =>
  new CheckFailed({
    check: "fast",
    command: check,
    exitCode: 1,
    outputFile: "/dev/fd/9",
    failingLines: ["error: a.test.ts: expected 1"],
    lastLines: ["1 fail"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}: ${(yield* texts).join("\n")}`)
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

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly overnight: boolean
  readonly checks?: ChecksScript
  readonly scripts: (world: World, root: string) => Scripts
  /** Runs beside the run, before it is joined. */
  readonly during: Effect.Effect<void, unknown, Env>
}

/** A whole run on main with a dashboard and a check command, all tickets at once. */
const runs = (plan: Plan): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const defaults = appConfig().settings
  const settings = {
    ...defaults,
    concurrent: plan.tickets.length,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  }
  return scenario(
    {
      config: { repo, settings, overnight: plan.overnight },
      backlog: plan.tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      policy: waitForTest,
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) => plan.scripts(world, root),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const dashboard: Dashboard = () => Effect.void
      const fiber = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
        }),
      )
      yield* plan.during
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The client_composed messages ticket a's worker was sent. */
const composed = (ran: Ran<unknown>) =>
  ran.sent.flatMap((item) =>
    item._tag === "Message" && item.ticket === "a" && item.message.client_composed === true
      ? [item.message.message.content as string]
      : [],
  )

const notesOf = (ran: Ran<unknown>, id: string) =>
  ran.issues.find((issue) => issue.id === id)?.notes ?? ""

/** No BLOCKED hold or stop was put on the run. */
const neverHeld = (ran: Ran<unknown>) => {
  expect(ran.log.some((text) => /HOLD|BLOCKED >4min/.test(text))).toBe(false)
  expect(ran.events.some((record) => record.kind === "stop" || record.kind === "hold")).toBe(false)
}

const deniedOvernight =
  /^ {2}PERMISSION: a's worker: Bash\(rm -rf build\) denied \(.*\), by tutti, the run being an overnight one$/

const blockedWhy =
  "its worker was blocked on a permission request for over 4m, and nobody was there to answer, the run being an overnight one (BLOCKED): its request was denied"

/**
 * b merges shared.txt at 1m; a, finishing at 3m with its own shared.txt, conflicts and is handed
 * the conflict, its hand-back turn `handBack`.
 */
const conflicting =
  (handBack: (world: World, root: string) => SessionScript) =>
  (world: World, root: string): Scripts => ({
    a: [
      [
        ...finishes(world, root, "a" as TicketId, "3 minutes", { "shared.txt": "a\n" }),
        ...handBack(world, root),
      ],
    ],
    b: [finishes(world, root, "b" as TicketId, "1 minute", { "shared.txt": "b\n" })],
  })

describe("an overnight run ends a hand-back whose worker is blocked on a request", () => {
  test("a conflict: its request denied, its worker told, Blocked MERGE_CONFLICT, no hold", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      overnight: true,
      scripts: conflicting(() => asksOnHandBack()),
      during: Effect.gen(function* () {
        yield* passes("4 minutes")
        yield* untilLogged(/RESOLVING: tutti\/a conflicts with main/)
        yield* passes("5 minutes")
        yield* untilLogged(/MERGE_CONFLICT: a closed/)
      }),
    })
    expectPhases(ran, { a: "Blocked", b: "Done" })
    expectLog(ran, [
      /RESOLVING: tutti\/a conflicts with main in shared\.txt/,
      deniedOvernight,
      "  a's worker was stopped and told its hand-back is over",
      new RegExp(
        `MERGE_CONFLICT: a closed, but tutti/a conflicts with main in shared\\.txt, .*\\(handed back to its worker, but ${blockedWhy.replace(/[()]/g, "\\$&")}; the rebase was aborted\\)`,
      ),
    ])
    neverHeld(ran)
    expect(ran.events).toContainEqual(
      expect.objectContaining({
        kind: "attention_answered",
        ticket: "a",
        answer: "deny",
        via: "overnight",
      }),
    )
    // Its prompt, the hand-back, then that the hand-back is over.
    const sent = composed(ran)
    expect(sent).toHaveLength(3)
    expect(sent[2]).toStartWith(
      "tutti: nobody was there to answer your request for over 4m, the run being an overnight one, so tutti denied it, stopped you, and ends this hand-back: it aborts the rebase if it is still in progress",
    )
    expect(notesOf(ran, "a")).toContain(
      `its worker was asked to resolve the rebase, but ${blockedWhy}`,
    )
    // Stopped mid-turn, then told the hand-back is over.
    expect(ran.sent.filter((s) => s.ticket === "a").map((s) => s._tag)).toContain("Interrupted")
    expect(ran.checkRuns.map((each) => each.cwd)).toEqual([expect.stringMatching(/\/b$/)])
  })

  test("a conflict resolved before the request: taken as it is, checked and merged", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      overnight: true,
      scripts: conflicting((world, root) =>
        asksOnHandBack(continues(world, root, "a" as TicketId, { "shared.txt": "both\n" })),
      ),
      during: Effect.gen(function* () {
        yield* passes("4 minutes")
        yield* untilLogged(/RESOLVING: tutti\/a conflicts with main/)
        yield* passes("5 minutes")
        yield* untilLogged(/^ {2}a closed .*; merged into main/)
      }),
    })
    expectPhases(ran, { a: "Done", b: "Done" })
    expectLog(ran, [
      deniedOvernight,
      "  a: its worker was blocked on a permission request for over 4m on its hand-back, the run being an overnight one (BLOCKED), but its rebase has finished: tutti/a is taken as it is",
      /^ {2}a closed .*; merged into main/,
    ])
    neverHeld(ran)
    expect(composed(ran).at(-1)).toStartWith(
      "tutti: nobody was there to answer your request for over 4m, the run being an overnight one, so tutti denied it; your rebase has finished, so tutti has stopped you and takes tutti/a as it is now",
    )
  })

  test("a failed check: its request denied, Review CHECKS_FAILED, the notes saying why", async () => {
    const ran = await runs({
      tickets: ["a"],
      overnight: true,
      checks: { fast: [failing()] },
      scripts: (world, root) => ({
        a: [
          [
            ...finishes(world, root, "a" as TicketId, "1 minute", { "a.txt": "a\n" }),
            ...asksOnHandBack(),
          ],
        ],
      }),
      during: Effect.gen(function* () {
        yield* passes("2 minutes")
        yield* untilLogged(/handed back to its worker/)
        yield* passes("5 minutes")
        yield* untilLogged(/CHECKS_FAILED/)
      }),
    })
    expectPhases(ran, { a: "Review" })
    expectLog(ran, [deniedOvernight, "  a's worker was stopped and told its hand-back is over"])
    neverHeld(ran)
    expect(notesOf(ran, "a")).toContain(blockedWhy)
    expect(composed(ran).at(-1)).toStartWith(
      "tutti: nobody was there to answer your request for over 4m, the run being an overnight one, so tutti denied it, stopped you, and ends this hand-back: it puts tutti/a back at",
    )
  })
})

describe("without --overnight", () => {
  test("a hand-back's worker blocked on a request holds the run with BLOCKED, as before", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      overnight: false,
      scripts: conflicting(() => asksOnHandBack()),
      during: Effect.gen(function* () {
        yield* passes("4 minutes")
        yield* untilLogged(/RESOLVING: tutti\/a conflicts with main/)
        yield* passes("5 minutes")
        yield* untilLogged(/BLOCKED >4min: a needs you/)
        // Its 20 minutes up, the hand-back ends as one not done in time.
        yield* passes("20 minutes")
        yield* untilLogged(/MERGE_CONFLICT: a closed/)
      }),
    })
    expectPhases(ran, { a: "Blocked", b: "Done" })
    expect(ran.events).not.toContainEqual(
      expect.objectContaining({ kind: "attention_answered", via: "overnight" }),
    )
    expect(notesOf(ran, "a")).not.toContain("overnight")
  })
})
