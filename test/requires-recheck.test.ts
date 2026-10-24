// A merge that changes the requires list in .tutti/settings.json on the base (src/run/requires.ts,
// setup.ts's takeSettings), as orchestra 0.9.1's takeRequires and recheckRequires: the run takes the
// new list and checks it again before the next ticket starts. What is still missing stops the run
// REQUIREMENTS_MISSING, exit 2, the running tickets finishing first (a HOLD line); the workers
// started from then on are told the list as it is now.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { workerOptions } from "../src/agent/options.ts"
import { requiresNote } from "../src/project/prompt.ts"
import type { Requirement } from "../src/project/settings.ts"
import { line } from "../src/run/log.ts"
import { sameRequires } from "../src/run/requires.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  Recording,
  result,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const settingsFile = ".tutti/settings.json"
const defaults = appConfig().settings
type Settings = typeof defaults

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-requires-recheck-${name}-`)))

interface Places {
  readonly repo: string
  readonly root: string
}

/** Claims its ticket, does `first`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  places: Places,
  id: string,
  options: { readonly files?: Files; readonly first?: SessionScript } = {},
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...(options.first ?? [sleep(0)]),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(
              join(places.root, id),
              `Change (${id})`,
              options.files ?? { [`${id}.txt`]: `${id}\n` },
            ),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** The settings file committing `requires`, the setup none, as the run's settings have it. */
const requiring = (requires: ReadonlyArray<Requirement>): Files => ({
  [settingsFile]: JSON.stringify({ checks: { setup: { command: null } }, requires }),
})

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

interface Plan {
  readonly tickets: ReadonlyArray<string>
  /** Each ticket blocked by the one before it, so that it starts once that one has merged. */
  readonly chain?: boolean
  /** The tickets each ticket is blocked by, where not chained. */
  readonly blockedBy?: Readonly<Record<string, ReadonlyArray<string>>>
  /** The run's requires list as it starts: none by default. */
  readonly requires?: ReadonlyArray<Requirement>
  /** Laid over the settings: the defaults with no setup, 1 worker. */
  readonly settings?: (settings: Settings) => Partial<Settings>
  readonly scripts: (world: World, places: Places) => Scripts
  /** Runs beside the run, before it is joined. */
  readonly during?: Effect.Effect<void, unknown, Env>
}

/** A whole run on main, and the requires lists the run told the workers' host of. */
const runs = (
  plan: Plan,
): Promise<Ran<Outcome> & Places & { readonly told: ReadonlyArray<ReadonlyArray<string>> }> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const base: Settings = {
    ...defaults,
    concurrent: 1,
    requires: plan.requires ?? [],
    checks: { ...defaults.checks, setup: { ...defaults.checks.setup, command: null } },
  }
  let told: ReadonlyArray<ReadonlyArray<string>> = []
  return scenario(
    {
      config: { repo: places.repo, settings: { ...base, ...plan.settings?.(base) } },
      backlog: (plan.chain === true
        ? backlog().chain(...plan.tickets)
        : plan.tickets.reduce((b, id) => {
            const blockers = plan.blockedBy?.[id]
            return b.ticket(id, blockers === undefined ? {} : { blockedBy: [...blockers] })
          }, backlog())
      ).seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      scripts: (world: World) => plan.scripts(world, places),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      if (plan.during !== undefined) yield* plan.during
      const outcome = yield* Fiber.join(fiber)
      told = yield* (yield* Recording).requires
      return outcome
    }),
  ).then((ran) => ({ ...ran, ...places, told }))
}

const changed = (id: string) =>
  `  REQUIRES: ${id}'s merge changed the requirements in ${settingsFile} on main: they are checked before the next ticket starts`

const missingLine = (detail: string) =>
  `REQUIREMENTS_MISSING: ${detail}; meet it (each entry of 'requires' in ${settingsFile} says how), then run again`

const startedTickets = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.sent.flatMap((sent) => (sent._tag === "Started" ? [sent.ticket] : []))

const license: Requirement = {
  name: "license",
  check: "false",
  manual: "accept the licence in the app",
}

