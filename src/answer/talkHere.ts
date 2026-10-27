// `tutti answer --talk <question>` outside a run (tutti-i0sz, § 4.11, § 8.1): the question's talk
// (src/run/answerTalk.ts) in the Interview view, in a renderer of its own in the terminal. What a
// run's startup gives a session it reads here alone, without the run's checks of the tree or the
// backlog: the configuration, the Claude Code it resolves, the login probe's billing and the MCP
// servers workers get. It holds the run lock while it talks, so it never shares .tutti/run with a
// run (a run going on talks a question through from its dashboard's Shift+A); it appends to the
// log and the event stream as a run does, under its own start.
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { Account } from "../agent/Account.ts"
import { layer as agentHostLayer } from "../agent/AgentHostLive.ts"
import { Attention } from "../agent/Attention.ts"
import { ClaudeCode } from "../agent/ClaudeCode.ts"
import { resolveClaude } from "../agent/claudeBinary.ts"
import { WorkerEnv, workerEnv } from "../agent/env.ts"
import { resolveServers } from "../agent/mcp.ts"
import { Transcripts } from "../agent/Transcripts.ts"
import { AppConfig, load } from "../cli/AppConfig.ts"
import { noFlags } from "../cli/flags.ts"
import { talkQuestion } from "../run/answerTalk.ts"
import { EventStream } from "../run/eventstream.ts"
import { runStarted } from "../run/localTime.ts"
import { Log } from "../run/log.ts"
import { otherWorkers } from "../run/machine.ts"
import { Beads } from "../services/Beads.ts"
import { Git, GitWriter } from "../services/Git.ts"
import { RunLock } from "../services/RunLock.ts"
import { Tty, layer as ttyLayer } from "../services/Tty.ts"
import { interviewScreen } from "../ui/App.tsx"
import { open as openRenderer } from "../ui/renderer.ts"
import { type Appearance, makeTheme } from "../ui/theme.ts"
import type { Talker } from "./questions.ts"

/** Why `tutti answer --talk` doesn't talk where stdin or stdout isn't a terminal. */
export const needsTerminal = "it needs a terminal for its view: run it in one"

/** git, with its one writer at a time. */
const gitLayer = Git.layer().pipe(Layer.provideMerge(GitWriter.layer))

/** A failure's message, as the command says why the talk couldn't start. */
const why = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message: unknown }).message)
    : String(error)

/** The talk of `tutti answer --talk` in the main checkout `top`, started from `cwd`, tutti `version`. */
export const talkHere =
  (cwd: string, version: string) =>
  (top: string): Talker<never> =>
  (question) =>
    Effect.gen(function* () {
      const tty = yield* Tty
      if (!tty.stdinIsTty || !tty.stdoutIsTty) return yield* Effect.fail(needsTerminal)
      const configured = yield* load(noFlags, top, cwd).pipe(
        Effect.mapError((error) => error.problems.join("; ")),
      )
      const claude = yield* resolveClaude(configured.claude, cwd)
      if (claude.problems.length > 0) return yield* Effect.fail(claude.problems.join("; "))
      const config = { ...configured, claude: claude.path }
      const probe = yield* Layer.build(
        Layer.provide(Account.layer, Layer.succeed(AppConfig, config)),
      )
        .pipe(
          Effect.flatMap((built) =>
            Effect.provideContext(
              Effect.flatMap(Account, (account) => account.probe),
              built,
            ),
          ),
        )
        .pipe(Effect.mapError((error) => `the login probe: ${why(error)}`))
      const servers = yield* resolveServers(top, config.settings.workers.mcp_servers).pipe(
        Effect.mapError((error) => `the MCP servers: ${why(error)}`),
      )
      const git = yield* Git
      const commonDir = yield* git
        .commonDir(top)
        .pipe(Effect.mapError(() => `tutti cannot find the git folder of ${top}`))
      const branch = Option.getOrElse(
        yield* git.currentBranch(top).pipe(Effect.orElseSucceed(() => Option.none<string>())),
        () => "HEAD",
      )
      const started = runStarted(Date.now())
      const lock = yield* RunLock
      yield* lock
        .acquire({
          repo: top,
          commonDir,
          holder: { pid: process.pid, started, version, branch },
        })
        .pipe(Effect.mapError(why))

      const env = { subscription: probe.subscription, billing: config.billing }
      const services = agentHostLayer({
        prompt: { text: "", file: null },
        servers,
        account: probe,
      }).pipe(
        Layer.provideMerge(Attention.layer()),
        Layer.provideMerge(
          Layer.mergeAll(
            ClaudeCode.layer.pipe(Layer.provide(Layer.succeed(WorkerEnv, workerEnv(env)))),
            Transcripts.layer({ repo: top }),
            otherWorkers,
          ),
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(AppConfig, config),
            Beads.layer({ cwd: top }),
            Log.layer({ repo: top }),
            EventStream.layer({ repo: top, run: started }),
          ),
        ),
        Layer.provideMerge(gitLayer),
        Layer.provideMerge(BunServices.layer),
      )
      const shell = yield* openRenderer({ chosen: config.appearance, mouse: config.mouse }).pipe(
        Effect.mapError((error) => `tutti cannot open its screen: ${error.message}`),
      )
      const depth = tty.colourDepth === "truecolor" ? "truecolor" : "256"
      const themeOf = (appearance: Appearance) =>
        makeTheme(config.scheme.scheme, { appearance, depth, noColor: config.noColor })
      // A service that can't be made (a folder of .tutti/run refused) stops the talk, saying why.
      return yield* talkQuestion(question, interviewScreen(shell, themeOf)).pipe(
        Effect.provide(services),
        Effect.mapError(why),
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(gitLayer, RunLock.layer, ttyLayer).pipe(
          Layer.provideMerge(BunServices.layer),
        ),
      ),
      Effect.scoped,
    )
