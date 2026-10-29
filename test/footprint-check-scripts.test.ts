// What the merge check's and the full check's scripts run counts as a check file (tutti-0vbd.1):
// tickets say "scripts/check.sh passes", which check-fast.sh runs, and held each other back on it
// though none changed it. check-own's script is left out: tickets change what it runs.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { scriptedChecks } from "../src/project/settings.ts"
import { checkScriptLines, scriptsRun, uncommented } from "../src/run/checkScripts.ts"
import { type FootprintTicket, ticketFootprint, withChanges } from "../src/run/footprint.ts"
import { likelyConflictLine, overlapHold, sharedChanges } from "../src/run/holds.ts"
import type { RepoFiles } from "../src/run/repoFiles.ts"
import { footprintsOf } from "../src/run/schedule.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"

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

// The checkout, as tutti init writes its wrappers.
const sources: Record<string, string> = {
  "scripts/check-fast.sh": [
    "#!/bin/sh",
    "# scripts/check-fast.sh: the merge check; see docs/holds.md",
    "set -e",
    'cd "$(dirname "$0")/.."',
    "printf '%s\\n' 'SUITE: check'",
    "(",
    "scripts/check.sh",
    ")",
  ].join("\n"),
  "scripts/check-full.sh": "#!/bin/sh\n(TUTTI_SLOW=1 scripts/check.sh)\n  // src/lint.ts\n",
  "scripts/check-own.sh": "#!/bin/sh\nexec bun scripts/check-own.ts\n",
  "scripts/check-own.ts": "export const own = 1\n",
  "scripts/check.sh": "#!/bin/sh\nbunx tsc\nbunx biome check src/a.ts\n",
  "docs/holds.md": "# Holds\n",
  "src/a.ts": "export const a = 1\n",
  "src/lint.ts": "export const lint = 1\n",
}

const checkout = (files: Record<string, string>): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-check-scripts-")))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const commands = ["scripts/check-fast.sh", "scripts/check-full.sh", "scripts/check-own.sh"]

/** The checkout's files as the scheduler's footprints read them, with git tracking `tracked`. */
const filesOf = (
  dir: string,
  tracked: Record<string, string>,
  scripted: ReadonlyArray<string> = commands.slice(0, 2),
): Promise<RepoFiles> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* footprintsOf({
        repo: dir,
        base: "main",
        checkCommands: commands,
        scriptedChecks: scripted,
        worktree: (id) => Effect.succeed(`/repo-tutti/${id}`),
      })
      return yield* source.repo
    }).pipe(Effect.provide(Layer.mergeAll(memoryGit({ dir, files: tracked }), BunServices.layer))),
  )

describe("the scripts a check command runs", () => {
  const tracked = Object.keys(sources)

  test("are the tracked files it names from the root, each once", () => {
    expect(scriptsRun("scripts/check-fast.sh", tracked)).toEqual(["scripts/check-fast.sh"])
    expect(scriptsRun("sh ./scripts/check.sh && sh scripts/check.sh", tracked)).toEqual([
      "scripts/check.sh",
    ])
    expect(scriptsRun("bun test && sh scripts/lint.sh", tracked)).toEqual([])
    expect(scriptsRun("check.sh", tracked)).toEqual([])
    expect(scriptsRun("sh ../scripts/check.sh /etc/check.sh", tracked)).toEqual([])
  })

  test("are the fast and full checks' commands, not a worker's own", () => {
    const settings = {
      ...defaultSettings,
      checks: {
        ...defaultSettings.checks,
        fast: { ...defaultSettings.checks.fast, command: "scripts/check-fast.sh" },
        full: { ...defaultSettings.checks.full, command: null },
        own: { ...defaultSettings.checks.own, command: "scripts/check-own.sh" },
      },
    }
    expect(scriptedChecks(settings)).toEqual(["scripts/check-fast.sh"])
  })

  test("leave out their comments, a shebang among them", () => {
    expect(uncommented("#!/bin/sh\n  # a.sh\n// b.ts\nrun c.sh # d.sh\n")).toEqual([
      "run c.sh # d.sh",
      "",
    ])
  })

  test("give their lines, and none of a script that can't be read", async () => {
    const outside = checkout({ "evil.sh": "scripts/secret.sh\n" })
    const dir = checkout({ "scripts/check-fast.sh": "scripts/check.sh\n" })
    symlinkSync(join(outside, "evil.sh"), join(dir, "evil.sh"))
    const lines = await Effect.runPromise(
      checkScriptLines(
        dir,
        ["scripts/check-fast.sh", "scripts/gone.sh", "evil.sh"],
        ["scripts/check-fast.sh && scripts/gone.sh", "evil.sh"],
      ).pipe(Effect.provide(BunServices.layer)),
    )
    expect(lines).toEqual(["scripts/check.sh", ""])
  })
})

describe("the check files", () => {
  test("are what the fast and full checks' scripts run, one level deep", async () => {
    const files = await filesOf(checkout(sources), sources)
    expect(files.checks("scripts/check-fast.sh")).toBe(true)
    expect(files.checks("scripts/check.sh")).toBe(true)
    // What check.sh names is read no further.
    expect(files.checks("src/a.ts")).toBe(false)
  })

  test("leave out what check-own's script runs", async () => {
    const files = await filesOf(checkout(sources), sources)
    expect(files.checks("scripts/check-own.sh")).toBe(true)
    expect(files.checks("scripts/check-own.ts")).toBe(false)
  })

  test("take nothing from a comment", async () => {
    const files = await filesOf(checkout(sources), sources)
    expect(files.checks("docs/holds.md")).toBe(false)
    expect(files.checks("src/lint.ts")).toBe(false)
  })

  test("take nothing from a script that can't be read", async () => {
    const { "scripts/check-fast.sh": _, ...onDisk } = sources
    const files = await filesOf(checkout(onDisk), sources, ["scripts/check-fast.sh"])
    expect(files.checks("scripts/check-fast.sh")).toBe(true)
    expect(files.checks("scripts/check.sh")).toBe(false)
  })
})

describe("a ticket naming what the merge check runs", () => {
  test("holds no other ticket naming it, but one naming what check-own's script runs", async () => {
    const files = await filesOf(checkout(sources), sources)
    const says = (more: string) =>
      ticketFootprint(ticket(`scripts/check.sh passes. ${more}`), files)
    const running = new Map([["t-1", says("scripts/check-own.ts reads it.")]])
    expect(overlapHold(says("Nothing else."), running)).toBeUndefined()
    expect(overlapHold(says("Change scripts/check-own.ts."), running)?.text).toBe(
      "after t-1: both touch scripts/check-own.ts",
    )
  })

  test("isn't held for one changing it, and two changing it are still warned of", async () => {
    const files = await filesOf(checkout(sources), sources)
    const changing = withChanges(ticketFootprint(ticket(""), files), ["scripts/check.sh"], files)
    const running = new Map([["t-1", changing]])
    expect(overlapHold(ticketFootprint(ticket("scripts/check.sh passes."), files), running)).toBe(
      undefined,
    )
    const both = sharedChanges(
      new Map<TicketId, ReadonlyArray<string>>([
        ["t-1" as TicketId, ["scripts/check.sh"]],
        ["t-2" as TicketId, ["scripts/check.sh"]],
      ]),
    )
    expect(both.map((edit): string => likelyConflictLine(edit))).toEqual([
      "  LIKELY_CONFLICT: t-1 and t-2 both edit scripts/check.sh; the second to merge may conflict",
    ])
  })
})
