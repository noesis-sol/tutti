import { describe, expect, test } from "bun:test"
import { Console, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import * as free from "../src/run/deferredFree.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import {
  box,
  check,
  type HoldKind,
  lines,
  make,
  type NothingToRun,
  noHolds,
  noStyles,
  nothingToRun,
  type Options,
  plainLines,
  themeStyles,
} from "../src/run/nothing.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import { Git, type GitWriter } from "../src/services/Git.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

// The message a run with nothing to run shows, in a box on a terminal and as plain lines otherwise,
// as orchestra's nothing_test.go has them; the check that finds it; and DEFERRED_FREE.

type Env = Beads | Backlog | Git | GitWriter | Repository | Log | EventStream | Captured

const repo = "/repo"

/** Runs `effect` against the in-memory backlog with `seeds`, a repository, a log and events. */
const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), gitLayer({ dir: repo }), logLayer(), eventsLayer()).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** The check's options for a run of all of bd ready, with `fields` over them. */
const options = (fields: Partial<Options> = {}): Options => ({
  scope: null,
  filter: { excludeTypes: [] },
  repo,
  base: "main",
  carried: new Set(),
  unmerged: new Set(),
  held: noHolds,
  ...fields,
})

/** The box on an 80-column terminal, without styles, as the terminal shows it. */
const plainBox = (n: NothingToRun, width = 80) => `${box(n, width, noStyles)}\n`

/** The plain lines, as stdout shows them after their time. */
const plain = (n: NothingToRun) => plainLines(n).join("\n")

