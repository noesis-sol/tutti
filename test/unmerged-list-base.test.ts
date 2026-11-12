// The closed tickets labelled unmerged, the third of a fill's bd reads and nearly always empty, are
// kept by Beads' live layer until tutti's next write of a status or label, or labelledKeep, a few
// minutes (tutti-jh9t); and the fill has them read afresh once the base's commit has moved, which
// may have merged one of them by hand (Beads.dropKept, schedule/reads.ts's labelledNow).
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import { make } from "../src/run/schedule.ts"
import { Beads, type Issue, labelledKeep } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

const list = join(import.meta.dir, "fixtures/bd", "list.json")

/** A bd that lists the fixture's issues and logs each call's arguments. */
const fakeBd = () => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-unmerged-list-base-"))
  const bin = join(dir, "bd")
  const log = join(dir, "calls")
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      `if [ "$1" = list ]; then cat '${list}'; exit 0; fi`,
      "exit 0",
    ].join("\n"),
  )
  chmodSync(bin, 0o755)
  return { dir, bin, log }
}

/** The calls bd was given, a line of arguments each. */
const calls = (bd: ReturnType<typeof fakeBd>): ReadonlyArray<string> =>
  existsSync(bd.log) ? readFileSync(bd.log, "utf8").trim().split("\n").filter(Boolean) : []

const live = <A, E>(bd: ReturnType<typeof fakeBd>, effect: Effect.Effect<A, E, Beads>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Beads.layer({ cwd: bd.dir, command: bd.bin }).pipe(Layer.provide(BunServices.layer)),
      ),
      Effect.provide(TestClock.layer()),
    ),
  )

const leftUnmerged = { status: "closed", labels: ["unmerged"] } as const

describe("the closed issues with labels, in the live layer", () => {
  test("are kept a few minutes", () => {
    const kept = Duration.toMillis(labelledKeep)
    expect(kept).toBeGreaterThanOrEqual(Duration.toMillis(Duration.minutes(1)))
    expect(kept).toBeLessThanOrEqual(Duration.toMillis(Duration.minutes(5)))
  })

  test("are read again after dropKept", async () => {
    const bd = fakeBd()
    const counts = await live(
      bd,
      Effect.gen(function* () {
        const beads = yield* Beads
        yield* beads.list(leftUnmerged)
        yield* beads.list(leftUnmerged)
        const kept = calls(bd).length
        yield* beads.dropKept()
        yield* beads.list(leftUnmerged)
        yield* beads.list(leftUnmerged)
        return [kept, calls(bd).length]
      }),
    )
    expect(counts).toEqual([1, 2])
  })
})

type Env = Beads | Backlog | Ledger | Log | EventStream | RunFibers | Scope.Scope

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

describe("a fill", () => {
  test("drops the kept list once the base's commit has moved, not while it stays", async () => {
    const [dropped, lists] = await run(
      [
        { id: "t-1", priority: 0 },
        { id: "t-2", priority: 1 },
      ],
      Effect.gen(function* () {
        const beads = yield* Beads
        const head = yield* Ref.make<string | undefined>("aaa")
        const dropped = yield* Ref.make(0)
        const lists = yield* Ref.make(0)
        const counted = Beads.of({
          ...beads,
          dropKept: () => Ref.update(dropped, (n) => n + 1),
          list: (options) =>
            Effect.andThen(
              options?.status === "closed" ? Ref.update(lists, (n) => n + 1) : Effect.void,
              beads.list(options),
            ),
        })
        // t-1 takes the one slot; t-2 in line has what holds it back read each fill.
        const schedule = yield* make({
          concurrent: 1,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          closedBranches: { head: Ref.get(head), why: () => Effect.succeed(undefined) },
          start: { start: (_: Issue) => Effect.never },
        }).pipe(Effect.provideService(Beads, counted))
        const after = Effect.all([Ref.get(dropped), Ref.get(lists)])
        yield* schedule.fillTrying
        const first = yield* after
        yield* schedule.fillTrying
        const same = yield* after
        yield* Ref.set(head, "bbb")
        yield* schedule.fillTrying
        const moved = yield* after
        // git unable to say where the base is: read afresh, to be safe.
        yield* Ref.set(head, undefined)
        yield* schedule.fillTrying
        return [
          [first[0], same[0], moved[0], (yield* after)[0]],
          [first[1], same[1], moved[1], (yield* after)[1]],
        ] as const
      }),
    )
    expect(dropped).toEqual([1, 1, 2, 3])
    expect(lists).toEqual([1, 2, 3, 4])
  })

  test("keeps the list as Beads does without the option that reads the base", async () => {
    const dropped = await run(
      [
        { id: "t-1", priority: 0 },
        { id: "t-2", priority: 1 },
      ],
      Effect.gen(function* () {
        const beads = yield* Beads
        const dropped = yield* Ref.make(0)
        const counted = Beads.of({ ...beads, dropKept: () => Ref.update(dropped, (n) => n + 1) })
        const schedule = yield* make({
          concurrent: 1,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          start: { start: (_: Issue) => Effect.never },
        }).pipe(Effect.provideService(Beads, counted))
        yield* schedule.fillTrying
        yield* schedule.fillTrying
        return yield* Ref.get(dropped)
      }),
    )
    expect(dropped).toBe(0)
  })
})
