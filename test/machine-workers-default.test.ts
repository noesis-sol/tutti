// --machine-workers' default (src/run/machine.ts, src/cli/AppConfig.ts, src/run/startup.ts;
// orchestra 0.9.3's DefaultMachineWorkers): a run caps the workers across the machine's runs at half
// the cores, at least 2, unless --machine-workers, TUTTI_MACHINE_WORKERS or orchestra's
// ORCHESTRA_MACHINE_WORKERS gives it, 0 for no cap. The START line says the cap and what gave it,
// and a run whose own concurrent is above the cap says so under it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Option, Result } from "effect"
import fc from "fast-check"
import { noServersNote } from "../src/agent/mcp.ts"
import {
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  load,
  resolve,
} from "../src/cli/AppConfig.ts"
import { noFlags, type RunFlagName } from "../src/cli/flags.ts"
import {
  aboveCapNote,
  defaultMachineWorkers,
  defaultMachineWorkersFrom,
  machineWorkersLabel,
} from "../src/run/machine.ts"
import { type Started, startBlock } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import { appConfig } from "../src/testing/AppConfig.ts"

const resolvedWith = (
  flags: Partial<Record<RunFlagName, string>>,
  env: Record<string, string>,
  cores = 10,
) =>
  resolve({
    repo: "/work/project",
    flags: {
      ...noFlags,
      ...Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, Option.some(v)])),
    },
    env: (name) => env[name],
    user: defaultUserConfig,
    settings: defaultSettings,
    cores,
  })

const resolved = (
  flags: Partial<Record<RunFlagName, string>>,
  env: Record<string, string>,
  cores = 10,
) => {
  const config = resolvedWith(flags, env, cores)
  if (Result.isFailure(config)) throw new Error(config.failure.join("\n"))
  const { machineWorkers, machineWorkersFrom } = config.success
  return { machineWorkers, machineWorkersFrom }
}

const problems = (flags: Partial<Record<RunFlagName, string>>, env: Record<string, string>) => {
  const config = resolvedWith(flags, env)
  return Result.isFailure(config) ? config.failure : []
}

describe("the default cap", () => {
  test("is half the cores, at least 2", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10, 16].map(defaultMachineWorkers)).toEqual([
      2, 2, 2, 2, 2, 3, 3, 5, 8,
    ])
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1024 }), (cores) => {
        const cap = defaultMachineWorkers(cores)
        expect(cap).toBeGreaterThanOrEqual(2)
        expect(cap).toBe(cores < 4 ? 2 : Math.floor(cores / 2))
      }),
    )
  })

  test("applies with neither the flag nor a variable, and says it is the default", () => {
    expect(resolved({}, {})).toEqual({
      machineWorkers: 5,
      machineWorkersFrom: "default: half of 10 cores",
    })
    expect(resolved({}, {}, 2)).toEqual({
      machineWorkers: 2,
      machineWorkersFrom: "default: half of 2 cores",
    })
  })
})

