// The reason of a check that can't be run (tutti-esc3): a script that prints `SUITE: check` and
// then exits 127 as a command in it is missing, under set -e, gives the shell's line as its reason,
// not its SUITE: line. The reason is the last line in which a shell says it could not find or
// execute a command, else the first line that isn't a SUITE:, PROGRESS: or FLAKY: line.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import { defaultSettings } from "../src/run/resolveConfig.ts"
import { CheckNotRun, CheckOutput, Checks, resultOf } from "../src/services/Checks.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"

const check = "scripts/check-fast.sh"

/** The CheckNotRun `exit` failed with. */
const notRunOf = <A, E>(exit: Exit.Exit<A, E>): CheckNotRun => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined || !(error.error instanceof CheckNotRun)) {
    throw new Error(`expected CheckNotRun, got ${exit.cause}`)
  }
  return error.error
}

/** The reason resultOf gives for a check that exited with 127, having printed `printed`. */
const reasonOf = (printed: string): string => {
  const output = new CheckOutput()
  output.write(new TextEncoder().encode(printed))
  return notRunOf(Effect.runSync(Effect.exit(resultOf("fast", check, 127, output, "/dev/fd/9"))))
    .reason
}

describe("the reason of a check that could not be run", () => {
  test("is the shell's line after a SUITE: line, not the SUITE: line (dash)", () => {
    const dash = "scripts/check-fast.sh: 30: scripts/check-own.sh: not found"
    expect(reasonOf(`SUITE: check\n${dash}\n`)).toBe(dash)
  })

  test("skips PROGRESS: and FLAKY: lines too", () => {
    expect(reasonOf("PROGRESS: 1/2\nFLAKY: a.test.ts x\nSUITE: test\nsomething else\n")).toBe(
      "something else",
    )
  })

  test("is the last line in which a shell says it couldn't run a command", () => {
    const lines = [
      "check-fast: TUTTI_CHECK_WHOLE=1: running scripts/check.sh whole",
      "bash: tsc: command not found",
      "scripts/check-fast.sh: line 26: scripts/check.sh: Permission denied",
      "",
    ]
    expect(reasonOf(lines.join("\n"))).toBe(lines[2] ?? "")
  })

  for (const said of [
    "sh: 1: ./check.sh: not found",
    "bash: tsc: command not found",
    "sh: scripts/check-fast.sh: No such file or directory",
    "sh: ./check.sh: Permission denied",
    "sh: ./scripts: Is a directory",
    "bash: ./check.sh: cannot execute: required file not found",
    "bash: ./check: cannot execute binary file: Exec format error",
  ]) {
    test(`takes the shell's '${said}' over the line before`, () => {
      expect(reasonOf(`starting\n${said}\n`)).toBe(said)
    })
  }

  test("is the first line that isn't a marker line where no shell says so", () => {
    expect(reasonOf("SUITE: check\n  first said  \nsecond\n")).toBe("first said")
  })

  test("is never a SUITE:, PROGRESS: or FLAKY: line", () => {
    const marker = fc
      .tuple(fc.constantFrom("SUITE:", "PROGRESS:", "FLAKY:"), fc.string({ maxLength: 40 }))
      .map(([prefix, rest]) => `${prefix}${rest.replace(/[\r\n]/g, "")}`)
    const plain = fc
      .string({ minLength: 1, maxLength: 40 })
      .map((text) => `x${text.replace(/[\r\n]/g, "")}`)
    fc.assert(
      fc.property(fc.array(fc.oneof(marker, plain), { maxLength: 12 }), (lines) => {
        const reason = reasonOf(`${lines.join("\n")}\n`)
        const plainLines = lines.filter((line) => line.startsWith("x"))
        if (plainLines.length === 0) expect(reason).toBe("it exited with 127, printing nothing")
        else expect(reason.startsWith("x")).toBe(true)
      }),
    )
  })
})

describe("the live layer", () => {
  // Ending on the missing command, as dash's set -e exits with its 127 too: macOS's sh, bash 3.2,
  // exits 1 under set -e.
  test("a script that prints SUITE: and then ends on a missing command", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tutti-check-not-run-reason-"))
    writeFileSync(
      join(cwd, "check.sh"),
      "#!/bin/sh\nprintf '%s\\n' 'SUITE: check'\n./check-own-tutti-missing.sh\n",
      { mode: 0o755 },
    )
    const { checks } = defaultSettings
    const settings = {
      ...defaultSettings,
      checks: { ...checks, fast: { command: "./check.sh", timeout: Duration.seconds(10) } },
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          Effect.gen(function* () {
            return yield* (yield* Checks).fast({ cwd, outputFile: join(cwd, "check.log") })
          }),
          Checks.layer.pipe(
            Layer.provide(TestAppConfig.layer(TestAppConfig.appConfig({ settings }))),
            Layer.provideMerge(BunServices.layer),
          ),
        ),
      ),
    )
    const { reason } = notRunOf(exit)
    expect(reason).toContain("check-own-tutti-missing.sh")
    expect(reason).not.toContain("SUITE:")
  })
})
