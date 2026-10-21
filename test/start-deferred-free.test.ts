// The run's START block lists each deferred ticket in its scope whose blockers have all merged, a
// DEFERRED_FREE line with the command that reopens it (§ 5 item 4), as orchestra's does: after the
// tickets left unmerged and the workers carried over, before the first dispatch.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { expectLog, type Ran, scenario } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-sdf-${name}-`)))

/** A whole run on main over `seeds`, with nothing ready to start, scoped to `ticket` if given. */
const runs = (seeds: ReadonlyArray<Seed>, ticket: string | null = null): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  return scenario(
    { config: { repo, ticket }, backlog: seeds, git: { dir: repo } },
    run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
  )
}

/** The DEFERRED_FREE lines of the log. */
const freeLines = (ran: Ran<unknown>) => ran.log.filter((text) => text.includes("DEFERRED_FREE"))

const freeLine = (id: string, blockers: string) =>
  `  DEFERRED_FREE: ${id}: its blockers have merged (${blockers}); to run it: bd update ${id} --status open`

describe("DEFERRED_FREE in the START block", () => {
  test("lists each deferred ticket whose blockers have all merged, below the START line", async () => {
    const ran = await runs([
      { id: "b-1", status: "closed" },
      { id: "b-2", status: "closed" },
      { id: "b-3" },
      { id: "k-1", status: "deferred", blockedBy: ["b-1", "b-2"] },
      { id: "k-2", status: "deferred", blockedBy: ["b-1", "b-3"] },
      { id: "k-3", status: "deferred" },
      { id: "k-4", status: "deferred", blockedBy: ["b-1"], labels: ["human"] },
    ])
    expect(ran.log[0]).toBe("START tutti 0.1.0-test")
    expect(ran.log[1]).toBe(freeLine("k-1", "b-1, b-2"))
    expect(freeLines(ran)).toEqual([freeLine("k-1", "b-1, b-2")])
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "info", ticket: "k-1", text: freeLine("k-1", "b-1, b-2") }),
    )
    expectLog(ran, ["START tutti 0.1.0-test", freeLine("k-1", "b-1, b-2"), /^READY_EMPTY/])
  })

  test("a blocker an earlier run left unmerged frees nothing", async () => {
    const ran = await runs([
      { id: "b-1", status: "closed", labels: ["unmerged"] },
      { id: "k-1", status: "deferred", blockedBy: ["b-1"] },
    ])
    expect(freeLines(ran)).toEqual([])
    expect(ran.log).toContain(
      "  b-1 was left unmerged by an earlier run; tickets it blocks wait until tutti/b-1 is merged into main or its 'unmerged' label is removed",
    )
  })

  test("a scoped run lists only the deferred tickets of its scope", async () => {
    const ran = await runs(
      [
        { id: "b-1", status: "closed" },
        { id: "e-1", type: "epic" },
        { id: "e-1.1", parent: "e-1", status: "deferred", blockedBy: ["b-1"] },
        { id: "k-1", status: "deferred", blockedBy: ["b-1"] },
      ],
      "e-1",
    )
    expect(freeLines(ran)).toEqual([freeLine("e-1.1", "b-1")])
  })
})
