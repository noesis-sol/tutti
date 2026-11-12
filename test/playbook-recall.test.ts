// Two-stage recall in a run (tutti-5fs7.4; src/run/playbookRun.ts): a worker in the staged arm is
// told its lessons' records once it struggles, its second verifier round or a failed check handed
// back, once; one in the plain arm has them in its standing rules; and each ticket's end counts by
// its arm. Each scenario is a whole run under TestClock.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { line } from "../src/core/log.ts"
import { armOf, type Lesson, playbookFile, recallArmOf } from "../src/run/playbook.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  hook,
  result,
  type SessionScript,
  type Step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Script as ChecksScript } from "../src/testing/Checks.ts"
import type { Files } from "../src/testing/Git.ts"
import { backlog, expectExitCode, type Ran, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-playbook-recall-${name}-`)))

const record =
  "The one that went badly rewrote the parser's cursor in place while the reader still held it; " +
  "the one that went well copied the cursor before changing it and handed the copy back."

/** A lesson of the whole project, active, with a record. */
const lesson: Lesson = {
  id: "L1",
  text: "The parser keeps a cursor per file: copy it before changing it.",
  scope: [],
  kind: "pitfall",
  evidence: [{ ticket: "t-0", event: "check@1" }],
  state: "active",
  helpful: 0,
  harmful: 0,
  held_clean: 0,
  held_bad: 0,
  measured: [],
  admitted_at: "2026-11-06T09:00:00Z",
  version: 1,
  record,
  recall: { staged_clean: 0, staged_bad: 0, plain_clean: 0, plain_bad: 0 },
}

/** A ticket ID shown L1 and in the recall arm `arm`. */
const ticketIn = (arm: "staged" | "plain"): TicketId => {
  for (let i = 0; ; i++) {
    const ticket = `t-${i}`
    if (armOf("L1", ticket) && recallArmOf(ticket) === arm) return ticket as TicketId
  }
}

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings
type Settings = typeof defaults

/** A verifier round's hooks, `call` begun and ended PASS. */
const verifierRound = (call: string): ReadonlyArray<Step> => {
  const tool = {
    tool_name: "Agent",
    tool_input: { subagent_type: "verifier", prompt: "Verify" },
    tool_use_id: call,
  }
  return [
    hook({ hook_event_name: "PreToolUse", ...tool }),
    hook({
      hook_event_name: "PostToolUse",
      ...tool,
      tool_response: { agentId: "a", content: [{ type: "text", text: "PASS" }] },
    }),
  ]
}

/** Claims its ticket, runs `rounds` verifier rounds, commits `files` and closes it. */
const works = (
  world: World,
  root: string,
  id: TicketId,
  rounds: number,
  files: Files = { "a.txt": "a\n" },
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...Array.from({ length: rounds }, (_, i) => verifierRound(`toolu_${i + 1}`)).flat(),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** A hand-back turn in which the worker commits a fix naming its ticket. */
const fixes = (world: World, root: string, id: string): SessionScript =>
  turn([
    ...bash(check),
    ...bash(
      `git commit -am "Fix the check (${id})"`,
      Effect.asVoid(
        Effect.orDie(
          world.repository.commit(join(root, id), `Fix the check (${id})`, { "fix.txt": "x\n" }),
        ),
      ),
    ),
  ])

/** The fast check failing, its lines saying what failed. */
const fails = () =>
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

interface Plan {
  readonly id: TicketId
  readonly checks?: ChecksScript
  /** The ticket's worker's turns. */
  readonly turns: (world: World, root: string) => ReadonlyArray<SessionScript>
}

/** A whole run of the one ticket on main, L1 in the playbook, its worktree made in git first. */
const runs = (plan: Plan): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  mkdirSync(join(repo, ".tutti"), { recursive: true })
  writeFileSync(join(repo, playbookFile), `${JSON.stringify(lesson)}\n`)
  const settings: Settings = {
    ...defaults,
    concurrent: 1,
    checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  }
  return scenario(
    {
      config: { repo, settings },
      backlog: backlog().ticket(plan.id).seeds,
      git: { dir: repo },
      worktrees: { root },
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) => ({ [plan.id]: plan.turns(world, root) }),
    },
    Effect.gen(function* () {
      yield* (yield* Git).addWorktree(repo, join(root, plan.id), {
        branch: `tutti/${plan.id}`,
        base: "main",
      })
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      return yield* Fiber.join(fiber)
    }),
  )
}

/** The client_composed messages the ticket's worker was sent after its ticket's prompt. */
const composed = (ran: Ran<unknown>, id: TicketId): ReadonlyArray<string> =>
  ran.sent
    .flatMap((item) =>
      item._tag === "Message" && item.ticket === id && item.message.client_composed === true
        ? [String(item.message.message.content)]
        : [],
    )
    .slice(1)

/** The lessons the ticket's worker's session began with. */
const started = (ran: Ran<unknown>, id: TicketId): string => {
  const first = ran.sent.find((each) => each._tag === "Started" && each.ticket === id)
  return first?._tag === "Started" ? (first.session.lessons ?? "") : ""
}

describe("a worker in the staged arm", () => {
  const id = ticketIn("staged")

  test("is told its lessons' records as its second verifier round begins, once", async () => {
    const ran = await runs({
      id,
      turns: (world, root) => [[...works(world, root, id, 3), ...turn([], result("Noted."))]],
    })
    expectExitCode(ran, 0)
    expect(ran.events.find((each) => each.kind === "dispatch")).toMatchObject({
      ticket: id,
      playbook: { version: 1, lessons: ["L1"], held: [], recall: "staged" },
    })
    // The rule at its start, the record held back.
    expect(started(ran, id)).toContain("The parser keeps a cursor per file")
    expect(started(ran, id)).not.toContain("went badly")
    const [told, ...others] = composed(ran, id)
    expect(others).toEqual([])
    expect(told).toStartWith("\n\ntutti: this is your second verifier round")
    expect(told).toContain(
      `- The parser keeps a cursor per file: copy it before changing it.\n  ${record}`,
    )
    expect(ran.events.filter((each) => each.kind === "lesson_record")).toMatchObject([
      { ticket: id, why: "verifier", ids: ["L1"] },
    ])
    expect(ran.log).toContain(`  records for ${id} (second verifier round): L1`)
    // Its end counts by its arm: clean, three rounds all PASS.
    expect(ran.events.find((each) => each.kind === "lesson_measure")).toMatchObject({
      ticket: id,
      clean: true,
      lessons: [{ id: "L1", shown: true, helpful: 1, recall: { arm: "staged", staged_clean: 1 } }],
    })
  })

  test("is told nothing on one round", async () => {
    const ran = await runs({ id, turns: (world, root) => [works(world, root, id, 1)] })
    expectExitCode(ran, 0)
    expect(composed(ran, id)).toEqual([])
    expect(ran.events.filter((each) => each.kind === "lesson_record")).toEqual([])
  })

  test("gets the records with a failed check handed back, and not again on a second", async () => {
    const ran = await runs({
      id,
      checks: { fast: [fails(), fails()] },
      turns: (world, root) => [
        [...works(world, root, id, 1), ...fixes(world, root, id), ...fixes(world, root, id)],
      ],
    })
    expectExitCode(ran, 0)
    const [first, second, ...others] = composed(ran, id)
    expect(others).toEqual([])
    expect(first).toContain(`tutti: Before tutti/${id} merges into main, '${check}' fails on it.`)
    expect(first).toContain(
      "\n\ntutti: a failed check is handed back to you, which earlier tickets",
    )
    expect(first).toEndWith(`\n  ${record}\n`)
    expect(second).toContain(`'${check}' fails on it.`)
    expect(second).not.toContain("went well")
    expect(ran.events.filter((each) => each.kind === "lesson_record")).toMatchObject([
      { ticket: id, why: "hand_back", ids: ["L1"] },
    ])
    expect(ran.log).toContain(`  records for ${id} (failed check handed back): L1`)
    // Not clean: handed back. Counted as staged, not clean.
    expect(ran.events.find((each) => each.kind === "lesson_measure")).toMatchObject({
      ticket: id,
      clean: false,
      lessons: [{ id: "L1", shown: true, harmful: 1, recall: { arm: "staged", staged_bad: 1 } }],
    })
  })
})

describe("a worker in the plain arm", () => {
  const id = ticketIn("plain")

  test("reads each record under its rule from the start, and is told nothing as it struggles", async () => {
    const ran = await runs({ id, turns: (world, root) => [works(world, root, id, 2)] })
    expectExitCode(ran, 0)
    expect(ran.events.find((each) => each.kind === "dispatch")).toMatchObject({
      ticket: id,
      playbook: { recall: "plain" },
    })
    expect(started(ran, id)).toContain(
      `\n  Where an earlier ticket here went badly and another went well: ${record}`,
    )
    expect(composed(ran, id)).toEqual([])
    expect(ran.events.filter((each) => each.kind === "lesson_record")).toEqual([])
    expect(ran.events.find((each) => each.kind === "lesson_measure")).toMatchObject({
      ticket: id,
      clean: true,
      lessons: [{ id: "L1", recall: { arm: "plain", plain_clean: 1 } }],
    })
  })
})
