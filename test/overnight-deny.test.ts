// An overnight run and the requests nobody is there to answer (tutti-epza.10): a worker's
// permission request is denied by tutti once it has waited 30 s, its turn going on with the
// refusal, rather than hold its slot for blockedAfter and be set aside; a request of a ticket no
// fiber follows is denied at blockedAfter rather than stop the run; and the pre-flight warns of
// the permissions.ask rules in the settings the workers load.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Duration, Effect, Fiber, Layer, Scope, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import * as fc from "fast-check"
import {
  Attention,
  type AttentionRequest,
  blockedAfter,
  type DenyOptions,
  overnightDenial,
  tuttiDenialMessage,
} from "../src/agent/Attention.ts"
import { overnightDenyAfter } from "../src/cli/AppConfig.ts"
import {
  askRulesCheck,
  askRulesOf,
  claudeUserSettingsFile,
  readAskRules,
  workerSettingsFiles,
} from "../src/run/askRules.ts"
import { make as makeBlockedWatch } from "../src/run/blockedWatch.ts"
import type { EventRecord } from "../src/run/events.ts"
import { blockedTickets } from "../src/run/holds.ts"
import { make as makeHoldsGate } from "../src/run/holdsGate.ts"
import { line } from "../src/run/log.ts"
import { make as makeOvernightAside } from "../src/run/overnightAside.ts"
import { run } from "../src/run/run.ts"
import { emptyStatus, type Status } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  result,
  type SessionScript,
  sleep,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as asleepLayer } from "../src/testing/Wake.ts"
import { openFibers } from "./fibers.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  scenario,
  type World,
} from "./harness.ts"

const overnightDeny: DenyOptions = { after: overnightDenyAfter }

const sdkOptions = (): Parameters<CanUseTool>[2] => ({
  signal: new AbortController().signal,
  toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
  requestId: "req",
})

const question = {
  questions: [
    {
      question: "Which store?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
      multiSelect: false,
    },
  ],
}

/** Gives the fibers a moment, the clock still. */
const moment = Effect.promise(() => Bun.sleep(5))

/** Moves TestClock on by `n` seconds, a second at a time, the fibers given a moment after each. */
const seconds = (n: number) =>
  Effect.forEach(
    Array.from({ length: n }),
    () => Effect.andThen(TestClock.adjust(Duration.seconds(1)), moment),
    { discard: true },
  )

/** Moves TestClock on by `n` minutes, a minute at a time, the fibers given a moment after each. */
const minutes = (n: number) =>
  Effect.forEach(
    Array.from({ length: n }),
    () => Effect.andThen(TestClock.adjust(Duration.minutes(1)), moment),
    { discard: true },
  )

/** `ticket`'s worker calls `tool` with `input`; its result, as a promise. */
const asks = (ticket: string, tool: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const canUse = yield* (yield* Attention).request(ticket as TicketId, openFibers())
    const answered = canUse(tool, input, sdkOptions())
    yield* moment
    return answered
  })

const settled = (answered: Promise<PermissionResult | null>) => Effect.promise(() => answered)

const records = Effect.flatMap(Captured, (captured) => captured.records)

const answeredRecords = (all: ReadonlyArray<EventRecord>) =>
  all.filter((record) => record.kind === "attention_answered")

/**
 * Runs `body` beside a BlockedWatch over Attention, permission requests denied as `deny` says and
 * the watch an overnight run's when `overnight`, under TestClock and the test Wake; `held` gives
 * the tickets BLOCKED holds now.
 */
const watching = <A>(
  deny: DenyOptions | undefined,
  overnight: boolean,
  body: (
    held: Effect.Effect<ReadonlyArray<string>>,
  ) => Effect.Effect<A, never, Attention | Captured>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const status = yield* SubscriptionRef.make<Status>(emptyStatus)
      const holds = yield* makeHoldsGate({ status, notices: [], wakeUp: Effect.void })
      yield* makeBlockedWatch({
        holds,
        ended: Effect.succeed(false),
        wakeUp: () => Effect.void,
        watch: (effect) => Effect.forkIn(effect, scope),
        ...(overnight ? { overnight: yield* makeOvernightAside } : {}),
      })
      return yield* body(
        Effect.map(holds.now, (now) => [...blockedTickets(now)] as ReadonlyArray<string>),
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(
        attentionLayer(waitForTest, undefined, deny).pipe(
          Layer.provideMerge(ledgerLayer()),
          Layer.provideMerge(Layer.merge(TestClock.layer(), asleepLayer)),
        ),
      ),
    ),
  )

