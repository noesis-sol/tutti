// A failed full check's last 40 lines, in the log, the reviewer's evidence and the run report after
// the reviewer's text, as orchestra's; and the FLAKY warnings of a full check that passed.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer } from "effect"
import fc from "fast-check"
import { lexer, type Tokens } from "marked"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { Organs } from "../src/organs/Organs.ts"
import { makePrinter } from "../src/print/organLine.ts"
import {
  type FullChecked,
  fullCheckEnd,
  fullCheckEvidence,
  fullCheckReport,
} from "../src/run/fullcheck.ts"
import type { Line } from "../src/run/log.ts"
import { reportsDir } from "../src/run/report.ts"
import { finish, run } from "../src/run/run.ts"
import { CheckFailed, CheckOutput } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import {
  type CheckRun,
  type Script as ChecksScript,
  passed,
  type Scripted,
} from "../src/testing/Checks.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { backlog, expectLog, type Ran, scenario, type World } from "./harness.ts"

const fullCommand = "scripts/check-full.sh"
const setupCommand = "bun install"
const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
const reviewerText = "The run merged t-1; the full check failed.\n"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-fullcheck-end-${name}-`)))

/** The settings with a full check, and a setup when `setup` is set. */
const config = (setup = false): Partial<AppConfigValue> => {
  const { settings } = appConfig()
  return {
    settings: {
      ...settings,
      checks: {
        ...settings.checks,
        full: { command: fullCommand, timeout: Duration.minutes(60) },
        setup: { ...settings.checks.setup, command: setup ? setupCommand : null },
      },
    },
  }
}

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: string) =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** What a whole run gave: the reviewer's input and the report it saved. */
interface Reviewed {
  readonly input: string
  readonly report: string
}

/** A whole run on main in which t-1 merges, then its report, written by a canned reviewer. */
const reviewed = async (checks: ChecksScript, setup = false): Promise<Ran<Reviewed>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const calls: Array<OrganCallRecord> = []
  const organs = Organs.layer.pipe(
    Layer.provideMerge(cannedLayer({ reviewer: { report: reviewerText } }, calls)),
  )
  return scenario(
    {
      config: { ...config(setup), repo },
      git: { dir: repo },
      worktrees: { root },
      backlog: backlog().ticket("t-1").seeds,
      checks,
      scripts: (world) => ({ "t-1": [finishes(world, root, "t-1")] }),
    },
    Effect.gen(function* () {
      const git = yield* Git
      yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
      const running = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", endLater: true }),
      )
      const outcome = yield* Fiber.join(running)
      const out = { write: () => {}, columns: () => 100, tty: false }
      yield* finish(
        outcome,
        Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }),
        false,
      )
      const input = calls.find((each) => each.call.organ === "reviewer")?.input ?? ""
      const dir = join(repo, reportsDir)
      const [name] = existsSync(dir) ? readdirSync(dir) : []
      const report = name === undefined ? "" : readFileSync(join(dir, name), "utf8")
      return { input, report }
    }).pipe(Effect.provide(organs)),
  )
}

const gotten = <A>(ran: Ran<A>): A => {
  if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
  return ran.exit.value
}

/** The body of the reviewer's section titled `title`, or undefined when it has none. */
const sectionOf = (input: string, title: string): string | undefined => {
  const at = input.indexOf(`## ${title}\n\n`)
  if (at === -1) return undefined
  const body = input.slice(at).split("\n").slice(3).join("\n")
  return body.slice(0, body.indexOf("\n</evidence id="))
}

/** What the check's output says, as Checks takes it from the output as it is printed. */
const saidOf = (output: string) => {
  const taken = new CheckOutput()
  taken.write(new TextEncoder().encode(output))
  taken.end()
  return taken.summary()
}

