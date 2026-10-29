// This repository's own queue.shared_files (.tutti/settings.json): the spec and the top-level docs,
// which most tickets edit in place, hold no two of its tickets apart; its code still does.
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { readSettings } from "../src/project/settings.ts"
import { type FootprintTicket, ticketFootprint } from "../src/run/footprint.ts"
import { overlapHold } from "../src/run/holds.ts"
import { repoFiles } from "../src/run/repoFiles.ts"

const root = join(import.meta.dir, "..")

const settings = await Effect.runPromise(readSettings(root).pipe(Effect.provide(BunServices.layer)))

const tracked = [
  ".orchestra/specs/tutti-spec.md",
  "docs/parity.md",
  "docs/dashboard.md",
  "docs/running.md",
  "docs/spikes/01-sdk-session.md",
  "src/run/schedule.ts",
  "src/run/holds.ts",
]

/** A ticket with this description and nothing else. */
const ticket = (description: string): FootprintTicket => ({
  title: "",
  description,
  design: "",
  acceptance: "",
  labels: [],
  metadata: {},
  files: [],
  predictedFiles: [],
})

/** Why a ticket described so is held back for one running described so, if it is. */
const heldFor = (mine: string, running: string) => {
  const repo = repoFiles(tracked, [], [], settings.queue.shared_files)
  return overlapHold(
    ticketFootprint(ticket(mine), repo),
    new Map([["t-1", ticketFootprint(ticket(running), repo)]]),
    undefined,
    (file) => !repo.shared(file),
  )?.text
}

describe("this repository's shared files", () => {
  test("are the spec and the top-level docs", () => {
    expect(settings.queue.shared_files).toEqual([".orchestra/specs/tutti-spec.md", "docs/*.md"])
  })

  test("two tickets sharing only the spec and docs aren't held apart", () => {
    const mine =
      "Change src/run/schedule.ts; update .orchestra/specs/tutti-spec.md, docs/parity.md and docs/running.md."
    const running =
      "Change src/run/holds.ts; update .orchestra/specs/tutti-spec.md, docs/parity.md and docs/dashboard.md."
    expect(heldFor(mine, running)).toBeUndefined()
  })

  test("two tickets sharing a source file still are", () => {
    const mine = "Change src/run/holds.ts and update .orchestra/specs/tutti-spec.md."
    const running = "Change src/run/holds.ts and update docs/parity.md."
    expect(heldFor(mine, running)).toBe("after t-1: both touch src/run/holds.ts")
  })

  test("a doc in a folder under docs/ still is", () => {
    const mine = "Change src/run/schedule.ts and update docs/spikes/01-sdk-session.md."
    const running = "Change src/run/holds.ts and update docs/spikes/01-sdk-session.md."
    expect(heldFor(mine, running)).toBe("after t-1: both touch docs/spikes/01-sdk-session.md")
  })
})
