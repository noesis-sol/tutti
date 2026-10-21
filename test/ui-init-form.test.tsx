// tutti init's form (§ 7.1, § 8.3): its two steps in the renderer under the stepper, the scout's
// spinner and Esc skipping it, cancelling, the line-based flow for TERM=dumb, which form a terminal
// gets, and the summary printed once the renderer is gone (§ 7.11's init styles).
import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect, Exit, Fiber, Scope } from "effect"
import { act } from "react"
import type { ChecksQuestions } from "../src/init/checks.ts"
import type { InitForm, InitSummary } from "../src/init/init.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { step } from "../src/init/steps.ts"
import type { WorkersQuestions } from "../src/init/workers.ts"
import type { Scouting } from "../src/organs/scout.ts"
import { initHeader, initSummary, scoutClock, tildify } from "../src/print/initSummary.ts"
import { initFormKind, openInitForm } from "../src/ui/InitForm.tsx"
import { streamInput } from "../src/ui/plain/forms.ts"
import { rendererConfig, type Shell } from "../src/ui/renderer.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { pressEscape } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const plain = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const size = { width: 90, height: 30 }

const repo = "/work/shop"

const workers: WorkersQuestions = {
  installBeads: null,
  concurrent: { initial: 1, max: 16 },
  mcp: { available: ["github", "linear"], chosen: ["github"] },
  changelogUnion: true,
}

const twoSuites: Scouting = {
  suites: [
    {
      name: "unit tests",
      kind: "unit",
      command: "npm test",
      targeted: "npm test -- <files>",
      found_in: "package.json:7",
      tier: "fast",
      parallel_safe: true,
      needs: [],
    },
    {
      name: "e2e",
      kind: "e2e",
      command: "npx playwright test",
      targeted: "",
      found_in: "playwright.config.ts:1",
      tier: "full",
      parallel_safe: false,
      needs: ["a browser"],
    },
  ],
  stack: ["TypeScript 5.9"],
  note: "",
}

const checks = (scout: Effect.Effect<Scouting, string>): ChecksQuestions => ({
  checks: {
    scout,
    checkScript: false,
    command: "",
    keepsRunner: false,
    runners: { fast: null, full: null },
    skill: "missing",
  },
  setup: null,
  prefix: null,
  verifier: true,
})

/** A frame's lines, their trailing blanks and the blank lines under them dropped. */
const trimmed = (frame: string): string =>
  frame
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

/**
 * init's form in a test renderer, its clock stopped at 0 so the spinner and the scout's time hold
 * still: `ask` runs on it, and `body` drives it while it does. The answer, or how it failed.
 */