describe("an overnight run's denial of a permission request", () => {
  test("comes once it has waited 30s, by tutti, in nobody's name, its turn going on", async () => {
    const seen = await watching(overnightDeny, true, (held) =>
      Effect.gen(function* () {
        const attention = yield* Attention
        const answered = yield* asks("p-1", "Bash", { command: "git push" })
        const [request] = yield* attention.current
        yield* seconds(29)
        const before = (yield* attention.current).length
        yield* seconds(1)
        return {
          blocks: attention.blocksAfter(request as AttentionRequest),
          before,
          after: (yield* attention.current).length,
          result: yield* settled(answered),
          tally: yield* attention.tally("p-1" as TicketId),
          records: yield* records,
          held: yield* held,
        }
      }),
    )
    // BLOCKED waits for the denial, and blockedAfter past it.
    expect(Duration.toMillis(seen.blocks)).toBe(
      Duration.toMillis(blockedAfter) + Duration.toMillis(overnightDenyAfter),
    )
    expect(seen.before).toBe(1)
    expect(seen.after).toBe(0)
    expect(seen.result).toEqual({
      behavior: "deny",
      message: `${tuttiDenialMessage}: ${overnightDenial}`,
      decisionClassification: "user_reject",
    })
    expect(seen.tally).toMatchObject({ permissions: 1, denied: 1 })
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({
        ticket: "p-1",
        answer: "deny",
        via: "overnight",
        after_ms: 30_000,
      }),
    ])
    expect(seen.held).toEqual([])
  })

  test("leaves a question, and a ticket it doesn't deny for, to BLOCKED", async () => {
    const deny: DenyOptions = { after: overnightDenyAfter, denies: (ticket) => ticket !== "x-1" }
    const seen = await watching(deny, false, (held) =>
      Effect.gen(function* () {
        const attention = yield* Attention
        yield* asks("q-1", "AskUserQuestion", question)
        yield* asks("x-1", "Bash", { command: "git push" })
        yield* minutes(1)
        const open = (yield* attention.current).map((request): string => request.ticket)
        yield* minutes(Duration.toMinutes(blockedAfter) - 1)
        return { open, held: [...(yield* held)].sort() }
      }),
    )
    expect(seen.open).toEqual(["q-1", "x-1"])
    expect(seen.held).toEqual(["q-1", "x-1"])
  })

  test("is too late for the maintainer's answer before it, and isn't given then", async () => {
    const seen = await watching(overnightDeny, true, () =>
      Effect.gen(function* () {
        const attention = yield* Attention
        const answered = yield* asks("p-1", "Bash", { command: "git push" })
        const [request] = yield* attention.current
        yield* seconds(10)
        yield* Effect.orDie(
          attention.answer((request as AttentionRequest).id, { _tag: "Allow" }, "screen"),
        )
        const result = yield* settled(answered)
        yield* seconds(30)
        return { result, records: yield* records }
      }),
    )
    expect(seen.result).toMatchObject({ behavior: "allow" })
    expect(answeredRecords(seen.records)).toEqual([
      expect.objectContaining({ ticket: "p-1", answer: "allow", via: "screen" }),
    ])
  })
})

describe("BLOCKED in an overnight run, for a ticket no fiber follows", () => {
  test("denies its requests rather than stop the run, and says so", async () => {
    const seen = await watching(undefined, true, (held) =>
      Effect.gen(function* () {
        const attention = yield* Attention
        const answered = yield* asks("p-1", "Bash", { command: "rm -rf build" })
        yield* minutes(Duration.toMinutes(blockedAfter) - 1)
        const before = (yield* attention.current).length
        yield* minutes(1)
        return {
          before,
          after: (yield* attention.current).length,
          held: yield* held,
          result: yield* settled(answered),
          records: yield* records,
        }
      }),
    )
    expect(seen.before).toBe(1)
    expect(seen.after).toBe(0)
    expect(seen.held).toEqual([])
    expect(seen.result).toMatchObject({
      behavior: "deny",
      message: `${tuttiDenialMessage}: ${overnightDenial}`,
    })
    expect(seen.records).toContainEqual(
      expect.objectContaining({
        kind: "warn",
        ticket: "p-1",
        text: "  p-1: its worker was blocked on a permission request for over 4m -> denied, the run being an overnight one, with nobody there to answer",
      }),
    )
    expect(seen.records.some((record) => record.kind === "stop")).toBe(false)
  })

  test("still holds a plain run", async () => {
    const seen = await watching(undefined, false, (held) =>
      Effect.gen(function* () {
        yield* asks("p-1", "Bash", { command: "rm -rf build" })
        yield* minutes(Duration.toMinutes(blockedAfter))
        return { held: yield* held, open: (yield* (yield* Attention).current).length }
      }),
    )
    expect(seen).toEqual({ held: ["p-1"], open: 1 })
  })
})

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-overnight-deny-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))