/** A full check, or the setup before it, that prints `output` to its file and fails. */
const fails =
  (check: "full" | "setup", output: string): Scripted =>
  (ran: CheckRun) =>
    Effect.suspend(() => {
      if (ran.outputFd !== undefined) writeSync(ran.outputFd, output)
      return Effect.fail(
        new CheckFailed({
          check,
          command: check === "full" ? fullCommand : setupCommand,
          exitCode: 1,
          outputFile: ran.outputFile,
          ...saidOf(output),
        }),
      )
    })

/** 60 lines of a suite's output, the last saying what failed. */
const lines = [
  "SUITE: e2e",
  ...Array.from({ length: 58 }, (_, i) => `step ${i + 1}`),
  "FAIL: it broke",
]
const output = `${lines.join("\n")}\n`
const end = lines.slice(-fullCheckEnd)

describe("a failed full check's last 40 lines", () => {
  test("are in the log under its line, the reviewer's section, and the report after the reviewer's text", async () => {
    const ran = await reviewed({ full: [fails("full", output)] })
    const { input, report } = gotten(ran)

    const at = ran.log.findIndex((each) => each.startsWith("  FULL_CHECK_FAILED: "))
    expect(at).toBeGreaterThan(-1)
    expect(ran.log.slice(at + 1, at + 2 + fullCheckEnd)).toEqual([
      "  the end of its output:",
      ...end.map((each) => `    ${each}`),
    ])
    expect(ran.log).not.toContain("    step 19")

    const evidence = sectionOf(input, "The full check") ?? ""
    expect(evidence).toMatch(/^ *FULL_CHECK_FAILED: 'scripts\/check-full\.sh' fails on main at /)
    expect(evidence).toEndWith(`\nThe end of its output:\n${end.join("\n")}`)

    expect(report).toContain(`${reviewerText}\n## Full check\n\n`)
    expect(report).toMatch(
      /\n## Full check\n\n`scripts\/check-full\.sh` failed in the suite e2e; filed \S+\. The whole output is in `.*\/\.tutti\/run\/check-full\.log`\. Its end:\n\n```\n/,
    )
    expect(report).toContain(`\`\`\`\n${end.join("\n")}\n\`\`\`\n`)
    expect(report).not.toContain("step 19\n")
  })

  test("of the setup before it: the report says the check did not run", async () => {
    // The setup in the ticket's new worktree passes; the one before the full check fails.
    const ran = await reviewed(
      { setup: [passed("setup"), fails("setup", "resolving\nerror: no left-pad\n")] },
      true,
    )
    const { input, report } = gotten(ran)
    expectLog(ran, [
      /^ {2}FULL_CHECK_FAILED: the setup 'bun install', run before /,
      "  the end of its output:",
      "    resolving",
      "    error: no left-pad",
    ])
    expect(sectionOf(input, "The full check")).toEndWith(
      "\nThe end of its output:\nresolving\nerror: no left-pad",
    )
    expect(report).toMatch(
      /\n## Full check\n\n`scripts\/check-full\.sh` did not run: the setup before it, `bun install`, failed; no ticket filed: it is not a suite's failure\. The whole output is in `[^`]+`\. Its end:\n\n```\nresolving\nerror: no left-pad\n```\n/,
    )
    // The check records (§ 10): the setup in the ticket's worktree, then the full check's.
    expect(
      ran.events.flatMap((r) => (r.kind === "check" ? [[r.suite, r.ticket, r.result]] : [])),
    ).toEqual([
      ["setup", "t-1", "passed"],
      ["setup", undefined, "failed"],
    ])
  })

  test("a full check that passed has no end in the log, the reviewer's section or the report", async () => {
    const ran = await reviewed({})
    const { input, report } = gotten(ran)
    expect(ran.log).not.toContain("  the end of its output:")
    expect(sectionOf(input, "The full check")).toMatch(/^ *FULL_CHECK passed: [^\n]*$/)
    expect(report).toStartWith("# tutti run · ")
    expect(report).not.toContain("## Full check")
    // The full check's record has no ticket (§ 10).
    expect(ran.events.filter((r) => r.kind === "check").at(-1)).toMatchObject({
      suite: "full",
      result: "passed",
    })
    expect(ran.events.filter((r) => r.kind === "check").at(-1)).not.toHaveProperty("ticket")
  })
})