describe("the box and its lines", () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly n: NothingToRun
    readonly styled: string
    readonly plain: string
  }> = [
    {
      name: "all done",
      n: make({ allDone: true }),
      styled: "╭────────────╮\n│ ✓ All done │\n╰────────────╯\n",
      plain: "✓ All done",
    },
    {
      name: "all done, epics still open",
      n: make({ allDone: true, stillOpen: ["k-1", "k-7"] }),
      styled:
        "╭───────────────────────────────────────────╮\n" +
        "│ ✓ All done                                │\n" +
        "│   Still open: k-1, k-7 (bd close k-1 k-7) │\n" +
        "╰───────────────────────────────────────────╯\n",
      plain: "✓ All done\n  Still open: k-1, k-7 (bd close k-1 k-7)",
    },
    {
      name: "nothing ready",
      n: make({ questions: 2, waiting: 1, inProgress: 3, other: 1, unmerged: 1 }),
      styled:
        "╭─────────────────────────────────────────────────────╮\n" +
        "│ ○ Nothing ready to run                              │\n" +
        "│   2 questions wait for your answer: bd human list   │\n" +
        "│   1 ticket waits on other tickets: bd blocked       │\n" +
        "│   3 in progress · 1 other                           │\n" +
        "│   1 closed but not merged: bd list --label unmerged │\n" +
        "╰─────────────────────────────────────────────────────╯\n",
      plain:
        "○ Nothing ready to run\n" +
        "  2 questions wait for your answer: bd human list\n" +
        "  1 ticket waits on other tickets: bd blocked\n" +
        "  3 in progress · 1 other\n" +
        "  1 closed but not merged: bd list --label unmerged",
    },
    {
      name: "nothing ready in a scope",
      n: make({
        scope: "k-1" as TicketId,
        notDone: [
          { id: "k-2" as TicketId, why: "blocked by k-9 outside the scope" },
          { id: "k-3" as TicketId, why: "closed but not merged: left unmerged by an earlier run" },
        ],
      }),
      styled:
        "╭────────────────────────────────────────────────────────────────╮\n" +
        "│ ○ Nothing under k-1 is ready to run                            │\n" +
        "│   k-2 (blocked by k-9 outside the scope)                       │\n" +
        "│   k-3 (closed but not merged: left unmerged by an earlier run) │\n" +
        "╰────────────────────────────────────────────────────────────────╯\n",
      plain:
        "○ Nothing under k-1 is ready to run\n" +
        "  k-2 (blocked by k-9 outside the scope)\n" +
        "  k-3 (closed but not merged: left unmerged by an earlier run)",
    },
  ]

  for (const each of cases) {
    test(`${each.name}: a box on a terminal, plain lines otherwise`, () => {
      expect(plainBox(each.n)).toBe(each.styled)
      expect(plain(each.n)).toBe(each.plain)
    })
  }

  test("each reason has its line and its command, in orchestra's words", () => {
    const n = make({
      questions: 2,
      waiting: 3,
      heldParents: 2,
      heldBlocked: 2,
      heldFollowUps: 2,
      inProgress: 1,
      deferred: 1,
      other: 2,
      unmerged: 1,
    })
    expect(lines(n, noStyles).rest).toEqual([
      "2 questions wait for your answer: bd human list",
      "3 tickets wait on other tickets: bd blocked",
      "2 tickets wait for their subtickets to merge",
      "2 tickets wait for their blockers to merge",
      "2 follow-ups wait for the tickets they were filed from to merge",
      "1 in progress · 1 deferred · 2 other",
      "1 closed but not merged: bd list --label unmerged",
    ])
  })

  test("one of each count reads in the singular", () => {
    const n = make({ questions: 1, waiting: 1, heldParents: 1, heldBlocked: 1, heldFollowUps: 1 })
    expect(lines(n, noStyles).rest).toEqual([
      "1 question waits for your answer: bd human list",
      "1 ticket waits on other tickets: bd blocked",
      "1 ticket waits for its subtickets to merge",
      "1 ticket waits for its blocker to merge",
      "1 follow-up waits for the ticket it was filed from to merge",
    ])
    expect(lines(make({ deferred: 4 }), noStyles).rest).toEqual(["4 deferred"])
  })

  test("a narrow terminal wraps the box's long lines, indented under their own", () => {
    const n = make({
      scope: "k-1" as TicketId,
      notDone: [
        { id: "k-3" as TicketId, why: "closed but not merged: left unmerged by an earlier run" },
      ],
    })
    const got = box(n, 40, noStyles)
    expect(got).toBe(
      "╭──────────────────────────────────────╮\n" +
        "│ ○ Nothing under k-1 is ready to run  │\n" +
        "│   k-3 (closed but not merged: left   │\n" +
        "│     unmerged by an earlier run)      │\n" +
        "╰──────────────────────────────────────╯",
    )
    for (const each of got.split("\n")) expect(Bun.stringWidth(each)).toBeLessThanOrEqual(40)
  })

  test("all done is framed done, ✓ done bold; nothing ready is framed frame, ○ faint", () => {
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
    const styles = themeStyles(theme)
    const done = box(make({ allDone: true, stillOpen: ["k-1"] }), 80, styles)
    expect(done).toContain(`${theme.ansi("done")}╭`)
    expect(done).toContain(theme.styles.closed.paint("✓"))
    expect(done).toContain("\x1b[1mAll done\x1b[0m")
    expect(done).toContain(theme.styles.picked.paint("k-1"))
    expect(done).toContain(theme.styles.key.paint("bd close k-1"))
    const ready = box(make({ questions: 1 }), 80, styles)
    expect(ready).toContain(`${theme.ansi("frame")}╭`)
    expect(ready).toContain(theme.styles.dim.paint("○"))
    expect(ready).toContain("\x1b[1mNothing ready to run\x1b[0m")
    expect(ready).toContain(theme.styles.key.paint("bd human list"))
    expect(Bun.stripANSI(ready)).toBe(box(make({ questions: 1 }), 80, noStyles))
  })

  test("under NO_COLOR the box keeps its bold and faint, and no colour", () => {
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
    const drawn = box(make({ allDone: true }), 80, themeStyles(theme))
    expect(drawn).not.toContain("\x1b[38;")
    expect(drawn).not.toContain("\x1b[48;")
    expect(drawn).toContain("\x1b[1m✓\x1b[0m")
  })

  test("a ticket's text can't break the box: sanitised, and never wider than the terminal", () => {
    const text = fc.string({
      unit: fc.constantFrom("a", " ", "-", "\x1b", "[", "\n", "\t", "界", "é"),
    })
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: text.map((id) => id as TicketId), why: text }), { maxLength: 4 }),
        fc.integer({ min: 0, max: 120 }),
        (notDone, width) => {
          const drawn = box(make({ scope: "k-1" as TicketId, notDone }), width, noStyles)
          const rows = drawn.split("\n")
          for (const row of rows) {
            expect(Bun.stringWidth(row)).toBeLessThanOrEqual(Math.max(width, 20))
            expect([...row].some((c) => c < " " || c === "\x7f")).toBe(false)
          }
          expect(new Set(rows.map((row) => Bun.stringWidth(row))).size).toBe(1)
        },
      ),
    )
  })
})

