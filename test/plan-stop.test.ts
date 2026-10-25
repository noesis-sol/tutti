// A stop during tutti plan (Ctrl+C, SIGTERM: an interruption, which runMain ends with exit code
// 130): as it reads it says it changed nothing; during --apply it stops between two links, the one
// under way added whole, and says which links it added and which not.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Console, Context, Deferred, Effect, Exit, Fiber, Layer, Runtime } from "effect"
import { Command } from "effect/cli"
import { tuttiWith } from "../src/cli/commands.ts"
import { stoppedLine, stoppedReadingLine } from "../src/plan/plan.ts"
import { Beads, BeadsFailed, type TicketId } from "../src/services/Beads.ts"
import { type Git, Git as GitService } from "../src/services/Git.ts"
import type { RunLock } from "../src/services/RunLock.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { layer as lockLayer } from "../src/testing/RunLock.ts"

const files = {
  "src/run/merge.ts": "export const merge = () => refreshBranch()\n",
  "docs/notes.md": "# Notes\n",
  "README.md": "# tutti\n",
}

/** A checkout holding `files`, on disk for their contents and in git for their names. */
const checkout = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-plan-stop-")))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}

// Three links: t-1 waits for t-2, t-5 for t-4, t-8 for t-3.
const backlog: ReadonlyArray<Seed> = [
  { id: "t-1", priority: 2, description: "Retry in `Loop.merge`." },
  { id: "t-2", priority: 1, description: "Log each rebase in Loop.merge()." },
  { id: "t-3", priority: 2, description: "Reword README.md." },
  { id: "t-4", priority: 2, description: "Reword docs/notes.md." },
  { id: "t-5", priority: 3, description: "Add a section to docs/notes.md." },
  { id: "t-8", priority: 3, description: "Fix the title in README.md." },
]

interface Stop {
  /**
   * Where the stop comes: as bd lists the tickets, as git finds the lock to warn of a run, or as bd
   * adds the link of this ticket.
   */
  readonly at: "list" | "warning" | string
  /** The tickets whose link bd refuses to add. */
  readonly refused?: ReadonlyArray<string>
}

/**
 * Runs `tutti plan` with args against `backlog`, interrupting it at `stop`; returns what it said,
 * its exit, and each ticket's blockers after.
 */
const stopped = (args: ReadonlyArray<string>, stop: Stop) => {
  const dir = checkout()
  const printed: Array<string> = []
  const errors: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
    error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const beads = yield* Beads
      const git = yield* GitService
      const stopping = yield* Deferred.make<void>()
      // The stop comes while bd or git is at work: a list or git never answers, a link takes a
      // moment more.
      const withGit = Context.add(yield* Effect.context<Beads | Git | RunLock>(), GitService, {
        ...git,
        commonDir: (dir) =>
          stop.at === "warning"
            ? Effect.andThen(Deferred.succeed(stopping, undefined), Effect.never)
            : git.commonDir(dir),
      })
      const services = Context.add(withGit, Beads, {
        ...beads,
        list: (options) =>
          stop.at === "list"
            ? Effect.andThen(Deferred.succeed(stopping, undefined), Effect.never)
            : beads.list(options),
        addDependency: (id, dependsOn, type) =>
          Effect.gen(function* () {
            if (id === stop.at) {
              yield* Deferred.succeed(stopping, undefined)
              yield* Effect.sleep("50 millis")
            }
            if (stop.refused?.includes(id)) {
              return yield* new BeadsFailed({
                command: `bd dep add ${id} ${dependsOn}`,
                exitCode: 1,
                stderr: "database is locked\n",
                noSuchIssue: false,
              })
            }
            return yield* beads.addDependency(id, dependsOn, type)
          }),
      })
      const fiber = yield* Command.runWith(
        tuttiWith(Effect.succeed(dir), () => Layer.succeedContext(services)),
        { version: "test", renderErrors: false },
      )(["plan", ...args]).pipe(Effect.provideService(Console.Console, console), Effect.forkChild)
      yield* Deferred.await(stopping)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      const issues = yield* (yield* Backlog).issues
      const blockers = Object.fromEntries(
        issues.map((issue) => [
          issue.id,
          issue.dependencies.filter((d) => d.type === "blocks").map((d) => d.id),
        ]),
      )
      let code: number | undefined
      Runtime.defaultTeardown(exit, (c) => {
        code = c
      })
      return { printed, errors, exit, code, blockers }
    }).pipe(
      Effect.provide(Layer.mergeAll(beadsLayer(backlog), gitLayer({ dir, files }), lockLayer())),
      Effect.provide(BunServices.layer),
    ),
  )
}