/** Claims its ticket, asks to push, works on a minute, then commits and closes it. */
const pushesThenFinishes = (world: World, root: string, id: TicketId): SessionScript =>
  turn(
    [
      ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
      canUseTool("Bash", { command: "git push" }),
      sleep("1 minute"),
      ...bash(
        `git commit -am "Change (${id})"`,
        orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
      ),
      ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
    ],
    result(`Closed ${id}.`),
  )

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}: ${(yield* texts).join("\n")}`)
  })

describe("a whole overnight run whose worker asks a permission", () => {
  test("has it denied after 30s, and the ticket goes on and merges", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const ran = await scenario(
      {
        config: {
          repo,
          settings: appConfig().settings,
          overnight: true,
          denyPermissions: overnightDenyAfter,
        },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        policy: waitForTest,
        scripts: (world: World) => ({
          "t-1": [pushesThenFinishes(world, root, "t-1" as TicketId)],
        }),
      },
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
          branch: "tutti/t-1",
          base: "main",
        })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        yield* untilLogged(/PERMISSION: t-1's worker/)
        for (let i = 0; i < 4; i++) {
          yield* advance("30 seconds")
          yield* Effect.promise(() => Bun.sleep(3))
        }
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done" })
    expectLog(ran, [
      /^ {2}PERMISSION: t-1's worker: Bash\(git push\) denied \(.*\), by tutti, the run being an overnight one$/,
      /^ {2}t-1 closed .*; merged into main/,
    ])
    expect(ran.log.some((text) => /BLOCKED|set aside|deferred/.test(text))).toBe(false)
    expect(ran.sent).toContainEqual(
      expect.objectContaining({
        _tag: "Answered",
        ticket: "t-1",
        result: expect.objectContaining({ behavior: "deny" }),
      }),
    )
  })
})

describe("the pre-flight's check of the ask rules", () => {
  test("reads permissions.ask of a settings file, and nothing else", () => {
    expect(
      askRulesOf(
        JSON.stringify({
          permissions: {
            allow: ["Bash(ls)"],
            ask: ["Bash(git push:*)", 3, "", "Bash(bd create:*)"],
          },
        }),
      ),
    ).toEqual(["Bash(git push:*)", "Bash(bd create:*)"])
    for (const text of ["", "not json", "[]", "null", '{"permissions":{"ask":"Bash"}}', "{}"]) {
      expect(askRulesOf(text)).toEqual([])
    }
  })

  test("reads any text without throwing, giving only its non-empty strings", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        for (const rule of askRulesOf(text)) {
          expect(typeof rule).toBe("string")
          expect(rule.trim()).not.toBe("")
        }
      }),
    )
  })

  test("warns of each file with some, naming the first three, and passes without", async () => {
    const repo = folder("ask")
    mkdirSync(join(repo, ".claude"))
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ permissions: { ask: ["Bash(git push:*)"] } }),
    )
    writeFileSync(
      join(repo, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { ask: ["A", "B", "C", "D", "E"] } }),
    )
    const files = workerSettingsFiles(join(repo, "no-home", "settings.json"), repo)
    const found = await Effect.runPromise(
      readAskRules(files).pipe(Effect.provide(BunServices.layer)),
    )
    expect(found).toEqual([
      { file: join(repo, ".claude", "settings.json"), rules: ["Bash(git push:*)"] },
      { file: join(repo, ".claude", "settings.local.json"), rules: ["A", "B", "C", "D", "E"] },
    ])
    const check = askRulesCheck(found, "30s")
    expect(check.verdict).toBe("warned")
    expect(check.text).toBe(
      `permissions.ask rules in ${repo}/.claude/settings.json (Bash(git push:*)); ${repo}/.claude/settings.local.json (A, B, C, and 2 more) make a worker ask, even in auto mode: overnight, tutti denies each such request after 30s, nobody being there to answer, and a ticket that needs one is left undone. Move the rules a ticket needs to permissions.allow for the night`,
    )
    expect(askRulesCheck([], "30s")).toEqual({
      verdict: "passed",
      text: "no permissions.ask rules in the settings workers load",
    })
  })

  test("finds the user's settings in CLAUDE_CONFIG_DIR, else in HOME's .claude", async () => {
    const at = (env: Record<string, string>) =>
      Effect.runPromise(
        claudeUserSettingsFile.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        ),
      )
    expect(await at({ CLAUDE_CONFIG_DIR: "/c", HOME: "/h" })).toBe("/c/settings.json")
    expect(await at({ CLAUDE_CONFIG_DIR: "", HOME: "/h" })).toBe("/h/.claude/settings.json")
  })
})
