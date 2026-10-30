// The check of a feature's tree once New feature's breakdown has filed it (§ 4.10): checkFiled with
// no spec refuses a root that isn't an epic, and warns of open tickets under it without files
// metadata or acceptance criteria, and of a cycle of blocks links among them, as it does a spec's
// tree; it says nothing of the spec's metadata, which a feature's issues don't carry.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { checkFiled } from "../src/run/spec.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"

const root = "feat-1" as TicketId

/** A ticket under the feature's epic, with files and acceptance criteria, waiting on `on`. */
const under = (n: number, on: ReadonlyArray<number> = []): Seed => ({
  id: `feat-1.${n}`,
  parent: "feat-1",
  acceptance: "The tests pass.",
  blockedBy: on.map((m) => `feat-1.${m}`),
  metadata: { files: [`src/${n}.ts`] },
})

const checked = (seeds: ReadonlyArray<Seed>, top: Seed = { id: "feat-1", type: "epic" }) =>
  Effect.runPromise(checkFiled(root, null, 2).pipe(Effect.provide(beadsLayer([top, ...seeds]))))

describe("checkFiled, for a feature's tree", () => {
  test("counts the epic and its tickets, and warns of nothing in a sound tree", async () => {
    const filed = await checked([under(1), under(2)])
    expect(filed).toEqual({ epics: 1, tickets: 2, refused: null, warnings: [] })
  })

  test("says nothing of the spec's metadata, which a feature's issues don't carry", async () => {
    const filed = await checked([under(1), under(2)], {
      id: "feat-1",
      type: "epic",
      metadata: { spec: "docs/shop.md" },
    })
    expect(filed.refused).toBeNull()
    expect(filed.warnings).toEqual([])
  })

  test("refuses a root that isn't an epic", async () => {
    const filed = await checked([], { id: "feat-1", type: "task" })
    expect(filed.refused).toBe("feat-1 is a task, not an epic")
  })

  test("warns of open tickets without files or acceptance criteria, the closed left out", async () => {
    const filed = await checked([
      { ...under(1), metadata: {} },
      { ...under(2), acceptance: "" },
      { ...under(3), metadata: {}, acceptance: "", status: "closed" },
    ])
    expect(filed.warnings).toEqual([
      "1 open ticket under feat-1 has no files metadata, so tutti guesses its files: feat-1.1",
      "1 open ticket under feat-1 has no acceptance criteria: feat-1.2",
    ])
  })

  test("warns of a cycle of blocks links among the open tickets", async () => {
    const filed = await checked([under(1, [2]), under(2, [1]), under(3)])
    const cycle = filed.warnings.filter((w) => w.includes("cycle"))
    expect(cycle).toHaveLength(1)
    expect(cycle[0]).toMatch(
      /^the blocks links among the open tickets under feat-1 make a cycle, so none of them can start: (feat-1\.1 → feat-1\.2 → feat-1\.1|feat-1\.2 → feat-1\.1 → feat-1\.2)$/,
    )
  })

  test("a cycle through a closed ticket is none", async () => {
    const filed = await checked([under(1, [2]), { ...under(2, [1]), status: "closed" }])
    expect(filed.warnings.some((w) => w.includes("cycle"))).toBe(false)
  })
})
