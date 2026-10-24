// The dashboard's load line and each worker's memory in Current (orchestra 0.8.5, src/ui/LoadLine.tsx):
// fake readings for each colour, on macOS and Linux, a narrow pane, RunView's projection of a
// reading, and a whole run reading a fake machine while it shows the dashboard.
import { describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, SubscriptionRef } from "effect"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import {
  type Kernel,
  type Levels,
  Load,
  type LoadSource,
  parseProcesses,
  type Reading,
  unknownMemory,
} from "../src/run/load.ts"
import { line } from "../src/run/log.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { run } from "../src/run/run.ts"
import {
  emptyStatus,
  emptyView,
  type LoadView,
  project,
  type RunView,
  type Status,
} from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Screen } from "../src/run/screen.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Root } from "../src/ui/App.tsx"
import { headOf } from "../src/ui/Card.tsx"
import { loadSegments, workerMemory } from "../src/ui/LoadLine.tsx"
import { type Segments, seg } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra, type StyleName } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { advance, expectExitCode, scenario } from "./harness.ts"
import { renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")
const gb = 1024 ** 3

const green: Levels = { cpu: "green", pressure: "green", swapping: "green" }

const macOS: LoadView = {
  workers: 4.8 * gb,
  unknown: 0,
  check: 1.4 * gb,
  pressure: "normal",
  available: -1,
  swapping: 0,
  load1: 9.8,
  cores: 10,
  levels: green,
}

const totals = { ...emptyView.totals, workers: 4, slots: 4 }

const text = (segments: Segments) => segments.map((each) => each.text).join("")

/** The segment holding `part`, which must be there. */
const segmentOf = (segments: Segments, part: string) => {
  const found = segments.find((each) => each.text.includes(part))
  if (found === undefined) throw new Error(`no segment holds ${part}`)
  return found
}

/** Whether `part` is drawn in `style`. */
const inStyle = (segments: Segments, part: string, style: StyleName) =>
  expect(segmentOf(segments, part).look).toBe(theme.styles[style])

describe("the load line", () => {
  test("has the workers alone before the run has read the machine", () => {
    expect(text(loadSegments(totals, null, theme, 120))).toBe(" ▶ 4 of 4 workers")
    const none = loadSegments({ ...totals, workers: 0, slots: 1 }, null, theme, 120)
    expect(text(none)).toBe(" ▶ 0 of 1 worker")
    inStyle(none, "▶ 0", "dim")
  })

  test("macOS, nothing pressed: the memory uncoloured, the pressure and the CPU green", () => {
    const segments = loadSegments(totals, macOS, theme, 120)
    expect(text(segments)).toBe(
      " ▶ 4 of 4 workers · memory 6.2 GB (workers 4.8, merge check 1.4) · pressure normal · CPU 9.8/10 cores",
    )
    expect(segmentOf(segments, "memory").look).toBeNull()
    inStyle(segments, "pressure normal", "done")
    inStyle(segments, "CPU", "done")
    inStyle(segments, "▶ 4", "picked")
  })

  test("only the CPU amber past 1.5 times the cores, the pressure still green", () => {
    const busy = { ...macOS, load1: 16, levels: { ...green, cpu: "amber" as const } }
    const segments = loadSegments(totals, busy, theme, 120)
    inStyle(segments, "CPU 16.0/10 cores", "deferred")
    inStyle(segments, "pressure normal", "done")
  })

  test("the CPU red past 3 times the cores for a minute", () => {
    const over = { ...macOS, load1: 31, levels: { ...green, cpu: "red" as const } }
    inStyle(loadSegments(totals, over, theme, 120), "CPU 31.0/10 cores", "stop")
  })

  test("the pressure red at warn, the CPU still green", () => {
    const warn = {
      ...macOS,
      pressure: "warn" as const,
      levels: { ...green, pressure: "red" as const },
    }
    const segments = loadSegments(totals, warn, theme, 120)
    inStyle(segments, "pressure warn", "stop")
    inStyle(segments, "CPU", "done")
  })

  test("swapping, amber, only while it is under way", () => {
    expect(text(loadSegments(totals, { ...macOS, swapping: 12 }, theme, 120))).not.toContain(
      "swapping",
    )
    const swapping = { ...macOS, swapping: 840.4, levels: { ...green, swapping: "amber" as const } }
    const segments = loadSegments(totals, swapping, theme, 140)
    expect(text(segments)).toContain(" · pressure normal · swapping 840 pages/min · CPU")
    inStyle(segments, "swapping 840 pages/min", "deferred")
  })

  test("Linux: the memory available beside the pressure", () => {
    const linux = { ...macOS, check: 0, available: 1.2 * gb, cores: 8, load1: 3.1 }
    expect(text(loadSegments(totals, linux, theme, 120))).toBe(
      " ▶ 4 of 4 workers · memory 4.8 GB · pressure normal (1.2 GB available) · CPU 3.1/8 cores",
    )
  })

  test("says how many workers' processes can't be found", () => {
    const unknown = { ...macOS, check: 0, unknown: 1 }
    expect(text(loadSegments(totals, unknown, theme, 120))).toContain(
      "memory 4.8 GB (workers 4.8, 1 unknown)",
    )
  })

  test("leaves out the figures it can't read", () => {
    const blank = { ...macOS, pressure: "unknown" as const, load1: -1 }
    expect(text(loadSegments(totals, blank, theme, 120))).toBe(
      " ▶ 4 of 4 workers · memory 6.2 GB (workers 4.8, merge check 1.4)",
    )
  })

  test("a narrow pane drops the breakdown, then the memory, then cuts the line", () => {
    expect(text(loadSegments(totals, macOS, theme, 80))).toBe(
      " ▶ 4 of 4 workers · memory 6.2 GB · pressure normal · CPU 9.8/10 cores",
    )
    expect(text(loadSegments(totals, macOS, theme, 60))).toBe(
      " ▶ 4 of 4 workers · pressure normal · CPU 9.8/10 cores",
    )
    const cut = text(loadSegments(totals, macOS, theme, 40))
    expect(cut.endsWith("…")).toBe(true)
    expect(Bun.stringWidth(cut)).toBe(40)
  })
})

const reading = (workers: ReadonlyMap<string, number>, kernel: Partial<Kernel> = {}): Reading => ({
  at: 0,
  workers,
  check: 1.4 * gb,
  kernel: { pressure: "normal", swaps: 0, load1: 9.8, cores: 10, available: -1, ...kernel },
  swapping: -1,
  levels: green,
})

const entry = (ticket: string, worker: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: TicketPhase.Working(),
  since: 0,
  worker,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** Both tickets' workers, editing. */
const editing: ReadonlyMap<string, WorkerState> = new Map([
  ["tut-1", WorkerState.Working({ doing: "editing" })],
  ["tut-2", WorkerState.Working({ doing: "editing" })],
])

const viewOf = (load: Reading | null, status: Partial<Status> = {}): RunView =>
  project({
    ledger: {
      tickets: new Map([
        ["tut-1", entry("tut-1", 1)],
        ["tut-2", entry("tut-2", 2)],
      ]),
      rows: 2,
      windDown: null,
      bugs: [],
    },
    workers: editing,
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "main", concurrency: 2, load, ...status },
  })

describe("RunView", () => {
  test("sums the reading's memory, and gives each card its worker's", () => {
    const view = viewOf(
      reading(
        new Map([
          ["tut-1", 1.5 * gb],
          ["tut-2", unknownMemory],
        ]),
      ),
    )
    expect(view.load).toEqual({
      workers: 1.5 * gb,
      unknown: 1,
      check: 1.4 * gb,
      pressure: "normal",
      available: -1,
      swapping: -1,
      load1: 9.8,
      cores: 10,
      levels: green,
    })
    expect(view.cards.map((card) => card.memory)).toEqual([1.5 * gb, unknownMemory])
  })

  test("has no load, and no card memory, before a reading", () => {
    const view = viewOf(null)
    expect(view.load).toBeNull()
    expect(view.cards.every((card) => card.memory === undefined)).toBe(true)
  })

  test("keeps the load's identity while the reading says the same", () => {
    const first = viewOf(reading(new Map([["tut-1", gb]])))
    const next = project(
      {
        ledger: {
          tickets: new Map([
            ["tut-1", entry("tut-1", 1)],
            ["tut-2", entry("tut-2", 2)],
          ]),
          rows: 2,
          windDown: null,
          bugs: [],
        },
        workers: editing,
        requests: [],
        status: {
          ...emptyStatus,
          version: "0.1.0",
          branch: "main",
          concurrency: 2,
          load: { ...reading(new Map([["tut-1", gb]])), at: 5000 },
        },
      },
      first,
    )
    expect(next.load).toBe(first.load)
  })
})

describe("Current", () => {
  test("a worker's memory on its card's first line, `? GB` when it can't be found", () => {
    const view = viewOf(
      reading(
        new Map([
          ["tut-1", 1.2 * gb],
          ["tut-2", unknownMemory],
        ]),
      ),
    )
    const [one, two] = view.cards
    if (one === undefined || two === undefined) throw new Error("no cards")
    const head = (card: typeof one) => text(headOf(card, theme, 42_000, "⣾", [seg(card.status)]))
    expect(head(one)).toBe("⣾ tut-1  editing  42s  1.2 GB")
    expect(head(two)).toBe("⣾ tut-2  editing  42s  ? GB")
    expect(workerMemory(0)).toBe("0.0 GB")
  })

  test("the dashboard draws the load line under the title line, a blank line between", async () => {
    const view = viewOf(reading(new Map([["tut-1", 1.2 * gb]])))
    const value: ShellValue = {
      view: external(view),
      screen: external<Screen>(Screen.Dashboard()),
      commands: Effect.runSync(makeCommands),
      appearance: external<Appearance>("dark"),
      themeOf,
      now: () => 42_000,
    }
    const frame = await renderFrame(<Root value={value} />, { width: 120, height: 30 })
    const lines = frame.chars.split("\n").map((each) => each.trimEnd())
    expect(lines[1]).toStartWith(" Tutti  0.1.0")
    expect(lines[2]).toBe("")
    expect(lines[3]).toBe(
      " ▶ 2 of 2 workers · memory 2.6 GB (workers 1.2, merge check 1.4) · pressure normal · CPU 9.8/10 cores",
    )
    expect(lines.join("\n")).not.toContain("│ Workers")
    expect(lines.some((each) => each.includes("tut-1  editing  42s  1.2 GB"))).toBe(true)
  })
})

describe("the run", () => {
  test("reads the machine's load while it shows the dashboard", async () => {
    const repo = realpathSync(await mkdtemp(join(tmpdir(), "tutti-load-repo-")))
    const root = realpathSync(await mkdtemp(join(tmpdir(), "tutti-load-worktrees-")))
    // t-1's Claude Code is 9001, with a command of its own; tutti runs a merge check besides.
    const listing = [
      `${process.pid} 1 ${process.pid} 100000`,
      `9001 ${process.pid} 9001 1048576`,
      "9002 9001 9001 524288",
      `9100 ${process.pid} 9100 262144`,
    ].join("\n")
    const source: LoadSource = {
      processes: Effect.succeed(parseProcesses(listing)),
      kernel: Effect.succeed({
        pressure: "warn",
        swaps: 0,
        load1: 9.8,
        cores: 10,
        available: -1,
      }),
    }
    const gate = Deferred.makeUnsafe<void>()
    let seen: RunView | undefined
    const ran = await scenario(
      {
        config: { repo, worktrees: root, settings: appConfig().settings },
        backlog: [{ id: "t-1" }],
        git: { dir: repo },
        worktrees: { root },
        processes: new Map([["t-1", 9001]]),
        scripts: (world) => ({
          "t-1": [
            claimsAndCloses("t-1", {
              claim: Effect.andThen(
                Deferred.await(gate),
                Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
              ),
              commit: Effect.asVoid(
                Effect.orDie(
                  world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
                ),
              ),
              close: Effect.asVoid(Effect.orDie(world.beads.close("t-1", "done"))),
            }),
          ],
        }),
      },
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
          branch: "tutti/t-1",
          base: "main",
        })
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard,
          }).pipe(Effect.provideService(Load, source)),
        )
        // RunView is written at most 30 times a second, on the Clock: move it on to see the latest.
        for (let i = 0; i < 200 && seen?.cards[0]?.memory === undefined; i++) {
          yield* advance("100 millis")
          yield* Effect.promise(() => Bun.sleep(5))
          if (shown !== undefined) seen = yield* SubscriptionRef.get(shown.view)
        }
        yield* Deferred.succeed(gate, undefined)
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expect(seen?.cards[0]?.memory).toBe(1.5 * gb)
    expect(seen?.load).toMatchObject({
      workers: 1.5 * gb,
      unknown: 0,
      check: 0.25 * gb,
      pressure: "warn",
      levels: { cpu: "green", pressure: "red", swapping: "green" },
    })
  })
})
