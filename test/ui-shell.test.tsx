import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliRenderer } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { Effect, Exit, Option, Queue, Scope, Stream, SubscriptionRef } from "effect"
import { act, type ReactNode, useEffect } from "react"
import { Filing } from "../src/agent/interviewTools.ts"
import { makeCommands, UiCommand } from "../src/run/commands.ts"
import { line } from "../src/run/log.ts"
import { run } from "../src/run/run.ts"
import { emptyView, type RunView } from "../src/run/runView.ts"
import { type Dashboard, Screen, type ScreenInputs } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { InterviewContext } from "../src/ui/InterviewView.tsx"
import {
  fatalEvents,
  fatalHandler,
  open,
  rendererConfig,
  repaintFully,
  themeModeLimit,
} from "../src/ui/renderer.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  bridge,
  type External,
  external,
  type ShellValue,
  useCommand,
  useRunView,
} from "../src/ui/useRunView.ts"
import { type Ran, type Setup, scenario, tty } from "./harness.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

// Each test's scope, closed after it: the bridge fibers and the renderers opened in it.
let scopes: Array<Scope.Closeable> = []
const newScope = () => {
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  return scope
}
afterEach(async () => {
  for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void))
  scopes = []
})

/** A RunView ref, bridged to React in a scope of the test's. */
const bridged = async () => {
  const ref = Effect.runSync(SubscriptionRef.make<RunView>(emptyView))
  const view = await Effect.runPromise(Scope.provide(newScope())(bridge(ref)))
  return { ref, view }
}

const shellValue = (view: External<RunView>, overrides: Partial<ShellValue> = {}): ShellValue => ({
  view,
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  ...overrides,
})

const withCompleted = (completed: number): RunView => ({
  ...emptyView,
  totals: { ...emptyView.totals, completed },
})

/** Renders `node` at 80×24, disposed after the test. */
const draw = async (node: ReactNode) => {
  const setup = await testRender(node, { width: 80, height: 24 })
  scopes.push(
    Effect.runSync(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        yield* Scope.addFinalizer(
          scope,
          Effect.promise(() =>
            act(async () => {
              await setup.dispose()
            }),
          ),
        )
        return scope
      }),
    ),
  )
  await setup.flush()
  return setup
}

describe("the bridge", () => {
  test("a RunView change re-renders the screen", async () => {
    const { ref, view } = await bridged()
    const setup = await draw(<Root value={shellValue(view)} />)
    expect(setup.captureCharFrame()).not.toContain("✓ 3")
    await act(async () => {
      await Effect.runPromise(SubscriptionRef.set(ref, withCompleted(3)))
    })
    await setup.waitForFrame((frame) => frame.includes("✓ 3"))
  })

  test("getSnapshot is the same object until the next change", async () => {
    const { ref, view } = await bridged()
    const first = view.get()
    expect(view.get()).toBe(first)
    const next = withCompleted(1)
    await Effect.runPromise(SubscriptionRef.set(ref, next))
    // The bridge's fiber stores it on its next turn.
    await Bun.sleep(10)
    expect(view.get()).toBe(next)
    expect(view.get()).toBe(view.get())
  })

  test("listeners hear each change, and an unchanged value tells none", () => {
    const store = external(1)
    let heard = 0
    const stop = store.subscribe(() => heard++)
    store.set(1)
    expect(heard).toBe(0)
    store.set(2)
    expect(heard).toBe(1)
    stop()
    store.set(3)
    expect(heard).toBe(1)
  })

  test("a component renders again only when RunView changes", async () => {
    const { ref, view } = await bridged()
    let renders = 0
    const Probe = () => {
      renders++
      return <text>{`completed ${useRunView().totals.completed}`}</text>
    }
    const value = shellValue(view)
    const setup = await draw(
      <Root value={value}>
        <Probe />
      </Root>,
    )
    const before = renders
    await setup.renderOnce()
    await setup.renderOnce()
    expect(renders).toBe(before)
    await act(async () => {
      await Effect.runPromise(SubscriptionRef.set(ref, withCompleted(2)))
      await Bun.sleep(10)
    })
    await setup.waitForFrame((frame) => frame.includes("completed 2"))
    expect(renders).toBe(before + 1)
  })

  test("a handler's command goes into the queue, no Effect run", async () => {
    const { view } = await bridged()
    const value = shellValue(view)
    const Sender = () => {
      const send = useCommand()
      useEffect(() => send(UiCommand.Drain()), [send])
      return <text>sent</text>
    }
    await draw(
      <Root value={value}>
        <Sender />
      </Root>,
    )
    const taken = await Effect.runPromise(Queue.poll(value.commands))
    expect(Option.getOrNull(taken)?._tag).toBe("Drain")
  })

  test("the screen routes by view", async () => {
    const { view } = await bridged()
    const screen = external<Screen>(Screen.Dashboard())
    const interview = { description: "A feature", filing: external<Filing>(Filing.None()) }
    const setup = await draw(
      <InterviewContext.Provider value={interview}>
        <Root value={shellValue(view, { screen })} />
      </InterviewContext.Provider>,
    )
    expect(setup.captureCharFrame()).toContain("Completed")
    await act(async () => screen.set(Screen.Worker({ ticket: "t-2" as TicketId })))
    await setup.waitForFrame((frame) => frame.includes("← Dashboard"))
    await act(async () => screen.set(Screen.Interview()))
    await setup.waitForFrame((frame) => frame.includes("← Back"))
  })

  test("the theme follows the appearance", async () => {
    const { view } = await bridged()
    const appearance = external<Appearance>("dark")
    const setup = await draw(<Root value={shellValue(view, { appearance })} />)
    const colourOf = (text: string) =>
      setup
        .captureSpans()
        .lines.flatMap((l) => l.spans)
        .find((span) => span.text.includes(text))
        ?.fg.toInts()
        .slice(0, 3)
    // `Tickets` is drawn in the emphasis role: #E5E7EB on dark, #374151 on light.
    expect(colourOf("Tickets")).toEqual([0xe5, 0xe7, 0xeb])
    await act(async () => appearance.set("light"))
    await setup.renderOnce()
    expect(colourOf("Tickets")).toEqual([0x37, 0x41, 0x51])
  })
})

