// A resumed worker is told the standing rules' notes that can change (changingNotes) in its resume's
// message, as its session keeps the system prompt it recorded as it began (`snapshot: true`): when
// a merge has changed the requires list since its session started (takeRequires), or when its
// session began in an earlier run. One resumed with the notes it was given already is told nothing.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer, resumedNotes } from "../src/agent/AgentHostLive.ts"
import type { Attention } from "../src/agent/Attention.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { changingNotes } from "../src/agent/options.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import type { WorkerState } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { type Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

// Each test starts the fake Claude Code as a process, up to a second on an idle machine.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

type Env = AgentHost | Attention | Transcripts | Files | Log | EventStream

const prompt = { text: "Work on TICKET_ID.", file: null }

const settings = {
  ...defaultSettings,
  checks: {
    ...defaultSettings.checks,
    fast: { ...defaultSettings.checks.fast, command: "scripts/check-fast.sh" },
  },
}

/** The contents of the user messages the fake read, in order. */
const usersIn = (file: string): ReadonlyArray<unknown> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
        .flatMap((e) => (e.stdin?.type === "user" ? [e.stdin.message.content] : []))
    : []

/** Runs `effect` with the live host over the fake, in a fresh folder; it gets that folder. */
const run = <A, E>(
  effect: (where: { dir: string; log: string }) => Effect.Effect<A, E, Env>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-resume-notes-"))
  const log = join(dir, "fake.jsonl")
  const host = liveLayer({
    prompt,
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify({ log }) },
  })
  return Effect.runPromise(
    effect({ dir, log }).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              logLayer(),
              eventsLayer(),
              configLayer(appConfig({ claude: fake, settings }, dir)),
              BunServices.layer,
            ),
          ),
        ),
      ),
    ),
  )
}

const session = (dir: string) => ({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })

/** Waits, at most 10 s, for the ticket's worker to be Idle. */
const idle = (ticket: string) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const found = yield* host.state(ticket).pipe(
      Stream.filter((state: WorkerState) => state._tag === "Idle"),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die(`${ticket} never became Idle`),
      }),
    )
    return Option.getOrThrow(found)
  })

/** Resumes the ticket's worker with `text` and waits for its turn to end. */
const resume = (dir: string, text: string) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* host.resume("t-1", session(dir), { text, from: "clientComposed" })
    yield* idle("t-1")
    yield* host.close("t-1")
  })

/** The changing notes a worker of this test's run is given with the requires list `names`. */
const notesWith = (names: ReadonlyArray<string>) =>
  changingNotes(
    {
      config: appConfig({ settings }, "/repo"),
      servers: { servers: [], note: noServersNote },
      readme: false,
      requires: names,
    },
    prompt,
  )

describe("a resumed worker is told the standing rules' notes that changed", () => {
  test("a requires list a merge changed reaches a resumed worker, once", async () => {
    const log = await run(({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        yield* host.send("t-1", "first", "clientComposed")
        yield* idle("t-1")
        yield* host.close("t-1")
        yield* resume(dir, "same list")
        yield* host.takeRequires(["jq"])
        yield* resume(dir, "new list")
        yield* resume(dir, "told already")
        return log
      }),
    )
    const told = resumedNotes(notesWith(["jq"]))
    expect(told).toContain("which has jq now")
    expect(told).toContain("Run a check")
    expect(usersIn(log)).toEqual(["first", "same list", `${told}new list`, "told already"])
  })

  test("a session begun in an earlier run is told the notes as they are now", async () => {
    const log = await run(({ dir, log }) =>
      Effect.gen(function* () {
        yield* resume(dir, "carry on")
        yield* resume(dir, "again")
        return log
      }),
    )
    expect(usersIn(log)).toEqual([`${resumedNotes(notesWith([]))}carry on`, "again"])
  })

  test("the notes are said whole, a blank line between them", () => {
    const told = resumedNotes(notesWith(["jq", "node"]))
    expect(told).toContain("which has jq, node now.")
    expect(told).not.toMatch(/\n{3}/)
    expect(told.endsWith("\n\n")).toBe(true)
  })
})
