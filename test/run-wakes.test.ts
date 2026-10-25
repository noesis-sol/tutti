// The run's wakes as data (tutti-rvzn.5): each wake records its reason, and a look woken by an
// attention change alone, a request opened or answered, reads neither bd nor git, while a merge
// still has the run take the next ticket at once, before any ready poll.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { Attention } from "../src/agent/Attention.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { make, reads, type Wake } from "../src/run/wakes.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  result,
  type SessionScript,
  tool,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { waitForTest } from "../src/testing/Attention.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, expectExitCode, expectPhases, scenario, type World } from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-wakes-${name}-`)))

describe("a look's reasons", () => {
  const others: ReadonlyArray<Wake> = [
    "poll",
    "freed",
    "merge",
    "hold",
    "command",
    "verdict",
    "drain",
  ]

  test("read bd and git for any reason but an attention change, or none recorded", () => {
    expect(reads(new Set())).toBe(true)
    expect(reads(new Set(["attention"]))).toBe(false)
    for (const why of others) {
      expect(reads(new Set([why]))).toBe(true)
      expect(reads(new Set<Wake>(["attention", why]))).toBe(true)
    }
  })

  test("are recorded by each wake and cleared as a look takes them", async () => {
    const [first, second, freed] = await Effect.runPromise(
      Effect.gen(function* () {
        const wakes = yield* make
        yield* wakes.wakeUp("attention")
        yield* wakes.wakeUp("merge")
        yield* wakes.wakeUp("attention")
        // The two wakes are one: the loop looks once, for both reasons.
        yield* wakes.next(Effect.never)
        const first = yield* wakes.take
        const second = yield* wakes.take
        // A freed slot wakes it as "freed".
        yield* wakes.next(Effect.void)
        return [first, second, yield* wakes.take] as const
      }),
    )
    expect([...first]).toEqual(["attention", "merge"])
    expect([...second]).toEqual([])
    expect([...freed]).toEqual(["freed"])
  })
})

/** Asks to remove each of `paths` in turn, each once answered; then commits and closes its ticket. */
const asksTwice = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...["build", "dist"].flatMap((path) => [
        canUseTool("Bash", { command: `rm -rf ${path}` }),
        ...tool("Bash", { command: `rm -rf ${path}` }),
      ]),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** Claims, commits and closes its ticket. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** Waits, in real time, until `ready`, then a little longer for the run's looks to settle. */
const until = (ready: Effect.Effect<boolean>, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if (yield* ready) {
        yield* Effect.promise(() => Bun.sleep(100))
        return
      }
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`never ${what}`)
  })

describe("permission traffic", () => {
  test("wakes the run without a bd or git read, and the run still ends once the ticket merges", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    // The bd and git calls made between the first request's answer and the second's settling.
    let between: { readonly bd: ReadonlyArray<string>; readonly git: ReadonlyArray<string> } = {
      bd: [],
      git: [],
    }
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("a").ticket("b").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World) => ({
          a: [asksTwice(world, root, "a" as TicketId)],
          b: [finishes(world, root, "b" as TicketId)],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        const beads = yield* Beads
        const attention = yield* Attention
        const repository = yield* Repository
        yield* git.addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
        yield* git.addWorktree(repo, join(root, "b"), { branch: "tutti/b", base: "main" })
        // The run's bd calls, by command; the workers' go to the backlog without them.
        const bd: Array<string> = []
        const counted = Beads.of(
          Object.fromEntries(
            Object.entries(beads).map(([name, call]) => [
              name,
              (...args: ReadonlyArray<unknown>) =>
                Effect.andThen(
                  Effect.sync(() => bd.push(name)),
                  (call as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
                ),
            ]),
          ) as unknown as Beads["Service"],
        )
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }).pipe(
            Effect.provideService(Beads, counted),
          ),
        )
        // The request open for a, other than `answered`.
        const open = (answered?: string) =>
          Effect.map(attention.current, (requests) =>
            requests.find((request) => request.ticket === "a" && request.id !== answered),
          )
        yield* until(
          Effect.map(open(), (request) => request !== undefined),
          "asked to remove build",
        )
        const first = (yield* open())?.id ?? ""
        const bdBefore = bd.length
        const gitBefore = (yield* repository.calls).length
        yield* attention.answer(first, { _tag: "Allow" }, "screen")
        yield* until(
          Effect.map(open(first), (request) => request !== undefined),
          "asked to remove dist",
        )
        between = {
          bd: bd.slice(bdBefore),
          git: (yield* repository.calls).slice(gitBefore).map((call) => call.op),
        }
        const second = (yield* open(first))?.id ?? ""
        yield* attention.answer(second, { _tag: "Allow" }, "screen")
        return yield* Fiber.join(fiber)
      }),
    )
    expect(between).toEqual({ bd: [], git: [] })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
  }, 30_000)
})

describe("a merge", () => {
  test("has the run take the ticket waiting on it at once, with no ready poll", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().chain("a", "b").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          a: [finishes(world, root, "a" as TicketId)],
          b: [finishes(world, root, "b" as TicketId)],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "a"), { branch: "tutti/a", base: "main" })
        yield* git.addWorktree(repo, join(root, "b"), { branch: "tutti/b", base: "main" })
        // The clock never moves: the ready poll never wakes the run.
        return yield* run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
        })
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    const started = ran.sent.flatMap((sent) => (sent._tag === "Started" ? [sent.ticket] : []))
    expect(started).toEqual(["a" as TicketId, "b" as TicketId])
  }, 30_000)
})
