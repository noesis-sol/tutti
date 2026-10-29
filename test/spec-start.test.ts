// What src/main.ts does with a spec run (§ 4.14) between the pieces it calls (src/run/specStart.ts):
// the setup read from the flags and their variables, its files committed with the spec, the run
// scoped to the root epic, which the lock then names, and an early start's breakdown that fails
// stopping the run with its exit code, or stopped itself once the run's end cuts it short.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Layer, Option, SubscriptionRef } from "effect"
import { breakdownWorker } from "../src/agent/breakdown.ts"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { AppConfig } from "../src/cli/AppConfig.ts"
import type { RunFlags } from "../src/cli/flags.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { scopedTo } from "../src/run/feature.ts"
import { exitCodes } from "../src/run/holds.ts"
import { settingUpLine } from "../src/run/specSetup.ts"
import { setUpFromFlags, setupFlags, specStart } from "../src/run/specStart.ts"
import type { TicketId } from "../src/services/Beads.ts"
import type { Holder } from "../src/services/RunLock.ts"
import {
  Recording,
  result,
  run,
  type Script,
  sessionState,
  tool,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  breakdownInit,
  type Calls,
  call,
  rootInput,
  specLayers,
  specOf,
  ticket,
} from "./specScenario.ts"

/** Run flags with `given` set, the rest not given. */
const flagsOf = (
  given: Partial<Record<"spec" | "prompt" | "concurrent", string>>,
): Pick<RunFlags, "spec" | "prompt" | "concurrent"> => ({
  spec: Option.fromNullishOr(given.spec),
  prompt: Option.fromNullishOr(given.prompt),
  concurrent: Option.fromNullishOr(given.concurrent),
})

/** An environment of `variables`. */
const envOf =
  (variables: Readonly<Record<string, string>> = {}) =>
  (name: string) =>
    variables[name]

describe("what a spec run's setup reads of the flags", () => {
  test("a flag over its variable, the spec trimmed and named by what gave it", () => {
    const env = envOf({ TUTTI_SPEC: "other.md", TUTTI_CONCURRENT: "2" })
    expect(setupFlags(flagsOf({ spec: " shop.md ", concurrent: "3" }), env)).toEqual({
      spec: { given: "shop.md", from: "--spec" },
      ownPrompt: false,
      concurrent: 3,
    })
    expect(setupFlags(flagsOf({}), env)).toEqual({
      spec: { given: "other.md", from: "TUTTI_SPEC" },
      ownPrompt: false,
      concurrent: 2,
    })
  })

  test("an empty variable is none given, and a concurrency it can't read none", () => {
    const env = envOf({ TUTTI_SPEC: "", TUTTI_PROMPT: "mine.md", TUTTI_CONCURRENT: "many" })
    expect(setupFlags(flagsOf({}), env)).toEqual({ spec: null, ownPrompt: true, concurrent: null })
  })
})

describe("a spec run's setup from the flags", () => {
  test("sets the repository up with the concurrency given, the files it wrote for the commit", async () => {
    const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-start-"))), "repo")
    mkdirSync(repo)
    writeFileSync(join(repo, "shop.md"), "# Shop\n")
    const said: Array<string> = []
    const setUpWith: Array<number | null> = []
    const files = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Repository
        yield* git.write(repo, { "shop.md": "# Shop\n" })
        return yield* setUpFromFlags({
          cwd: repo,
          flags: flagsOf({ spec: "shop.md" }),
          env: envOf({ TUTTI_CONCURRENT: "4" }),
          setUp: (concurrent) =>
            Effect.gen(function* () {
              setUpWith.push(concurrent)
              yield* git.write(repo, { ".tutti/settings.json": "{}\n" })
              return 0
            }),
          say: (text) => Effect.sync(() => void said.push(text)),
        })
      }).pipe(Effect.provide(Layer.mergeAll(memoryGit({ dir: repo }), BunServices.layer))),
    )
    expect(files).toEqual([".tutti/settings.json"])
    expect(setUpWith).toEqual([4])
    expect(said).toEqual([settingUpLine])
  })
})

/** The setup's files, as the main checkout's working tree holds them. */
const setupFiles = { ".tutti/settings.json": "{}\n", "scripts/check-fast.sh": "exit 0\n" }

/** The lock's holder as the run took it. */
const holder: Holder = { pid: 1, started: "2026-10-26T09:00:00Z", version: "0.0.0", branch: "main" }

/**
 * A spec run's start, wired as src/main.ts wires it, the scripted host playing the breakdown's
 * `script`: the setup's files in the working tree; `then` is what the run does once it has started,
 * in the run's scope, given what the breakdown's stopping the run completes.
 */
const starting = <A>(
  script: (recording: Calls) => Script,
  then: (
    wired: ReturnType<typeof specStart>,
    quitted: Deferred.Deferred<void>,
  ) => Effect.Effect<A, unknown>,
) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-start-")))
  const spec = specOf()
  const out: Array<string> = []
  const stdout: Out = { write: (text) => void out.push(text), columns: () => 100, tty: false }
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
  const recording = Effect.runSync(Deferred.make<Recording["Service"]>())
  const rewrites: Array<Holder> = []
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Deferred.succeed(recording, yield* Recording)
      const git = yield* Repository
      yield* git.write(repo, setupFiles)
      const quitted = yield* Deferred.make<void>()
      const wired = specStart({
        setup: Object.keys(setupFiles),
        holder,
        rewrite: (rewritten) => Effect.sync(() => void rewrites.push(rewritten)),
        runScope: yield* Effect.scope,
        quit: Deferred.succeed(quitted, undefined),
      })
      const begun = yield* wired.start(spec, appConfig({}, repo), {
        printer: makePrinter(stdout, theme),
        error: () => Effect.void,
        refine: Option.none(),
      })
      const after = yield* then(wired, quitted)
      return {
        begun,
        after,
        files: yield* git.tree("HEAD"),
        quitted: yield* Deferred.isDone(quitted),
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        specLayers({
          repo,
          scripts: { [breakdownWorker]: script(recording) },
          files: { "README.md": "# shop\n", [spec.path]: spec.text },
        }),
      ),
    ),
  ).then((value) => ({ ...value, repo, spec, rewrites, out: Bun.stripANSI(out.join("")) }))
}

