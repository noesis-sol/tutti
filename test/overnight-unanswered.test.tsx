// What an overnight run asks before it starts, with nobody there to answer (tutti-epza.17;
// src/run/answerLimit.ts): the pre-flight's fixes and its start-anyway question, and the open
// questions, each waiting its time limit, then taking its default, said and logged, those after it
// not asked; the countdown of the line forms and of the answer form in the renderer.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer, Option } from "effect"
import { noServersNote } from "../src/agent/mcp.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { makePrinter } from "../src/print/organLine.ts"
import { answerLimit, clockOf, countdownText, leavesOpen } from "../src/run/answerLimit.ts"
import { unknownKernel } from "../src/run/load.ts"
import { type Ask, type Cleared, type Night, preflight } from "../src/run/overnight.ts"
import { type Put, putQuestions } from "../src/run/overnightQuestions.ts"
import { gb } from "../src/run/processes.ts"
import type { Started } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestChecks from "../src/testing/Checks.ts"
import * as TestGit from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as probeLayer } from "../src/testing/UsageProbe.ts"
import * as TestWorktrees from "../src/testing/Worktrees.ts"
import { OpenQuestionForm } from "../src/ui/OpenQuestion.tsx"
import { confirm, type LineIO, openQuestion, streamInput } from "../src/ui/plain/forms.ts"
import type { OpenQuestion, Reply } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { idleFrame, withRender } from "./render.ts"

const theme = makeTheme(orchestra, {
  appearance: "dark",
  depth: "256",
  noColor: true,
  styled: false,
})

/** The limit the tests wait: short, as nobody answers. */
const limit = Duration.millis(30)

// ---------------------------------------------------------------------------------------------
// The pre-flight.

/** A configuration that passes every check but those `overrides` change. */
const goodConfig = (repo: string, overrides: Partial<AppConfigValue> = {}): AppConfigValue => {
  const base = TestAppConfig.appConfig({}, repo)
  return {
    ...base,
    overnight: true,
    keepAwake: true,
    autoAnswer: Duration.zero,
    settings: {
      ...base.settings,
      concurrent: 2,
      workers: { ...base.settings.workers, ticket_limit: Duration.hours(2) },
    },
    ...overrides,
  }
}

const startedOf = (config: AppConfigValue): Started => ({
  config,
  base: "main",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  account: {
    ...TestAccount.accountProbe(config),
    permissionMode: {
      requested: config.settings.workers.permission_mode,
      inEffect: config.settings.workers.permission_mode,
    },
  },
  organs: { _tag: "AgentSdk" },
  warnings: [],
})

/** A machine with nothing to warn of. */
const quietNight: Night = {
  platform: "darwin",
  cores: 16,
  awake: { _tag: "Command", command: { command: "caffeinate", args: ["-i"] } },
  battery: null,
  kernel: Effect.succeed({ ...unknownKernel, cores: 10, load1: 1, pressure: "normal" }),
  processes: Effect.succeed([]),
  disk: () => Effect.succeed({ free: 100 * gb, where: "/work" }),
  otherRuns: Effect.succeed([]),
  // No user settings file: its ask rules are none.
  claudeSettings: "/nonexistent/.claude/settings.json",
  probeAccount: (config) =>
    Effect.succeed({
      ...TestAccount.accountProbe(config),
      permissionMode: {
        requested: config.settings.workers.permission_mode,
        inEffect: config.settings.workers.permission_mode,
      },
    }),
}

/**
 * The pre-flight of `config`, its questions asked in a terminal: `answers` answered in order, then
 * nothing, the asker waiting for ever. How it ended, what it asked and with what limit, and what it
 * printed and logged.
 */
