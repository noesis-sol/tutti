// ClaudeCode, the one port every Claude Code session tutti opens goes through: what its adapter
// launches a session with (the environment by how it is billed, the executable, the stderr, the
// abort and the spawn), and how the session's stream, control requests and end reach the Query.
import { describe, expect, test } from "bun:test"
import type {
  Options,
  Query,
  query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Exit, Layer, Stream } from "effect"
import fc from "fast-check"
import {
  BilledAs,
  ClaudeCode,
  type Launch,
  LaunchFailed,
  launchEnv,
  SessionFailed,
} from "../src/agent/ClaudeCode.ts"
import { queryThrew } from "../src/agent/claudeBinary.ts"
import { WorkerEnv, workerEnv } from "../src/agent/env.ts"
import { withStderr } from "../src/agent/sessionProcess.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"

const key = "sk-ant-test"
const tutti = { PATH: "/usr/bin", ANTHROPIC_API_KEY: key, HERDR_PANE: "p-1" }

/** The run's WorkerEnv over tutti's environment `tutti`, with a subscription login. */
const workers = workerEnv({ subscription: true, billing: "subscription", env: tutti })

describe("launchEnv", () => {
  test("billed as workers, the run's WorkerEnv, which holds the key back beside a login", () => {
    const env = launchEnv({ billedAs: BilledAs.Workers() }, workers)
    expect(env).toEqual(workers)
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(env).not.toHaveProperty("HERDR_PANE")
    expect(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1")
    const api = workerEnv({ subscription: true, billing: "api", env: tutti })
    expect(launchEnv({ billedAs: BilledAs.Workers() }, api).ANTHROPIC_API_KEY).toBe(key)
  })

  test("billed as workers, the launch's own environment isn't read", () => {
    const elsewhere = { PATH: "/opt/bin", ANTHROPIC_API_KEY: "sk-ant-other" }
    expect(launchEnv({ billedAs: BilledAs.Workers(), env: elsewhere }, workers)).toEqual(workers)
  })

  test("billed as the login probe, never the key, from tutti's environment", () => {
    const api = workerEnv({ subscription: true, billing: "api", env: tutti })
    const env = launchEnv({ billedAs: BilledAs.LoginProbe(), env: tutti }, api)
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(env.PATH).toBe("/usr/bin")
    expect(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1")
  })

  test("a worker's share laid over WorkerEnv; none without one", () => {
    const organ = launchEnv({ billedAs: BilledAs.Workers() }, workers)
    expect(organ).not.toHaveProperty("TUTTI_CORES")
    expect(organ).not.toHaveProperty("BASH_DEFAULT_TIMEOUT_MS")
    const worker = launchEnv(
      { billedAs: BilledAs.Workers(), share: { checkTimeout: Duration.minutes(20), cores: 3 } },
      workers,
    )
    expect(worker.TUTTI_CORES).toBe("3")
    expect(worker.GOFLAGS).toBe("-p=3")
    expect(worker.BASH_DEFAULT_TIMEOUT_MS).toBe(String(20 * 60 * 1000))
    expect(worker.PATH).toBe("/usr/bin")
  })
})

/** What a stand-in for the SDK's query() was called with, and what its Query was asked. */
interface Seen {
  options?: Options | undefined
  prompt?: string | AsyncIterable<SDKUserMessage>
  closed: number
  interrupts: Array<unknown>
  cancelled: Array<string>
}

/**
 * A query() whose Query plays `messages`, then ends, or fails with `fails`; it answers its control
 * requests, and has getSettings() when `settings` is given.
 */
const standIn = (
  messages: ReadonlyArray<SDKMessage>,
  answers: { readonly fails?: Error; readonly settings?: unknown } = {},
) => {
  const seen: Seen = { closed: 0, interrupts: [], cancelled: [] }
  const open = ((params: Parameters<typeof query>[0]) => {
    seen.options = params.options
    seen.prompt = params.prompt
    const handle = {
      async *[Symbol.asyncIterator]() {
        yield* messages
        if (answers.fails !== undefined) throw answers.fails
      },
      initializationResult: async () => ({ account: { email: "a@b.c" } }),
      mcpServerStatus: async () => [{ name: "docs", status: "connected" }],
      getContextUsage: async () => ({ totalTokens: 10 }),
      interrupt: async (options: unknown) => {
        seen.interrupts.push(options)
        return { still_queued: [], cancelled: [] }
      },
      cancelAsyncMessage: async (uuid: string) => {
        seen.cancelled.push(uuid)
        return true
      },
      close: () => {
        seen.closed++
      },
      ...(answers.settings === undefined ? {} : { getSettings: async () => answers.settings }),
    }
    return handle as unknown as Query
  }) as typeof query
  return { open, seen }
}

const launch = (fields: Partial<Launch> = {}): Launch => ({
  options: { cwd: "/work/project", persistSession: false },
  prompt: "Hello.",
  billedAs: BilledAs.Workers(),
  closeLimit: Duration.seconds(1),
  ...fields,
})

/** Runs `use` with a session opened over `open`, under `config`, its scope closed after. */
const opened = <A, E>(
  open: typeof query,
  use: (session: Effect.Success<ReturnType<ClaudeCode["Service"]["open"]>>) => Effect.Effect<A, E>,
  fields: Partial<Launch> = {},
  config: AppConfigValue = appConfig({ claude: "/opt/claude/bin/claude" }),
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const session = yield* (yield* ClaudeCode).open(launch(fields))
      return yield* use(session)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ClaudeCode.layerWith(open).pipe(
          Layer.provide(Layer.mergeAll(configLayer(config), Layer.succeed(WorkerEnv, workers))),
        ),
      ),
    ),
  )

