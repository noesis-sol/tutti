// A start interrupted at any point (§ 4.8): the ticket isn't left Starting with no session, so its
// next start isn't refused as "a session is already open".
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer, Option, Scheduler } from "effect"
import { AgentHost, AgentStartFailed } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

const sessionId = "11111111-1111-4111-8111-111111111111"

/** Runs `effect` with the live host, in a fresh folder. */
const run = <A, E>(effect: (dir: string) => Effect.Effect<A, E, AgentHost>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-start-interrupt-"))
  const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false } },
  })
  return Effect.runPromise(
    effect(dir).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(waitForTest),
              transcriptsLayer(),
              ClaudeCode.layer.pipe(Layer.provide(workersIn(testEnv))),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

const folderMissing = (cwd: string) => `its folder isn't there: ${cwd}`

/**
 * A scheduler that interrupts the fiber `target` names at its `step`th turn of the run loop, as
 * an interrupt from another fiber lands when the fiber yields there.
 */
class InterruptAt extends Scheduler.MixedScheduler {
  target: number | undefined = undefined
  turns = 0
  constructor(readonly step: number) {
    super()
  }
  override shouldYield(fiber: Fiber.Fiber<unknown, unknown>) {
    if (fiber.id === this.target && ++this.turns === this.step) fiber.interruptUnsafe()
    return super.shouldYield(fiber)
  }
}

describe("AgentHost live: a start interrupted", () => {
  test("at any step leaves the ticket free for its next start", async () => {
    // The start's folder isn't there, so it ends before spawning anything; each turn of its run
    // loop up to that end is a point it is interrupted at.
    const { results, cwd } = await run((dir) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const cwd = join(dir, "gone")
        const results: Array<{ step: number; first: Exit.Exit<void, unknown>; next: unknown }> = []
        for (let step = 1; step <= 60; step++) {
          const ticket = `t-${step}`
          const scheduler = new InterruptAt(step)
          const starting = yield* Effect.forkChild(
            host
              .start(ticket, { sessionId, cwd })
              .pipe(Effect.provideService(Scheduler.Scheduler, scheduler)),
          )
          scheduler.target = starting.id
          const first = yield* Fiber.await(starting)
          // A start left Closing would hold the next for ever.
          const next = yield* host.start(ticket, { sessionId, cwd }).pipe(
            Effect.timeoutOrElse({
              duration: Duration.seconds(1),
              orElse: () => Effect.fail(new AgentStartFailed({ ticket, reason: "still waiting" })),
            }),
            Effect.flip,
          )
          results.push({ step, first, next })
        }
        return { results, cwd }
      }),
    )
    const refused = results.flatMap(({ step, next }) =>
      next instanceof AgentStartFailed && next.reason !== folderMissing(cwd)
        ? [{ step, reason: next.reason }]
        : [],
    )
    expect(refused).toEqual([])
    // The steps reach past the start's end: some starts were interrupted, and the last ran to it.
    expect(results.some(({ first }) => Exit.hasInterrupts(first))).toBe(true)
    const last = results.at(-1)?.first
    // The failure, not the whole Exit: the cause also carries AgentHost.start's trace.
    expect(last === undefined ? undefined : Exit.findErrorOption(last)).toEqual(
      Option.some(new AgentStartFailed({ ticket: "t-60", reason: folderMissing(cwd) })),
    )
  }, 60_000)
})
