// The hand-back notice's feed (§ 4.3): the conflict hand-backs waiting on steered workers reach the
// screen, as the tickets they are for. HandBacks' changes follow those waiting; dashboard() bridges
// the screen's into the worker view, whose notice comes and goes with them; a whole run steered
// from its screen shows the waiting hand-back, and stops showing it once you hand it over
// (HandBackNow).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Exit, Fiber, Queue, Scope, Stream, SubscriptionRef } from "effect"
import { act } from "react"
import { Attention } from "../src/agent/Attention.ts"
import { Transcripts } from "../src/agent/Transcripts.ts"
import { makeCommands, UiCommand } from "../src/run/commands.ts"
import type { TicketFiling } from "../src/run/fileTicket.ts"
import { makeHandBacks, type RebaseStop } from "../src/run/handback.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run as runTutti } from "../src/run/run.ts"
import { emptyStatus, project } from "../src/run/runView.ts"
import { type Dashboard, Screen, type ScreenInputs } from "../src/run/screen.ts"
import { Git } from "../src/services/Git.ts"
import {
  canUseTool,
  init,
  result,
  run,
  type SessionScript,
  sessionState,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { dashboard } from "../src/ui/App.tsx"
import { rendererConfig, type Shell } from "../src/ui/renderer.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { advance, backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

const stopOf = (id: string): RebaseStop => ({
  ticket: { id, title: `Ticket ${id}`, branch: `tutti/${id}`, worktree: `/w/${id}` },
  onto: "abc",
  fork: "def",
  head: "123",
  own: 1,
  files: [`${id}.txt`],
})

describe("HandBacks' changes", () => {
  test("give those waiting now, then each change: kept, replaced, taken", async () => {
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handBacks = yield* makeHandBacks
          const all: Array<ReadonlyArray<string>> = []
          const ids = (stops: ReadonlyArray<RebaseStop>) => stops.map((stop) => stop.ticket.id)
          const fiber = yield* handBacks.changes.pipe(
            Stream.take(5),
            Stream.runForEach((stops) => Effect.sync(() => void all.push(ids(stops)))),
            Effect.forkScoped,
          )
          yield* Effect.yieldNow
          yield* handBacks.wait(stopOf("a"))
          yield* handBacks.wait(stopOf("b"))
          // a's later hand-back replaces its earlier one, after b's.
          yield* handBacks.wait(stopOf("a"))
          yield* handBacks.take("b")
          // Nothing to take: no change.
          yield* handBacks.take("c")
          yield* Fiber.join(fiber)
          return all
        }),
      ),
    )
    expect(seen).toEqual([[], ["a"], ["a", "b"], ["b", "a"], ["a"]])
  })
})

// dashboard() in the command's renderer, on worker 1's view.

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const notice = "A merge conflict waits for this worker"