const interruptedOnly = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)

describe("tutti plan stopped", () => {
  test("--apply stops between two links, the one under way added, and says which", async () => {
    const result = await stopped(["--apply"], { at: "t-5" })
    expect(result.printed).toEqual([
      "Adding 3 blocks links between the 6 open tickets:",
      "  t-1 (P2) waits for t-2 (P1): both touch Loop.merge",
      "  t-5 (P3) waits for t-4 (P2): both touch docs/notes.md",
    ])
    expect(result.errors).toEqual([
      "tutti plan: stopped. Added 2 of 3 links: t-1 waits for t-2, t-5 waits for t-4. Not added: t-8 waits for t-3.",
    ])
    expect(interruptedOnly(result.exit)).toBe(true)
    expect(result.code).toBe(130)
    expect(result.blockers["t-1"]).toEqual(["t-2" as TicketId])
    expect(result.blockers["t-5"]).toEqual(["t-4" as TicketId])
    expect(result.blockers["t-8"]).toEqual([])
  })

  test("a stop during the first link names it alone as added", async () => {
    const result = await stopped(["--apply"], { at: "t-1" })
    expect(result.errors).toEqual([
      "tutti plan: stopped. Added 1 of 3 links: t-1 waits for t-2. Not added: t-5 waits for t-4, t-8 waits for t-3.",
    ])
    expect(result.code).toBe(130)
    expect(result.blockers["t-1"]).toEqual(["t-2" as TicketId])
    expect(result.blockers["t-5"]).toEqual([])
  })

  test("a link bd refused before the stop is among those not added", async () => {
    const result = await stopped(["--apply"], { at: "t-5", refused: ["t-1"] })
    expect(result.errors).toEqual([
      "tutti plan: bd dep add t-1 t-2: bd dep add t-1 t-2 exited with 1: database is locked",
      "tutti plan: stopped. Added 1 of 3 links: t-5 waits for t-4. Not added: t-1 waits for t-2, t-8 waits for t-3.",
    ])
    expect(result.code).toBe(130)
    expect(result.blockers["t-1"]).toEqual([])
    expect(result.blockers["t-5"]).toEqual(["t-4" as TicketId])
  })

  test("a stop during the last link says all were added", async () => {
    const result = await stopped(["--apply"], { at: "t-8" })
    expect(result.errors).toEqual([
      "tutti plan: stopped. Added 3 of 3 links: t-1 waits for t-2, t-5 waits for t-4, t-8 waits for t-3.",
    ])
    expect(result.code).toBe(130)
    expect(result.blockers["t-8"]).toEqual(["t-3" as TicketId])
  })

  test("a stop as it looks for a run to warn of says nothing changed", async () => {
    const result = await stopped(["--apply"], { at: "warning" })
    expect(result.printed).toEqual([])
    expect(result.errors).toEqual([stoppedReadingLine])
    expect(result.code).toBe(130)
    expect(Object.values(result.blockers).flat()).toEqual([])
  })

  test("a stop as it reads the tickets says nothing changed", async () => {
    const result = await stopped(["--apply"], { at: "list" })
    expect(result.printed).toEqual([])
    expect(result.errors).toEqual([stoppedReadingLine])
    expect(result.code).toBe(130)
    expect(Object.values(result.blockers).flat()).toEqual([])
  })
})

describe("stoppedLine", () => {
  const link = (blocked: TicketId, blocker: TicketId) => ({ blocked, blocker, why: "README.md" })

  test("says none added when the stop came before the first link", () => {
    expect(
      stoppedLine(
        [],
        [link("b" as TicketId, "a" as TicketId), link("c" as TicketId, "b" as TicketId)],
      ),
    ).toBe("tutti plan: stopped. Added 0 of 2 links. Not added: b waits for a, c waits for b.")
  })
})