const runPreflight = async (
  config: AppConfigValue,
  options: { readonly answers?: ReadonlyArray<boolean>; readonly failingBase?: boolean } = {},
) => {
  const printed: Array<string> = []
  const asked: Array<readonly [string, boolean, Duration.Duration]> = []
  const left = [...(options.answers ?? [])]
  const ask: Ask = (question, initial, given) =>
    Effect.suspend(() => {
      asked.push([question, initial, given])
      const answer = left.shift()
      return answer === undefined ? Effect.never : Effect.succeed(answer)
    })
  const printer = makePrinter(
    { write: (text) => printed.push(text), columns: () => 400, tty: false },
    theme,
  )
  const fast = options.failingBase === true ? [{ exitCode: 1, output: "FAIL a test\n" }] : []
  const layers = Layer.mergeAll(
    TestBeads.layer([{ id: "tut-1", title: "Ready work" }]),
    probeLayer([]),
    TestGit.layer({ dir: config.repo }),
    TestWorktrees.layer(),
    TestChecks.layer({ fast }, []),
  ).pipe(
    Layer.provideMerge(logLayer()),
    Layer.provideMerge(TestAppConfig.layer(config)),
    Layer.provideMerge(BunServices.layer),
  )
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const cleared: Cleared = yield* preflight({
        started: startedOf(config),
        night: quietNight,
        say: { ...printer, theme },
        ask: Option.some(ask),
        puts: true,
        force: false,
        limit,
      })
      return { cleared, logged: yield* texts }
    }).pipe(Effect.provide(layers)),
  )
  return { ...outcome, asked, printed: printed.join("").split("\n") }
}

const project = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-unanswered-")))

/** One ticket at a time and a ticket limit: two failed checks, each with its fix. */
const twoFixes = (repo: string) => {
  const config = goodConfig(repo, { limit: 5 })
  return { ...config, settings: { ...config.settings, concurrent: 1 } }
}

