// A ClaudeSession's inbox: a session opened without a prompt is sent what `send` pushes, through
// the AsyncIterable its adapter gives the SDK as the prompt, until the session closes; one opened
// with a prompt of its own takes nothing from `send`.
import { describe, expect, test } from "bun:test"
import type { Query, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import { userMessage } from "../src/agent/AgentHost.ts"
import { BilledAs, ClaudeCode, type ClaudeSession, type Launch } from "../src/agent/ClaudeCode.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"

/** A query() that keeps the prompt it was given, and whose Query sends nothing. */
const keeping = () => {
  const kept: { prompt?: string | AsyncIterable<SDKUserMessage> } = {}
  const open = ((params: Parameters<typeof query>[0]) => {
    kept.prompt = params.prompt
    return {
      async *[Symbol.asyncIterator]() {},
      close: () => {},
    } as unknown as Query
  }) as typeof query
  return { open, kept }
}

const launch = (fields: Partial<Launch> = {}): Launch => ({
  options: { cwd: "/work/project" },
  billedAs: BilledAs.Workers(),
  env: { PATH: "/usr/bin" },
  closeLimit: Duration.seconds(1),
  ...fields,
})

const hello = userMessage({ text: "Hello.", from: "clientComposed" }, "u-1", "s-1")
const more = userMessage({ text: "More.", from: "human" }, "u-2", "s-1")

/** Opens a session over `open` in a scope of its own, which `use` may close. */
const withSession = <A>(
  open: typeof query,
  fields: Partial<Launch>,
  use: (session: ClaudeSession, scope: Scope.Closeable) => Effect.Effect<A>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const session = yield* (yield* ClaudeCode).open(launch(fields)).pipe(Scope.provide(scope))
      return yield* Effect.ensuring(use(session, scope), Scope.close(scope, Exit.void))
    }).pipe(
      Effect.provide(ClaudeCode.layerWith(open).pipe(Layer.provide(configLayer(appConfig())))),
    ),
  )

describe("a session's inbox", () => {
  test("without a prompt, the SDK reads what send pushes, until the session closes", async () => {
    const { open, kept } = keeping()
    const { sent, read, after } = await withSession(open, {}, (session, scope) =>
      Effect.gen(function* () {
        const sent = [yield* session.send(hello), yield* session.send(more)]
        yield* Scope.close(scope, Exit.void)
        const after = yield* session.send(hello)
        const prompt = kept.prompt as AsyncIterable<SDKUserMessage>
        const read = yield* Effect.promise(() => Array.fromAsync(prompt))
        return { sent, read, after }
      }),
    )
    expect(sent).toEqual([true, true])
    // The inbox ended with the session: the SDK reads what it took, and then its end.
    expect(read).toEqual([hello, more])
    expect(after).toBe(false)
  })

  test("with a prompt of its own, send pushes nothing", async () => {
    const { open, kept } = keeping()
    const sent = await withSession(open, { prompt: "Hello." }, (session) => session.send(hello))
    expect(sent).toBe(false)
    expect(kept.prompt).toBe("Hello.")
  })
})
