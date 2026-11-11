// The merge check, and the early check that takes its slot, get the merge check's share of the
// machine the run keeps (Shares' merge, tutti-k4if.3) in their environment, as a worker's checks
// get theirs: TUTTI_CORES, TUTTI_MEMORY_MB, their orchestra names, GOFLAGS' -p and
// TUTTI_SHARE_FILE, so a check script sizes itself by the share the memory budget counts for it
// rather than by the memory free now (tutti-sri2).
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { BranchEnv, checkShareEnv, sharedEnv } from "../src/core/env.ts"
import { defaultSettings } from "../src/run/resolveConfig.ts"
import { Checks } from "../src/services/Checks.ts"
import { mergeShareFileOf, type Share, Shares } from "../src/services/share.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"

// Real processes.
setDefaultTimeout(30_000)

const repo = "/work/project"

/** The share's variables. */
const names = [
  "TUTTI_CORES",
  "ORCHESTRA_CORES",
  "TUTTI_MEMORY_MB",
  "ORCHESTRA_MEMORY_MB",
  "TUTTI_SHARE_FILE",
  "GOFLAGS",
]

/** What a check prints of them. */
const printed = `echo "${names.map((name) => `\${${name}-unset}`).join(" ")}"`

const unset = "unset unset unset unset unset unset\n"

/** The setup, the merge check and the full check printing the share's variables. */
const settings = {
  ...defaultSettings,
  checks: {
    ...defaultSettings.checks,
    setup: { ...defaultSettings.checks.setup, command: printed },
    fast: { command: printed, timeout: Duration.seconds(10) },
    full: { command: printed, timeout: Duration.seconds(10) },
  },
}

/** What each check printed, with the run keeping `share` (null for none). */
const run = async (share: Share | null) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tutti-merge-check-share-")))
  const files = {
    setup: join(cwd, "setup.log"),
    fast: join(cwd, "check.log"),
    full: join(cwd, "full.log"),
  }
  const layer = Checks.layer.pipe(
    Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ repo, settings }))),
    Layer.provide(Layer.succeed(Shares, { now: Effect.succeed(share), set: () => Effect.void })),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const checks = yield* Checks
      yield* checks.setup({ cwd, outputFile: files.setup, before: "fast" })
      yield* checks.fast({ cwd, outputFile: files.fast })
      yield* checks.full({ cwd, outputFile: files.full })
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Layer.succeed(BranchEnv, { PATH: testEnv.PATH ?? "/usr/bin:/bin" })),
      Effect.provide(BunServices.layer),
    ),
  )
  return {
    setup: readFileSync(files.setup, "utf8"),
    fast: readFileSync(files.fast, "utf8"),
    full: readFileSync(files.full, "utf8"),
  }
}

/** A worker's share, and the merge check's, twice its memory and cores. */
const share: Share = { cores: 3, memory: 2048, merge: { cores: 6, memory: 4096 } }

describe("the merge check's share", () => {
  test("the merge check gets the merge check's share the run keeps, and its file", async () => {
    const said = await run(share)
    expect(said.fast).toBe(`6 6 4096 4096 ${mergeShareFileOf(repo)} -p=6\n`)
  })

  test("the setup and the full check get none", async () => {
    const said = await run(share)
    expect(said.setup).toBe(unset)
    expect(said.full).toBe(unset)
  })

  test("where the run keeps no share, the merge check gets none", async () => {
    const said = await run(null)
    expect(said).toEqual({ setup: unset, fast: unset, full: unset })
  })
})

describe("checkShareEnv", () => {
  test("lays a share's variables over the environment, after its GOFLAGS", () => {
    const env = { PATH: "/bin", GOFLAGS: "-mod=mod", TUTTI_CORES: "9" }
    expect(checkShareEnv(env, { cores: 2, memory: 1024, file: "/r/share.json" })).toEqual({
      PATH: "/bin",
      GOFLAGS: "-mod=mod -p=2",
      TUTTI_CORES: "2",
      ORCHESTRA_CORES: "2",
      TUTTI_MEMORY_MB: "1024",
      ORCHESTRA_MEMORY_MB: "1024",
      TUTTI_SHARE_FILE: "/r/share.json",
    })
  })

  test("is a worker's share but Bash's timeouts", () => {
    const env = { PATH: "/bin" }
    const share = { cores: 4, memory: 3072, file: "/r/share.json" }
    const worker = sharedEnv(env, { ...share, checkTimeout: Duration.minutes(20) })
    const { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, ...rest } = worker
    expect(BASH_DEFAULT_TIMEOUT_MS).toBeDefined()
    expect(BASH_MAX_TIMEOUT_MS).toBeDefined()
    expect(rest).toEqual(checkShareEnv(env, share))
  })
})
