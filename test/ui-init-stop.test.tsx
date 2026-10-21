// Ctrl+C in tutti init's renderer once init takes its steps (orchestra-qa9p): a key in the
// renderer's raw mode, not SIGINT, which stops init after the step under way, the spinner saying
// it is stopping; before init takes its steps, Ctrl+C between questions does nothing.
import { describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { act } from "react"
import type { InitForm } from "../src/init/init.ts"
import { openInitForm } from "../src/ui/InitForm.tsx"
import { rendererConfig, type Shell } from "../src/ui/renderer.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

/** init's form in a test renderer, its clock at 0: `ask` runs on it while `body` drives it. */
const driven = async <A,>(
  ask: (form: InitForm) => Effect.Effect<A, unknown, Scope.Scope>,
  body: (screen: {
    readonly until: (text: string) => Promise<string>
    readonly press: (drive: (setup: TestRendererSetup) => void) => Promise<void>
  }) => Promise<void>,
): Promise<Exit.Exit<A, unknown>> => {
  const setup = await createTestRenderer({
    ...rendererConfig,
    width: 90,
    height: 30,
    onDestroy: () => {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    },
  })
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const shell: Shell = { renderer: setup.renderer, appearance: external<Appearance>("dark") }
  const scope = Effect.runSync(Scope.make())
  try {
    let fiber: Fiber.Fiber<A, unknown> | undefined
    await act(async () => {
      fiber = Effect.runFork(
        Effect.flatMap(
          openInitForm(shell, themeOf, "/work/shop", () => 0),
          ask,
        ).pipe(Scope.provide(scope)),
      )
    })
    const until = async (text: string) => {
      for (let tries = 0; tries < 200; tries++) {
        await act(async () => {
          await setup.renderOnce()
        })
        const now = setup.captureCharFrame()
        if (now.includes(text)) return now
        await act(async () => {
          await Bun.sleep(5)
        })
      }
      throw new Error(`the form never showed ${JSON.stringify(text)}:\n${setup.captureCharFrame()}`)
    }
    const press = async (drive: (setup: TestRendererSetup) => void) => {
      await act(async () => {
        drive(setup)
      })
    }
    await body({ until, press })
    const exit = await Effect.runPromise(Fiber.await(fiber as Fiber.Fiber<A, unknown>))
    await act(async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return exit
  } finally {
    setup.renderer.destroy()
  }
}

describe("Ctrl+C in init's renderer", () => {
  test("while init takes its steps, it stops init, and the spinner says it is stopping", async () => {
    const exit = await driven(
      (form) =>
        Effect.gen(function* () {
          const stopped = yield* Deferred.make<void>()
          if (form.catchStops === undefined) return "no catchStops"
          yield* form.catchStops(() => Deferred.doneUnsafe(stopped, Effect.void))
          yield* Deferred.await(stopped)
          return "stopped"
        }),
      async ({ until, press }) => {
        await until("Setting the project up…")
        await press((setup) => setup.mockInput.pressCtrlC())
        expect(await until("Stopping after this step…")).toContain("⣾ Stopping after this step…")
      },
    )
    expect(Exit.isSuccess(exit) && exit.value).toBe("stopped")
  })

  test("before init takes its steps, Ctrl+C between questions does nothing", async () => {
    const exit = await driven(
      () => Effect.sleep("100 millis").pipe(Effect.as("went on")),
      async ({ until, press }) => {
        await until("Setting the project up…")
        await press((setup) => setup.mockInput.pressCtrlC())
        expect(await until("Setting the project up…")).not.toContain("Stopping")
      },
    )
    expect(Exit.isSuccess(exit) && exit.value).toBe("went on")
  })
})
