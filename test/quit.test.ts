import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Fiber, Queue, Ref, type Scope } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import type { Line } from "../src/run/log.ts"
import { line } from "../src/run/log.ts"
import {
  atOnceText,
  catchSignals,
  fromDashboard,
  heard,
  interruptedText,
  listen,
  panicLines,
  type QuitRequest,
  quitBy,
  quitLine,
  quittingText,
  route,
  stillQuittingLine,
  underWayLine,
} from "../src/run/quit.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store } from "../src/services/Store.ts"
import {
  awaitInterrupt,
  bash,
  claimsAndCloses,
  interruptedResult,
  Recording,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Scripted } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

/** A new folder, its real path. */
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-quit-${name}-`)))

const ctrlC = quitBy("SIGINT")

/** What a ticket's worker's commands do to the in-memory Beads and git. */
const commands = (world: World, root: string, id: string) => {
  const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))
  return {
    claim: orDie(world.beads.update(id, { claim: true })),
    commit: orDie(
      world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
    ),
    close: orDie(world.beads.close(id, "done")),
  }
}

/** A worker that claims its ticket, does `meanwhile`, and is at work until it is interrupted. */
const atWork = (
  world: World,
  root: string,
  id: string,
  meanwhile: ReadonlyArray<SessionScript[number]> = [],
): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, commands(world, root, id).claim),
      ...meanwhile,
      awaitInterrupt,
    ],
    interruptedResult,
  )

/** What a quit run left: its outcome, state.json at its end, and the exits it asked for. */
interface Quit extends Outcome {
  readonly state: State
  readonly exits: ReadonlyArray<{ readonly code: number; readonly said: ReadonlyArray<Line> }>
}

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly setup: Omit<Setup, "scripts" | "worktrees"> & {
    readonly scripts: (
      world: World,
      root: string,
      quits: Queue.Queue<QuitRequest>,
    ) => NonNullable<Setup["scripts"]>
  }
  /** Runs beside the run, before it is joined. */
  readonly during?: (quits: Queue.Queue<QuitRequest>) => Effect.Effect<void, unknown, Env>
  /** Runs before the run starts. */
  readonly before?: (repo: string) => Effect.Effect<void, unknown, Env>
  readonly around?: (
    run: Effect.Effect<Outcome, never, Env | Scope.Scope>,
  ) => Effect.Effect<Outcome, never, Env | Scope.Scope>
}

/** A whole run on main, given a queue of requests to quit; as run.test.ts's runs. */
const quitting = (plan: Plan): Promise<Ran<Quit>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const quits = Effect.runSync(Queue.unbounded<QuitRequest>())
  const { scripts, config, ...setup } = plan.setup
  return scenario(
    {
      ...setup,
      config: { ...config, repo },
      git: { ...setup.git, dir: repo },
      worktrees: { root },
      scripts: (world: World) => {
        const made = scripts(world, root, quits)
        return typeof made === "function" ? made(world) : made
      },
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      if (plan.before !== undefined) yield* plan.before(repo)
      const exits = yield* Ref.make<Quit["exits"]>([])
      const running = run({
        version: "0.1.0-test",
        base: "main",
        start: [line`START tutti 0.1.0-test`],
        quits,
        exitNow: (code, said) => Ref.update(exits, (all) => [...all, { code, said }]),
      })
      const fiber = yield* Effect.forkChild(
        plan.around === undefined ? running : plan.around(running),
      )
      if (plan.during !== undefined) yield* plan.during(quits)
      const outcome = yield* Fiber.join(fiber)
      const state = yield* (yield* Store).state
      return { ...outcome, state, exits: yield* Ref.get(exits) } satisfies Quit
    }),
  )
}

const quitOf = (ran: Ran<Quit>): Quit => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the run failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The kinds of what the ticket's worker was sent, in order. */
const sentTo = (ran: Ran<unknown>, ticket: string) =>
  ran.sent.filter((sent) => sent.ticket === ticket).map((sent) => sent._tag)

/** Waits, in real time, until `ready` holds: for what a script does outside the TestClock. */
const until = <E, R>(ready: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000; i++) {
      if (yield* ready) return
      yield* Effect.promise(() => Bun.sleep(1))
    }
    return yield* Effect.die(new Error("waited too long"))
  })

const interrupted = (ticket: string) =>
  Effect.map(Recording, (recording) =>
    Effect.map(recording.all, (all) =>
      all.some((sent) => sent._tag === "Interrupted" && sent.ticket === ticket),
    ),
  ).pipe(Effect.flatten)

describe("quitting", () => {
  test("follows § 4.8's steps in order, saves the session in state.json and exits 130", async () => {
    const ran = await quitting({
      tickets: ["t-1", "t-2"],
      setup: {
        config: { settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        scripts: (world, root, quits) => ({
          "t-1": [atWork(world, root, "t-1", [step(Effect.asVoid(Queue.offer(quits, ctrlC)))])],
          "t-2": [claimsAndCloses("t-2")],
        }),
      },
    })
    expectExitCode(ran, 130)
    // Scheduling stopped: t-2 never started.
    expectPhases(ran, { "t-1": "Stopped", "t-2": "Queued" })
    expect(ran.log.some((each) => each.includes("t-2 dispatching"))).toBe(false)
    // Interrupted, then closed.
    expect(sentTo(ran, "t-1")).toEqual(["Started", "Message", "Interrupted", "Closed"])
    expectLog(ran, [
      "QUIT with Ctrl+C: no new tickets; interrupting the workers of t-1 and saving their sessions for the next run",
      /^tutti 0\.1\.0-test on main/,
      "INTERRUPTED: quit with Ctrl+C; t-1's session is saved for the next run",
    ])
    expectEvents(ran, ["warn", "suspended", "stop", "end"])
    expect(ran.events.at(-1)).toMatchObject({ kind: "end", code: 130 })
    expect(ran.events.find((record) => record.kind === "stop")).toMatchObject({
      detail: "INTERRUPTED",
    })
    const quit = quitOf(ran)
    const saved = quit.state.tickets["t-1"]
    expect(saved).toMatchObject({ suspended: "quit", phase: "Stopped" })
    expect(saved?.session).toEqual(expect.any(String))
    expect(ran.events.find((record) => record.kind === "suspended")).toMatchObject({
      ticket: "t-1",
      session: saved?.session,
      why: "quit",
    })
    expect(quit.exits).toEqual([])
  })

  test("waits 10 s at most for the workers' results, under TestClock", async () => {
    const ran = await quitting({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").seeds,
        // The worker never ends its turn: the interrupt goes unanswered.
        scripts: (world, root, quits) => ({
          "t-1": [
            turn([
              ...bash("bd update t-1 --claim", commands(world, root, "t-1").claim),
              step(Effect.asVoid(Queue.offer(quits, ctrlC))),
              sleep("1 hour"),
            ]),
          ],
        }),
      },
      during: () =>
        Effect.gen(function* () {
          yield* until(interrupted("t-1"))
          yield* advance("9 seconds")
          for (let i = 0; i < 200; i++) yield* Effect.yieldNow
          const store = yield* Store
          expect((yield* store.ticket("t-1"))?.suspended).toBeUndefined()
          yield* advance("1 second")
        }),
    })
    expectExitCode(ran, 130)
    expectPhases(ran, { "t-1": "Stopped" })
    expectLog(ran, [
      /^QUIT with Ctrl\+C/,
      "  the workers of t-1 did not end their turns within 10s; closing their sessions",
      /^INTERRUPTED: quit with Ctrl\+C/,
    ])
    expect(sentTo(ran, "t-1")).toEqual(["Started", "Message", "Interrupted", "Closed"])
    expect(quitOf(ran).state.tickets["t-1"]).toMatchObject({ suspended: "quit" })
  })

  test("a second request says what quitting waits for; the third exits at once, 130", async () => {
    const ran = await quitting({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").seeds,
        scripts: (world, root, quits) => ({
          "t-1": [
            turn([
              ...bash("bd update t-1 --claim", commands(world, root, "t-1").claim),
              step(Effect.asVoid(Queue.offer(quits, ctrlC))),
              sleep("1 hour"),
            ]),
          ],
        }),
      },
      during: (quits) =>
        Effect.gen(function* () {
          yield* until(interrupted("t-1"))
          yield* Queue.offerAll(quits, [ctrlC, ctrlC])
          const store = yield* Store
          yield* until(Effect.map(store.ticket("t-1"), (saved) => saved?.suspended === "quit"))
          yield* advance("10 seconds")
        }),
    })
    expectLog(ran, [
      /^QUIT with Ctrl\+C/,
      "  quitting: waiting for t-1's worker; press Ctrl+C again to quit at once",
      "INTERRUPTED: quit at once with Ctrl+C; saved the sessions of t-1",
    ])
    expect<unknown>(quitOf(ran).exits).toEqual([
      { code: 130, said: ["INTERRUPTED: quit at once with Ctrl+C; saved the sessions of t-1"] },
    ])
    expect(ran.events.filter((record) => record.kind === "end")[0]).toMatchObject({ code: 130 })
  })

  test("a merge under way: its check killed, the ticket Stopped and unmerged; a second request says how to abandon it", async () => {
    const offered = Effect.runSync(Ref.make<Queue.Queue<QuitRequest> | null>(null))
    // t-2's check, on its branch rebased onto main, asks to quit and never ends.
    const hanging: Scripted = Effect.gen(function* () {
      const quits = yield* Ref.get(offered)
      if (quits !== null) yield* Queue.offer(quits, ctrlC)
      return yield* Effect.never
    })
    const ran = await quitting({
      tickets: ["t-1", "t-2"],
      setup: {
        config: { settings: { ...appConfig().settings, concurrent: 2 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        checks: { fast: [hanging] },
        scripts: (world, root, quits) => {
          Effect.runSync(Ref.set(offered, quits))
          return {
            // t-1's worker doesn't answer its interrupt, so quitting waits for it.
            "t-1": [
              turn([
                ...bash("bd update t-1 --claim", commands(world, root, "t-1").claim),
                sleep("1 hour"),
              ]),
            ],
            "t-2": [claimsAndCloses("t-2", commands(world, root, "t-2"))],
          }
        },
      },
      // main moves on while t-2 runs, so its merge rebases it and checks it.
      before: () =>
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        }),
      during: (quits) =>
        Effect.gen(function* () {
          yield* until(interrupted("t-1"))
          yield* Queue.offer(quits, ctrlC)
          for (let i = 0; i < 200; i++) yield* Effect.yieldNow
          yield* advance("10 seconds")
        }),
    })
    expectExitCode(ran, 130)
    expectPhases(ran, { "t-1": "Stopped", "t-2": "Stopped" })
    expectLog(ran, [
      "QUIT with Ctrl+C: no new tickets; interrupting the workers of t-1, t-2 and saving their sessions for the next run",
      "  t-2's merge is under way; press Ctrl+C again to abandon it",
      /^ {2}the workers of t-1 did not end their turns/,
      "INTERRUPTED: quit with Ctrl+C; the sessions of t-1, t-2 are saved for the next run",
    ])
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "phase", ticket: "t-2", cause: "MergeInterrupted" }),
    )
    expect(ran.issues.find((issue) => issue.id === "t-2")?.labels).toContain("unmerged")
    expect(ran.issues.find((issue) => issue.id === "t-1")?.labels).not.toContain("unmerged")
    expect(quitOf(ran).state.tickets["t-2"]).toMatchObject({ suspended: "quit", phase: "Stopped" })
  })

  test("a panic in a ticket's fiber: logged with its stack, workers suspended, PANIC, exit 4", async () => {
    let armed = false
    const ran = await quitting({
      tickets: ["t-1", "t-2"],
      setup: {
        config: { settings: { ...appConfig().settings, concurrent: 2 } },
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        scripts: (world, root) => ({
          "t-1": [
            turn([
              ...bash("bd update t-1 --claim", commands(world, root, "t-1").claim),
              sleep("30 seconds"),
              step(
                Effect.sync(() => {
                  armed = true
                }),
              ),
            ]),
          ],
          "t-2": [atWork(world, root, "t-2")],
        }),
      },
      around: (running) =>
        Effect.gen(function* () {
          const beads = yield* Beads
          return yield* running.pipe(
            Effect.provideService(Beads, {
              ...beads,
              // Once: the run's end reads the ticket too.
              show: (id) => {
                if (!armed || id !== "t-1") return beads.show(id)
                armed = false
                return Effect.die(new Error("boom"))
              },
            }),
          )
        }),
      during: () =>
        Effect.gen(function* () {
          for (let i = 0; i < 20; i++) {
            for (let j = 0; j < 200; j++) yield* Effect.yieldNow
            yield* advance("10 seconds")
          }
        }),
    })
    expectExitCode(ran, 4)
    expectPhases(ran, { "t-1": "Stopped", "t-2": "Stopped" })
    expectLog(ran, [/^PANIC in t-1's fiber: boom$/, /^ {2}at /, /^PANIC: t-1's fiber: boom/])
    expect(sentTo(ran, "t-2")).toContain("Interrupted")
    expect(quitOf(ran).state.tickets["t-2"]).toMatchObject({ suspended: "PANIC" })
  })

  test("a panic in the run's loop: the workers suspended; PANIC, exit 4", async () => {
    let armed = false
    const ran = await quitting({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").ticket("t-2").seeds,
        config: { settings: { ...appConfig().settings, concurrent: 2 } },
        scripts: (world, root) => ({
          "t-1": [
            atWork(world, root, "t-1", [
              step(
                Effect.sync(() => {
                  armed = true
                }),
              ),
            ]),
          ],
        }),
      },
      // The next fill's bd list dies, once.
      around: (running) =>
        Effect.gen(function* () {
          const beads = yield* Beads
          return yield* running.pipe(
            Effect.provideService(Beads, {
              ...beads,
              list: (filter) => {
                if (!armed) return beads.list(filter)
                armed = false
                return Effect.die(new Error("loop boom"))
              },
            }),
          )
        }),
      during: () =>
        Effect.gen(function* () {
          for (let i = 0; i < 20; i++) {
            for (let j = 0; j < 200; j++) yield* Effect.yieldNow
            yield* advance("10 seconds")
          }
        }),
    })
    expectExitCode(ran, 4)
    expectLog(ran, [/^PANIC in the run: loop boom$/, /^PANIC: the run's loop: loop boom/])
    expect(sentTo(ran, "t-1")).toEqual(["Started", "Message", "Interrupted", "Closed"])
    expect(quitOf(ran).state.tickets["t-1"]).toMatchObject({ suspended: "PANIC" })
  })

  test("a quit while the full check runs stops it, and the run ends INTERRUPTED, 130", async () => {
    const offered = Effect.runSync(Ref.make<Queue.Queue<QuitRequest> | null>(null))
    const hanging: Scripted = Effect.gen(function* () {
      const quits = yield* Ref.get(offered)
      if (quits !== null) yield* Queue.offer(quits, ctrlC)
      return yield* Effect.never
    })
    const { settings } = appConfig()
    const ran = await quitting({
      tickets: ["t-1"],
      setup: {
        config: {
          settings: {
            ...settings,
            checks: {
              ...settings.checks,
              full: { command: "scripts/check-full.sh", timeout: Duration.minutes(60) },
            },
          },
        },
        backlog: backlog().ticket("t-1").seeds,
        checks: { full: [hanging] },
        scripts: (world, root, quits) => {
          Effect.runSync(Ref.set(offered, quits))
          return { "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))] }
        },
      },
    })
    expectExitCode(ran, 130)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      "READY_EMPTY after 1 tickets",
      /^ {2}FULL_CHECK_SKIPPED: /,
      "INTERRUPTED: quit with Ctrl+C during the full check",
    ])
    expect(ran.events.at(-1)).toMatchObject({ kind: "end", code: 130 })
  })

  test("a panic in the merge queue: the ticket back in line, Stopped; PANIC, exit 4", async () => {
    const ran = await quitting({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").seeds,
        checks: { fast: [Effect.die(new Error("merge boom"))] },
        scripts: (world, root) => ({
          "t-1": [claimsAndCloses("t-1", commands(world, root, "t-1"))],
        }),
      },
      before: () =>
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        }),
    })
    expectExitCode(ran, 4)
    expectPhases(ran, { "t-1": "Stopped" })
    expectLog(ran, [
      /^PANIC in the merge queue: merge boom$/,
      /^PANIC: the merge queue: merge boom/,
    ])
    expect(quitOf(ran).state.tickets["t-1"]).toMatchObject({ suspended: "PANIC" })
  })

  test("an interrupt the CLI never answers counts toward the 10 s", async () => {
    const ran = await quitting({
      tickets: ["t-1"],
      setup: {
        backlog: backlog().ticket("t-1").seeds,
        scripts: (world, root, quits) => ({
          "t-1": [atWork(world, root, "t-1", [step(Effect.asVoid(Queue.offer(quits, ctrlC)))])],
        }),
      },
      around: (running) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          return yield* running.pipe(
            Effect.provideService(AgentHost, { ...host, interrupt: () => Effect.never }),
          )
        }),
      during: () =>
        Effect.gen(function* () {
          yield* until(Effect.map(texts, (log) => log.some((each) => each.startsWith("QUIT"))))
          for (let i = 0; i < 200; i++) yield* Effect.yieldNow
          yield* advance("10 seconds")
        }),
    })
    expectExitCode(ran, 130)
    expectLog(ran, [
      /^QUIT with Ctrl\+C/,
      "  the workers of t-1 did not end their turns within 10s; closing their sessions",
    ])
    expect(sentTo(ran, "t-1")).toEqual(["Started", "Message", "Closed"])
  })
})

describe("signals", () => {
  test("SIGUSR1 and SIGUSR2 drain, SIGTSTP is caught, each until the scope closes", async () => {
    const heardOf: Array<string> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* catchSignals({
            drain: (signal) => heardOf.push(signal),
            suspend: () => heardOf.push("SIGTSTP"),
          })
          // A SIGTSTP sent here proves nothing: the kernel drops it in an orphaned process group
          // (docs/spikes/06-bun-ffi.md, § 3). The handler is there, so tutti isn't stopped.
          expect(process.listenerCount("SIGTSTP")).toBe(1)
          process.kill(process.pid, "SIGUSR1")
          yield* Effect.promise(() => Bun.sleep(20))
          process.kill(process.pid, "SIGUSR2")
          yield* Effect.promise(() => Bun.sleep(20))
        }),
      ),
    )
    expect(heardOf).toEqual(["SIGUSR1", "SIGUSR2"])
    expect(process.listenerCount("SIGUSR1")).toBe(0)
    expect(process.listenerCount("SIGTSTP")).toBe(0)
  })

  test("SIGINT, SIGTERM and SIGHUP go to the run listening, else interrupt the command", async () => {
    const got: Array<string> = []
    const otherwise = () => got.push("interrupt")
    route("SIGTERM", otherwise)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* listen((signal) => got.push(signal))
          route("SIGINT", otherwise)
          route("SIGHUP", otherwise)
        }),
      ),
    )
    route("SIGINT", otherwise)
    expect(got).toEqual(["interrupt", "SIGINT", "SIGHUP", "interrupt"])
  })

  test("the first request quits, the second warns, the third and later exit", () => {
    expect([1, 2, 3, 4].map(heard)).toEqual(["quit", "warn", "exit", "exit"])
    expect(quitBy("SIGINT")).toEqual({ how: "with Ctrl+C", again: "press Ctrl+C again" })
    expect(quitBy("SIGTERM")).toEqual({ how: "by SIGTERM", again: "send SIGTERM again" })
    expect(fromDashboard.again).toBe("press Ctrl+C again")
  })
})

describe("the lines", () => {
  test("as § 4.8 words them", () => {
    expect<unknown>(underWayLine("t-1", ctrlC)).toBe(
      "  t-1's merge is under way; press Ctrl+C again to abandon it",
    )
    expect<unknown>(quitLine(quitBy("SIGTERM"), [])).toBe(
      "QUIT by SIGTERM: no new tickets; no worker is running",
    )
    expect<unknown>(stillQuittingLine([], ctrlC)).toBe(
      "  quitting; press Ctrl+C again to quit at once",
    )
    expect(interruptedText("by SIGHUP", ["b", "a"], ["b"])).toBe(
      "quit by SIGHUP; the sessions of a, b are saved for the next run; b was handed back, the rebase or fix left as it is",
    )
    expect(atOnceText("with Ctrl+C", [], "t-1")).toBe(
      "quit at once with Ctrl+C; abandoned t-1's merge: git may still finish it, so check git status before starting another run",
    )
    expect<unknown>(panicLines("the run", "plain")).toEqual(["PANIC in the run: plain"])
  })

  test("a ticket's title or a defect can't put a line break in a line", () => {
    const [first] = panicLines("t-1's fiber", new Error("boom\nsecond\u001b[2J"))
    expect<unknown>(first).toBe("PANIC in t-1's fiber: boom")
  })

  test("the dashboard's title says Quitting… in place of · stopping", () => {
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
    const title = {
      version: "0.1.0",
      branch: "",
      scope: null,
      began: 0,
      stopping: true,
      quitting: quittingText([
        { ticket: "t-1", what: "worker" },
        { ticket: "t-2", what: "merge" },
      ]),
      solo: null,
    }
    const text = titleSegments(title, [], 0, theme, 120)
      .map((segment) => segment.text)
      .join("")
    expect(text).toContain("· Quitting… waiting for t-1's worker, t-2's merge")
    expect(text).not.toContain("stopping")
  })
})
