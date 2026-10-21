// The title line says `· shared with N runs` while other tutti or orchestra runs share the machine
// (orchestra 0.8.5): the run keeps the count its last look at the folder of runs found
// (Status.shared, run.ts's lookAround), and the title line shows it beside its states.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, SubscriptionRef } from "effect"
import { line } from "../src/run/log.ts"
import { type ProcessCheck, Processes } from "../src/run/machine.ts"
import { run } from "../src/run/run.ts"
import type { RunView, TitleView } from "../src/run/runView.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { advance, expectExitCode, scenario } from "./harness.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const title: TitleView = {
  version: "0.1.0",
  branch: "main",
  scope: null,
  began: 0,
  stopping: false,
  quitting: null,
  solo: null,
  shared: 0,
}

/** The title line's text `width` columns wide, the run's time at 0. */
const text = (view: TitleView, width = 120) =>
  titleSegments(view, [], 0, theme, width)
    .map((segment) => segment.text)
    .join("")

describe("the title line", () => {
  test("says nothing of sharing while no other run shares the machine", () => {
    expect(text(title)).not.toContain("shared")
  })

  test("says how many other runs share the machine", () => {
    expect(text({ ...title, shared: 1 })).toContain(" tutti  0.1.0  · shared with 1 run   main")
    expect(text({ ...title, shared: 2 })).toContain("· shared with 2 runs   main")
  })

  test("keeps the count after the solo ticket, and before the branch a narrow pane drops", () => {
    const solo = { ...title, shared: 1, solo: { ticket: "s", running: true } }
    expect(text(solo)).toContain("· solo s running  · shared with 1 run   main")
    expect(text(solo, 56).trimEnd()).toBe(" tutti  0.1.0  · solo s running  · shared with 1 run")
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-shared-title-${name}-`)))

/** Every process runs, its start unknown: the other run's PID is going. */
const everyoneAlive: ProcessCheck = { alive: () => true, start: () => Effect.succeed(null) }

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((each) => pattern.test(each))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

describe("the run's dashboard", () => {
  test("counts the other runs as its looks find them start and end", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const runs = folder("runs")
    const other = join(runs, "run-4242-1.json")
    writeFileSync(
      other,
      `{"pid":4242,"repo":"/work/other","concurrent":3,"started":"${new Date().toISOString()}","running":1}`,
    )
    const gate = Deferred.makeUnsafe<void>()
    const seen: Array<number> = []
    const ran = await scenario(
      {
        config: { repo, worktrees: root, runs, settings: appConfig().settings },
        backlog: [{ id: "t-1" }],
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => ({
          "t-1": [
            claimsAndCloses("t-1", {
              claim: Effect.andThen(
                Deferred.await(gate),
                Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
              ),
              commit: Effect.asVoid(
                Effect.orDie(
                  world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
                ),
              ),
              close: Effect.asVoid(Effect.orDie(world.beads.close("t-1", "done"))),
            }),
          ],
        }),
      },
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
          branch: "tutti/t-1",
          base: "main",
        })
        let shown: ScreenInputs | undefined
        const dashboard: Dashboard = (inputs) =>
          Effect.sync(() => {
            shown = inputs
          })
        // RunView is written at most 30 times a second, on the Clock: move it on to see the latest.
        const view: Effect.Effect<RunView> = Effect.gen(function* () {
          for (let i = 0; i < 3; i++) {
            yield* advance("100 millis")
            yield* Effect.promise(() => Bun.sleep(10))
          }
          if (shown === undefined) throw new Error("the run showed no dashboard")
          return yield* SubscriptionRef.get(shown.view)
        })
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard,
          }).pipe(Effect.provideService(Processes, everyoneAlive)),
        )
        yield* untilLogged(/SHARED_MACHINE: another orchestra run/)
        seen.push((yield* view).title.shared)
        unlinkSync(other)
        // The ready poll has the run look again, and find the other run gone.
        yield* advance(readyPoll)
        yield* untilLogged(/the other orchestra run in \/work\/other has ended/)
        seen.push((yield* view).title.shared)
        yield* Deferred.succeed(gate, undefined)
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expect(seen).toEqual([1, 0])
  })
})