describe("dashboard()", () => {
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

  test("shows the notice while the screen's hand-backs name the view's ticket", async () => {
    const setup = await createTestRenderer({
      ...rendererConfig,
      width: 80,
      height: 24,
      onDestroy: () => {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
      },
    })
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const shell: Shell = { renderer: setup.renderer, appearance: external<Appearance>("dark") }
    /** The frame once `ready` holds of it, drawn again until it does. */
    const frameWhen = async (ready: (frame: string) => boolean): Promise<string> => {
      const deadline = Date.now() + 5000
      for (;;) {
        await act(async () => {
          await setup.renderOnce()
        })
        const frame = setup.captureCharFrame()
        if (ready(frame) || Date.now() > deadline) return frame
        await act(async () => {
          await Bun.sleep(20)
        })
      }
    }
    const scope = Effect.runSync(Scope.make())
    try {
      const entry: Entry = {
        ticket: "t-1",
        title: "Title of t-1",
        phase: TicketPhase.Working(),
        since: 0,
        worker: 1,
        row: 0,
        rechecking: false,
        steered: true,
        lastMessage: null,
        tallies: emptyTallies,
      }
      const view = project({
        ledger: { tickets: new Map([["t-1", entry]]), rows: 1, windDown: null, bugs: [] },
        workers: new Map(),
        requests: [],
        status: { ...emptyStatus, version: "0.1.0", branch: "main", concurrency: 1 },
      })
      const inputs: ScreenInputs = await Effect.runPromise(
        Effect.gen(function* () {
          return {
            view: yield* SubscriptionRef.make(view),
            screen: yield* SubscriptionRef.make<Screen>(Screen.Worker({ ticket: "t-1" })),
            commands: yield* makeCommands,
            transcripts: yield* Transcripts,
            handBacks: yield* SubscriptionRef.make<ReadonlyArray<string>>([]),
            filings: yield* SubscriptionRef.make<ReadonlyArray<TicketFiling>>([]),
          } satisfies ScreenInputs
        }).pipe(Effect.provide(transcriptsLayer())),
      )
      await act(async () => {
        await Effect.runPromise(dashboard(shell, themeOf)(inputs).pipe(Scope.provide(scope)))
      })
      expect(await frameWhen((frame) => frame.includes("t-1"))).not.toContain(notice)
      const set = (tickets: ReadonlyArray<string>) =>
        act(async () => {
          await Effect.runPromise(SubscriptionRef.set(inputs.handBacks, tickets))
        })
      await set(["t-2", "t-1"])
      expect(await frameWhen((frame) => frame.includes(notice))).toContain(notice)
      await set(["t-2"])
      expect(await frameWhen((frame) => !frame.includes(notice))).not.toContain(notice)
    } finally {
      await act(async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      })
      setup.renderer.destroy()
    }
  })
})

// A whole run with its screen: a's worker, steered by your message, finishes with a conflict with
// main, which waits for it; you hand it over from its view. b's worker, waiting on you meanwhile,
// keeps the run going until then.

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-handback-notice-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/**
 * a's worker: it asks to run a command (you steer it meanwhile), lands a conflicting change on main
 * as it works, commits its own and closes the ticket; your message then has a turn of its own.
 * Its session kept open while the hand-back waits (§ 4.8), it resolves the conflict you hand it.
 * b's asks too, and then finishes.
 */