describe("what gives the cap", () => {
  test("--machine-workers, then TUTTI_MACHINE_WORKERS, then ORCHESTRA_MACHINE_WORKERS", () => {
    const both = { TUTTI_MACHINE_WORKERS: "4", ORCHESTRA_MACHINE_WORKERS: "6" }
    expect(resolved({ machineWorkers: "3" }, both)).toEqual({
      machineWorkers: 3,
      machineWorkersFrom: "--machine-workers",
    })
    expect(resolved({}, both)).toEqual({
      machineWorkers: 4,
      machineWorkersFrom: "TUTTI_MACHINE_WORKERS",
    })
    expect(resolved({}, { ORCHESTRA_MACHINE_WORKERS: "6" })).toEqual({
      machineWorkers: 6,
      machineWorkersFrom: "ORCHESTRA_MACHINE_WORKERS",
    })
  })

  test("0 for no cap, from any of them", () => {
    expect(resolved({ machineWorkers: "0" }, {}).machineWorkers).toBe(0)
    expect(resolved({}, { TUTTI_MACHINE_WORKERS: "0" }).machineWorkers).toBe(0)
    expect(resolved({}, { ORCHESTRA_MACHINE_WORKERS: "0" }).machineWorkers).toBe(0)
  })

  test("an empty variable is unset", () => {
    expect(resolved({}, { TUTTI_MACHINE_WORKERS: "", ORCHESTRA_MACHINE_WORKERS: "3" })).toEqual({
      machineWorkers: 3,
      machineWorkersFrom: "ORCHESTRA_MACHINE_WORKERS",
    })
  })

  test("a bad ORCHESTRA_MACHINE_WORKERS is a problem only when nothing before it gives the cap", () => {
    expect(problems({}, { ORCHESTRA_MACHINE_WORKERS: "many" })).toEqual([
      "ORCHESTRA_MACHINE_WORKERS must be a whole number (got 'many').",
    ])
    expect(problems({ machineWorkers: "3" }, { ORCHESTRA_MACHINE_WORKERS: "many" })).toEqual([])
    expect(problems({}, { TUTTI_MACHINE_WORKERS: "3", ORCHESTRA_MACHINE_WORKERS: "x" })).toEqual([])
  })

  test("a bad TUTTI_MACHINE_WORKERS isn't stood in for by ORCHESTRA_MACHINE_WORKERS", () => {
    expect(problems({}, { TUTTI_MACHINE_WORKERS: "x", ORCHESTRA_MACHINE_WORKERS: "3" })).toEqual([
      "TUTTI_MACHINE_WORKERS must be a whole number (got 'x').",
    ])
  })

  test("a run reads ORCHESTRA_MACHINE_WORKERS from its environment", async () => {
    const project = mkdtempSync(join(tmpdir(), "tutti-machine-workers-default-"))
    const xdg = mkdtempSync(join(tmpdir(), "tutti-xdg-"))
    const exit = await Effect.runPromise(
      Effect.exit(
        load(noFlags, project).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { ORCHESTRA_MACHINE_WORKERS: "7", XDG_CONFIG_HOME: xdg, HOME: "/nowhere" },
              }),
            ),
          ),
          Effect.provide(BunServices.layer),
        ),
      ),
    )
    if (!Exit.isSuccess(exit)) throw new Error(`expected a config, got ${exit.cause}`)
    expect(exit.value.machineWorkers).toBe(7)
    expect(exit.value.machineWorkersFrom).toBe("ORCHESTRA_MACHINE_WORKERS")
  })
})

describe("the START block", () => {
  const started = (config: Partial<AppConfigValue>, concurrent = 1): Started => {
    const base = appConfig(config, "/work/project")
    return {
      config: { ...base, settings: { ...base.settings, concurrent } },
      base: "main",
      prompt: { text: "Work on TICKET_ID.", file: null },
      mcp: { servers: [], note: noServersNote },
      account: TestAccount.accountProbe(),
      organs: "AgentSdk",
      warnings: [],
    }
  }

  test("says the cap and what gave it", () => {
    expect(startBlock(started({}), "0.1.0")[0]).toContain(
      "concurrent: 1, machine workers: 5 (default: half of 10 cores), ticket limit:",
    )
    const given = { machineWorkers: 3, machineWorkersFrom: "TUTTI_MACHINE_WORKERS" }
    expect(startBlock(started(given), "0.1.0")[0]).toContain(
      "machine workers: 3 (TUTTI_MACHINE_WORKERS)",
    )
    const none = { machineWorkers: 0, machineWorkersFrom: "--machine-workers" }
    expect(startBlock(started(none), "0.1.0")[0]).toContain(
      "machine workers: none (--machine-workers)",
    )
  })

  test("says once under it that a concurrent above the cap holds at it", () => {
    const note =
      "  concurrent 6 is above the machine's cap of 5 workers: the run holds at it (HOLD: MACHINE), with fewer of its own as the machine's other runs have workers running"
    expect(startBlock(started({}, 6), "0.1.0") as ReadonlyArray<string>).toContain(note)
    expect(aboveCapNote(6, 5)).toBe(note.trimStart())
    const below = startBlock(started({}, 5), "0.1.0")
    expect(below.some((l) => l.includes("above the machine's cap"))).toBe(false)
    const uncapped = startBlock(
      started({ machineWorkers: 0, machineWorkersFrom: "--machine-workers" }, 6),
      "0.1.0",
    )
    expect(uncapped.some((l) => l.includes("above the machine's cap"))).toBe(false)
  })

  test("the label is the number or none, and what gave it", () => {
    expect(machineWorkersLabel(5, defaultMachineWorkersFrom(10))).toBe(
      "5 (default: half of 10 cores)",
    )
    expect(machineWorkersLabel(0, "ORCHESTRA_MACHINE_WORKERS")).toBe(
      "none (ORCHESTRA_MACHINE_WORKERS)",
    )
    expect(machineWorkersLabel(2, "")).toBe("2")
  })
})
