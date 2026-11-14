// The report's evidence from bd and git is read while the end-of-run full check runs, so that the
// reviewer starts as the check ends, with no read between (tutti-z6p5): the commits merged, the
// tickets closed and set aside, the ready count, which then says it was counted before the check.
// A quit during the full check interrupts the reads with it.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Queue, Ref } from "effect"
import type { AppConfigValue } from "../src/core/AppConfig.ts"
import type { Log } from "../src/core/log.ts"
import { Organs } from "../src/organs/Organs.ts"
import { makePrinter } from "../src/print/organLine.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { reportsDir } from "../src/run/report.ts"
import { finish, run } from "../src/run/run.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { CheckRun, Scripted } from "../src/testing/Checks.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { makeTheme } from "../src/ui/theme.ts"
import {
  backlog,
  expectExitCode,
  expectLog,
  type Outcome,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const fullCommand = "scripts/check-full.sh"
const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: true })
const reviewerText = "The run merged t-1; the full check passed.\n"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-report-reads-${name}-`)))

/** The settings with a full check. */
const config = (): Partial<AppConfigValue> => {
  const { settings } = appConfig()
  return {
    settings: {
      ...settings,
      checks: { ...settings.checks, full: { command: fullCommand, timeout: Duration.minutes(60) } },
    },
  }
}

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: TicketId) =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** What the run's end did, in order: the full check's start and end, and each read of the evidence. */
type Step =
  | "full check starts"
  | "full check ends"
  | "git log"
  | "bd list"
  | "bd ready"
  | "bd ready interrupted"

/** Waits, in real time, until `ready` holds: the run goes under the TestClock. */
const until = <E, R>(ready: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000; i++) {
      if (yield* ready) return
      yield* Effect.promise(() => Bun.sleep(1))
    }
    return yield* Effect.die(new Error("waited too long"))
  })

/**
 * The run's Beads and Git with each read of the report's evidence noted in `steps`, once the log
 * has the closing line, which the run writes before the full check and the reads (the reads
 * before it are the run's own): the git log of the commits merged, the bd list of the tickets
 * closed and set aside, and bd ready, which `holdReady` holds open until it is interrupted.
 */
const noting = <A, E, R>(
  running: Effect.Effect<A, E, R>,
  steps: Ref.Ref<ReadonlyArray<Step>>,
  holdReady = false,
): Effect.Effect<A, E, R | Beads | Git | Log> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const git = yield* Git
    const note = (step: Step) => Ref.update(steps, (all) => [...all, step])
    const ended = Effect.map(texts, (lines) => lines.some((each) => each.startsWith("READY_EMPTY")))
    /** `read`, noted as `step` once the run has ended; `held` in its place where given. */
    const atEnd = <B, E2, R2>(
      step: Step,
      read: Effect.Effect<B, E2, R2>,
      held?: Effect.Effect<B, E2, R2>,
    ) => Effect.flatMap(ended, (after) => (after ? Effect.andThen(note(step), held ?? read) : read))
    const held = Effect.never.pipe(Effect.onInterrupt(() => note("bd ready interrupted")))
    return yield* running.pipe(
      Effect.provideService(Beads, {
        ...beads,
        list: (options = {}) => atEnd("bd list", beads.list(options)),
        ready: (options) => atEnd("bd ready", beads.ready(options), holdReady ? held : undefined),
      }),
      Effect.provideService(Git, {
        ...git,
        log: (repo, base, head) => atEnd("git log", git.log(repo, base, head)),
      }),
    )
  })

/** What a whole run gave: the steps in order, the reviewer's input and the report it saved. */
interface Reviewed {
  readonly steps: ReadonlyArray<Step>
  readonly input: string
  readonly report: string
}

/**
 * A whole run on main in which t-1 merges, its full check running until the evidence has been read,
 * then its report, written by a canned reviewer.
 */
const reviewed = async (): Promise<Ran<Reviewed>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const calls: Array<OrganCallRecord> = []
  const steps = Effect.runSync(Ref.make<ReadonlyArray<Step>>([]))
  const note = (step: Step) => Ref.update(steps, (all) => [...all, step])
  const read = Effect.map(Ref.get(steps), (all) => all.includes("bd ready"))
  // The full check ends once the evidence has been read; a check that ended first would hang it.
  const waits: Scripted = (_: CheckRun) =>
    Effect.gen(function* () {
      yield* note("full check starts")
      yield* until(read)
      yield* note("full check ends")
      return { _tag: "CheckPassed", check: "full", command: fullCommand } as const
    }).pipe(
      Effect.map((passed) => ({
        ...passed,
        failingLines: [],
        lastLines: [],
        suites: [],
        suite: null,
        flaky: [],
        flakyCount: 0,
      })),
    )
  const organs = Organs.layer.pipe(
    Layer.provideMerge(cannedLayer({ reviewer: { report: reviewerText } }, calls)),
  )
  return scenario(
    {
      config: { ...config(), repo },
      git: { dir: repo },
      worktrees: { root },
      backlog: backlog().ticket("t-1").seeds,
      checks: { full: [waits] },
      scripts: (world) => ({ "t-1": [finishes(world, root, "t-1" as TicketId)] }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
      const running = yield* Effect.forkChild(
        noting(run({ version: "0.1.0-test", base: "main", endLater: true }), steps),
      )
      const outcome = yield* Fiber.join(running)
      const out = { write: () => {}, columns: () => 100, tty: false }
      yield* finish(
        outcome,
        Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }),
        false,
      )
      const input = calls.find((each) => each.call.organ === "reviewer")?.input ?? ""
      const dir = join(repo, reportsDir)
      const [name] = existsSync(dir) ? readdirSync(dir) : []
      const report = name === undefined ? "" : readFileSync(join(dir, name), "utf8")
      return { steps: yield* Ref.get(steps), input, report }
    }).pipe(Effect.provide(organs)),
  )
}

const gotten = <A>(ran: Ran<A>): A => {
  if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
  return ran.exit.value
}

/** The body of the reviewer's section titled `title`, or undefined when it has none. */
const sectionOf = (input: string, title: string): string | undefined => {
  const at = input.indexOf(`## ${title}\n\n`)
  if (at === -1) return undefined
  const body = input.slice(at).split("\n").slice(3).join("\n")
  return body.slice(0, body.indexOf("\n</evidence id="))
}

