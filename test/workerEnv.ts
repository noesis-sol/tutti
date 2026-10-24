// The run's WorkerEnv (src/agent/env.ts) for a test's ClaudeCode layer, which main.ts sets as a run
// starts: workers' environment made from `env`.
import { Layer } from "effect"
import { WorkerEnv, workerEnv } from "../src/agent/env.ts"
import type { billings } from "../src/cli/flags.ts"

/** WorkerEnv made from `env`, with a subscription login unless told otherwise, billed to it. */
export const workersIn = (
  env: Readonly<Record<string, string | undefined>>,
  subscription = true,
  billing: (typeof billings)[number] = "subscription",
): Layer.Layer<never> => Layer.succeed(WorkerEnv, workerEnv({ subscription, billing, env }))