const driven = async <A, E>(
  ask: (form: InitForm) => Effect.Effect<A, E>,
  body: (screen: {
    readonly setup: TestRendererSetup
    readonly until: (text: string) => Promise<string>
    readonly press: (drive: (setup: TestRendererSetup) => void | Promise<void>) => Promise<void>
  }) => Promise<void>,
): Promise<Exit.Exit<A, E>> => {
  const setup = await createTestRenderer({
    ...rendererConfig,
    ...size,
    onDestroy: () => {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    },
  })
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const shell: Shell = { renderer: setup.renderer, appearance: external<Appearance>("dark") }
  const scope = Effect.runSync(Scope.make())
  try {
    let fiber: Fiber.Fiber<A, E> | undefined
    await act(async () => {
      fiber = Effect.runFork(
        Effect.flatMap(
          openInitForm(shell, themeOf, repo, () => 0),
          ask,
        ).pipe(Scope.provide(scope)),
      )
    })
    const frame = async () => {
      await act(async () => {
        await setup.renderOnce()
      })
      return setup.captureCharFrame()
    }
    const until = async (text: string) => {
      for (let tries = 0; tries < 200; tries++) {
        const now = await frame()
        if (now.includes(text)) return trimmed(now)
        await act(async () => {
          await Bun.sleep(5)
        })
      }
      throw new Error(`the form never showed ${JSON.stringify(text)}:\n${await frame()}`)
    }
    const press = async (drive: (setup: TestRendererSetup) => void | Promise<void>) => {
      await act(async () => {
        await drive(setup)
      })
    }
    await body({ setup, until, press })
    const exit = await Effect.runPromise(Fiber.await(fiber as Fiber.Fiber<A, E>))
    await act(async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return exit
  } finally {
    setup.renderer.destroy()
  }
}

describe("init's form in the renderer", () => {
  test("the Workers step: the stepper, the fields answered above the one asked", async () => {
    const exit = await driven(
      (form) => form.workers(workers),
      async ({ until, press }) => {
        expect(await until("Tickets to run at the same time")).toMatchInlineSnapshot(`
          "
            tutti  init  /work/shop
            Sets this project up for tutti, in .tutti/.

           ● Workers ──── ○ Checks

           ┃ Tickets to run at the same time
           ┃ 1 to 16; each worker takes about 1 GiB of memory. Enter keeps 1.
           ┃ >

           Enter confirm · Esc cancel"
        `)
        await press(async (setup) => {
          await setup.mockInput.typeText("3")
          setup.mockInput.pressEnter()
        })
        await until("MCP servers workers get")
        await press((setup) => {
          setup.mockInput.pressArrow("down")
          setup.mockInput.pressKey(" ")
        })
        expect(await until("✓ linear")).toContain("> ✓ linear")
        await press((setup) => setup.mockInput.pressEnter())
        expect(await until("Merge CHANGELOG.md by union?")).toMatchInlineSnapshot(`
          "
            tutti  init  /work/shop
            Sets this project up for tutti, in .tutti/.

           ● Workers ──── ○ Checks

             Tickets to run at the same time  3
             3 workers: about 3 GiB of memory, about 1 GiB per worker
             MCP servers workers get  github, linear

           ┃ Merge CHANGELOG.md by union?
           ┃ Tickets that each add a changelog entry at the same spot conflict; CHANGELOG.md
           ┃ merge=union in .gitattributes has git keep both sides' lines.
           ┃   Yes     No

           ←→ choose · y yes · n no · Enter confirm · Esc cancel"
        `)
        await press((setup) => setup.mockInput.pressKey("n"))
      },
    )
    expect(Exit.isSuccess(exit) ? exit.value : String(exit)).toEqual({
      concurrent: 3,
      mcp: ["github", "linear"],
      changelogUnion: false,
    })
  })

  test("a number out of range is refused under the field until one in range is typed", async () => {
    const exit = await driven(
      (form) => form.workers({ ...workers, mcp: null, changelogUnion: false }),
      async ({ until, press }) => {
        await until("Tickets to run at the same time")
        await press(async (setup) => {
          await setup.mockInput.typeText("40")
          setup.mockInput.pressEnter()
        })
        expect(await until("Enter a whole number from 1 to 16.")).toContain("> 40")
        await press(async (setup) => {
          setup.mockInput.pressBackspace()
          setup.mockInput.pressBackspace()
          setup.mockInput.pressEnter()
        })
      },
    )
    // Enter on nothing keeps the number there.
    expect(Exit.isSuccess(exit) ? exit.value : String(exit)).toEqual({ concurrent: 1 })
  })

  test("the Checks step: the scout under its spinner, then the checklists", async () => {
    let finish: ((found: Scouting) => void) | undefined
    const scout = Effect.callback<Scouting, string>((resume) => {
      finish = (found) => resume(Effect.succeed(found))
    })
    const exit = await driven(
      (form) =>
        Effect.gen(function* () {
          yield* form.workers({ ...workers, mcp: null, changelogUnion: false })
          return yield* form.checks(checks(scout))
        }),
      async ({ until, press }) => {
        await until("Tickets to run at the same time")
        await press((setup) => setup.mockInput.pressEnter())
        expect(await until("Looking for the project's suites")).toMatchInlineSnapshot(`
          "
            tutti  init  /work/shop
            Sets this project up for tutti, in .tutti/.

           ✓ Workers ──── ● Checks

           ┃ ⣾ Looking for the project's suites 0:00 (up to 5 minutes)
           ┃ Its tests, lints, type checks and builds.
           ┃ Esc: skip and type a check yourself

           Esc skip · Ctrl+C cancel"
        `)
        await act(async () => {
          finish?.(twoSuites)
        })
        expect(await until("The scout found 2 suites.")).toContain("> Use them as they are")
        await press((setup) => setup.mockInput.pressEnter())
        expect(await until("On every merge (check-fast)")).toMatchInlineSnapshot(`
          "
            tutti  init  /work/shop
            Sets this project up for tutti, in .tutti/.

           ✓ Workers ──── ● Checks

             The project's checks  Use them as they are

           ┃ On every merge (check-fast)
           ┃ scripts/check-fast.sh runs these on every ticket rebased before it merges: the quick
           ┃ ones.
           ┃ > ✓ npm test  · unit tests · package.json:7
           ┃   • npx playwright test  · e2e · playwright.config.ts:1 · needs a browser · takes
           ┃ turns

           ↑↓ move · Space tick · Enter confirm · Esc cancel"
        `)
        await press((setup) => setup.mockInput.pressEnter())
        await until("At the end of a run (check-full)")
        await press((setup) => setup.mockInput.pressEnter())
        await until("Also file tickets for untested areas?")
        await press((setup) => setup.mockInput.pressEnter())
        await until("Add a verification step for workers?")
        await press((setup) => setup.mockInput.pressKey("y"))
      },
    )
    expect(Exit.isSuccess(exit) ? exit.value : String(exit)).toEqual({
      checks: {
        kind: "found",
        fast: [
          {
            name: "unit tests",
            command: "npm test",
            targeted: "npm test -- <files>",
            foundIn: "package.json:7",
            serial: false,
          },
        ],
        full: [
          {
            name: "e2e",
            command: "npx playwright test",
            targeted: "",
            foundIn: "playwright.config.ts:1",
            serial: true,
          },
        ],
        fileUntested: false,
      },
      stack: ["TypeScript 5.9"],
      verifier: true,
    })
  })

  test("Esc skips the scout, stopping it, and the choice starts on manual", async () => {
    let stopped = false
    const scout = Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          stopped = true
        }),
      ),
    )
    const exit = await driven(
      (form) => form.checks(checks(scout)),
      async ({ until, press }) => {
        const shown = await until("Looking for the project's suites")
        // Checks alone, Workers not asked: its name, without the stepper's marks.
        expect(shown).not.toContain("Workers")
        await press(pressEscape)
        const choice = await until("The project's checks")
        expect(choice).toContain("The search was skipped with Esc.")
        expect(choice).toContain("> Manual")
        await press((setup) => setup.mockInput.pressEnter())
        await until("Check command")
        await press(async (setup) => {
          await setup.mockInput.typeText("make check")
          setup.mockInput.pressEnter()
        })
        await until("Add a verification step for workers?")
        await press((setup) => setup.mockInput.pressEnter())
      },
    )
    expect(stopped).toBe(true)
    expect(Exit.isSuccess(exit) ? exit.value : String(exit)).toEqual({
      checks: { kind: "manual", command: "make check" },
      stack: [],
      verifier: true,
    })
  })

  test.each([
    ["Esc at a field", "field", "escape"],
    ["Ctrl+C at a field", "field", "ctrl+c"],
    ["Ctrl+C under the scout", "scout", "ctrl+c"],
  ] as const)("%s cancels the form", async (_, where, key) => {
    const exit = await driven(
      (form): Effect.Effect<unknown, unknown> =>
        where === "field" ? form.workers(workers) : form.checks(checks(Effect.never)),
      async ({ until, press }) => {
        await until(where === "field" ? "Tickets to run" : "Looking for the project's suites")
        await press((setup) =>
          key === "escape" ? pressEscape(setup) : setup.mockInput.pressCtrlC(),
        )
      },
    )
    expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain("FormCancelled")
  })

  test("between questions, while init works, a spinner says so", async () => {
    const exit = await driven(
      (form) =>
        Effect.gen(function* () {
          const imported = yield* form.import({
            imports: ["concurrent", "the worker prompt"],
            leftOut: [],
          })
          yield* Effect.sleep("30 millis")
          return imported
        }),
      async ({ until, press }) => {
        await until("Import orchestra's settings and worker prompt?")
        await press((setup) => setup.mockInput.pressEnter())
        expect(await until("Setting the project up…")).toContain("⣾ Setting the project up…")
      },
    )
    expect(Exit.isSuccess(exit) && exit.value).toBe(true)
  })
})

