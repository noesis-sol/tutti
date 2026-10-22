// init's form questions no other test asks (§ 8.3), in the line forms over a stream as a terminal's
// typing: the offer to install Beads, whether to replace check-fast.sh and check-full.sh where they
// differ from the checks chosen, and the offer to mark the checkout trusted; and init's requires
// steps (§ 8.4) where README.md can't be read or the settings don't parse.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { type ChecksQuestions, choiceScripts, runsDescription } from "../src/init/checks.ts"
import type { InitForm, TrustOffer } from "../src/init/init.ts"
import { lineForm } from "../src/init/lineForm.ts"
import { readmeSteps, requiresSteps } from "../src/init/requires.ts"
import type { WorkersQuestions } from "../src/init/workers.ts"
import type { Requirement } from "../src/project/settings.ts"
import { streamInput } from "../src/ui/plain/forms.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const plainTheme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

/** Bold and faint, which NO_COLOR keeps, left out, to read the output as text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the output's escape sequences
const unstyled = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "")

/** Asks `ask` of init's line form over `input`, which then ends: the answer, and what it wrote. */
const answer = async <A, E>(input: string, ask: (form: InitForm) => Effect.Effect<A, E>) => {
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
          theme: plainTheme,
        })
        return yield* ask(form)
      }),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`the form failed: ${exit.cause}`)
  return { answers: exit.value, output: unstyled(output) }
}

describe("the offer to install Beads", () => {
  const workers: WorkersQuestions = {
    installBeads: { method: "Homebrew", command: "brew install beads" },
    concurrent: null,
    mcp: null,
    changelogUnion: false,
  }

  test("is asked where bd is missing and init knows how to install it, yes on Enter", async () => {
    const { answers, output } = await answer("\n", (form) => form.workers(workers))
    expect(answers).toEqual({ installBeads: true })
    expect(output).toBe(
      "Workers\n\nbd isn't installed. tutti can install it with Homebrew: brew install beads\nInstall Beads? [Y/n] \n",
    )
  })

  test("declined, Beads isn't installed", async () => {
    const { answers } = await answer("n\n", (form) => form.workers(workers))
    expect(answers).toEqual({ installBeads: false })
  })

  test("isn't asked where bd is there or no install is known", async () => {
    const { answers, output } = await answer("", (form) =>
      form.workers({ ...workers, installBeads: null }),
    )
    expect(answers).toEqual({})
    expect(output).not.toContain("Install Beads?")
  })
})

describe("replacing the runners there", () => {
  // The scout failed, so Manual is offered; 2 picks Create from scratch, which writes the runners.
  const scratch = { kind: "scratch" } as const
  const planned = choiceScripts(scratch)
  if (planned === null) throw new Error("scratch writes no runners")
  const otherFast = "#!/bin/sh\nnpm test\n"
  const otherFull = "#!/bin/sh\nnpm run e2e\n"

  const questions = (runners: {
    readonly fast: string | null
    readonly full: string | null
  }): ChecksQuestions => ({
    checks: {
      scout: Effect.fail("there is no scout in these tests"),
      checkScript: false,
      command: "",
      keepsRunner: false,
      runners,
      skill: "missing",
    },
    setup: null,
    prefix: null,
    verifier: false,
  })

  const fastQuestion = "Replace scripts/check-fast.sh?"
  const fullQuestion = "Replace scripts/check-full.sh?"

  test("check-fast.sh that differs is asked about, kept on Enter, saying what it runs", async () => {
    const { answers, output } = await answer("2\n\n", (form) =>
      form.checks(questions({ fast: otherFast, full: null })),
    )
    expect(answers).toEqual({ checks: scratch, stack: [], replaceFast: false })
    expect(output).toContain(
      `scripts/check-fast.sh is there, and differs from the checks chosen. ${runsDescription(otherFast)}\n${fastQuestion} [y/N] `,
    )
    expect(output).not.toContain(fullQuestion)
  })

  test("both are asked, check-fast.sh first, where both differ", async () => {
    const { answers, output } = await answer("2\ny\ny\n", (form) =>
      form.checks(questions({ fast: otherFast, full: otherFull })),
    )
    expect(answers).toEqual({ checks: scratch, stack: [], replaceFast: true, replaceFull: true })
    expect(output.indexOf(fastQuestion)).toBeLessThan(output.indexOf(fullQuestion))
    expect(output).toContain(
      `scripts/check-full.sh is there, and differs from the checks chosen. ${runsDescription(otherFull)}\n${fullQuestion} [y/N] `,
    )
  })

  test("check-full.sh is weighed against the one written beside the check-fast.sh answered for", async () => {
    // check-full.sh as init writes it beside the check-fast.sh kept: the same, so not asked.
    const kept = choiceScripts(scratch, otherFast)?.full ?? ""
    expect(kept).not.toBe(planned.full)
    const keptFast = await answer("2\nn\n", (form) =>
      form.checks(questions({ fast: otherFast, full: kept })),
    )
    expect(keptFast.answers).toEqual({ checks: scratch, stack: [], replaceFast: false })
    expect(keptFast.output).not.toContain(fullQuestion)
    // Replacing check-fast.sh, that check-full.sh differs from the one init writes.
    const replaced = await answer("2\ny\n\n", (form) =>
      form.checks(questions({ fast: otherFast, full: kept })),
    )
    expect(replaced.answers).toEqual({
      checks: scratch,
      stack: [],
      replaceFast: true,
      replaceFull: false,
    })
  })

  test("check-full.sh alone is asked about where check-fast.sh is the one chosen", async () => {
    const { answers, output } = await answer("2\ny\n", (form) =>
      form.checks(questions({ fast: planned.fast, full: otherFull })),
    )
    expect(answers).toEqual({ checks: scratch, stack: [], replaceFull: true })
    expect(output).not.toContain(fastQuestion)
  })

  test("runners the same as the checks chosen, or missing, aren't asked about", async () => {
    for (const runners of [planned, { fast: null, full: null }]) {
      const { answers, output } = await answer("2\n", (form) => form.checks(questions(runners)))
      expect(answers).toEqual({ checks: scratch, stack: [] })
      expect(output).not.toContain("Replace ")
    }
  })

  test("Manual writes no runners, so isn't asked about them", async () => {
    const { answers, output } = await answer("3\nmake check\n", (form) =>
      form.checks(questions({ fast: otherFast, full: otherFull })),
    )
    expect(answers).toEqual({ checks: { kind: "manual", command: "make check" }, stack: [] })
    expect(output).not.toContain("Replace ")
  })
})

