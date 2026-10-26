// A spec run's start with the scripted host playing the breakdown's session (§ 4.14), shared by
// test/spec-run.test.ts and test/spec-early.test.ts: the breakdown's own tools are called as its
// session would call them, found in the session's kind as the host recorded its start.
import { createHash } from "node:crypto"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Layer, Option } from "effect"
import { breakdownWorker } from "../src/agent/breakdown.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { serverName } from "../src/agent/interviewTools.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import type { Spec } from "../src/run/spec.ts"
import type { SpecOutcome } from "../src/run/specRun.ts"
import { specRun } from "../src/run/specRun.ts"
import {
  init,
  Recording,
  result,
  type Script,
  layer as scriptedHost,
  sessionState,
  tool,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

export const specText = "# Shop\n\n## Listing\n\nList the items.\n"
export const sha = (text: string) => createHash("sha256").update(text).digest("hex")

export const specOf = (text = specText): Spec => ({
  given: "docs/shop.md",
  from: "--spec",
  source: "/elsewhere/docs/shop.md",
  path: "docs/shop.md",
  copy: false,
  text,
  sha256: sha(text),
})

/** The breakdown's session's system/init: tutti's in-process server alone, in dontAsk. */
export const breakdownInit = init({
  permissionMode: "dontAsk",
  mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }],
})

export type Calls = Deferred.Deferred<Recording["Service"]>

/** Calls the breakdown's own tool `name` with `input`, as its session would, keeping the answer. */
export const call = (
  recording: Calls,
  name: string,
  input: Record<string, unknown>,
  answers: Array<ToolAnswer>,
) =>
  Effect.gen(function* () {
    const sent = yield* (yield* Deferred.await(recording)).sentTo(breakdownWorker)
    const started = sent.find((s) => s._tag === "Started")
    const kind = started?._tag === "Started" ? started.session.kind : undefined
    if (kind?._tag !== "Interview" || kind.breakdown === undefined) {
      throw new Error("no breakdown session started")
    }
    const found = kind.breakdown.tools.find((t) => t.name === name)
    if (found === undefined) throw new Error(`no tool ${name}`)
    answers.push(yield* Effect.promise(() => found.handler(input as never, {})))
  })

/** A turn calling each of `calls` (a tool's name and input) in turn, then ending. */
export const turn = (
  recording: Calls,
  calls: ReadonlyArray<readonly [string, Record<string, unknown>]>,
  answers: Array<ToolAnswer>,
) => [
  sessionState("running"),
  ...calls.flatMap(([name, input]) =>
    tool(`mcp__tutti__${name}`, input, call(recording, name, input, answers)),
  ),
  result("Done."),
  sessionState("idle"),
]

export const ticket = (fields: Record<string, unknown>) => ({
  parent: "",
  type: "task",
  priority: 2,
  title: `Ticket ${String(fields.key)}`,
  description: 'Builds § "Listing".',
  acceptance: "The tests pass.",
  labels: [],
  files: [],
  waits_for: [],
  ...fields,
})

export const textOf = (answer: ToolAnswer | undefined): string =>
  (answer?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("")

/** Runs specRun on `spec` in a fresh main checkout, the scripted host playing `script`. */
export const scenario = (options: {
  readonly spec?: Spec
  readonly seeds?: ReadonlyArray<Seed>
  /** Issues seeded once the main checkout has its start commit, `start`. */
  readonly seedsAt?: (start: string) => ReadonlyArray<Seed>
  /** The spec's text as the main checkout's start commit has it; the spec's own by default. */
  readonly committed?: string
  readonly script?: (recording: Calls) => Script
  readonly timeLimit?: Duration.Duration
  /** Starts the run early in this run's scope (SpecRequest.earlyIn), and what to do with Early. */
  readonly early?: (outcome: SpecOutcome) => Effect.Effect<SpecOutcome>
}) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-run-")))
  const spec = options.spec ?? specOf()
  const out: Array<string> = []
  const errors: Array<string> = []
  const stdout: Out = { write: (text) => void out.push(text), columns: () => 100, tty: false }
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
  const recording = Effect.runSync(Deferred.make<Recording["Service"]>())
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Deferred.succeed(recording, yield* Recording)
      const git = yield* Repository
      for (const seed of options.seedsAt?.(yield* git.head()) ?? [])
        yield* (yield* Backlog).put(seed)
      // The main checkout holds the spec as it is now, uncommitted where it changed.
      if (options.committed !== undefined) {
        yield* git.write(repo, { [spec.path]: spec.text })
      }
      const outcome = yield* specRun(
        {
          spec,
          repo,
          refine: false,
          timeLimit: options.timeLimit ?? Duration.minutes(60),
          effort: "high",
          ...(options.early === undefined ? {} : { earlyIn: yield* Effect.scope }),
        },
        {
          printer: makePrinter(stdout, theme),
          error: (text) => Effect.sync(() => void errors.push(text)),
          refine: Option.none(),
        },
      )
      const backlog = yield* Backlog
      const early = options.early === undefined ? undefined : yield* options.early(outcome)
      return {
        outcome,
        early,
        issues: yield* backlog.issues,
        log: yield* texts,
        sent: yield* (yield* Recording).sentTo(breakdownWorker),
        head: yield* git.head(),
        files: yield* git.tree("HEAD"),
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        scriptedHost(
          options.script === undefined ? {} : { [breakdownWorker]: options.script(recording) },
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              BunServices.layer,
              logLayer(),
              eventsLayer(),
              configLayer(appConfig({}, repo)),
              beadsLayer(options.seeds ?? []),
              memoryGit({
                dir: repo,
                files: { "README.md": "# shop\n", [spec.path]: options.committed ?? spec.text },
              }),
            ),
          ),
        ),
      ),
    ),
  ).then((value) => ({ ...value, repo, out: out.join(""), errors }))
}

/** The root epic and environment ticket file_root files. */
export const rootInput = {
  title: "The shop",
  description: "Lists the items.",
  priority: 1,
  environment: {
    title: "Set the project up",
    description: "The toolchain, the scaffold, the checks.",
    acceptance: "The checks run.",
    files: ["README.md", "package.json"],
  },
}