describe("init's form in lines", () => {
  /** The line form over `input`, which then ends: what `ask` answered, and what it wrote. */
  const answered = async <A, E>(input: string, ask: (form: InitForm) => Effect.Effect<A, E>) => {
    const stream = new PassThrough()
    stream.write(input)
    stream.end()
    let output = ""
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const form = lineForm({
            input: yield* streamInput(stream),
            write: (text) => {
              output += text
            },
            theme: plain,
          })
          return yield* ask(form)
        }),
      ),
    )
    return { exit, output }
  }

  test("asks both steps one question per line, under their headers", async () => {
    // 3 workers; linear only; the union declined; the scout's suites used as they are, both
    // checklists as they are, no untested areas; the verifier as offered.
    const { exit, output } = await answered("3\nlinear\nn\n\n\n\n\n\n", (form) =>
      Effect.all([form.workers(workers), form.checks(checks(Effect.succeed(twoSuites)))]),
    )
    expect(Exit.isSuccess(exit) ? exit.value : String(exit)).toEqual([
      { concurrent: 3, mcp: ["linear"], changelogUnion: false },
      {
        checks: {
          kind: "found",
          fast: [
            {
              name: "unit tests",
              command: "npm test",
              targeted: "npm test -- <files>",
              foundIn: "package.json:7",
              serial: false,
            },
          ],
          full: [
            {
              name: "e2e",
              command: "npx playwright test",
              targeted: "",
              foundIn: "playwright.config.ts:1",
              serial: true,
            },
          ],
          fileUntested: false,
        },
        stack: ["TypeScript 5.9"],
        verifier: true,
      },
    ])
    expect(Bun.stripANSI(output)).toMatchInlineSnapshot(`
      "Workers

      Tickets to run at the same time
      1 to 16; each worker takes about 1 GiB of memory. Enter keeps 1.
      > 
      3 workers: about 3 GiB of memory, about 1 GiB per worker

      MCP servers workers get
      Defined here: github, linear. Names, comma-separated; - for none; Enter keeps github.
      > 
      Tickets that each add a changelog entry at the same spot conflict; CHANGELOG.md merge=union in .gitattributes has git keep both sides' lines.
      Merge CHANGELOG.md by union? [Y/n] 
      Checks

      Looking for the project's suites (up to 5 minutes)…
      The project's checks
      The scout found 2 suites.
      1. Use them as they are
      2. Create from scratch with the create-check-suite skill
      3. Manual
      Enter a number between 1 and 3 > 
      On every merge (check-fast)
      scripts/check-fast.sh runs these on every ticket rebased before it merges: the quick ones.
      1. npm test  · unit tests · package.json:7
      2. npx playwright test  · e2e · playwright.config.ts:1 · needs a browser · takes turns
      Numbers, comma-separated; - for none; Enter keeps 1.
      > 
      At the end of a run (check-full)
      scripts/check-full.sh runs scripts/check-fast.sh, then these, once at the end of a run. A suite ticked above as well runs in check-fast only.
      1. npx playwright test  · e2e · playwright.config.ts:1 · needs a browser · takes turns
      Numbers, comma-separated; - for none; Enter keeps 1.
      > 
      A ticket asks a worker to map the project's features with the create-check-suite skill, and to file a ticket for each area no suite tests.
      Also file tickets for untested areas? [y/N] 
      A subagent that checks each ticket's change against the ticket in a fresh context, before the worker closes it, knowing the project is built with TypeScript 5.9. Each ticket then costs a subagent's run too.
      Add a verification step for workers? [Y/n] 
      "
    `)
  })

  test("the end of input cancels it", async () => {
    const { exit } = await answered("3\n", (form) => form.workers(workers))
    expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain("FormCancelled")
  })
})