describe("the report's evidence is read while the full check runs", () => {
  test("the reads start before the check ends, and the reviewer starts as it ends, with no read between", async () => {
    const ran = await reviewed()
    const { steps, input, report } = gotten(ran)
    const starts = steps.indexOf("full check starts")
    const ends = steps.indexOf("full check ends")
    expect(starts).toBeGreaterThan(-1)
    expect(ends).toBeGreaterThan(starts)
    // Every read of the evidence came before the check ended, in their order, and none after it.
    expect(steps.filter((step) => !step.startsWith("full check"))).toEqual([
      "git log",
      "bd list",
      "bd ready",
    ])
    expect(steps.indexOf("bd ready")).toBeLessThan(ends)
    expect(steps.slice(ends + 1)).toEqual([])
    // The reviewer's evidence is as before, the ready count saying when it was counted.
    expect(sectionOf(input, "Commits merged into main in this run")).toMatch(/ Change \(t-1\)$/)
    expect(
      sectionOf(
        input,
        "Tickets closed in this run, merged or with no change to merge (ID, title, phase, close reason)",
      ),
    ).toMatch(/^t-1: /)
    expect(sectionOf(input, "Tickets still ready")).toBe("0, counted before the full check ran")
    expect(sectionOf(input, "The full check")).toMatch(/^ *FULL_CHECK passed: /)
    expect(report).toStartWith("# tutti run · ")
    expect(report).toContain(reviewerText)
  })
})

/** A whole run on main in which t-1 merges, then a Ctrl+C while the full check and bd ready run. */
const quitDuringCheck = async (): Promise<
  Ran<Outcome & { readonly steps: ReadonlyArray<Step> }>
> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const quits = Effect.runSync(Queue.unbounded<QuitRequest>())
  const steps = Effect.runSync(Ref.make<ReadonlyArray<Step>>([]))
  const note = (step: Step) => Ref.update(steps, (all) => [...all, step])
  const reading = Effect.map(Ref.get(steps), (all) => all.includes("bd ready"))
  // The full check quits the run once the report's bd ready is under way, and never ends by itself.
  const hanging: Scripted = (_: CheckRun) =>
    Effect.gen(function* () {
      yield* note("full check starts")
      yield* until(reading)
      yield* Queue.offer(quits, quitBy("SIGINT"))
      return yield* Effect.never
    })
  const organs = Organs.layer.pipe(
    Layer.provideMerge(cannedLayer({ reviewer: { report: reviewerText } }, [])),
  )
  return scenario(
    {
      config: { ...config(), repo },
      git: { dir: repo },
      worktrees: { root },
      backlog: backlog().ticket("t-1").seeds,
      checks: { full: [hanging] },
      scripts: (world) => ({ "t-1": [finishes(world, root, "t-1" as TicketId)] }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
      const running = yield* Effect.forkChild(
        noting(run({ version: "0.1.0-test", base: "main", quits }), steps, true),
      )
      const outcome = yield* Fiber.join(running)
      return { ...outcome, steps: yield* Ref.get(steps) }
    }).pipe(Effect.provide(organs)),
  )
}

describe("a quit during the full check", () => {
  test("interrupts the report's reads with it, and the run ends INTERRUPTED, 130", async () => {
    const ran = await quitDuringCheck()
    const { steps } = gotten(ran)
    expectExitCode(ran, 130)
    expect(steps.slice(steps.indexOf("bd ready"))).toEqual(["bd ready", "bd ready interrupted"])
    expectLog(ran, [
      /^ {2}FULL_CHECK_SKIPPED: /,
      "INTERRUPTED: quit with Ctrl+C during the full check",
    ])
    expect(ran.events.at(-1)).toMatchObject({ kind: "end", code: 130 })
  })
})