const result = { type: "result", subtype: "success", is_error: false } as unknown as SDKMessage

describe("ClaudeCode's adapter", () => {
  test("launches with the spec, the environment, the executable, the abort and the spawn", async () => {
    const { open, seen } = standIn([result])
    const pieces: Array<string> = []
    const exit = await opened(open, (session) => Stream.runCollect(session.messages), {
      onStderr: (data) => pieces.push(data),
    })
    expect(exit).toEqual(Exit.succeed([result]))
    expect(seen.prompt).toBe("Hello.")
    const options = seen.options
    expect(options?.cwd).toBe("/work/project")
    expect(options?.persistSession).toBe(false)
    expect(options?.pathToClaudeCodeExecutable).toBe("/opt/claude/bin/claude")
    expect(options?.env).toEqual(workers)
    expect(options?.abortController).toBeInstanceOf(AbortController)
    expect(typeof options?.spawnClaudeCodeProcess).toBe("function")
    // Claude Code's stderr reaches onStderr through the spawn's stderr callback.
    options?.stderr?.("a line\n")
    expect(pieces).toEqual(["a line\n"])
  })

  test("the embedded Claude Code when --claude names none", async () => {
    const { open, seen } = standIn([])
    await opened(open, () => Effect.void, {}, appConfig({ claude: null }))
    expect(seen.options).not.toHaveProperty("pathToClaudeCodeExecutable")
  })

  test("closes the Query as its scope closes", async () => {
    const { open, seen } = standIn([])
    const exit = await opened(open, () => Effect.sync(() => seen.closed))
    expect(exit).toEqual(Exit.succeed(0))
    expect(seen.closed).toBe(1)
  })

  test("a query() that throws as it is called fails with LaunchFailed, saying what to do", async () => {
    const noBinary = new Error(
      "Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk " +
        "without --omit=optional, or set options.pathToClaudeCodeExecutable.",
    )
    const throwing = (() => {
      throw noBinary
    }) as typeof query
    const exit = await opened(throwing, () => Effect.void)
    expect(exit).toEqual(Exit.fail(new LaunchFailed({ reason: queryThrew(noBinary) })))
  })

  test("a stream that fails fails with SessionFailed, the SDK's reason in it", async () => {
    const { open } = standIn([result], { fails: new Error("Claude Code exited with code 1") })
    const exit = await opened(open, (session) => Stream.runDrain(session.messages))
    if (Exit.isSuccess(exit)) throw new Error("the stream ended")
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    expect(error).toBeInstanceOf(SessionFailed)
    expect((error as SessionFailed).reason).toBe("Claude Code exited with code 1")
    expect((error as SessionFailed).message).toBe("Claude Code exited with code 1")
  })

  test("its control requests reach the Query", async () => {
    const { open, seen } = standIn([], { settings: { errors: [] } })
    const exit = await opened(open, (session) =>
      Effect.all({
        init: session.initialization,
        status: session.mcpStatus,
        settings: session.settings,
        usage: session.contextUsage,
        interrupted: session.interrupt(true),
        dropped: session.cancelQueued("u-1"),
      }),
    )
    expect(exit).toEqual(
      Exit.succeed({
        init: { account: { email: "a@b.c" } },
        status: [{ name: "docs", status: "connected" }],
        settings: { errors: [] },
        usage: { totalTokens: 10 },
        interrupted: { still_queued: [], cancelled: [] },
        dropped: true,
      } as never),
    )
    expect(seen.interrupts).toEqual([{ cancelQueued: true }])
    expect(seen.cancelled).toEqual(["u-1"])
  })

  test("a Query without getSettings() has no settings", async () => {
    const { open } = standIn([])
    expect(await opened(open, (session) => session.settings)).toEqual(Exit.succeed(undefined))
  })

  test("kill and abort abort the session; nothing spawned has no PID", async () => {
    const { open, seen } = standIn([])
    const exit = await opened(open, (session) =>
      Effect.gen(function* () {
        const pid = session.pid()
        yield* session.kill
        return { pid, aborted: seen.options?.abortController?.signal.aborted }
      }),
    )
    expect(exit).toEqual(Exit.succeed({ pid: undefined, aborted: true }))
  })
})

describe("SessionFailed", () => {
  test("property: quoted is its reason, then at most `max` characters of its stderr's end", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.integer({ min: 1, max: 600 }),
        (reason, stderr, max) => {
          const failed = new SessionFailed({ reason, stderr })
          expect(failed.quoted(max)).toBe(withStderr(reason, stderr.slice(-max).trim()))
          expect(failed.quoted(max).startsWith(reason)).toBe(true)
        },
      ),
    )
  })
})
