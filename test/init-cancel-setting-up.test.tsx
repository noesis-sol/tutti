// Ctrl+C in tutti init's renderer while init works between questions, before it catches stops
// (tutti-298): a key in the renderer's raw mode, not SIGINT, which cancels init as it does in a
// field, interrupting what it reads. Here bd hangs as init reads the ticket prefix through it.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { createTestRenderer } from "@opentui/core/testing"
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { act } from "react"
import { init } from "../src/init/init.ts"
import type { Machine } from "../src/init/steps.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import { openInitForm } from "../src/ui/InitForm.tsx"
import { FormCancelled } from "../src/ui/questions.ts"
import { rendererConfig, type Shell } from "../src/ui/renderer.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { idleFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

/** A temp repository with Beads set up, and a home folder. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-cancel-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(join(repo, ".beads"))
  mkdirSync(home)
  return { repo, commonDir, home }
}

describe("Ctrl+C while init sets up, before it catches stops", () => {
  test("pressed while bd reads the ticket prefix, it cancels init and interrupts bd", async () => {
    const project = newProject()
    const reading = Deferred.makeUnsafe<void>()
    const interrupted = Deferred.makeUnsafe<void>()
    const ran: Array<string> = []
    const machine: Machine = {
      run: (command, args) => {
        ran.push([command, ...args].join(" "))
        return command === "bd" && args[0] === "config"
          ? Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            )
          : Effect.succeed("")
      },
      which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
      env: (name) => (name === "HOME" ? project.home : undefined),
      platform: "darwin",
      executable: () => false,
    }
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
      let fiber: Fiber.Fiber<unknown, unknown> | undefined
      await act(async () => {
        fiber = Effect.runFork(
          Effect.gen(function* () {
            const form = yield* openInitForm(shell, themeOf, project.repo, () => 0)
            return yield* init({
              repo: project.repo,
              commonDir: project.commonDir,
              branch: "main",
              version: "0.1.0",
              // The Workers step asks nothing, so the prefix is read under the working spinner.
              flags: { force: false, concurrent: 2, mcp: [], changelogUnion: false },
              form,
              scout: Effect.fail("there is no scout in this test"),
              machine,
              configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
              account: TestAccount.layer(),
              claudeConfig: join(project.home, ".claude.json"),
              catchStops: (stop) =>
                form.catchStops === undefined ? Effect.void : form.catchStops(stop),
            })
          }).pipe(
            Effect.provide(RunLock.layer),
            Effect.provide(TestBeads.layer([{ id: "tutti-1" }])),
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
            ),
            Effect.provide(BunServices.layer),
            Scope.provide(scope),
          ),
        )
      })
      await act(async () => {
        await Effect.runPromise(Deferred.await(reading))
      })
      expect(await idleFrame(setup)).toContain("Setting the project up…")
      await act(async () => {
        setup.mockInput.pressCtrlC()
      })
      const exit = await Effect.runPromise(
        Fiber.await(fiber as Fiber.Fiber<unknown, unknown>).pipe(Effect.timeout("5 seconds")),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
        expect(reason?._tag === "Fail" && reason.error).toBeInstanceOf(FormCancelled)
      }
      expect(await Effect.runPromise(Deferred.isDone(interrupted))).toBe(true)
      expect(ran).toContain("bd config get issue_prefix --json")
      // init changed nothing, and holds no lock: a lock's file is emptied as it is let go.
      expect(readdirSync(project.repo).sort()).toEqual([".beads", ".git"])
      for (const file of readdirSync(project.commonDir)) {
        expect(readFileSync(join(project.commonDir, file), "utf8")).toBe("")
      }
      await act(async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      })
    } finally {
      setup.renderer.destroy()
    }
  })
})
