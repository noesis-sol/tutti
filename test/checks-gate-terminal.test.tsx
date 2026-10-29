// A spec run's checks gate in a terminal (§ 4.14, src/run/gateForm.ts): init's form in place of the
// dashboard, under the checks gate's title. Once the checks passed it shows what each runner runs,
// Enter keeping them and starting the rest of the tree. A hold asked in the form: checks set there
// are checked again from the start, and checks left as they are file the hold's question as
// without a terminal. (The form's tutti checks step itself, on real git: checks-gate-form.test.ts.)
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, SubscriptionRef } from "effect"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { fastScript, fullScript } from "../src/init/runners.ts"
import {
  fingerprint,
  type GateAsk,
  gateKey,
  gateQuestionTitle,
  gateSpecKey,
} from "../src/run/checksGate.ts"
import { makeCommands } from "../src/run/commands.ts"
import type { EventRecord } from "../src/run/events.ts"
import { keepDescription, keepQuestion } from "../src/run/gateForm.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { emptyStatus, project } from "../src/run/runView.ts"
import { type Dashboard, Screen, type ScreenInputs } from "../src/run/screen.ts"
import { HumanLabel, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { Repository } from "../src/testing/Git.ts"
import { Root } from "../src/ui/App.tsx"
import type { Asking, FormShown, InitScreen } from "../src/ui/InitForm.tsx"
import { makeInitForm } from "../src/ui/InitForm.tsx"
import { gateHeading } from "../src/ui/initTitle.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { backlog, expectExitCode, expectLog, type Ran, scenario, type World } from "./harness.ts"
import { renderFrame } from "./render.ts"

const fast = "scripts/check-fast.sh"
const full = "scripts/check-full.sh"
const spec = "shop.md"
const defaults = appConfig().settings
const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-checks-gate-terminal-${name}-`)))

const config = (repo: string): Partial<AppConfigValue> => ({
  repo,
  ticket: "s-1" as TicketId,
  specPath: spec,
  settings: {
    ...defaults,
    concurrent: 1,
    checks: {
      ...defaults.checks,
      setup: { ...defaults.checks.setup, command: null },
      fast: { command: fast, timeout: Duration.minutes(10) },
      full: { command: full, timeout: Duration.minutes(60) },
    },
  },
})

const emptyRunners = { [fast]: fastScript([]), [full]: fullScript([], true) }
const realRunners = {
  [fast]: fastScript([{ name: "unit", command: "bun test", foundIn: "", serial: false }]),
  [full]: fullScript([{ name: "e2e", command: "bun run e2e", foundIn: "", serial: false }], false),
}

const tree: ReadonlyArray<Seed> = backlog()
  .ticket("s-1", { type: "epic", metadata: { spec } })
  .ticket("s-1.1", { parent: "s-1", priority: 0, labels: ["solo"], metadata: { spec } })
  .ticket("s-1.2", { parent: "s-1", blockedBy: ["s-1.1"], metadata: { spec } }).seeds

const commits = (world: World, root: string, id: string, files: Record<string, string>) =>
  claimsAndCloses(id as TicketId, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id as TicketId, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(world.repository.commit(join(root, id), `Change (${id})`, files)),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id as TicketId, "done"))),
  })

/** The form the dashboard draws in place of its screen, once the gate opens it. */
const formOpened = (inputs: () => ScreenInputs | undefined) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const slot = inputs()?.form
      const shown = slot === undefined ? null : yield* SubscriptionRef.get(slot)
      if (shown !== null) return shown
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error("the gate never opened its form")
  })

/** The field the form asks, once it asks one. */
const asked = (screen: { readonly get: () => InitScreen }) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const asking = screen.get().asking
      if (asking !== null && asking._tag !== "Scout") return asking
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error("the form never asked")
  })

/** A whole spec run with a dashboard; `answer` answers the gate's form once it opens. */
const terminalRun = (o: {
  readonly onMain: Record<string, string>
  readonly environmentWrites: Record<string, string>
  readonly answer: (shown: FormShown, asking: Asking) => void
}) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const seen: Array<{ heading: string; asking: Asking }> = []
  const ran = scenario(
    {
      config: config(repo),
      git: { dir: repo },
      worktrees: { root },
      backlog: tree,
      scripts: (world) => ({
        "s-1.1": [commits(world, root, "s-1.1", o.environmentWrites)],
        "s-1.2": [commits(world, root, "s-1.2", { "shop.ts": "export {}\n" })],
      }),
    },
    Effect.gen(function* () {
      yield* (yield* Repository).commit(repo, "tutti: set up for spec shop.md", o.onMain)
      const git = yield* Git
      for (const id of ["s-1.1", "s-1.2"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      let inputs: ScreenInputs | undefined
      const dashboard: Dashboard = (given) =>
        Effect.sync(() => {
          inputs = given
        })
      const running = yield* Effect.forkChild(
        run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
        }),
      )
      const shown = yield* formOpened(() => inputs)
      const asking = yield* asked(shown.screen)
      seen.push({ heading: shown.heading.about, asking })
      o.answer(shown, asking)
      const outcome = yield* Fiber.join(running)
      const left = inputs?.form === undefined ? null : yield* SubscriptionRef.get(inputs.form)
      return { ...outcome, left }
    }),
  )
  return { ran, seen }
}

const started = (ran: Ran<unknown>): ReadonlyArray<string> =>
  ran.sent.flatMap((sent) => (sent._tag === "Started" ? [sent.ticket] : []))

const gateRecords = (ran: Ran<unknown>) =>
  ran.events.filter(
    (record): record is Extract<EventRecord, { kind: "checks_gate" }> =>
      record.kind === "checks_gate",
  )

describe("the checks gate in a terminal", () => {
  test("shows what each runner runs once they passed; Enter keeps them and the tree starts", async () => {
    const { ran: running, seen } = terminalRun({
      onMain: emptyRunners,
      environmentWrites: realRunners,
      answer: (_, asking) => {
        if (asking._tag === "Confirm") asking.answer(true)
      },
    })
    const ran = (await running) as Ran<Outcome & { readonly left: FormShown | null }>
    expectExitCode(ran, 0)
    const [first] = seen
    expect(first?.heading).toBe(gateHeading.about)
    expect(first?.asking._tag).toBe("Confirm")
    if (first?.asking._tag !== "Confirm") throw new Error("the form asked no confirm")
    expect(first.asking.field.question).toBe(keepQuestion)
    expect(first.asking.field.description).toBe(
      keepDescription([
        { name: fast, runs: ["bun test"] },
        { name: full, runs: [fast, "bun run e2e"] },
      ]),
    )
    expect(first.asking.field.initial).toBe(true)
    expect(started(ran)).toEqual(["s-1.1", "s-1.2"])
    expect(gateRecords(ran)).toMatchObject([{ detail: "passed" }])
    expect(gateRecords(ran)[0]?.changed).toBeUndefined()
    if (ran.exit._tag !== "Success") throw new Error("the scenario failed")
    expect(ran.exit.value.left).toBeNull()
  })
})

/**
 * A whole spec run whose gate asks through `ask`, as the form would: the environment ticket writes
 * nothing, so the runners still check nothing.
 */
const askedRun = (
  ask: (repository: Repository["Service"], repo: string) => GateAsk,
  seeds: ReadonlyArray<Seed> = tree,
) => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      config: config(repo),
      git: { dir: repo },
      worktrees: { root },
      backlog: seeds,
      scripts: (world) => ({
        "s-1.1": [commits(world, root, "s-1.1", { "README.md": "# Shop\n" })],
        "s-1.2": [commits(world, root, "s-1.2", { "shop.ts": "export {}\n" })],
      }),
    },
    Effect.gen(function* () {
      const repository = yield* Repository
      yield* repository.commit(repo, "tutti: set up for spec shop.md", emptyRunners)
      const git = yield* Git
      for (const id of ["s-1.1", "s-1.2"]) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      return yield* run({
        version: "0.1.0-test",
        base: "main",
        start: [line`START tutti 0.1.0-test`],
        gateAsk: ask(repository, repo),
      })
    }),
  )
}

describe("the gate's hold, asked in a terminal", () => {
  test("checks the checks set in the form again, and starts the tree once they pass", async () => {
    const calls: Array<string> = []
    const ran = await askedRun((repository, repo) => ({
      held: (why) =>
        Effect.gen(function* () {
          calls.push(`held: ${why}`)
          // As the form commits what tutti checks wrote on the base.
          yield* Effect.orDie(repository.commit(repo, "tutti: set the checks", realRunners))
          return "set" as const
        }),
      shown: (runners) =>
        Effect.sync(() => {
          calls.push(
            `shown: ${runners.map((each) => `${each.name}: ${each.runs.join("; ")}`).join(" | ")}`,
          )
          return "accepted" as const
        }),
    }))
    expectExitCode(ran, 0)
    expect(calls).toEqual([
      `held: ${fast} checks nothing, and ${full} checks nothing`,
      `shown: ${fast}: bun test | ${full}: ${fast}; bun run e2e`,
    ])
    expect(started(ran)).toEqual(["s-1.1", "s-1.2"])
    expect(gateRecords(ran)).toMatchObject([{ detail: "passed", changed: true }])
    expect(ran.issues.some((each) => each.title === gateQuestionTitle)).toBe(false)
  })

  test("a question an earlier run filed for these checks opens the form, and is closed once they pass", async () => {
    const print = fingerprint([
      { check: "fast", command: fast, path: fast, script: emptyRunners[fast] ?? null },
      { check: "full", command: full, path: full, script: emptyRunners[full] ?? null },
    ])
    const seeds = backlog()
      .ticket("s-1", { type: "epic", metadata: { spec } })
      .ticket("s-1.1", { parent: "s-1", priority: 0, labels: ["solo"], metadata: { spec } })
      .ticket("s-9", {
        title: gateQuestionTitle,
        labels: [HumanLabel],
        metadata: { [gateSpecKey]: spec, [gateKey]: print },
      })
      .ticket("s-1.2", { parent: "s-1", blockedBy: ["s-1.1", "s-9"], metadata: { spec } }).seeds
    const held: Array<string> = []
    const ran = await askedRun(
      (repository, repo) => ({
        held: (why) =>
          Effect.gen(function* () {
            held.push(why)
            yield* Effect.orDie(repository.commit(repo, "tutti: set the checks", realRunners))
            return "set" as const
          }),
        shown: () => Effect.succeed("accepted" as const),
      }),
      seeds,
    )
    expectExitCode(ran, 0)
    expect(held).toHaveLength(1)
    expect(started(ran)).toEqual(["s-1.1", "s-1.2"])
    expect(ran.issues.find((each) => each.id === "s-9")?.status).toBe("closed")
    expect(ran.issues.filter((each) => each.title === gateQuestionTitle)).toHaveLength(1)
    expectLog(ran, [/^CHECKS_GATE: closed s-9: the checks gate passed on main at \w+$/])
  })

  test("left as they are, the hold files its question as without a terminal", async () => {
    const ran = await askedRun(() => ({
      held: () => Effect.succeed("left" as const),
      shown: () => Effect.succeed("accepted" as const),
    }))
    expectExitCode(ran, 2)
    expect(started(ran)).toEqual(["s-1.1"])
    expect(ran.issues.some((each) => each.title === gateQuestionTitle)).toBe(true)
    expectLog(ran, [/^CHECKS_HELD: the checks gate held the spec's tree: /])
  })
})

describe("the form in place of the dashboard", () => {
  test("is drawn under the checks gate's title, asking to keep the checks", async () => {
    const opened = makeInitForm(() => 0)
    const shown: FormShown = { screen: opened.screen, repo: "/work/shop", heading: gateHeading }
    const asking = Effect.runFork(
      opened.fields.confirm({
        question: keepQuestion,
        description: keepDescription([{ name: fast, runs: ["bun test"] }]),
        initial: true,
      }),
    )
    const value: ShellValue = {
      view: external(
        project({
          ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
          workers: new Map(),
          requests: [],
          status: { ...emptyStatus, version: "0.1.0", branch: "main", concurrency: 1 },
        }),
      ),
      screen: external<Screen>(Screen.Dashboard()),
      commands: Effect.runSync(makeCommands),
      appearance: external<Appearance>("dark"),
      themeOf,
      now: () => 0,
      form: external<FormShown | null>(shown),
    }
    const frame = await renderFrame(<Root value={value} />, { width: 100, height: 30 })
    expect(frame.chars).toContain("checks gate")
    expect(frame.chars).toContain(keepQuestion)
    expect(frame.chars).toContain(`${fast}: bun test`)
    expect(frame.chars).not.toContain("picking the next ticket")
    Effect.runFork(Fiber.interrupt(asking))
  })
})