describe("a spec run's start in the run", () => {
  test("commits the setup's files with the spec, and scopes the run to the root epic, which the lock names", async () => {
    const answers: Array<ToolAnswer> = []
    const plain = { ...rootInput, environment: undefined }
    const rest = { root: "test-1", issues: [ticket({ key: "list" })] }
    const ran = await starting(
      (recording) => [
        [
          wait,
          breakdownInit,
          sessionState("running"),
          ...tool("mcp__tutti__file_root", plain, call(recording, "file_root", plain, answers)),
          ...tool(
            "mcp__tutti__file_breakdown",
            rest,
            call(recording, "file_breakdown", rest, answers),
          ),
          result("Done."),
          sessionState("idle"),
        ],
      ],
      (wired) =>
        Effect.gen(function* () {
          yield* wired.stop
          return { options: wired.runOptions(), code: wired.exitCode(exitCodes.ok) }
        }),
    )
    expect(ran.begun).toEqual({ _tag: "Scoped", root: "test-1" as TicketId })
    expect(ran.rewrites).toEqual([{ ...holder, scope: "test-1" }])
    expect(ran.files.get(".tutti/settings.json")).toBe("{}\n")
    expect(ran.files.get("scripts/check-fast.sh")).toBe("exit 0\n")
    expect(ran.out).toContain(`committed the setup with the spec ${ran.spec.path}`)
    expect(ran.after).toEqual({ options: {}, code: exitCodes.ok })
    expect(ran.quitted).toBe(false)
    // The run is scoped to the root epic, with the spec's path.
    const root = ran.begun._tag === "Scoped" ? ran.begun.root : null
    const config = await Effect.runPromise(
      scopedTo(
        root ?? ("none" as TicketId),
        ran.spec.path,
      )(
        Effect.gen(function* () {
          return yield* AppConfig
        }),
      ).pipe(Effect.provideService(AppConfig, appConfig({}, ran.repo))),
    )
    expect(config.ticket).toBe("test-1" as TicketId)
    expect(config.specPath).toBe(ran.spec.path)
  })

  test("a breakdown failing after the early start stops the run, with its exit code", async () => {
    const go = Effect.runSync(Deferred.make<void>())
    const answers: Array<ToolAnswer> = []
    const ran = await starting(
      (recording) => [
        [
          wait,
          breakdownInit,
          sessionState("running"),
          ...tool(
            "mcp__tutti__file_root",
            rootInput,
            call(recording, "file_root", rootInput, answers),
          ),
          run(Deferred.await(go)),
          result("No more."),
          sessionState("idle"),
          wait,
          sessionState("running"),
          result("Still no more."),
          sessionState("idle"),
        ],
      ],
      (wired, quitted) =>
        Effect.gen(function* () {
          // The run goes on the environment ticket, its banner the breakdown's filing.
          const filing = wired.runOptions().filing
          const during = filing === undefined ? undefined : yield* SubscriptionRef.get(filing)
          yield* Deferred.succeed(go, undefined)
          yield* Deferred.await(quitted).pipe(Effect.timeout(Duration.seconds(10)))
          yield* wired.stop
          return { during, code: wired.exitCode(exitCodes.ok) }
        }),
    )
    expect(ran.begun).toEqual({ _tag: "Scoped", root: "test-1" as TicketId })
    expect(ran.rewrites).toEqual([{ ...holder, scope: "test-1" }])
    expect(ran.files.get(".tutti/settings.json")).toBe("{}\n")
    expect(ran.after).toEqual({
      during: "breaking the spec down: 1 epic, 1 ticket filed",
      code: exitCodes.setup,
    })
    expect(ran.quitted).toBe(true)
  })

  test("a breakdown the run's end cuts short is stopped with it, the run's exit code its own", async () => {
    const answers: Array<ToolAnswer> = []
    const ran = await starting(
      (recording) => [
        [
          wait,
          breakdownInit,
          sessionState("running"),
          ...tool(
            "mcp__tutti__file_root",
            rootInput,
            call(recording, "file_root", rootInput, answers),
          ),
          // The rest is never filed: the run ends first.
          run(Effect.never),
        ],
      ],
      (wired) =>
        Effect.gen(function* () {
          const filing = wired.runOptions().filing
          if (filing === undefined) return { during: undefined, after: undefined, code: null }
          const during = yield* SubscriptionRef.get(filing)
          yield* wired.stop
          // The breakdown over, its banner is gone.
          const after = yield* SubscriptionRef.get(filing)
          return { during, after, code: wired.exitCode(exitCodes.ok) }
        }),
    )
    expect(ran.begun).toEqual({ _tag: "Scoped", root: "test-1" as TicketId })
    expect(ran.after).toEqual({
      during: "breaking the spec down: 1 epic, 1 ticket filed",
      after: null,
      code: exitCodes.ok,
    })
    expect(ran.quitted).toBe(false)
  })
})
