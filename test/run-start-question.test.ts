// The start question in the run (§ 5 item 3, § 7.1): when a run asks it, and how; what it says of
// the current tickets; the line form over stdin; and the feature it chose, named in the run lock.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { asking, askLines, type Deciding, decided, ticketCount } from "../src/run/choose.ts"
import { noHolds, type Options } from "../src/run/nothing.ts"
import { Beads, BeadsFailed } from "../src/services/Beads.ts"
import { type Holder, parseHolder, RunLock } from "../src/services/RunLock.ts"
import type { OutputMode } from "../src/services/Tty.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { layer as memoryLock } from "../src/testing/RunLock.ts"
import { TicketCount, Work } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const undecided: Deciding = { tickets: false, ticket: null, feature: null, plain: false, limit: 40 }
const both = { stdinIsTty: true, stdoutIsTty: true }
const dashboard: OutputMode = { _tag: "Dashboard" }

describe("whether the run asks", () => {
  test("on two TTYs with no deciding flag, in the renderer with the dashboard", () => {
    expect(decided(undecided)).toBe(false)
    expect(asking(both, undecided, dashboard)).toBe("renderer")
  })

  test("as lines when the terminal can't draw the dashboard: TERM=dumb, fewer colours", () => {
    expect(asking(both, undecided, { _tag: "Plain", reason: "dumb" })).toBe("lines")
    expect(asking(both, undecided, { _tag: "Plain", reason: "fewerColours" })).toBe("lines")
  })

  test("not when stdin or stdout isn't a TTY", () => {
    expect(asking({ ...both, stdinIsTty: false }, undecided, dashboard)).toBe("no")
    expect(asking({ ...both, stdoutIsTty: false }, undecided, dashboard)).toBe("no")
  })

  test("not when a flag decides: --tickets, --ticket, --feature, --plain, a --limit reached", () => {
    const flags: ReadonlyArray<Partial<Deciding>> = [
      { tickets: true },
      { ticket: "k-1" },
      { feature: "dark mode" },
      { plain: true },
      { limit: 0 },
    ]
    for (const flag of flags) {
      const config = { ...undecided, ...flag }
      expect(decided(config)).toBe(true)
      expect(asking(both, config, dashboard)).toBe("no")
      expect(asking(both, config, { _tag: "Plain", reason: "dumb" })).toBe("no")
    }
  })
})

const options = (fields: Partial<Options> = {}): Options => ({
  scope: null,
  filter: { excludeTypes: [] },
  repo: "/repo",
  base: "main",
  carried: new Set(),
  unmerged: new Set(),
  held: noHolds,
  ...fields,
})

/** What the start question says of `seeds`' tickets; with `failing`, bd ready fails. */
const count = (seeds: ReadonlyArray<Seed>, fields: Partial<Options> = {}, failing = false) => {
  const beads = failing
    ? Layer.effect(
        Beads,
        Effect.map(Beads, (live) =>
          Beads.of({
            ...live,
            ready: () =>
              Effect.fail(
                new BeadsFailed({
                  command: "bd ready",
                  exitCode: 1,
                  stderr: "no database",
                  noSuchIssue: false,
                }),
              ),
          }),
        ),
      ).pipe(Layer.provide(beadsLayer(seeds)))
    : beadsLayer(seeds)
  return Effect.runPromise(
    ticketCount(options(fields)).pipe(
      Effect.provide(
        Layer.mergeAll(beads, gitLayer({ dir: "/repo" })).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )
}

describe("what it says of the current tickets", () => {
  test("how many bd ready lists, questions and epics left out", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "k-1" },
      { id: "k-2" },
      { id: "q-1", labels: ["human"] },
      { id: "e-1", type: "epic" },
      { id: "k-3", status: "closed" },
    ]
    expect(await count(seeds)).toEqual(TicketCount.Ready({ n: 2 }))
  })

  test("all done when none is left", async () => {
    expect(await count([{ id: "k-1", status: "closed" }])).toEqual(TicketCount.AllDone())
  })

  test("none ready, with how many are open but held or waiting", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "in_progress" },
      { id: "w-1", blockedBy: ["b-1"] },
      { id: "q-1", labels: ["human"] },
    ]
    expect(await count(seeds)).toEqual(TicketCount.NoneReady({ open: 3 }))
  })

  test("in a scope, the tickets of the scope not done", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "e-1", type: "epic" },
      { id: "e-1.1", parent: "e-1", status: "in_progress" },
      { id: "k-1" },
    ]
    expect(await count(seeds, { scope: "e-1" })).toMatchObject({ _tag: "NoneReady" })
  })

  test("unknown when bd can't say", async () => {
    expect(await count([{ id: "k-1" }], {}, true)).toEqual(TicketCount.Unknown())
  })
})

