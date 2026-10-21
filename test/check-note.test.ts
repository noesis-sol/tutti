// The check note (§ 4.11): a worker's standing rules have it run a check once, its whole output kept
// in .tutti/run/ and its exit status printed, rather than again to see what it said. The example is
// the project's merge check (checks.fast.command) where it has one, and a placeholder where not.
import { describe, expect, test } from "bun:test"
import { workerOptions } from "../src/agent/options.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { checkNote, workerCheckLog } from "../src/project/prompt.ts"
import { appConfig } from "../src/testing/AppConfig.ts"

const prompt = { text: "You work on TICKET_ID.", file: null }

/** A config whose merge check is `command`. */
const configWith = (command: string | null): AppConfigValue => {
  const base = appConfig({}, "/work/project")
  const checks = base.settings.checks
  return {
    ...base,
    settings: { ...base.settings, checks: { ...checks, fast: { ...checks.fast, command } } },
  }
}

/** The standing rules a worker on `bd-7` is given when the merge check is `command`. */
const rules = (command: string | null): string => {
  const options = workerOptions({
    config: configWith(command),
    ticket: "bd-7",
    worktree: "/w",
    prompt,
    servers: { servers: [], note: null },
    callbacks: {
      canUseTool: async () => ({ behavior: "allow" }),
      onElicitation: async () => ({ action: "decline" }),
      hooks: {},
      stderr: () => {},
    },
    session: { _tag: "New", sessionId: "s" },
    env: {},
    abortController: new AbortController(),
  })
  const system = options.systemPrompt
  if (typeof system !== "object" || Array.isArray(system) || system.type !== "preset") {
    throw new Error("not a preset system prompt")
  }
  return system.append ?? ""
}

describe("the check note", () => {
  test("has the worker run a check once, its output saved and its exit status printed", () => {
    const note = checkNote("scripts/check-fast.sh")
    expect(note).toContain(
      "Run a check (tests, linters, a build) once, its whole output saved to a file in .tutti/run " +
        "(never committed) and its exit status printed, as in " +
        "'scripts/check-fast.sh > .tutti/run/worker-check.log 2>&1; echo \"exit $?\"'",
    )
    expect(note).toContain(
      "then read the file's end or search it, rather than running the check again to see its " +
        "output or whether it passed.",
    )
    expect(note).toContain("Piping a check through tail hides its exit status.")
  })

  test("saves to its own file, not check.log, which holds the run's own check", () => {
    expect(workerCheckLog).toBe(".tutti/run/worker-check.log")
  })

  test("names a placeholder where the project has no merge check", () => {
    expect(checkNote(null)).toContain(`as in '<the check> > ${workerCheckLog} 2>&1;`)
  })

  test("follows the worker prompt in a worker's standing rules, naming the merge check", () => {
    expect(rules("bun run check")).toBe(`You work on bd-7.${checkNote("bun run check")}`)
    expect(rules("bun run check")).toContain(`'bun run check > ${workerCheckLog} 2>&1;`)
    expect(rules(null)).toBe(`You work on bd-7.${checkNote(null)}`)
  })
})
