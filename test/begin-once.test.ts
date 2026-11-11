// A run begins once (src/cli/start/beginning.ts), and starts its keep-awake command once
// (src/cli/start/power.ts's holdOf), however many times its start calls `begin`: a dashboard
// run's start does so after a spec's refinement and again after the open questions put in the
// renderer, and an overnight run's pre-flight holds the machine awake before `begin` is called.
import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Scope, SubscriptionRef } from "effect"
import { noServersNote } from "../src/agent/mcp.ts"
import type { Beginning } from "../src/cli/start/beginning.ts"
import { beginningOf } from "../src/cli/start/beginning.ts"
import type { Choice } from "../src/cli/start/choice.ts"
import { holdOf, type Power } from "../src/cli/start/power.ts"
import type { AppConfigValue } from "../src/core/AppConfig.ts"
import type { Log } from "../src/core/log.ts"
import type { GettingReady } from "../src/print/gettingReady.ts"
import { type AwakeCommand, keepingAwakeLine } from "../src/run/keepAwake.ts"
import type { Started } from "../src/run/startup.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { ProcessGroups } from "../src/services/exec.ts"
import type { HeldLock, Holder } from "../src/services/RunLock.ts"
import type { OutputMode } from "../src/services/Tty.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { Work } from "../src/ui/questions.ts"

/** A keep-awake command that ends at once: its start is its line in the log. */
const awake: AwakeCommand = { command: "sh", args: ["-c", "exit 0"] }

/** What a hold, or a beginning on one, may need: as `Power.hold` declares it. */
type Needs = Log | BunServices.BunServices | Scope.Scope

/** Runs `effect` in a run scope of its own, with a captured log: the log's lines at its end. */
const holding = <E>(effect: (runScope: Scope.Scope) => Effect.Effect<void, E, Needs>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runScope = yield* Effect.scope
        yield* effect(runScope)
        return yield* texts
      }),
    ).pipe(
      Effect.provide(logLayer()),
      Effect.provide(BunServices.layer),
      Effect.provideService(ProcessGroups, new Set()),
    ),
  )

/** How many times the log says the command started. */
const starts = (lines: ReadonlyArray<string>) =>
  lines.filter((line) => line === keepingAwakeLine(awake)).length

describe("the keep-awake command's hold", () => {
  test("hold called twice starts the command once, running `before` once", async () => {
    let befores = 0
    const lines = await holding((runScope) =>
      Effect.gen(function* () {
        const hold = yield* holdOf({ _tag: "Command", command: awake }, process.cwd())
        const before = Effect.sync(() => {
          befores++
        })
        yield* hold.hold(runScope, before)
        yield* hold.hold(runScope, before)
      }),
    )
    expect(starts(lines)).toBe(1)
    expect(befores).toBe(1)
  })

  test("holdFirst then hold starts it once, as an overnight run's pre-flight does", async () => {
    const lines = await holding((runScope) =>
      Effect.gen(function* () {
        const hold = yield* holdOf({ _tag: "Command", command: awake }, process.cwd())
        yield* hold.holdFirst(runScope)
        yield* hold.holdFirst(runScope)
        yield* hold.hold(runScope)
      }),
    )
    expect(starts(lines)).toBe(1)
  })

  test("without a command, nothing starts and the title line has no badge", async () => {
    const lines = await holding((runScope) =>
      Effect.gen(function* () {
        const hold = yield* holdOf({ _tag: "Off" }, process.cwd())
        yield* hold.holdFirst(runScope)
        yield* hold.hold(runScope)
        expect(hold.runOption()).toEqual({})
        expect(yield* SubscriptionRef.get(hold.keepingAwake)).toBe(false)
      }),
    )
    expect(starts(lines)).toBe(0)
  })
})

const startedOf = (config: AppConfigValue): Started => ({
  config,
  base: "main",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  account: {
    ...TestAccount.accountProbe(config),
    permissionMode: {
      requested: config.settings.workers.permission_mode,
      inEffect: config.settings.workers.permission_mode,
    },
  },
  organs: { _tag: "AgentSdk" },
  warnings: [],
})

