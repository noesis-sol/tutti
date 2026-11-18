// The Linear sync's startup check of bd's version (tutti-j9no): bd 1.3.0 is the oldest with
// linear.outbound_state_map, so an older bd that has bd linear warns and the run goes on without
// the sync, as for any other lack.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import {
  checkLinear,
  linearStateTypes,
  stateMapKey,
  versionWarning,
} from "../src/run/linearCheck.ts"
import { decodeVersion } from "../src/services/Beads.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { Backlog } from "../src/testing/Beads.ts"
import { sanitizeLine } from "../src/text/sanitize.ts"

const stateMaps = Object.fromEntries(linearStateTypes.map((type) => [stateMapKey(type), "open"]))

const key = { LINEAR_API_KEY: "lin_api_test" }

/** The startup check's warnings with a bd as `bd` says, after `before` (a fault, say). */
const warnings = (
  bd: TestBeads.TestBd,
  before: Effect.Effect<void, never, Backlog> = Effect.void,
) =>
  Effect.runPromise(
    Effect.andThen(before, checkLinear(key)).pipe(
      Effect.provide(TestBeads.layer([], { configuration: stateMaps, ...bd })),
    ),
  )

describe("bd's version in the Linear startup check", () => {
  test("bd 1.3.0 and later sync", async () => {
    for (const version of ["1.3.0", "1.3.4", "1.10.0", "2.0.0"]) {
      expect(await warnings({ version })).toEqual([])
    }
  })

  test("an older bd that has bd linear: a warning naming both versions", async () => {
    expect(await warnings({ version: "1.2.2" })).toEqual([
      "linear: not syncing: bd 1.2.2 is older than 1.3.0, which the sync needs; update Beads",
    ])
    expect(await warnings({ version: "1.3.0-rc.1" })).toEqual([
      "linear: not syncing: bd 1.3.0-rc.1 is older than 1.3.0, which the sync needs; update Beads",
    ])
  })

  test("a bd with no bd linear warns of that alone, not of its version too", async () => {
    expect(await warnings({ version: "0.9.0", linear: false })).toEqual([
      "linear: not syncing: the installed bd has no bd linear; update Beads",
    ])
  })

  test("bd version failing is a warning, not a failed start", async () => {
    const failed = await warnings(
      {},
      Effect.flatMap(Backlog, (backlog) =>
        backlog.fail("version", { stderr: "Error: unknown flag: --json" }),
      ),
    )
    expect(failed).toEqual([
      "linear: not syncing: could not read bd's version: Error: unknown flag: --json",
    ])
    const timedOut = await warnings(
      {},
      Effect.flatMap(Backlog, (backlog) => backlog.fail("version", { timedOut: true })),
    )
    expect(timedOut).toEqual([
      "linear: not syncing: could not read bd's version: bd took longer than 30s",
    ])
  })

  test("a version that isn't one (a build of bd's main) is taken as new enough", () => {
    for (const version of ["dev", "1.3", "", "main-abc123"]) {
      expect(versionWarning(version)).toBeUndefined()
    }
  })

  test("the warning shows bd's version on one line, whatever bd said", () => {
    fc.assert(
      fc.property(fc.string(), (version) => {
        const warning = versionWarning(version)
        if (warning !== undefined) expect(warning).toBe(sanitizeLine(warning))
      }),
    )
    // Build metadata is no part of the comparison, so bd's could be anything.
    expect(versionWarning("1.2.2+\x1b[31mred\nnext")).toBe(
      "linear: not syncing: bd 1.2.2+red next is older than 1.3.0, which the sync needs; update Beads",
    )
  })
})

describe("decoding bd version --json", () => {
  test("reads the version, bare or in the envelope", async () => {
    const bare = '{"branch":"v1.3.4","build":"Homebrew","schema_version":1,"version":"1.3.4"}'
    const envelope =
      '{"data":{"branch":"v1.3.4","build":"Homebrew","version":"1.3.4"},"schema_version":1}'
    expect(await Effect.runPromise(decodeVersion("bd version --json", bare))).toBe("1.3.4")
    expect(await Effect.runPromise(decodeVersion("bd version --json", envelope))).toBe("1.3.4")
  })

  test("output with no version is unreadable", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(decodeVersion("bd version --json", "bd version 1.3.4")),
    )
    expect(exit._tag).toBe("Failure")
  })
})
