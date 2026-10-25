// A worker's Claude Code runs at a lower CPU priority (workerNice, tutti-ejkt.12), and with it what
// it starts, so that the merge check keeps its pace beside the workers; other sessions run at
// tutti's own priority.
import { describe, expect, test } from "bun:test"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { getPriority } from "node:os"
import type { Query, query, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import { BilledAs, ClaudeCode, type Launch } from "../src/agent/ClaudeCode.ts"
import { withSessionProcess, workerNice } from "../src/agent/sessionProcess.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"

/** sh running `script`, spawned as the SDK would. */
const shellSpawn = (script: string): SpawnOptions => ({
  command: "/bin/sh",
  args: ["-c", script],
  cwd: "/",
  env: { PATH: testEnv.PATH },
  signal: new AbortController().signal,
})

/** What `child` prints on stdout, once it has exited. */
const stdoutOf = (child: ChildProcessWithoutNullStreams) =>
  new Promise<string>((resolve) => {
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.once("close", () => resolve(out.trim()))
  })

/** The nice value a session spawned with `nice` runs at, and what it starts. */
const spawnedAt = async (nice: number | undefined) => {
  const { options } = withSessionProcess({}, nice)
  // The shell waits a moment, so that what it starts is started after its priority is set.
  const child = options.spawnClaudeCodeProcess?.(
    shellSpawn("sleep 0.2; ps -o nice= -p $$; sh -c 'ps -o nice= -p $$'"),
  ) as ChildProcessWithoutNullStreams
  const [own, started] = (await stdoutOf(child)).split(/\s+/u).map(Number)
  return { own, started }
}

/** tutti's own nice value: a session never runs above it. */
const ours = getPriority()

describe("withSessionProcess's priority", () => {
  test("with a nice value, Claude Code and what it starts run at it", async () => {
    const at = Math.max(ours, workerNice)
    expect(await spawnedAt(workerNice)).toEqual({ own: at, started: at })
  })

  test("without one, they run at tutti's own", async () => {
    expect(await spawnedAt(undefined)).toEqual({ own: ours, started: ours })
  })

  test("never raises a priority: a nice value above tutti's own leaves it", async () => {
    expect(await spawnedAt(ours - 1)).toEqual({ own: ours, started: ours })
  })
})

/** A query() that spawns a long sh through the adapter's spawn, as the SDK spawns Claude Code. */
const spawning = ((params: Parameters<typeof query>[0]) => {
  const child = params.options?.spawnClaudeCodeProcess?.(shellSpawn("sleep 30"))
  return {
    async *[Symbol.asyncIterator]() {},
    close: () => child?.kill("SIGKILL"),
  } as unknown as Query
}) as typeof query

const launch = (fields: Partial<Launch>): Launch => ({
  options: { cwd: "/" },
  billedAs: BilledAs.Workers(),
  env: { PATH: testEnv.PATH },
  closeLimit: Duration.seconds(5),
  ...fields,
})

/** The nice value the Claude Code of a session opened with `fields` runs at. */
const openedAt = (fields: Partial<Launch>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const session = yield* (yield* ClaudeCode).open(launch(fields)).pipe(Scope.provide(scope))
      const pid = session.pid()
      const nice = pid === undefined ? undefined : getPriority(pid)
      yield* Scope.close(scope, Exit.void)
      return nice
    }).pipe(
      Effect.provide(ClaudeCode.layerWith(spawning).pipe(Layer.provide(configLayer(appConfig())))),
    ),
  )

describe("ClaudeCode's sessions", () => {
  test("a worker's, opened with its share, runs at workerNice", async () => {
    const share = { checkTimeout: Duration.minutes(30), cores: 2 }
    expect(await openedAt({ share })).toBe(Math.max(ours, workerNice))
  })

  test("one without a share, a probe's or an organ's, runs at tutti's own", async () => {
    expect(await openedAt({})).toBe(ours)
  })
})
