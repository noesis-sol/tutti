// The checks gate's form on real git (§ 4.14, src/run/gateForm.ts): tutti checks' step works in a
// worktree of the base's head of its own, under the run's lock; what it changed there is committed,
// `tutti: set the checks`, and the base fast-forwarded to it, so the main checkout stays clean. Esc
// there, or a step that changes nothing, leaves the checks as they are.
import { describe, expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer, SubscriptionRef } from "effect"
import { fastScript, fullScript } from "../src/init/runners.ts"
import { type GateAsk, gateFolderPrefix } from "../src/run/checksGate.ts"
import { keepQuestion, makeGateAsk, noScout, setChecksMessage } from "../src/run/gateForm.ts"
import { makeSetUps } from "../src/run/setup.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { layer as agentHostLayer } from "../src/testing/AgentHost.ts"
import { appConfig, layer as appConfigLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import type { Asking, FormShown, InitScreen } from "../src/ui/InitForm.tsx"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

const fast = "scripts/check-fast.sh"
const full = "scripts/check-full.sh"

/** A project a spec run set up: its settings and runners that check nothing, committed on main. */
const project = (): Repo => {
  const repo = makeRepo()
  repo.commit("tutti: set up for spec shop.md", {
    ".tutti/settings.json": `${JSON.stringify({ checks: { fast: { command: fast }, full: { command: full } } }, null, 2)}\n`,
    [fast]: fastScript([]),
    [full]: fullScript([], true),
  })
  return repo
}

/** The field the form asks next that isn't `after`, or null once `done` is. */
const nextField = (
  screen: { readonly get: () => InitScreen },
  after: Asking | null,
  done: Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000; i++) {
      if (yield* done) return null
      const asking = screen.get().asking
      if (asking !== null && asking !== after && asking._tag !== "Scout") return asking
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`the form asked nothing after ${after?._tag ?? "opening"}`)
  })

/**
 * Asks through the gate's form in `repo`, `ask` choosing what to ask, `answer` answering each field
 * it asks until it is done: what it gave, the fields asked, and the log.
 */
const throughForm = <A>(
  repo: Repo,
  ask: (gate: GateAsk) => Effect.Effect<A>,
  answer: (asking: Asking) => void,
) => {
  const config = appConfig({ repo: repo.dir, worktrees: `${repo.dir}-worktrees` }, repo.dir)
  const layers = Layer.mergeAll(
    Worktrees.layer({ repo: repo.dir, root: config.worktrees, base: "main" }),
    agentHostLayer({}),
    beadsLayer([]),
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(attentionLayer(), transcriptsLayer())),
    Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
    Layer.provideMerge(Git.layer()),
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(appConfigLayer(config)),
    Layer.provideMerge(BunServices.layer),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const slot = yield* SubscriptionRef.make<FormShown | null>(null)
      const gate = yield* makeGateAsk({
        slot,
        base: "main",
        version: "0.1.0-test",
        setUps: yield* makeSetUps,
        scout: noScout,
        machine: {
          run: () => Effect.fail("no commands here"),
          which: () => null,
          env: () => undefined,
          platform: process.platform,
          executable: () => false,
        },
      })
      let finished = false
      const asked = yield* Effect.forkChild(
        Effect.ensuring(
          ask(gate),
          Effect.sync(() => {
            finished = true
          }),
        ),
      )
      let shown: FormShown | null = null
      while (shown === null) {
        shown = yield* SubscriptionRef.get(slot)
        if (shown === null) yield* Effect.promise(() => Bun.sleep(2))
      }
      const fields: Array<string> = []
      const done = Effect.sync(() => finished)
      let last: Asking | null = null
      for (;;) {
        const next: Asking | null = yield* nextField(shown.screen, last, done)
        if (next === null) break
        fields.push(titleOf(next))
        answer(next)
        last = next
      }
      const gave = yield* Fiber.join(asked)
      return {
        gave,
        fields,
        log: yield* texts,
        closed: (yield* SubscriptionRef.get(slot)) === null,
      }
    }).pipe(Effect.provide(layers)),
  )
}

/** What a field asks: its question or its title. */
const titleOf = (asking: Asking): string =>
  asking._tag === "Confirm"
    ? asking.field.question
    : asking._tag === "Scout"
      ? "scout"
      : asking.field.title

/**
 * The form's answers: Manual checks, `command` the check command, Yes to replacing a runner and to
 * keeping the checks, Enter (keep) for the setup command.
 */
const manually =
  (command: string, keep = true) =>
  (asking: Asking) => {
    switch (asking._tag) {
      case "Select":
        return asking.answer(asking.field.options.indexOf("Manual"))
      case "Text":
        return asking.answer(asking.field.title === "Check command" ? command : "")
      case "Confirm":
        return asking.answer(asking.field.question === keepQuestion ? keep : true)
      default:
        throw new Error(`asked a ${asking._tag}`)
    }
  }

describe("the checks gate's form, a hold asked", () => {
  slow.test(
    "sets the checks in tutti checks' step, committed on main and main fast-forwarded",
    async () => {
      const repo = project()
      const before = repo.head()
      const done = await throughForm(
        repo,
        (gate) => gate.held(`${fast} checks nothing`),
        manually("bun test"),
      )
      expect(done.gave).toBe("set")
      expect(done.fields[0]).toBe("The project's checks")
      expect(done.closed).toBe(true)
      expect(repo.git(["log", "-1", "--format=%s", "main"]).trim()).toBe(setChecksMessage)
      expect(repo.git(["rev-parse", "main~1"]).trim()).toBe(before)
      expect(repo.git(["show", `main:${fast}`])).toContain("bun test")
      // The main checkout moved with main, and has nothing uncommitted.
      expect(repo.git(["status", "--porcelain"])).toBe("")
      expect(repo.git(["worktree", "list"]).includes(gateFolderPrefix)).toBe(false)
      expect(done.log).toContainEqual(
        expect.stringMatching(
          /^CHECKS_GATE: set the checks in tutti checks' form: committed on main as \w+ \(\d+ files?\); checking them again$/,
        ),
      )
    },
  )

  slow.test("Esc leaves the checks as they are: nothing committed", async () => {
    const repo = project()
    const before = repo.head()
    const done = await throughForm(
      repo,
      (gate) => gate.held(`${fast} checks nothing`),
      (asking) => asking.cancel(),
    )
    expect(done.gave).toBe("left")
    expect(done.closed).toBe(true)
    expect(repo.head()).toBe(before)
    expect(repo.git(["status", "--porcelain"])).toBe("")
  })
})

describe("the checks gate's form, the checks shown", () => {
  slow.test(
    "Enter keeps them; No opens tutti checks' step, whose change is committed",
    async () => {
      const repo = project()
      const before = repo.head()
      const runners = [{ name: fast, runs: ["bun test"] }]
      const kept = await throughForm(repo, (gate) => gate.shown(runners), manually("", true))
      expect(kept.gave).toBe("accepted")
      expect(kept.fields).toEqual([keepQuestion])
      expect(repo.head()).toBe(before)

      const changed = await throughForm(
        repo,
        (gate) => gate.shown(runners),
        manually("bun run lint", false),
      )
      expect(changed.gave).toBe("set")
      expect(changed.fields.slice(0, 2)).toEqual([keepQuestion, "The project's checks"])
      expect(repo.git(["show", `main:${fast}`])).toContain("bun run lint")
    },
  )
})