const scripts = (world: World, repo: string, root: string) => {
  const worktree = join(root, "a")
  const b: SessionScript = [
    wait,
    init(),
    sessionState("running"),
    run(orDie(world.beads.update("b", { claim: true }))),
    canUseTool("Bash", { command: "ls" }),
    run(orDie(world.repository.commit(join(root, "b"), "Do b (b)", { "b.txt": "b\n" }))),
    run(orDie(world.beads.close("b", "done"))),
    result("Closed b."),
    sessionState("idle"),
  ]
  const first: SessionScript = [
    wait,
    init(),
    sessionState("running"),
    run(orDie(world.beads.update("a", { claim: true }))),
    canUseTool("Bash", { command: "ls" }),
    run(orDie(world.repository.commit(repo, "Land something else", { "a.txt": "main's a\n" }))),
    run(orDie(world.repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" }))),
    run(orDie(world.beads.close("a", "done"))),
    result("Closed a."),
    wait,
    init(),
    result(),
    sessionState("idle"),
    ...turn([run(orDie(world.repository.continueRebase(worktree, { "a.txt": "both\n" })))]),
  ]
  return { a: [first], b: [b] }
}

interface Seen {
  readonly outcome: Outcome
  /** The screen's hand-backs, each as it changed. */
  readonly handBacks: ReadonlyArray<ReadonlyArray<string>>
}

describe("the run feeds the screen the hand-backs waiting", () => {
  test("a steered worker's conflict shows as waiting until you hand it over", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const ran: Ran<Seen> = await scenario(
      {
        config: {
          repo,
          settings: {
            ...defaults,
            concurrent: 2,
            checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
          },
        },
        backlog: backlog().ticket("a").ticket("b").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World) => scripts(world, repo, root),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const each of ["a", "b"]) {
          yield* git.addWorktree(repo, join(root, each), { branch: `tutti/${each}`, base: "main" })
        }
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        const fiber = yield* Effect.forkChild(
          runTutti({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard,
          }),
        )
        const attention = yield* Attention
        const until = <R>(what: string, found: () => Effect.Effect<boolean, never, R>) =>
          Effect.gen(function* () {
            for (let i = 0; i < 2000; i++) {
              if (yield* found()) return
              yield* Effect.promise(() => Bun.sleep(2))
            }
            throw new Error(`waited in vain for ${what}: ${(yield* texts).join("\n")}`)
          })
        yield* until("the dashboard", () => Effect.sync(() => shown !== undefined))
        const inputs = shown as ScreenInputs
        const handBacks: Array<ReadonlyArray<string>> = []
        yield* SubscriptionRef.changes(inputs.handBacks).pipe(
          Stream.runForEach((tickets) => Effect.sync(() => void handBacks.push(tickets))),
          Effect.forkScoped,
        )
        const send = (command: UiCommand) =>
          Effect.gen(function* () {
            yield* Queue.offer(inputs.commands, command)
            yield* until("the command to be taken", () =>
              Effect.map(Queue.size(inputs.commands), (n) => n === 0),
            )
            yield* Effect.promise(() => Bun.sleep(10))
          })
        const requestOf = (ticket: string) =>
          Effect.map(attention.current, (all) => all.find((request) => request.ticket === ticket))
        const answer = (ticket: string) =>
          Effect.gen(function* () {
            const request = yield* requestOf(ticket)
            if (request === undefined) throw new Error(`${ticket} has no request open`)
            yield* send(UiCommand.Answer({ requestId: request.id, answer: { _tag: "Allow" } }))
          })
        for (let i = 0; i < 60; i++) {
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(1))
          if ((yield* attention.current).length > 1) break
        }
        for (const ticket of ["a", "b"]) {
          yield* until(`${ticket}'s request`, () =>
            Effect.map(requestOf(ticket), (request) => request !== undefined),
          )
        }
        yield* send(
          UiCommand.SendMessage({
            ticket: "a",
            text: "Keep it small",
            uuid: "11111111-2222-4333-8444-555555555555",
          }),
        )
        yield* answer("a")
        for (let i = 0; i < 200; i++) {
          if ((yield* SubscriptionRef.get(inputs.handBacks)).includes("a")) break
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(2))
        }
        yield* until("a's hand-back to wait", () =>
          Effect.map(SubscriptionRef.get(inputs.handBacks), (all) => all.includes("a")),
        )
        yield* send(UiCommand.HandBackNow({ ticket: "a" }))
        const merged = (ticket: string) =>
          Effect.map(texts, (lines) =>
            lines.some((each) => each.startsWith(`  ${ticket} closed (`)),
          )
        for (let i = 0; i < 200; i++) {
          if (yield* merged("a")) break
          yield* advance("1 second")
          yield* Effect.promise(() => Bun.sleep(2))
        }
        yield* until("a's merge", () => merged("a"))
        yield* answer("b")
        for (let i = 0; i < 5; i++) {
          yield* advance("1 minute")
          yield* Effect.promise(() => Bun.sleep(3))
        }
        const outcome = yield* Fiber.join(fiber)
        return { outcome, handBacks } satisfies Seen
      }) as Effect.Effect<Seen, unknown, Env | Scope.Scope>,
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const { outcome, handBacks } = ran.exit.value
    expect(outcome.exitCode).toBe(0)
    expect(outcome.phases.a?._tag).toBe("Done")
    expect(outcome.phases.b?._tag).toBe("Done")
    expect(handBacks).toEqual([[], ["a"], []])
  }, 30_000)
})
