import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer, Queue } from "effect"
import { TestClock } from "effect/testing"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { Organs } from "../src/organs/Organs.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import type { EventRecord } from "../src/run/events.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { finish, type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { defers, gone, type SessionScript, run as step, turn } from "../src/testing/AgentHost.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { type Answers, layer as cannedLayer } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { backlog, type Ran, scenario, type World } from "./harness.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-finish-${name}-`)))

/** Claims its ticket and defers it. */
const gives = (world: World, id: string): SessionScript =>
  defers(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    defer: Effect.asVoid(Effect.orDie(world.beads.defer(id))),
  })

/** Claims its ticket and goes, is resumed once and goes again: PAUSED. */
const pauses = (world: World, id: string): ReadonlyArray<SessionScript> => [
  [
    ...turn([step(Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))))]).slice(
      0,
      -2,
    ),
    gone("exit 1"),
  ],
  [gone("exit 1")],
]

interface Plan {
  readonly config?: Partial<AppConfigValue>
  readonly backlog: ReadonlyArray<Seed>
  readonly workers: Readonly<Record<string, "defers" | "pauses">>
  /** The organs' answers: the run has organs only when given. */
  readonly organs?: Answers
  /** Whether `finish` prints the styled summary, as after a dashboard. */
  readonly styled?: boolean
  /** Ctrl+C: `finish` is interrupted once it has begun. */
  readonly interrupt?: boolean
  /** Ctrl+C before the run's first look: the run is quit. */
  readonly quit?: boolean
}

interface Finished {
  readonly outcome: Outcome
  /** The event records as the run left them, before `finish`. */
  readonly before: ReadonlyArray<EventRecord>
  /** What `finish` printed, without its styles. */
  readonly printed: string
}

/** A whole run with RunOptions.endLater, then `finish` on a printer that keeps what it prints. */
const finishes = (plan: Plan): Promise<Ran<Finished>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const printed: Array<string> = []
  const out: Out = { write: (text) => printed.push(text), columns: () => 100, tty: false }
  const ran = Effect.gen(function* () {
    const git = yield* Git
    for (const id of Object.keys(plan.workers)) {
      yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
    }
    const quits = yield* Queue.unbounded<QuitRequest>()
    if (plan.quit) yield* Queue.offer(quits, quitBy("SIGINT"))
    const outcome = yield* run({ version: "0.1.0-test", base: "main", quits, endLater: true })
    const before = yield* (yield* Captured).records
    const finishing = yield* Effect.forkChild(
      finish(
        outcome,
        Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }),
        plan.styled ?? true,
      ),
    )
    if (plan.interrupt) {
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(finishing)
    } else yield* Fiber.join(finishing)
    return { outcome, before, printed: Bun.stripANSI(printed.join("")) }
  })
  return scenario(
    {
      config: { ...plan.config, repo },
      git: { dir: repo },
      worktrees: { root },
      backlog: plan.backlog,
      scripts: (world) =>
        Object.fromEntries(
          Object.entries(plan.workers).map(([id, how]) => [
            id,
            how === "defers" ? [gives(world, id)] : pauses(world, id),
          ]),
        ),
    },
    plan.organs === undefined
      ? ran
      : ran.pipe(Effect.provide(Organs.layer.pipe(Layer.provideMerge(cannedLayer(plan.organs))))),
  )
}

const finished = (ran: Ran<Finished>): Finished => {
  if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
  return ran.exit.value
}

const kinds = (records: ReadonlyArray<EventRecord>) => records.map((record) => record.kind)

const report = "The run ended with nothing left to do.\n\n## Set aside\n- t-1: deferred\n"

describe("when a run leaves its end to finish", () => {
  test("the run writes no end record; finish prints the styled summary and closing line, then writes it", async () => {
    const ran = await finishes({
      backlog: backlog().ticket("t-1", { title: "Parse the config" }).seeds,
      workers: { "t-1": "defers" },
    })
    const { outcome, before, printed } = finished(ran)
    expect(kinds(before)).not.toContain("end")
    expect(outcome.closing).toEqual(
      expect.objectContaining({ _tag: "Done", text: "READY_EMPTY after 1 tickets", tickets: 1 }),
    )
    expect(outcome.summary.rows.map((row) => row.ticket)).toEqual(["t-1"])
    expect(printed).toContain(" Tutti  0.1.0-test")
    expect(printed).toContain("Completed")
    expect(printed).toContain("Tickets")
    expect(printed).toMatch(/│ ↷ deferred +│ t-1 +│/)
    expect(printed).toContain("♪ Completed the Run  1 ticket")
    // Without organs there is no report.
    expect(printed).not.toContain("◆")
    expect(kinds(ran.events).at(-1)).toBe("end")
    expect(ran.events.at(-1)).toEqual(expect.objectContaining({ kind: "end", code: 0 }))
    expect(kinds(ran.events).filter((kind) => kind === "end")).toHaveLength(1)
  })

  test("a scoped run's stop is closed with its stops' line and its scope line", async () => {
    const ran = await finishes({
      config: { ticket: "e-1" },
      backlog: backlog().epic("e-1", ["e-1.1"]).seeds,
      workers: { "e-1.1": "pauses" },
    })
    const { outcome, printed } = finished(ran)
    expect(outcome.closing._tag).toBe("Stopped")
    expect(outcome.closing.text).toMatch(/^PAUSED: .*; SCOPE_OPEN: e-1: /)
    expect(printed).toMatch(/\n■ PAUSED: [^\n]*\n {2}SCOPE_OPEN: e-1: /)
    expect(printed).not.toContain("; SCOPE_OPEN")
    expect(printed).toContain("ticket e-1")
    // The log's stop line is the stops' line alone, as before.
    expect(ran.log.filter((l) => l.startsWith("PAUSED: "))).toEqual([
      outcome.closing.text.split("; SCOPE_")[0] ?? "",
    ])
    expect(ran.events.at(-1)).toEqual(expect.objectContaining({ kind: "end", code: 3 }))
  })

  test("with organs, the report and its organ lines follow the summary, before the end record", async () => {
    const ran = await finishes({
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "defers" },
      organs: {
        reviewer: { report },
        triage: { cause: "problem", confidence: "medium", summary: "Needs a simulator." },
      },
    })
    const { printed } = finished(ran)
    const closing = printed.indexOf("♪ Completed the Run")
    const written = printed.indexOf("◆ Run report written")
    expect(closing).toBeGreaterThan(-1)
    expect(written).toBeGreaterThan(closing)
    expect(printed.indexOf("Set aside", written)).toBeGreaterThan(written)
    expect(printed).toMatch(/◆ Report saved to \.tutti\/reports\/.*\.md/)
    expect(ran.log.some((l) => l.startsWith("REPORT: written to .tutti/reports/"))).toBe(true)
    expect(ran.events.at(-1)).toEqual(expect.objectContaining({ kind: "end", code: 0 }))
  })

  test("plain, finish prints no summary, only the report, as the log has said the summary", async () => {
    const ran = await finishes({
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "defers" },
      organs: {
        reviewer: { report },
        triage: { cause: "problem", confidence: "medium", summary: "Needs a simulator." },
      },
      styled: false,
    })
    const { printed } = finished(ran)
    expect(printed).not.toContain("♪")
    expect(printed).not.toContain(" Tutti ")
    expect(printed).toStartWith("◆ Run report written")
    // The log's REPORT line, printed on stdout too, says where the report is saved.
    expect(printed).not.toContain("Report saved")
    expect(ran.log.some((l) => l.startsWith("REPORT: written to .tutti/reports/"))).toBe(true)
    expect(ran.log).toContain("READY_EMPTY after 1 tickets")
    expect(ran.events.at(-1)).toEqual(expect.objectContaining({ kind: "end", code: 0 }))
  })

  test("a run that was quit has no report", async () => {
    const ran = await finishes({
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "defers" },
      organs: { reviewer: { report } },
      quit: true,
    })
    const { outcome, printed } = finished(ran)
    expect(outcome.exitCode).toBe(130)
    expect(printed).toContain("■ INTERRUPTED: ")
    expect(printed).not.toContain("◆")
    expect(ran.events.at(-1)).toEqual(expect.objectContaining({ kind: "end", code: 130 }))
  })

  test("Ctrl+C during the report skips it and ends the run INTERRUPTED", async () => {
    const ran = await finishes({
      backlog: backlog().ticket("t-1").seeds,
      workers: { "t-1": "defers" },
      organs: {
        reviewer: Effect.never,
        triage: { cause: "problem", confidence: "medium", summary: "Needs a simulator." },
      },
      interrupt: true,
    })
    const { printed } = finished(ran)
    expect(printed).toContain("◆ Run report skipped")
    const ends = ran.events.filter((record) => record.kind === "end")
    expect(ends).toEqual([expect.objectContaining({ kind: "end", code: 130 })])
  })
})