/** A test renderer for open(), and the setup that drives it. */
const testRenderer = async () => {
  const setup = await createTestRenderer({ ...rendererConfig, width: 40, height: 10 })
  return setup
}

/** Opens the shell over a test renderer in a scope of the test's, recording what is reported. */
const opened = async (chosen: "auto" | "light" | "dark" = "auto", renderer?: CliRenderer) => {
  if (renderer === undefined) return opened(chosen, (await testRenderer()).renderer)
  const reported: Array<{ readonly error: unknown; readonly destroyed: boolean }> = []
  const scope = newScope()
  const shell = await Effect.runPromise(
    Scope.provide(scope)(
      open({
        chosen,
        make: async () => renderer,
        report: (error) => reported.push({ error, destroyed: renderer.isDestroyed }),
      }),
    ),
  )
  return { shell, renderer, reported, scope }
}

describe("the renderer", () => {
  test("is made in the alternate screen, leaving Ctrl+C and every signal to tutti", () => {
    expect(rendererConfig).toEqual({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: [],
    })
  })

  test("an error nothing caught is reported once the renderer has closed", async () => {
    const { renderer } = await testRenderer()
    let closed = false
    void renderer.closed.then(() => {
      closed = true
    })
    let closedFirst: boolean | undefined
    await fatalHandler(renderer, () => {
      closedFirst = renderer.isDestroyed && closed
    })(new Error("boom"))
    expect(closedFirst).toBe(true)
  })

  test("listens for uncaught exceptions and rejections while it is open, and only then", async () => {
    const made = (await testRenderer()).renderer
    const listeners = (event: (typeof fatalEvents)[number]): ReadonlyArray<unknown> =>
      process.listeners(event)
    const before = fatalEvents.map((event) => new Set(listeners(event)))
    const { reported, scope, renderer } = await opened("dark", made)
    const added = fatalEvents.map((event, i) =>
      listeners(event).filter((listener) => !before[i]?.has(listener)),
    )
    expect(added.map((listeners) => listeners.length)).toEqual([1, 1])
    const handler = added[0]?.[0] as (error: unknown) => Promise<void>
    expect(added[1]?.[0]).toBe(handler)
    const error = new Error("thrown outside any fiber")
    await handler(error)
    expect(reported).toEqual([{ error, destroyed: true }])
    expect(renderer.isDestroyed).toBe(true)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    for (const event of fatalEvents) expect(listeners(event)).not.toContain(handler)
  })

  test("the Effect runtime's fatal path destroys the renderer as the scope closes", async () => {
    const { renderer } = await testRenderer()
    let failedWith: string | undefined
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* open({ chosen: "dark", make: async () => renderer, report: () => {} })
          return yield* Effect.die(new Error("a defect"))
        }),
      ).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            failedWith = renderer.isDestroyed ? "destroyed" : "still open"
          }),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failedWith).toBe("destroyed")
  })

  test("a renderer that can't be made fails with RendererFailed", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        open({ chosen: "dark", make: () => Promise.reject(new Error("no native library")) }),
      ),
    )
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("no native library")
  })

  test("a resize repaints the whole screen", async () => {
    const { renderer } = await opened("dark")
    const flag = renderer as unknown as { forceFullRepaintRequested: boolean }
    flag.forceFullRepaintRequested = false
    renderer.emit("resize", 30, 8)
    expect(flag.forceFullRepaintRequested).toBe(true)
    flag.forceFullRepaintRequested = false
    repaintFully(renderer as CliRenderer)
    expect(flag.forceFullRepaintRequested).toBe(true)
  })
})

