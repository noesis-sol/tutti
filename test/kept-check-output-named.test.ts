// What a ticket's failed check or setup is said with, for any reader but its worker, names the copy
// of its output kept beside its transcript (keptChecks.ts): its notes, the log's CHECKS_FAILED and
// SETUP_FAILED lines and the run report's evidence outlive the worktree, which goes once the
// ticket is set aside. Its worker is still pointed at the file in its worktree, which it can read.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { keptChecksFolder } from "../src/run/keptChecks.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckOutput, checkLogName, resultOf, setupLogName } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { runFolder, Worktrees } from "../src/services/Worktrees.ts"
import { bash, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { CheckRun, Script as ChecksScript } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, type Scripts, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-kept-check-output-named-${name}-`)))

const check = "scripts/check-fast.sh"
const setup = "bun install"
const defaults = appConfig().settings
type Settings = typeof defaults

/** A check that writes `output` where it is asked to and fails, as the live one does. */
const failing = (output: string) => (run: CheckRun) =>
  Effect.suspend(() => {
    if (run.outputFd !== undefined) writeFileSync(run.outputFd, output)
    const said = new CheckOutput()
    said.write(new TextEncoder().encode(output))
    return resultOf(run.check, run.command, 1, said, run.outputFile)
  })

/** Claims its ticket, commits a file and closes it, as a worker does. */
const works = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { "a.txt": "a\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

interface Plan {
  /** Laid over the settings: the defaults with the check command `check`. */
  readonly settings?: (settings: Settings) => Partial<Settings>
  readonly checks: ChecksScript
  /** a's worker's turns. */
  readonly turns: (world: World, root: string) => Scripts["a"]
}

/** Where a run of a ran. */
interface Places {
  readonly repo: string
  readonly root: string
}

/** A whole run of the one ticket a on main, its worktree made in git first, and where it ran. */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const base: Settings = {
    ...defaults,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  }
  return scenario(
    {
      config: { repo, settings: { ...base, ...plan.settings?.(base) } },
      backlog: backlog().ticket("a").seeds,
      git: { dir: repo },
      worktrees: { root },
      checks: plan.checks,
      scripts: (world: World) => ({ a: plan.turns(world, root) }),
    },
    Effect.gen(function* () {
      yield* (yield* Git).addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, repo, root }))
}

/** a's copy `name` beside its transcript. */
const keptOf = (places: Places, name: string) => join(places.repo, keptChecksFolder("a"), name)

/** a's issue's notes. */
const notesOf = (ran: Ran<unknown>) => ran.issues.find((issue) => issue.id === "a")?.notes ?? ""

/** The client_composed messages a's worker was sent after its ticket's prompt. */
const composed = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.sent
    .flatMap((item) =>
      item._tag === "Message" && item.ticket === "a" && item.message.client_composed === true
        ? [String(item.message.message.content)]
        : [],
    )
    .slice(1)

const said = "error: a.test.ts: expected 1\n"

describe("a ticket set aside as its check failed", () => {
  test("with no hand-back: its CHECKS_FAILED line names the kept copy", async () => {
    const ran = await runs({
      settings: (settings) => ({ merge: { ...settings.merge, check_hand_backs: 0 } }),
      checks: { fast: [failing(said)] },
      turns: (world, root) => [works(world, root, "a" as TicketId)],
    })
    if (Exit.isFailure(ran.exit)) throw new Error(`the run failed: ${ran.exit.cause}`)
    const kept = keptOf(ran, "merge-1.log")
    expect(readFileSync(kept, "utf8")).toBe(said)
    expectLog(ran, [
      new RegExp(
        `^ {2}CHECKS_FAILED: a closed, but '${check}' fails on tutti/a .*\\(output is in ${kept.replaceAll(".", "\\.")}\\)`,
      ),
    ])
    expect(ran.log.join("\n")).not.toContain(join(ran.root, "a", runFolder, checkLogName))
  })

  test("after a hand-back: its worker is told the worktree's file, its notes the kept copies", async () => {
    const ran = await runs({
      checks: { fast: [failing(said), failing(said)] },
      // Its worker finds nothing to fix and commits nothing: it is set aside on the second failure.
      turns: (world, root) => [[...works(world, root, "a" as TicketId), ...turn([])]],
    })
    const [handBack] = composed(ran)
    expect(handBack).toContain(
      `Its whole output is in ${join(ran.root, "a", runFolder, checkLogName)};`,
    )
    const again = keptOf(ran, "fix-2.log")
    expect(readFileSync(again, "utf8")).toBe(said)
    const notes = notesOf(ran)
    expect(notes).toContain(`(output is in ${again}); it was handed back to its worker to fix once`)
    expect(notes).toContain(
      `its worker committed nothing, and '${check}' fails again (output is in ${again})`,
    )
    expect(notes).not.toContain(join(ran.root, "a", runFolder))
    expectLog(ran, [
      new RegExp(`^ {2}CHECKS_FAILED: .*\\(output is in ${again.replaceAll(".", "\\.")}\\)`),
    ])
  })
})

describe("a ticket whose setup fails before its worker starts", () => {
  test("has its SETUP_FAILED line and its notes name the kept copy", async () => {
    const ran = await runs({
      settings: (settings) => ({
        checks: { ...settings.checks, setup: { ...settings.checks.setup, command: setup } },
      }),
      checks: { setup: [failing("no lockfile\n")] },
      turns: () => [],
    })
    const kept = keptOf(ran, "setup-1.log")
    expect(readFileSync(kept, "utf8")).toBe("no lockfile\n")
    expectLog(ran, [
      `  SETUP_FAILED: '${setup}' fails in ${join(ran.root, "a")} for a; the whole output is in ${kept}`,
    ])
    expect(notesOf(ran)).toContain(`(the whole output is in ${kept}).`)
    expect(notesOf(ran)).not.toContain(join(ran.root, "a", runFolder, setupLogName))
  })
})

describe("the run report's evidence of a ticket set aside as its check failed", () => {
  test("names the kept copy", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const ran = await scenario(
      {
        config: {
          repo,
          settings: {
            ...defaults,
            checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
            merge: { ...defaults.merge, check_hand_backs: 0 },
          },
        },
        backlog: backlog().ticket("a").seeds,
        git: { dir: repo },
        worktrees: { root },
        checks: { fast: [failing(said)] },
      },
      Effect.gen(function* () {
        const id = "a" as TicketId
        const queue = yield* makeQueue({ repo, base: "main" })
        const worktree = yield* (yield* Worktrees).prepare(id)
        yield* (yield* Git).addWorktree(repo, worktree.path, {
          branch: worktree.branch,
          base: "main",
        })
        yield* (yield* Repository).commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
        yield* (yield* Beads).close(id, "done")
        const ledger = yield* Ledger
        yield* ledger.transition(id, Move.Ready(), { title: "Ticket a" })
        yield* ledger.transition(id, Move.Dispatched())
        yield* queue.offer({
          id,
          title: "Ticket a",
          branch: worktree.branch,
          worktree: worktree.path,
        })
        yield* queue.settled
        return (yield* queue.rechecks.failures).get(id)
      }).pipe(Effect.provide(Ledger.layer)),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    expect(ran.exit.value).toContain(
      `; its output is in ${join(repo, keptChecksFolder("a"), "merge-1.log")}.\n`,
    )
  })
})