describe("a full check that passed with flaky tests", () => {
  test("warns of each in the log and the event stream, and counts those it doesn't name", async () => {
    const ran = await reviewed({
      full: [passed("full", { flaky: ["a.test.ts > retries", ""], flakyCount: 5 })],
    })
    const warned = [
      "  FLAKY: the full check 'scripts/check-full.sh' passed, but a test failed and then passed on a rerun: a.test.ts > retries",
      "  FLAKY: the full check 'scripts/check-full.sh' passed, but a test failed and then passed on a rerun: it doesn't say which",
      "  FLAKY: the full check 'scripts/check-full.sh' passed, but 3 more tests failed and then passed on a rerun",
    ]
    expectLog(ran, [/^ {2}FULL_CHECK passed: /, ...warned])
    const warnings = ran.events.flatMap((record) => (record.kind === "warn" ? [record.text] : []))
    expect(warnings).toEqual(warned)
  })
})

/** A full check that failed in `suite`, its output ending with `end`. */
const failedWith = (end: ReadonlyArray<string>, suite = "e2e"): FullChecked => ({
  outcome: "failed",
  at: "abcdef0123",
  took: 1000,
  suite,
  output: "/repo/.tutti/run/check-full.log",
  end,
  ticket: "t-9",
  filed: "filed t-9",
  text: "  FULL_CHECK_FAILED: …" as Line,
})

/** The code blocks Markdown reads in `text`. */
const codeBlocks = (text: string): ReadonlyArray<string> =>
  lexer(text)
    .filter((token): token is Tokens.Code => token.type === "code")
    .map((token) => token.text)

describe("what the report says of the full check", () => {
  test("nothing for one that passed, was skipped or could not run", () => {
    for (const outcome of ["passed", "skipped", "not run"] as const) {
      const checked: FullChecked = { ...failedWith([]), outcome }
      expect(fullCheckReport(checked, fullCommand)).toBe("")
      expect(fullCheckEvidence(checked)).toBe(checked.text)
    }
  })

  test("of one that printed nothing, that it printed nothing; one that timed out says so", () => {
    expect(fullCheckReport(failedWith([]), fullCommand)).toBe(
      "\n## Full check\n\n`scripts/check-full.sh` failed in the suite e2e; filed t-9. " +
        "The whole output is in `/repo/.tutti/run/check-full.log`. It printed nothing.\n",
    )
    expect(fullCheckEvidence(failedWith([]))).toBe("  FULL_CHECK_FAILED: …")
    const timedOut: FullChecked = { ...failedWith(["…"]), outcome: "timed out" }
    expect(fullCheckReport(timedOut, fullCommand)).toContain("` timed out in the suite e2e;")
  })

  test("escapes the suite, and no backtick in the output or the command closes its code", () => {
    const said = fullCheckReport(failedWith(["```", "a `` b"], "*e2e*"), "echo `x`")
    expect(said).toContain("\n## Full check\n\n`` echo `x` `` failed in the suite \\*e2e\\*;")
    expect(codeBlocks(said)).toEqual(["```\na `` b"])
  })

  test("any output's end is in the report's code block as it was printed, on its own lines", () => {
    const text = fc.string({ unit: "grapheme" }).filter((each) => !/[\n\r\t\p{Cc}]/u.test(each))
    fc.assert(
      fc.property(fc.array(text, { minLength: 1, maxLength: fullCheckEnd }), (end) => {
        const said = fullCheckReport(failedWith(end), fullCommand)
        expect(codeBlocks(said)).toEqual([end.join("\n")])
        expect(fullCheckEvidence(failedWith(end))).toEndWith(`\n${end.join("\n")}`)
      }),
    )
  })
})