describe("the appearance", () => {
  test("is dark when the terminal doesn't say, and follows its theme_mode events", async () => {
    const started = performance.now()
    const { shell, renderer } = await opened("auto")
    expect(performance.now() - started).toBeLessThan(themeModeLimit + 500)
    expect(shell.appearance.get()).toBe("dark")
    renderer.emit("theme_mode", "light")
    expect(shell.appearance.get()).toBe("light")
    renderer.emit("theme_mode", "dark")
    expect(shell.appearance.get()).toBe("dark")
  })

  test("is the user's choice when there is one, whatever the terminal says", async () => {
    const { shell, renderer } = await opened("light")
    expect(shell.appearance.get()).toBe("light")
    renderer.emit("theme_mode", "dark")
    expect(shell.appearance.get()).toBe("light")
  })
})

describe("the run", () => {
  /** A run of an empty backlog, given a dashboard that records what it is shown. */
  const runWith = async (setup: Setup) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-ui-shell-")))
    const shown: Array<ScreenInputs> = []
    const dashboard: Dashboard = (inputs) => Effect.sync(() => void shown.push(inputs))
    const ran = await scenario(
      { ...setup, config: { ...setup.config, repo }, git: { dir: repo } },
      Effect.gen(function* () {
        const outcome = yield* run({
          version: "0.1.0-test",
          base: "main",
          start: [line`START tutti 0.1.0-test`],
          dashboard,
        })
        // Each view as first projected from the run's sources.
        const views = yield* Effect.forEach(shown, (inputs) =>
          SubscriptionRef.changes(inputs.view).pipe(
            Stream.filter((view) => view !== emptyView),
            Stream.runHead,
          ),
        )
        const screens = yield* Effect.forEach(shown, (inputs) => SubscriptionRef.get(inputs.screen))
        return { outcome, views, screens }
      }),
    )
    return ran
  }

  const resultOf = <A,>(ran: Ran<A>): A => {
    if (Exit.isFailure(ran.exit)) throw new Error(`the run failed: ${ran.exit.cause}`)
    return ran.exit.value
  }

  test("shows the dashboard when Tty says the terminal can draw one", async () => {
    const ran = await runWith({ tty: tty() })
    const { outcome, views, screens } = resultOf(ran)
    expect(views).toHaveLength(1)
    expect(Option.getOrNull(views[0] ?? Option.none())?.totals.slots).toBeGreaterThan(0)
    expect(screens).toEqual([Screen.Dashboard()])
    expect(outcome.exitCode).toBe(0)
    expect(String(outcome.ending.at(-1))).toBe("READY_EMPTY after 0 tickets")
    expect(outcome.ending[0]).toMatch(/^tutti 0\.1\.0-test on main · /)
  })

  test("is plain when Tty says so, or with --plain", async () => {
    for (const setup of [
      { tty: tty({ stdoutIsTty: false }) },
      { tty: tty({ env: { TERM: "dumb" } }) },
      { tty: tty({ env: { TERM: "xterm" } }) },
      { tty: tty(), config: { plain: true } },
    ] satisfies ReadonlyArray<Setup>) {
      const { views } = resultOf(await runWith(setup))
      expect(views).toHaveLength(0)
    }
  })
})
