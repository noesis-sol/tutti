// The title line's ` keep awake ` badge (§ 7.2, § 7.11): after the version while the run's
// --keep-awake command holds the machine awake (keepAwake.ts's `holding`, run.ts's keepingAwake,
// Status.keepAwake), a pill in the keepAwake role, the first thing a narrow pane gives up.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, SubscriptionRef } from "effect"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { Banner, type RunView, type TitleView } from "../src/run/runView.ts"
import type { Dashboard, ScreenInputs } from "../src/run/screen.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { titleSegments } from "../src/ui/TitleLine.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { advance, expectExitCode, scenario } from "./harness.ts"

const themeIn = (appearance: Appearance, noColor = false) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor })

const theme = themeIn("dark")

const title: TitleView = {
  version: "0.1.0",
  branch: "main",
  scope: null,
  began: 0,
  stopping: false,
  quitting: null,
  solo: null,
  shared: 0,
  keepAwake: false,
}

const awake: TitleView = { ...title, keepAwake: true }

const usage: Banner = Banner.Usage({ utilization: 0.85, resetsAt: null, limit: "five-hour" })

/** The title line's text `width` columns wide, the run's time at 0. */
const text = (view: TitleView, width = 120, banners: ReadonlyArray<Banner> = []) =>
  titleSegments(view, banners, 0, theme, width)
    .map((segment) => segment.text)
    .join("")

describe("the keep-awake badge", () => {
  test("follows the version while the run keeps the machine awake", () => {
    expect(text(awake)).toStartWith(" tutti  0.1.0  keep awake    main · 0s")
  })

  test("is absent from a run that doesn't keep the machine awake", () => {
    expect(text(title)).toStartWith(" tutti  0.1.0   main · 0s")
    expect(text(title)).not.toContain("keep awake")
  })

  test("comes before the run's states", () => {
    expect(text({ ...awake, stopping: true, shared: 2 })).toStartWith(
      " tutti  0.1.0  keep awake   · stopping  · shared with 2 runs   main",
    )
  })

  test("gives way first in a narrow pane, before the branch, the time and the usage", () => {
    let width = 120
    while (text(awake, width - 1, [usage]).includes(" keep awake ")) width--
    // The narrowest it shows at, the line is whole: the branch, the time and the usage too.
    const badged = text(awake, width, [usage])
    expect(badged).toContain("main · 0s")
    expect(badged).toContain("usage 85% of the five-hour limit")
    // A column short: the badge is dropped, and the branch, the time and the usage stay whole.
    const narrower = text(awake, width - 1, [usage])
    expect(narrower).not.toContain("keep awake")
    expect(narrower).toBe(text(title, width - 1, [usage]))
    expect(narrower).toContain("main · 0s")
    expect(narrower).toContain("usage 85% of the five-hour limit")
  })

  test("is drawn in the keepAwake role, filled, in the light and the dark variant", () => {
    for (const appearance of ["light", "dark"] as const) {
      const drawn = themeIn(appearance)
      const badge = titleSegments(awake, [], 0, drawn, 120).find(
        (segment) => segment.text === " keep awake ",
      )
      expect(badge?.look).toBe(drawn.styles.keepAwake)
      expect(drawn.styles.keepAwake.bg?.toInts()).toEqual(drawn.rgba("keepAwake").toInts())
      expect(drawn.styles.keepAwake.fg?.toInts()).toEqual(drawn.rgba("keepAwakeText").toInts())
    }
    const hex = (appearance: Appearance) => ({
      fill: orchestra.colours.keepAwake[appearance],
      text: orchestra.colours.keepAwakeText[appearance],
    })
    expect(hex("light")).toEqual({
      fill: { _tag: "Hex", hex: "#B45309" },
      text: { _tag: "Hex", hex: "#FFFBEB" },
    })
    expect(hex("dark")).toEqual({
      fill: { _tag: "Hex", hex: "#F59E0B" },
      text: { _tag: "Hex", hex: "#1C1917" },
    })
  })

  test("is warmer than, and set apart from, the roles near it", () => {
    for (const appearance of ["light", "dark"] as const) {
      const fill = orchestra.colours.keepAwake[appearance]
      for (const near of ["notice", "windingDown", "needsYou", "pill"] as const) {
        expect({ near, fill }).not.toEqual({ near, fill: orchestra.colours[near][appearance] })
      }
    }
  })

  test("paints ANSI as a pill without bold", () => {
    expect(themeIn("dark").styles.keepAwake.paint(" keep awake ")).toBe(
      "\x1b[38;2;28;25;23m\x1b[48;2;245;158;11m keep awake \x1b[0m",
    )
  })

  test("keeps its words under NO_COLOR", () => {
    const plain = themeIn("dark", true)
    const segments = titleSegments(awake, [], 0, plain, 120)
    expect(segments.map((segment) => segment.text).join("")).toStartWith(
      " tutti  0.1.0  keep awake    main",
    )
    expect(plain.styles.keepAwake.paint(" keep awake ")).toBe(" keep awake ")
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-keep-awake-badge-${name}-`)))

describe("the run's dashboard", () => {
  test("shows the badge while the keep-awake command holds, and drops it once it ends", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const gate = Deferred.makeUnsafe<void>()
    const seen: Array<boolean> = []
    const ran = await scenario(
      {
        config: { repo, worktrees: root, settings: appConfig().settings },
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
        const holding = yield* SubscriptionRef.make(true)
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti 0.1.0-test`],
            dashboard,
            keepingAwake: SubscriptionRef.changes(holding),
          }),
        )
        seen.push((yield* view).title.keepAwake)
        yield* SubscriptionRef.set(holding, false)
        seen.push((yield* view).title.keepAwake)
        yield* Deferred.succeed(gate, undefined)
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expect(seen).toEqual([true, false])
  })

  test("never shows it for a run that doesn't keep the machine awake", async () => {
    const repo = folder("off-repo")
    const root = folder("off-worktrees")
    let shown: ScreenInputs | undefined
    const dashboard: Dashboard = (inputs) =>
      Effect.sync(() => {
        shown = inputs
      })
    const ran = await scenario(
      { config: { repo, worktrees: root }, backlog: [], git: { dir: repo }, worktrees: { root } },
      run({ version: "0.1.0-test", base: "main", dashboard }),
    )
    expectExitCode(ran, 0)
    const view = shown === undefined ? undefined : Effect.runSync(SubscriptionRef.get(shown.view))
    expect(view?.title.keepAwake).toBe(false)
  })
})
