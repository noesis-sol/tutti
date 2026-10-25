// Beads.list in the live layer (src/services/Beads.ts), as fills and merges read it (tutti-ejkt.6):
// by ID with bd list --id, only those IDs given back and none asked for read none; and the closed
// issues with labels (the ones left unmerged), which a merge's recheck and the look it wakes both
// read, kept for labelledKeep and dropped by a label or status tutti writes.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Beads, labelledKeep, type TicketId } from "../src/services/Beads.ts"

const list = join(import.meta.dir, "fixtures/bd", "list.json")
const show = join(import.meta.dir, "fixtures/bd", "show-b.json")

/** A bd that shows (and updates) the fixture's issue, lists the fixture's issues and logs each call's arguments. */
const fakeBd = () => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-beads-list-kept-"))
  const bin = join(dir, "bd")
  const log = join(dir, "calls")
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      `if [ "$1" = show ] || [ "$1" = update ]; then cat '${show}'; exit 0; fi`,
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

const run = <A, E>(bd: ReturnType<typeof fakeBd>, effect: Effect.Effect<A, E, Beads>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Beads.layer({ cwd: bd.dir, command: bd.bin }).pipe(Layer.provide(BunServices.layer)),
      ),
      Effect.provide(TestClock.layer()),
    ),
  )

const leftUnmerged = { status: "closed", labels: ["unmerged"] } as const

describe("Beads.list by ID", () => {
  test("asks bd list --id for them, and gives back only those", async () => {
    const bd = fakeBd()
    const ids = await run(
      bd,
      Effect.map(
        Effect.flatMap(Beads, (beads) =>
          beads.list({ all: true, ids: ["demo-mtp" as TicketId, "demo-zwl" as TicketId] }),
        ),
        (issues) => issues.map((issue): string => issue.id),
      ),
    )
    expect(ids).toEqual(["demo-mtp", "demo-zwl"])
    expect(calls(bd)).toEqual(["list --json --limit=0 --all --id=demo-mtp,demo-zwl"])
  })

  test("asks bd nothing for no IDs", async () => {
    const bd = fakeBd()
    const issues = await run(
      bd,
      Effect.flatMap(Beads, (beads) => beads.list({ all: true, ids: [] })),
    )
    expect(issues).toEqual([])
    expect(calls(bd)).toEqual([])
  })
})

describe("the closed issues with labels", () => {
  test("are read once while kept, and again after labelledKeep", async () => {
    const bd = fakeBd()
    const counts = await run(
      bd,
      Effect.gen(function* () {
        const beads = yield* Beads
        yield* beads.list(leftUnmerged)
        yield* beads.list(leftUnmerged)
        const kept = calls(bd).length
        yield* TestClock.adjust(Duration.sum(labelledKeep, Duration.millis(1)))
        yield* beads.list(leftUnmerged)
        return [kept, calls(bd).length]
      }),
    )
    expect(counts).toEqual([1, 2])
  })

  test("are read again after tutti adds or removes a label, or changes a status", async () => {
    const bd = fakeBd()
    const lists = await run(
      bd,
      Effect.gen(function* () {
        const beads = yield* Beads
        const id = "demo-mtp.2" as TicketId
        const read = Effect.andThen(beads.list(leftUnmerged), beads.list(leftUnmerged))
        yield* read
        yield* beads.addLabel(id, "unmerged")
        yield* read
        yield* beads.removeLabel(id, "unmerged")
        yield* read
        yield* beads.update(id, { status: "open" })
        yield* read
        // Notes change no label nor status: the list is kept.
        yield* beads.update(id, { appendNotes: "a note" })
        yield* read
        return calls(bd).filter((call) => call.startsWith("list")).length
      }),
    )
    expect(lists).toBe(4)
  })

  test("are kept apart from other lists, which are read each time", async () => {
    const bd = fakeBd()
    const lists = await run(
      bd,
      Effect.gen(function* () {
        const beads = yield* Beads
        yield* beads.list()
        yield* beads.list()
        yield* beads.list({ status: "closed" })
        yield* beads.list({ status: "closed" })
        return calls(bd).length
      }),
    )
    expect(lists).toBe(4)
  })
})