describe("DEFERRED_FREE", () => {
  const d: free.DeferredFree = {
    id: "k-4" as TicketId,
    blockers: ["k-2" as TicketId, "k-3" as TicketId],
  }

  test("the START block's line, as orchestra words it", () => {
    expect(free.startLine(d, "main")).toBe(
      "DEFERRED_FREE: k-4: its blockers have merged (k-2, k-3); to run it: bd update k-4 --status open",
    )
    expect(free.startLine({ ...d, worktree: "/wt/k 4" }, "main")).toBe(
      "DEFERRED_FREE: k-4: its blockers have merged (k-2, k-3); to run it: bd update k-4 --status open; " +
        "its worktree has no commits beyond main, safe to remove: git worktree remove '/wt/k 4' && git branch -d tutti/k-4",
    )
    expect(free.startLine({ ...d, uncommitted: "/wt/k-4" }, "main")).toBe(
      "DEFERRED_FREE: k-4: its blockers have merged (k-2, k-3); to run it: bd update k-4 --status open; " +
        "its worktree holds uncommitted changes, not safe to remove: git -C /wt/k-4 status",
    )
  })

  test("in the box, below the reasons, with the command that reopens each", () => {
    const n = make({
      deferred: 3,
      deferredFree: [
        d,
        { ...d, id: "k-5" as TicketId, worktree: "/wt/k-5" },
        { ...d, id: "k-6" as TicketId, uncommitted: "/wt/k-6" },
      ],
    })
    expect(plain(n)).toBe(
      "○ Nothing ready to run\n" +
        "  3 deferred\n" +
        "  Deferred: k-4: its blockers have merged (k-2, k-3); to run it: bd update k-4 --status open\n" +
        "  Deferred: k-5: its blockers have merged (k-2, k-3); to run it: bd update k-5 --status open\n" +
        "    its worktree has no commits of its own, safe to remove: git worktree remove /wt/k-5 && git branch -d tutti/k-5\n" +
        "  Deferred: k-6: its blockers have merged (k-2, k-3); to run it: bd update k-6 --status open\n" +
        "    its worktree holds uncommitted changes, not safe to remove: git -C /wt/k-6 status",
    )
    const scoped = make({
      scope: "k-1" as TicketId,
      notDone: [{ id: "k-4" as TicketId, why: "deferred" }],
      deferredFree: [d],
    })
    expect(lines(scoped, noStyles).rest).toEqual([
      "k-4 (deferred)",
      "Deferred: k-4: its blockers have merged (k-2, k-3); to run it: bd update k-4 --status open",
    ])
    const allDone = make({ allDone: true, deferredFree: [d] })
    expect(lines(allDone, noStyles).rest).toEqual([])
  })

  const freeing = (fields: Partial<free.Freeing> = {}): free.Freeing => ({
    repo,
    base: "main",
    filter: { excludeTypes: [] },
    inScope: () => true,
    pending: free.startPending(new Set(), new Set()),
    ...fields,
  })

  const listOf = (fields: Partial<free.Freeing>) =>
    Effect.gen(function* () {
      const open = yield* (yield* Beads).list()
      return (yield* free.list(freeing(fields), open)).map((each) => each.id)
    })

  test("lists a deferred ticket whose blockers are all closed and merged", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "b-2", status: "closed" },
      { id: "b-open" },
      { id: "free", status: "deferred", blockedBy: ["b-1", "b-2"] },
      { id: "held", status: "deferred", blockedBy: ["b-1", "b-open"] },
      { id: "no-blockers", status: "deferred" },
      { id: "open-free", blockedBy: ["b-1"] },
      { id: "question", status: "deferred", blockedBy: ["b-1"], labels: ["human"] },
      { id: "epic", status: "deferred", blockedBy: ["b-1"], type: "epic" },
      { id: "chore", status: "deferred", blockedBy: ["b-1"], type: "chore" },
      { id: "later", status: "deferred", blockedBy: ["b-1"], deferUntil: "2026-12-01T00:00:00Z" },
    ]
    expect(await run(seeds, listOf({ filter: { excludeTypes: ["chore"] } }))).toEqual([
      "free" as TicketId,
    ])
    expect(await run(seeds, listOf({ inScope: (id) => id !== "free" }))).toEqual([
      "chore" as TicketId,
    ])
  })

  test("a blocker closed but not merged, or still with its worker, frees nothing", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "k-1", status: "deferred", blockedBy: ["b-1"] },
    ]
    expect(await run(seeds, listOf({}))).toEqual(["k-1" as TicketId])
    const unmerged = free.startPending(new Set(), new Set(["b-1" as TicketId]))
    expect(await run(seeds, listOf({ pending: unmerged }))).toEqual([])
    const carried = free.startPending(new Set(["b-1" as TicketId]), new Set())
    expect(await run(seeds, listOf({ pending: carried }))).toEqual([])
  })

  test("a ticket deferred until a date is listed once that date has come", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "k-1", status: "deferred", blockedBy: ["b-1"], deferUntil: "2026-12-01T00:00:00Z" },
    ]
    const at = (time: string) => Effect.andThen(TestClock.setTime(Date.parse(time)), listOf({}))
    expect(await run(seeds, at("2026-11-30T23:59:59Z"))).toEqual([])
    expect(await run(seeds, at("2026-12-01T00:00:01Z"))).toEqual(["k-1" as TicketId])
  })

  test("its worktree: safe to remove when empty, kept with uncommitted changes or commits", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "empty", status: "deferred", blockedBy: ["b-1"] },
      { id: "dirty", status: "deferred", blockedBy: ["b-1"] },
      { id: "work", status: "deferred", blockedBy: ["b-1"] },
      { id: "none", status: "deferred", blockedBy: ["b-1"] },
    ]
    const found = await run(
      seeds,
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        for (const id of ["empty", "dirty", "work"]) {
          yield* git.addWorktree(repo, `/wt/${id}`, { branch: `tutti/${id}`, base: "main" })
        }
        yield* repository.write("/wt/dirty", { "a.ts": "a" })
        yield* repository.commit("/wt/work", "work", { "b.ts": "b" })
        return yield* free.list(freeing(), yield* (yield* Beads).list())
      }),
    )
    expect([...found].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "dirty" as TicketId, blockers: ["b-1" as TicketId], uncommitted: "/wt/dirty" },
      { id: "empty" as TicketId, blockers: ["b-1" as TicketId], worktree: "/wt/empty" },
      { id: "none" as TicketId, blockers: ["b-1" as TicketId] },
      { id: "work" as TicketId, blockers: ["b-1" as TicketId] },
    ])
  })

  test("the START block lists them in the log and as info records; a bd failure drops them", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "k-1", status: "deferred", blockedBy: ["b-1"] },
    ]
    const said = await run(
      seeds,
      Effect.gen(function* () {
        yield* free.say(freeing())
        return { log: yield* texts, records: yield* (yield* Captured).records }
      }),
    )
    const text =
      "  DEFERRED_FREE: k-1: its blockers have merged (b-1); to run it: bd update k-1 --status open"
    expect(said.log).toEqual([text])
    expect(
      said.records.map((r) => ({ kind: r.kind, ...("text" in r ? { text: r.text } : {}) })),
    ).toEqual([{ kind: "info", text }])
  })
})