describe("the line form over stdin", () => {
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

  const ask = async (typed: string) => {
    const stdin = new PassThrough()
    stdin.write(typed)
    stdin.end()
    let output = ""
    const exit = await Effect.runPromiseExit(
      askLines(
        stdin,
        (text) => {
          output += text
        },
        theme,
        TicketCount.Ready({ n: 3 }),
      ),
    )
    return { exit, output }
  }

  test("chooses the current tickets, or a new feature with its description", async () => {
    const tickets = await ask("1\n")
    expect(tickets.exit).toEqual(Exit.succeed(Work.Tickets()))
    expect(tickets.output).toContain("Current tickets: 3 ready")
    const feature = await ask("2\ndark mode for the dashboard\n")
    expect(feature.exit).toEqual(
      Exit.succeed(Work.Feature({ description: "dark mode for the dashboard" })),
    )
  })

  test("is cancelled by the end of input (Ctrl+D)", async () => {
    const { exit } = await ask("")
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("FormCancelled")
  })
})

describe("the feature in the run lock", () => {
  const holder: Holder = {
    pid: process.pid,
    started: new Date(2026, 9, 18, 9, 0).toISOString(),
    version: "0.1.0",
    branch: "main",
  }

  test("is written to tutti.lock once the start question chose it, the lock still held", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-start-question-")))
    const commonDir = join(repo, ".git")
    mkdirSync(commonDir)
    const said = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* (yield* RunLock).acquire({ repo, commonDir, holder })
          const before = parseHolder(readFileSync(join(commonDir, "tutti.lock"), "utf8"))
          yield* lock.rewrite({ ...holder, feature: "dark mode" })
          const after = parseHolder(readFileSync(join(commonDir, "tutti.lock"), "utf8"))
          // A second run is still refused.
          const second = yield* Effect.exit(
            Effect.scoped((yield* RunLock).acquire({ repo, commonDir, holder })),
          )
          const orchestra = readFileSync(join(commonDir, "orchestra.lock"), "utf8")
          return { before, after, second, orchestra }
        }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    expect(said.before.feature).toBeUndefined()
    expect(said.after).toEqual({ ...holder, feature: "dark mode" })
    expect(Exit.isFailure(said.second)).toBe(true)
    expect(said.orchestra).not.toContain("dark mode")
    expect(readFileSync(join(commonDir, "tutti.lock"), "utf8")).toBe("")
  })

  test("names the new holder in the test layer's lock, as another run sees it", async () => {
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const locks = yield* RunLock
          const lock = yield* locks.acquire({ repo: "/repo", commonDir: "/repo/.git", holder })
          yield* lock.rewrite({ ...holder, feature: "dark mode" })
          const refused = yield* Effect.flip(
            Effect.scoped(locks.acquire({ repo: "/repo", commonDir: "/repo/.git", holder })),
          )
          return refused._tag === "AlreadyRunning" ? refused.holder : undefined
        }),
      ).pipe(Effect.provide(memoryLock())),
    )
    expect(seen).toEqual({ ...holder, feature: "dark mode" })
  })
})
