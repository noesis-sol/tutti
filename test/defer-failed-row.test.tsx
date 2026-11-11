// A ticket bd couldn't defer is Deferred in the run and not in bd (§ 7.2, tutti-1755): its row says
// what the line saying so says, as `bd undefer` has nothing to bring back, from the ledger's
// `deferFailed`, kept while it is Deferred.

import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { detail, type Log, ticketLine } from "../src/core/log.ts"
import { orchestra } from "../src/project/scheme.ts"
import { type Aside, putAside } from "../src/run/aside.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { type Entry, emptyTallies, Ledger, type State } from "../src/run/ledger.ts"
import { Move, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { make } from "../src/run/schedule.ts"
import { Screen } from "../src/run/screen.ts"
import type { Beads, TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { withRender } from "./render.ts"
import { boxWith } from "./screen.ts"

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const t1 = "t-1" as TicketId
const locked = { id: "t-1", stderr: "Error: database is locked\nmore of bd's output\n" }
const undefer = "Run bd undefer t-1 to bring it back."
const saysFailed =
  "DEFER_FAILED: t-1 set aside, and bd could not defer it: Error: database is locked; kept out of this run, look at it"

const aside: Aside = {
  note: "tutti: set aside.",
  reason: "set aside",
  detail: "set aside",
  deferred: ticketLine("t-1")`set aside`,
  failed: "t-1 set aside, and bd could not defer it",
  instead: "look at it",
}

type Env = Backlog | Beads | EventStream | Ledger | Log | RunFibers | Scope.Scope

/** Runs `effect` over the in-memory backlog with `seeds` and a ledger, under TestClock. */
const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** t-1 taken up and Working. */
const working = Effect.gen(function* () {
  const ledger = yield* Ledger
  yield* ledger.transition(t1, Move.Ready(), { title: "One ticket" })
  yield* ledger.transition(t1, Move.Dispatched())
  return ledger
})

/** t-1 set aside, bd failing its defer unless `defers`: the ledger as that leaves it. */
const setAside = (defers: boolean) =>
  run(
    [{ id: "t-1" }],
    Effect.gen(function* () {
      const ledger = yield* working
      if (!defers) yield* (yield* Backlog).fail("defer", locked)
      expect(yield* putAside({ id: t1, title: "One ticket" }, aside)).toBe(defers)
      return yield* ledger.current
    }),
  )

const viewOf = (ledger: State): RunView =>
  project({
    ledger,
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 4 },
    actions: new Map(),
  })

/** What the screen says once Enter has taken up the selected row, all on one line. */
const said = async (view: RunView, width: number, keys: number) => {
  const value = {
    view: external(view),
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf: (appearance: Appearance) =>
      makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false }),
    now: () => began,
  }
  let text = ""
  await withRender(<Root value={value} />, { width, height: 40 }, async (rendered) => {
    await rendered.input((setup) => {
      for (let i = 0; i < keys; i++) setup.mockInput.pressEnter()
    })
    text = (await rendered.capture()).chars
  })
  return text
}

/** `text` without its frames, its lines wrapped inside a frame run together. */
const unwrapped = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      const inner = line.split(/[│┃]/).filter((each) => each.trim() !== "")
      return inner[inner.length - 1]?.trim() ?? ""
    })
    .join(" ")
    .replace(/ +/g, " ")

describe("a Deferred row bd couldn't defer", () => {
  test("the panel says what its DEFER_FAILED line says, and no bd undefer", async () => {
    const panel = unwrapped(await said(viewOf(await setAside(false)), 155, 1))
    expect(panel).toContain("t-1 deferred: set aside")
    expect(panel).toContain(saysFailed)
    expect(panel).not.toContain("bd undefer")
  })

  test("so does its box in a pane with no panel", async () => {
    // Only the box's own lines, the dashboard's frames around it left out.
    const pane = await said(viewOf(await setAside(false)), 100, 2)
    const box = unwrapped(boxWith(pane, "t-1").lines.join("\n"))
    expect(box).toContain(saysFailed)
    expect(box).not.toContain("bd undefer")
  })

  test("is on the ledger as the line says it, without its indent", async () => {
    const state = await setAside(false)
    expect(state.tickets.get(t1)?.phase._tag).toBe("Deferred")
    expect(state.tickets.get(t1)?.deferFailed).toBe(saysFailed)
  })

  test("its text is sanitised as it enters the view", () => {
    const entry: Entry = {
      ticket: t1,
      title: "One ticket",
      phase: TicketPhase.Deferred({ why: "set aside" }),
      since: began,
      worker: null,
      row: 0,
      rechecking: false,
      steered: false,
      lastMessage: null,
      tallies: emptyTallies,
      deferFailed: "bd said \u001b[31mno\u001b[0m",
    }
    const [row] = viewOf({
      tickets: new Map([[t1, entry]]),
      rows: 1,
      windDown: null,
      bugs: [],
    }).rows
    expect(row?.detail).toMatchObject({ _tag: "Deferred", deferFailed: "bd said no" })
  })
})

describe("a Deferred row bd did defer", () => {
  test("offers bd undefer", async () => {
    const state = await setAside(true)
    expect(state.tickets.get(t1)?.deferFailed).toBeUndefined()
    expect(unwrapped(await said(viewOf(state), 155, 1))).toContain(undefer)
  })

  test("a ticket back in the queue forgets the failure, and a later deferral offers bd undefer", async () => {
    const state = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const ledger = yield* working
        yield* (yield* Backlog).fail("defer", locked)
        yield* putAside({ id: t1, title: "One ticket" }, aside)
        yield* ledger.transition(t1, Move.Undeferred())
        const back = (yield* ledger.current).tickets.get(t1)
        expect(back?.phase._tag).toBe("Queued")
        expect(back?.deferFailed).toBeUndefined()
        yield* ledger.transition(t1, Move.Dispatched())
        yield* putAside({ id: t1, title: "One ticket" }, aside)
        return yield* ledger.current
      }),
    )
    expect(state.tickets.get(t1)?.deferFailed).toBeUndefined()
    expect(unwrapped(await said(viewOf(state), 155, 1))).toContain(undefer)
  })
})

describe("BAD_TICKET_ID", () => {
  const bad = "x-../y" as TicketId
  const why = "IDs with path characters can't be run"
  const failure = detail`${why}: ${bad}, and bd could not defer it`

  /** Fills a queue with a ticket whose ID can't be run, bd failing its defer unless `defers`. */
  const filled = (defers: boolean) =>
    run(
      [{ id: bad, title: "Bad" }],
      Effect.gen(function* () {
        if (!defers) yield* (yield* Backlog).fail("defer", { id: bad, stderr: "locked\n" })
        const schedule = yield* make({
          concurrent: 1,
          limit: 40,
          scope: null,
          excludeTypes: [],
          start: { start: () => Effect.void },
        })
        yield* schedule.fillTrying
        return {
          entry: (yield* (yield* Ledger).current).tickets.get(bad),
          log: yield* texts,
        }
      }),
    )

  test("bd failing its defer: the row says that line, which the log has once", async () => {
    const { entry, log } = await filled(false)
    expect(entry?.phase._tag).toBe("Deferred")
    expect(entry?.deferFailed).toBe(failure.trimStart())
    expect(log.filter((each) => each === failure)).toHaveLength(1)
  })

  test("bd deferring it: the row has no failure to say", async () => {
    const { entry, log } = await filled(true)
    expect(entry?.phase._tag).toBe("Deferred")
    expect(entry?.deferFailed).toBeUndefined()
    expect(log).not.toContain(failure)
  })
})