/** Each ready ticket held back for the kind its ID names, as the holds would hold it. */
const heldByName = (issue: Issue): Effect.Effect<HoldKind | undefined> =>
  Effect.succeed(
    issue.id.startsWith("parent")
      ? "parent"
      : issue.id.startsWith("after")
        ? "blocker"
        : issue.id.startsWith("followup")
          ? "followUp"
          : undefined,
  )

describe("the check", () => {
  test("a ready ticket the run would start is something to run", async () => {
    expect(await run([{ id: "k-1" }], check(options()))).toBeNull()
  })

  test("everything closed is all done, with the epics still open to close", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "e-1", type: "epic" },
      { id: "k-1", status: "closed", parent: "e-1" },
      { id: "k-2", status: "closed" },
    ]
    const n = await run(seeds, check(options()))
    expect(n).toMatchObject({
      allDone: true,
      stillOpen: ["e-1"],
      done: "READY_EMPTY after 0 tickets: everything is done",
    })
  })

  test("nothing ready counts each ticket left by what holds it", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "in_progress" },
      { id: "q-1", labels: ["human"] },
      { id: "w-1", blockedBy: ["b-1"] },
      { id: "w-2", status: "blocked" },
      { id: "d-1", status: "deferred" },
      { id: "p-1", status: "pinned" },
      { id: "c-1", status: "closed", labels: ["unmerged"] },
      { id: "parent-1" },
      { id: "after-1" },
      { id: "followup-1" },
    ]
    const unmerged = new Set(["c-1" as TicketId])
    const n = await run(seeds, check(options({ held: heldByName, unmerged })))
    expect(n).toMatchObject({
      allDone: false,
      questions: 1,
      waiting: 2,
      heldParents: 1,
      heldBlocked: 1,
      heldFollowUps: 1,
      inProgress: 1,
      deferred: 1,
      other: 1,
      unmerged: 1,
      done: "READY_EMPTY after 0 tickets: nothing ready",
    })
  })

  test("a ticket closed but not merged keeps all done from being said", async () => {
    const seeds: ReadonlyArray<Seed> = [{ id: "c-1", status: "closed", labels: ["unmerged"] }]
    const n = await run(seeds, check(options({ unmerged: new Set(["c-1" as TicketId]) })))
    expect(n).toMatchObject({ allDone: false, unmerged: 1 })
  })

  test("a worker the last run left in the scope is something to run", async () => {
    const seeds: ReadonlyArray<Seed> = [{ id: "k-1", status: "in_progress" }]
    expect(await run(seeds, check(options({ carried: new Set(["k-1" as TicketId]) })))).toBeNull()
    // One outside the scope is no matter to a scoped run.
    const scoped = [
      ...seeds,
      { id: "e-1", type: "epic" },
      { id: "e-1.1", parent: "e-1", status: "closed" },
    ]
    const outside = await run(
      scoped,
      check(options({ scope: "e-1" as TicketId, carried: new Set(["k-1" as TicketId]) })),
    )
    expect(outside).toMatchObject({ scope: "e-1", allDone: true })
    const inside = await run(
      scoped,
      check(options({ scope: "e-1" as TicketId, carried: new Set(["e-1.1" as TicketId]) })),
    )
    expect(inside).toBeNull()
  })

  test("a scoped run names each ticket of its scope not done, and why", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "x-9" },
      { id: "e-1", type: "epic" },
      { id: "e-1.1", parent: "e-1", blockedBy: ["x-9"] },
      { id: "e-1.2", parent: "e-1", status: "closed" },
      { id: "e-1.3", parent: "e-1", status: "deferred" },
    ]
    const n = await run(
      seeds,
      check(options({ scope: "e-1" as TicketId, unmerged: new Set(["e-1.2" as TicketId]) })),
    )
    const byId = [...(n?.notDone ?? [])].sort((a, b) => a.id.localeCompare(b.id))
    expect(byId).toEqual([
      { id: "e-1.1" as TicketId, why: "blocked by x-9 outside the scope" },
      { id: "e-1.2" as TicketId, why: "closed but not merged: left unmerged by an earlier run" },
      { id: "e-1.3" as TicketId, why: "deferred" },
    ])
    expect(n?.done).toStartWith(
      "READY_EMPTY after 0 tickets: nothing ready; SCOPE_OPEN: e-1: 3 of its 3 subtickets not done: ",
    )
    expect(plain(n as NothingToRun).split("\n")[0]).toBe("○ Nothing under e-1 is ready to run")
  })

  test("a scope whose subtickets have all merged is all done, its epic still open", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "e-1", type: "epic" },
      { id: "e-1.1", parent: "e-1", status: "closed" },
    ]
    const n = await run(seeds, check(options({ scope: "e-1" as TicketId })))
    expect(n).toMatchObject({ allDone: true, stillOpen: ["e-1"] })
    expect(plain(n as NothingToRun)).toBe("✓ All done\n  Still open: e-1 (bd close e-1)")
  })

  test("with nothing ready it lists the deferred tickets whose blockers have merged", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "k-1", status: "deferred", blockedBy: ["b-1"] },
    ]
    const n = await run(seeds, check(options()))
    expect(n).toMatchObject({ deferred: 1, deferredFree: [{ id: "k-1", blockers: ["b-1"] }] })
  })
})