describe("which form a terminal gets", () => {
  const terminal = {
    stdinIsTty: true,
    stdoutIsTty: true,
    dumb: false,
    colourDepth: "truecolor",
  } as const

  test("the renderer on a terminal, lines with TERM=dumb or few colours, none without one", () => {
    expect(initFormKind(terminal)).toBe("renderer")
    expect(initFormKind({ ...terminal, colourDepth: "256" })).toBe("renderer")
    expect(initFormKind({ ...terminal, dumb: true, colourDepth: "fewer" })).toBe("lines")
    expect(initFormKind({ ...terminal, colourDepth: "fewer" })).toBe("lines")
    expect(initFormKind({ ...terminal, stdinIsTty: false })).toBeNull()
    expect(initFormKind({ ...terminal, stdoutIsTty: false })).toBeNull()
  })
})

describe("init's summary on the main screen", () => {
  const summary: InitSummary = {
    steps: [
      step("done", "settings", "wrote .tutti/settings.json"),
      step("kept", "worker prompt", "kept .tutti/worker-prompt.md"),
      step("caution", "check-fast", "scripts/check-fast.sh differs from what init would write"),
      step("missing", "bd", "install Beads"),
    ],
    next: [
      "Fix what's missing above (bd: install Beads).",
      "Start a run from the main checkout, on the branch finished tickets should land on:\ntutti",
    ],
    ready: false,
  }

  test("the title, each step's mark, the Next box and the sign-off", () => {
    const text = `${initHeader(plain, repo)}\n${initSummary(summary, plain, 72)}`
    // NO_COLOR keeps bold and faint; the words and frames are what's left to compare.
    expect(Bun.stripANSI(text)).toMatchInlineSnapshot(`
      "
       tutti  init  /work/shop
       Sets this project up for tutti, in .tutti/.

        ✓ settings       wrote .tutti/settings.json
        • worker prompt  kept .tutti/worker-prompt.md
        ! check-fast     scripts/check-fast.sh differs from what init would
                         write
        ✗ bd             install Beads

      ╭──────────────────────────────────────────────────────────────────────╮
      │ Next                                                                 │
      │ 1. Fix what's missing above (bd: install Beads).                     │
      │ 2. Start a run from the main checkout, on the branch finished        │
      │    tickets should land on:                                           │
      │    tutti                                                             │
      ╰──────────────────────────────────────────────────────────────────────╯
       ♪ Almost ready: fix what's missing above."
    `)
  })

  test("in init's styles: marks in their roles, the Next frame in the pill's colour", () => {
    const theme = themeOf("dark")
    const text = initSummary({ ...summary, ready: true }, theme, 72)
    const { closed, dim, stop, deferred, organ } = theme.styles
    expect(text).toContain(closed.paint("✓"))
    expect(text).toContain(dim.paint("•"))
    expect(text).toContain(stop.paint("✗"))
    expect(text).toContain(deferred.paint("!"))
    expect(text).toContain(organ.paint("Next"))
    expect(text).toContain(`${theme.ansi("pill", "fg")}╭`)
    expect(text).toContain(organ.paint(" ♪ tutti is ready."))
  })

  test("the scout's clock and the home folder", () => {
    expect(scoutClock(0)).toBe("0:00")
    expect(scoutClock(75_400)).toBe("1:15")
    expect(tildify("/home/me/shop", "/home/me")).toBe("~/shop")
    expect(tildify("/home/meow", "/home/me")).toBe("/home/meow")
  })
})