/** A beginning on counters: how often the machine was held and the lock rewritten. */
const beginningWith = (mode: OutputMode) => {
  const counts = { holds: 0, befores: 0, rewrites: [] as ReadonlyArray<Holder>, ends: 0 }
  const machine: Power = {
    awake: { _tag: "Command", command: awake },
    battery: null,
    notes: [],
    keepingAwake: Effect.runSync(SubscriptionRef.make(false)),
    runOption: () => ({}),
    hold: (_runScope, before = Effect.void) =>
      Effect.andThen(
        Effect.sync(() => {
          counts.holds++
        }),
        Effect.andThen(
          before,
          Effect.sync(() => {
            counts.befores++
          }),
        ),
      ),
    holdFirst: () => Effect.void,
  }
  const ready: GettingReady = {
    step: () => Effect.void,
    unpacking: (extracting) => extracting,
    end: Effect.sync(() => {
      counts.ends++
    }),
  }
  const lock: HeldLock = {
    rewrite: (holder) =>
      Effect.sync(() => {
        counts.rewrites = [...counts.rewrites, holder]
      }),
  }
  const config = TestAppConfig.appConfig()
  const holder: Holder = {
    pid: 4242,
    started: "2026-11-11T09:00:00Z",
    version: "0.0.0",
    branch: "main",
  }
  const choice: Choice = {
    scope: null,
    feature: null,
    spec: null,
    config,
    started: startedOf(config),
    holder,
  }
  const runScope = Effect.runSync(Scope.make())
  const beginning: Beginning = beginningOf({
    machine,
    runScope,
    mode,
    ready,
    lock,
    base: "main",
    choice,
  })
  return { beginning, counts }
}

/** Runs `effect` with captured events: the start events it emitted. */
const started = <E>(effect: Effect.Effect<void, E, EventStream | Needs>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* effect
        const records = yield* (yield* Captured).records
        return records.filter((record) => record.kind === "start")
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(eventsLayer(), logLayer(), BunServices.layer)),
      Effect.provideService(ProcessGroups, new Set()),
    ),
  )

describe("the run's beginning", () => {
  test("begin called twice holds the machine once and emits one start event", async () => {
    const { beginning, counts } = beginningWith({ _tag: "Dashboard" })
    const starts = await started(
      Effect.andThen(beginning.begin(Work.Tickets()), beginning.begin(Work.Tickets())),
    )
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ kind: "start", repo: "/work/project", branch: "main" })
    expect(counts.holds).toBe(1)
    // The getting-ready line ends before the keep-awake line only in plain output.
    expect(counts.ends).toBe(0)
  })

  test("in plain output, the getting-ready line ends before the keep-awake command starts", async () => {
    const { beginning, counts } = beginningWith({ _tag: "Plain", reason: "flag" })
    const starts = await started(
      Effect.andThen(beginning.begin(Work.Tickets()), beginning.begin(Work.Tickets())),
    )
    expect(starts).toHaveLength(1)
    expect(counts).toMatchObject({ holds: 1, befores: 1, ends: 1 })
  })

  test("a feature chosen names the lock's holder once, and the start event", async () => {
    const { beginning, counts } = beginningWith({ _tag: "Dashboard" })
    const feature = Work.Feature({ description: "dark mode" })
    const starts = await started(Effect.andThen(beginning.begin(feature), beginning.begin(feature)))
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ feature: "dark mode" })
    expect(counts.rewrites.map((holder) => holder.feature)).toEqual(["dark mode"])
  })

  test("beginUnlessSpec leaves a spec to begin once its breakdown has scoped the run", async () => {
    const { beginning, counts } = beginningWith({ _tag: "Dashboard" })
    const starts = await started(
      Effect.andThen(
        beginning.beginUnlessSpec(Work.Spec({ given: "/work/spec.md", refine: false })),
        beginning.begin(Work.Tickets()),
      ),
    )
    expect(starts).toHaveLength(1)
    expect(counts.holds).toBe(1)
  })
})