describe("a run with nothing to run", () => {
  /** A console that keeps what is printed to it, as stdout would show it. */
  const capturing = () => {
    const printed: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
    })
    return { printed, console }
  }

  test("prints the box, records its done line and ends: no dashboard", async () => {
    const { printed, console } = capturing()
    const ended = await run(
      [{ id: "k-1", status: "closed" }],
      Effect.gen(function* () {
        const ended = yield* nothingToRun(options(), { _tag: "Box", width: 80, styles: noStyles })
        return { ended, log: yield* texts, records: yield* (yield* Captured).records }
      }).pipe(Effect.provideService(Console.Console, console)),
    )
    expect(ended.ended).toBe(true)
    expect(printed).toEqual(["╭────────────╮\n│ ✓ All done │\n╰────────────╯"])
    expect(ended.log).toEqual(["READY_EMPTY after 0 tickets: everything is done"])
    expect(ended.records.map((r) => r.kind)).toEqual(["done"])
  })

  test("in plain mode prints the lines after the time", async () => {
    const { printed, console } = capturing()
    await run(
      [{ id: "q-1", labels: ["human"] }],
      nothingToRun(options(), { _tag: "Plain" }).pipe(
        Effect.provideService(Console.Console, console),
      ),
    )
    expect(
      printed.map((each) => each.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d /, "")),
    ).toEqual(["○ Nothing ready to run", "  1 question waits for your answer: bd human list"])
  })

  test("a run with a ticket to start goes on to its loop, printing nothing", async () => {
    const { printed, console } = capturing()
    const ended = await run(
      [{ id: "k-1" }],
      nothingToRun(options(), { _tag: "Plain" }).pipe(
        Effect.provideService(Console.Console, console),
      ),
    )
    expect(ended).toBe(false)
    expect(printed).toEqual([])
  })
})