describe("the requires list a merge changes", () => {
  test("is checked before the next ticket starts: one still missing stops the run, exit 2", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      chain: true,
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: requiring([license]) })],
        b: [works(world, places, "b")],
      }),
    })
    expectExitCode(ran, 2)
    expectLog(ran, [
      /^ {2}a closed /,
      changed("a"),
      "  REQUIRES: checking 1 requirement",
      missingLine("license (accept the licence in the app)"),
    ])
    expect(startedTickets(ran)).toEqual(["a"])
    expect(ran.events).toContainEqual(
      expect.objectContaining({ kind: "stop", detail: "REQUIREMENTS_MISSING" }),
    )
    // The workers' host is told the run's list as it is now.
    expect(ran.told).toEqual([["license"]])
  })

  test("that is met lets the next ticket start", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      chain: true,
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", {
            files: requiring([{ name: "shell", check: "true", install: "false" }]),
          }),
        ],
        b: [works(world, places, "b")],
      }),
    })
    expectExitCode(ran, 0)
    expectLog(ran, [
      /^ {2}a closed /,
      changed("a"),
      "  REQUIRES: checking 1 requirement",
      "  REQUIRES: shell met",
      /^ {2}b closed /,
    ])
    expect(startedTickets(ran)).toEqual(["a", "b"])
    expect(ran.told).toEqual([["shell"]])
  })

  test("still missing while a ticket runs holds the run until it finishes: HOLD, then the stop", async () => {
    // Said once the run holds; said anyway should it never, for the log's expectation to fail.
    const held = Effect.runSync(Deferred.make<void>())
    const ran = await runs({
      tickets: ["a", "b", "c"],
      // c starts once a has merged, b runs beside a.
      blockedBy: { c: ["a"] },
      settings: () => ({ concurrent: 2 }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: requiring([license]) })],
        // b finishes once the run holds for it.
        b: [works(world, places, "b", { first: [step(Deferred.await(held))] })],
        c: [works(world, places, "c")],
      }),
      during: Effect.forkChild(
        Effect.ensuring(Effect.ignore(untilLogged(/^HOLD: /)), Deferred.succeed(held, undefined)),
      ),
    })
    expectExitCode(ran, 2)
    expectLog(ran, [
      /^ {2}a closed /,
      changed("a"),
      "  REQUIRES: checking 1 requirement",
      `HOLD: ${missingLine("license (accept the licence in the app)")}; no new tickets while the 1 running finish`,
      /^ {2}b closed /,
      missingLine("license (accept the licence in the app)"),
    ])
    expect(startedTickets(ran)).toEqual(["a", "b"])
  })

  test("a merge that leaves the list as it was doesn't check it again", async () => {
    const shell: Requirement = { name: "shell", check: "true", install: "false" }
    const ran = await runs({
      tickets: ["a", "b"],
      chain: true,
      requires: [shell],
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: requiring([shell]) })],
        b: [works(world, places, "b")],
      }),
    })
    expectExitCode(ran, 0)
    expect(ran.log.filter((text) => text.includes("checking 1 requirement"))).toHaveLength(1)
    expect(ran.log.some((text) => text.includes("merge changed the requirements"))).toBe(false)
    expect(ran.told).toEqual([])
  })

  test("that can't be read leaves the run's list as it was", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      chain: true,
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", {
            // Two entries named alike: the settings don't decode.
            files: requiring([license, license]),
          }),
        ],
        b: [works(world, places, "b")],
      }),
    })
    expectExitCode(ran, 0)
    expectLog(ran, [
      /^ {2}a closed /,
      /^ {2}SETTINGS_UNREAD: a's merge changed \.tutti\/settings\.json on main, but it could not be read: .*; the setup stays none, and the requirements as they were$/,
      /^ {2}b closed /,
    ])
    expect(ran.log.some((text) => text.includes("REQUIRES"))).toBe(false)
    expect(ran.told).toEqual([])
  })
})

describe("the requires list a worker is told", () => {
  test("is the run's now, not the settings' the run started with", () => {
    const config = appConfig({}, "/work/project")
    const prompt = { text: "You work on TICKET_ID.", file: null }
    const options = workerOptions({
      config: { ...config, settings: { ...config.settings, requires: [license] } },
      ticket: "t-1",
      worktree: "/work/project-tutti/t-1",
      prompt,
      servers: { servers: [], note: null },
      skills: false,
      requires: ["jq", "docker"],
      callbacks: {
        canUseTool: async () => ({ behavior: "allow" }),
        onElicitation: async () => ({ action: "decline" }),
        hooks: {},
        stderr: () => {},
      },
      session: { _tag: "New", sessionId: "11111111-2222-4333-8444-555555555555" },
    })
    const system = options.systemPrompt
    const append = typeof system === "object" && "append" in system ? system.append : ""
    expect(append).toContain(requiresNote(["jq", "docker"], prompt.text, false))
    expect(append).not.toContain("license")
  })
})

describe("sameRequires", () => {
  test("is the same entries in the same order", () => {
    const jq: Requirement = { name: "jq", check: "command -v jq", install: "brew install jq" }
    expect(sameRequires([license, jq], [{ ...license }, { ...jq }])).toBe(true)
    expect(sameRequires([license, jq], [jq, license])).toBe(false)
    expect(sameRequires([jq], [{ ...jq, install: "apt-get install jq" }])).toBe(false)
    expect(sameRequires([jq], [{ ...jq, platforms: ["darwin"] }])).toBe(false)
    expect(sameRequires([], [])).toBe(true)
    expect(sameRequires([jq], [])).toBe(false)
  })
})