describe("the offer to mark the checkout trusted", () => {
  const offer: TrustOffer = {
    checkout: "/work/shop",
    explanation: "Claude Code hasn't been trusted in /work/shop.",
    file: "/home/me/.claude.json",
    key: "projects./work/shop.hasTrustDialogAccepted",
  }

  test("names the checkout, why, and what it would set where; no on Enter", async () => {
    const { answers, output } = await answer("\n", (form) => form.trust(offer))
    expect(answers).toBe(false)
    expect(output).toBe(
      `${offer.explanation} tutti would set ${offer.key} in ${offer.file}, as Claude Code suggests.\nMark /work/shop trusted? [y/N] \n`,
    )
  })

  test("yes marks it", async () => {
    expect((await answer("y\n", (form) => form.trust(offer))).answers).toBe(true)
  })
})

describe("init's requires steps, where the files can't be read", () => {
  const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-form-")))

  const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

  const jq: Requirement = { name: "jq", check: "command -v jq", install: "brew install jq" }

  /** A project whose .tutti/settings.json is `settings`, as written. */
  const withSettings = (settings: string) => {
    const repo = folder()
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(join(repo, ".tutti", "settings.json"), settings)
    return repo
  }

  test("README.md that can't be read is a caution, saying why, and nothing is written", async () => {
    const repo = folder()
    // A folder named README.md: there, but not a file to read.
    mkdirSync(join(repo, "README.md"))
    const steps = await run(readmeSteps(repo, [jq]))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: "caution", label: "README" })
    expect(steps[0]?.detail).toStartWith("cannot read README.md: ")
    expect(steps[0]?.detail.length).toBeGreaterThan("cannot read README.md: ".length)
    expect(steps[0]).not.toHaveProperty("commit")
  })

  test("settings that don't parse are a missing step, nothing checked", async () => {
    const steps = await run(requiresSteps(withSettings("{ not json")))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: "missing", label: "requires" })
    expect(steps[0]?.detail).not.toBe("")
  })

  test("settings with problems are a missing step for each, its path first", async () => {
    const steps = await run(
      requiresSteps(
        withSettings(
          JSON.stringify({ requires: [{ name: 1, check: "true", install: "" }], concurrent: "x" }),
        ),
      ),
    )
    expect(steps.length).toBeGreaterThanOrEqual(2)
    for (const each of steps) expect(each).toMatchObject({ kind: "missing", label: "requires" })
    expect(steps.some((each) => each.detail.startsWith("requires[0].name: "))).toBe(true)
    expect(steps.some((each) => each.detail.startsWith("concurrent: "))).toBe(true)
  })
})
