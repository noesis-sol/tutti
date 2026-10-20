import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Queue } from "effect"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { Organs } from "../src/organs/Organs.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { type QuitRequest, quitBy } from "../src/run/quit.ts"
import { finish, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { defers } from "../src/testing/AgentHost.ts"
import { type Answers, layer as cannedLayer } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { backlog, type Ran, scenario } from "./harness.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-lazy-${name}-`)))

const report = "The run ended with nothing left to do.\n"

interface Plan {
  /** The organs' answers: the run has organs only when given. */
  readonly organs?: Answers
  readonly styled: boolean
  /** Ctrl+C before the run's first look: the run is quit. */
  readonly quit?: boolean
}

interface Made {
  /** How many times `finish` made its out, as a plain run asks the terminal its background. */
  readonly made: number
  readonly printed: string
}

/** A run of one ticket its worker defers, then `finish` on an out that counts its making. */
const finishes = (plan: Plan): Promise<Ran<Made>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const printed: Array<string> = []
  const out: Out = { write: (text) => printed.push(text), columns: () => 100, tty: false }
  let made = 0
  const ran = Effect.gen(function* () {
    const git = yield* Git
    yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
    const quits = yield* Queue.unbounded<QuitRequest>()
    if (plan.quit) yield* Queue.offer(quits, quitBy("SIGINT"))
    const outcome = yield* run({ version: "0.1.0-test", base: "main", quits, endLater: true })
    const making = Effect.sync(() => {
      made += 1
      return { printer: makePrinter(out, theme), theme, width: 100 }
    })
    yield* finish(outcome, making, plan.styled)
    return { made, printed: Bun.stripANSI(printed.join("")) }
  })
  return scenario(
    {
      config: { repo },
      git: { dir: repo },
      worktrees: { root },
      backlog: backlog().ticket("t-1").seeds,
      scripts: (world) => ({
        "t-1": [
          defers("t-1", {
            claim: Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
            defer: Effect.asVoid(Effect.orDie(world.beads.defer("t-1"))),
          }),
        ],
      }),
    },
    plan.organs === undefined
      ? ran
      : ran.pipe(
          Effect.provide(
            Layer.mergeAll(Organs.layer, OrganCost.layer).pipe(
              Layer.provide(cannedLayer(plan.organs)),
            ),
          ),
        ),
  )
}

const finished = (ran: Ran<Made>): Made => {
  if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
  return ran.exit.value
}

const organs: Answers = {
  reviewer: { report },
  triage: { cause: "problem", confidence: "medium", summary: "Needs a simulator." },
}

describe("finish makes the report's out only when something prints on it", () => {
  test("plain, without organs, it is never made", async () => {
    const { made, printed } = finished(await finishes({ styled: false }))
    expect(made).toBe(0)
    expect(printed).toBe("")
  })

  test("plain, a run that was quit makes none, as its report is skipped", async () => {
    const { made, printed } = finished(await finishes({ organs, styled: false, quit: true }))
    expect(made).toBe(0)
    expect(printed).toBe("")
  })

  test("plain, with organs, it is made once, for the report", async () => {
    const { made, printed } = finished(await finishes({ organs, styled: false }))
    expect(made).toBe(1)
    expect(printed).toStartWith("◆ Run report written")
  })

  test("styled, it is made once, for the summary and the report both", async () => {
    const { made, printed } = finished(await finishes({ organs, styled: true }))
    expect(made).toBe(1)
    expect(printed).toContain("♪ Completed the Run")
    expect(printed).toContain("◆ Run report written")
  })

  test("styled, without organs, it is made once, for the summary", async () => {
    const { made } = finished(await finishes({ styled: true }))
    expect(made).toBe(1)
  })
})