describe("an overnight pre-flight nobody answers", () => {
  test("waits five minutes for each answer by default", () => {
    expect(Duration.toMillis(answerLimit)).toBe(5 * 60 * 1000)
  })

  test("takes the first fix once its time runs out, and the rest without asking", async () => {
    const { cleared, asked, printed, logged } = await runPreflight(twoFixes(project()))
    // Asked once, with the limit, which its countdown says.
    expect(asked).toEqual([["Run without a limit?", true, limit]])
    if (cleared._tag !== "Cleared") throw new Error(`expected the run cleared, got ${cleared._tag}`)
    expect(cleared.unanswered).toBe(true)
    expect(cleared.started.config.limit).toBeNull()
    expect(cleared.started.config.settings.concurrent).toBe(4)
    const unanswered = 'overnight pre-flight: no answer in 30ms to "Run without a limit?": yes'
    const notAsked =
      'overnight pre-flight: not asked, as nobody answered: "Run 4 tickets at a time?": yes'
    expect(printed).toContain(`◆ ${unanswered}`)
    expect(printed).toContain(`◆ ${notAsked}`)
    expect(logged).toContain(unanswered)
    expect(logged).toContain(notAsked)
    expect(logged).toContain("overnight pre-flight: fixed: the run has no ticket limit")
  })

  test("doesn't start the run anyway: a failed check without a fix refuses it", async () => {
    const repo = project()
    const { cleared, asked, logged } = await runPreflight(goodConfig(repo, { limit: 5 }), {
      failingBase: true,
    })
    expect(asked).toEqual([["Run without a limit?", true, limit]])
    expect(cleared).toEqual({ _tag: "Refused", failed: 1 })
    expect(logged).toContain(
      'overnight pre-flight: not asked, as nobody answered: "Start the run anyway, with 1 check failed?": no',
    )
    expect(logged.at(-1)).toBe("overnight pre-flight: 1 check failed: the run doesn't start")
  })

  test("the start-anyway question unanswered takes no", async () => {
    const repo = project()
    const { cleared, asked, logged } = await runPreflight(goodConfig(repo, { limit: 5 }), {
      answers: [false],
    })
    expect(asked.map(([question]) => question)).toEqual([
      "Run without a limit?",
      "Start the run anyway, with 1 check failed?",
    ])
    expect(cleared).toEqual({ _tag: "Refused", failed: 1 })
    expect(logged).toContain(
      'overnight pre-flight: no answer in 30ms to "Start the run anyway, with 1 check failed?": no',
    )
  })

  test("answered in time, nothing is taken for it", async () => {
    const { cleared, logged } = await runPreflight(twoFixes(project()), { answers: [true, true] })
    if (cleared._tag !== "Cleared") throw new Error(`expected the run cleared, got ${cleared._tag}`)
    expect(cleared.unanswered).toBe(false)
    expect(logged.some((line) => line.includes("no answer in"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// The open questions.

const question = (id: string, title: string, waiting: ReadonlyArray<string>): OpenQuestion => ({
  id: id as never,
  title,
  description: "",
  options: [],
  maintainerOnly: false,
  waiting: waiting as never,
})

const questions = [question("q-1", "Which flag?", ["tut-1"]), question("q-2", "Which colour?", [])]

/** Puts `questions` with `replies` in order, then waits for ever: what it put, said and logged. */
const putWithin = async (replies: ReadonlyArray<Reply>) => {
  const printed: Array<string> = []
  const putTo: Array<readonly [string, Duration.Duration]> = []
  const left = [...replies]
  const put: Put = (asked, _at, given) =>
    Effect.suspend(() => {
      putTo.push([asked.id, given])
      const reply = left.shift()
      return reply === undefined ? Effect.never : Effect.succeed(reply)
    })
  const printer = makePrinter(
    { write: (text) => printed.push(text), columns: () => 400, tty: false },
    theme,
  )
  const { putting, logged } = await Effect.runPromise(
    Effect.gen(function* () {
      const putting = yield* putQuestions({
        questions,
        put: Option.some(put),
        say: { ...printer, theme },
        limit,
      })
      return { putting, logged: yield* texts }
    }).pipe(Effect.provide(Layer.mergeAll(TestBeads.layer([]), logLayer()))),
  )
  return { putting, logged, putTo, printed: printed.join("").split("\n") }
}

describe("open questions nobody answers", () => {
  test("leave the first open once its time runs out, and the rest without putting them", async () => {
    const { putting, putTo, printed, logged } = await putWithin([])
    expect(putTo).toEqual([["q-1", limit]])
    expect(putting).toEqual({ _tag: "Done", answered: 0, left: 2 })
    const unanswered = "overnight pre-flight: no answer in 30ms to q-1 (Which flag?): left open"
    const notPut =
      "overnight pre-flight: not asked, as nobody answered: q-2 (Which colour?): left open"
    expect(printed).toContain(`◆ ${unanswered}`)
    expect(logged).toContain(unanswered)
    expect(logged).toContain(notPut)
    // Listed in the checklist of those left open, and the log, as without a terminal.
    expect(printed).toContain("◆ Overnight pre-flight: 2 questions left open")
    expect(logged).toContain(
      "overnight pre-flight: left open: q-1 (Which flag?): tut-1 waits on it",
    )
    expect(logged).toContain(
      "overnight pre-flight: left open: q-2 (Which colour?): no ticket waits on it",
    )
  })

  test("one left open in time doesn't stop the next being put", async () => {
    const { putting, putTo } = await putWithin([{ _tag: "LeaveOpen" }])
    expect(putTo.map(([id]) => id)).toEqual(["q-1", "q-2"])
    expect(putting).toEqual({ _tag: "Done", answered: 0, left: 2 })
  })
})

// ---------------------------------------------------------------------------------------------
// The countdowns.

describe("the countdown", () => {
  test("says the time left in minutes and seconds, rounded up, and what no answer takes", () => {
    expect(clockOf(5 * 60 * 1000)).toBe("5:00")
    expect(clockOf(59_001)).toBe("1:00")
    expect(clockOf(9_500)).toBe("0:10")
    expect(clockOf(-20)).toBe("0:00")
    expect(countdownText(299_400, "takes yes")).toBe("No answer in 5:00 takes yes.")
    expect(countdownText(61_000, leavesOpen)).toBe("No answer in 1:01 leaves it open.")
  })
})

/** Runs `form` on a stream nobody types in, with `live`, until `stop` ends it: what it wrote. */
const unansweredLines = async <A, E>(
  form: (io: LineIO) => Effect.Effect<A, E>,
  options: { readonly live: boolean; readonly wait: number },
) => {
  const stream = new PassThrough()
  let output = ""
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const io: LineIO = {
          input: yield* streamInput(stream),
          write: (text) => {
            output += text
          },
          theme,
          ...(options.live ? { live: { columns: () => 80 } } : {}),
        }
        const fiber = yield* Effect.forkChild(form(io))
        yield* Effect.sleep(Duration.millis(options.wait))
        yield* Fiber.interrupt(fiber)
      }),
    ),
  )
  return output
}

describe("a line form with a time limit", () => {
  test("says above its prompt what no answer takes, and ends the line once stopped", async () => {
    const output = await unansweredLines(
      (io) => confirm(io, { question: "Run without a limit?", initial: true, limit: answerLimit }),
      { live: false, wait: 20 },
    )
    expect(output).toBe("No answer in 5:00 takes yes.\nRun without a limit? [Y/n] \n")
  })

  test("in a live terminal, draws its countdown again over the line above the prompt", async () => {
    const output = await unansweredLines(
      (io) => confirm(io, { question: "Go?", limit: answerLimit }),
      { live: true, wait: 1_300 },
    )
    const [first, again] = output.split("Go? [y/N] ")
    expect(first).toBe("No answer in 5:00 takes no.\n")
    // Saved, up a line, cleared, drawn, and back where the answer is typed.
    expect(again).toBe("\x1b7\x1b[1A\r\x1b[2KNo answer in 4:59 takes no.\x1b8\n")
  })

  test("of an open question, says that no answer leaves it open", async () => {
    const output = await unansweredLines(
      (io) => openQuestion(io, questions[0] as OpenQuestion, { index: 0, of: 2 }, answerLimit),
      { live: false, wait: 20 },
    )
    expect(output).toContain("No answer in 5:00 leaves it open.\nEnter a number between 1 and 2 > ")
  })

  test("answered, it is the answer, as without one", async () => {
    const stream = new PassThrough()
    stream.write("n\n")
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const io: LineIO = { input: yield* streamInput(stream), write: () => {}, theme }
          return yield* confirm(io, { question: "Go?", initial: true, limit: answerLimit })
        }),
      ),
    )
    expect(exit).toEqual(Exit.succeed(false))
  })
})

describe("an open question in the renderer with a time limit", () => {
  test("counts down under its choices to leaving it open", async () => {
    let now = 1_000_000
    const node = (
      <OpenQuestionForm
        theme={theme}
        question={questions[0] as OpenQuestion}
        at={{ index: 0, of: 2 }}
        limit={answerLimit}
        clock={() => now}
        answer={() => {}}
        cancel={() => {}}
      />
    )
    await withRender(node, { width: 100, height: 24 }, async (rendered) => {
      expect(await idleFrame(rendered.setup)).toContain("No answer in 5:00 leaves it open.")
      now += 61_000
      // The countdown's ticker, each second, draws it again.
      await rendered.input(() => Bun.sleep(1_200))
      expect(await idleFrame(rendered.setup)).toContain("No answer in 3:59 leaves it open.")
    })
  })

  test("says nothing of one without a limit", async () => {
    const node = (
      <OpenQuestionForm
        theme={theme}
        question={questions[0] as OpenQuestion}
        at={{ index: 0, of: 2 }}
        answer={() => {}}
        cancel={() => {}}
      />
    )
    await withRender(node, { width: 100, height: 24 }, async (rendered) => {
      expect(await idleFrame(rendered.setup)).not.toContain("No answer in")
    })
  })
})
