// A worker's compactions (§ 4.2, "The callbacks also record compactions, for triage and the
// reviewer"): each PreCompact hook callback is counted in its ticket's tally and logged as orchestra
// logs it (`A's worker's context was compacted (auto)`), with an `info` record. Through the live
// host's callbacks, fired by the fake Claude Code (test/fixtures/fake-claude/claude.ts), and in a
// whole run, where the reviewer is told how often the worker was compacted.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { Organs } from "../src/organs/Organs.ts"
import { makePrinter } from "../src/print/organLine.ts"
import { noteCompaction, noteCompactions } from "../src/run/compactions.ts"
import type { EventRecord, Info } from "../src/run/events.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Cause } from "../src/run/phase.ts"
import { reportsDir } from "../src/run/report.ts"
import { finish, run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import { bash, hook, result, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { testEnv } from "./env.ts"
import { backlog, expectLog, scenario, type World } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-compactions-${name}-`)))

/** The PreCompact hook's input, as Claude Code gives it. */
const preCompact = (trigger: "auto" | "manual") => ({
  hook_event_name: "PreCompact",
  trigger,
  custom_instructions: null,
})

/** The compaction lines logged so far. */
const compactionLines = Effect.map(texts, (all) => all.filter((each) => each.includes("compacted")))

/** The `info` records about compactions captured so far. */
const compactionInfos = Effect.map(
  Effect.flatMap(Captured, (captured) => captured.records),
  (records) =>
    records.filter(
      (r): r is EventRecord & typeof Info.Type => r.kind === "info" && r.text.includes("compacted"),
    ),
)

/** Takes `ticket` into the ledger and dispatches it, as the run does. */
const dispatched = (ticket: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.transition(ticket, Cause.Ready(), { title: `Ticket ${ticket}` })
    yield* ledger.transition(ticket, Cause.Dispatched())
  })

/** The ticket's compactions tally now. */
const tallyOf = (ticket: string) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state) => state.tickets.get(ticket)?.tallies.compactions,
  )

describe("the live host's PreCompact callback", () => {
  test("is counted in the ticket's tally and logged, with an info record, each time", async () => {
    const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")
    const dir = folder("live")
    const scenario = {
      log: join(dir, "fake.jsonl"),
      turns: [
        [{ hook: preCompact("auto") }, { text: "Carrying on." }, { hook: preCompact("manual") }],
      ],
    }
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: { servers: [], note: noServersNote },
      account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
      env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) },
    })
    const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        yield* dispatched("t-5")
        yield* Effect.forkChild(noteCompactions, { startImmediately: true })
        const agents = yield* AgentHost
        yield* agents.start("t-5", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
        yield* agents.send("t-5", "Work on t-5.", "clientComposed")
        const idle = yield* agents.state("t-5").pipe(
          Stream.filter((s) => s._tag === "Idle"),
          Stream.runHead,
          Effect.timeout(Duration.seconds(10)),
        )
        // The callbacks record in fibers of their own: wait for both to be counted.
        const counted = yield* (yield* Ledger).changes.pipe(
          Stream.filter((state) => state.tickets.get("t-5")?.tallies.compactions === 2),
          Stream.runHead,
          Effect.timeout(Duration.seconds(10)),
        )
        return {
          idle: Option.isSome(idle),
          counted: Option.isSome(counted),
          tally: yield* tallyOf("t-5"),
          lines: yield* compactionLines,
          infos: yield* compactionInfos,
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          host.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                attentionLayer(waitForTest),
                transcriptsLayer(),
                ClaudeCode.layer,
                Ledger.layer,
              ),
            ),
            Layer.provideMerge(
              Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
            ),
          ),
        ),
      ),
    )
    expect(seen.idle).toBe(true)
    expect(seen.counted).toBe(true)
    expect(seen.tally).toBe(2)
    expect(seen.lines).toEqual([
      "  t-5's worker's context was compacted (auto)",
      "  t-5's worker's context was compacted (manual)",
    ])
    expect(seen.infos.map((r) => [r.ticket, r.text])).toEqual([
      ["t-5", "  t-5's worker's context was compacted (auto)"],
      ["t-5", "  t-5's worker's context was compacted (manual)"],
    ])
  })
})

describe("noteCompaction", () => {
  test("a worker whose ticket the run hasn't taken up, as the probe's, is neither counted nor logged", async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        yield* dispatched("t-1")
        yield* noteCompaction({ ticket: "probe", trigger: "auto" })
        return {
          tickets: [...(yield* (yield* Ledger).current).tickets.keys()],
          tally: yield* tallyOf("t-1"),
          lines: yield* compactionLines,
          infos: yield* compactionInfos,
        }
      }).pipe(Effect.provide(ledgerLayer())),
    )
    expect(seen.tickets).toEqual(["t-1"])
    expect(seen.tally).toBe(0)
    expect(seen.lines).toEqual([])
    expect(seen.infos).toEqual([])
  })

  test("a trigger that isn't one word is logged as one sanitised line", async () => {
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        yield* dispatched("t-1")
        yield* noteCompaction({ ticket: "t-1", trigger: "auto\n\u001b[31mred" })
        return yield* compactionLines
      }).pipe(Effect.provide(ledgerLayer())),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain("\n")
    expect(lines[0]).not.toContain("\u001b")
  })
})

describe("a whole run", () => {
  test("logs the worker's compaction and tells the reviewer it was compacted once", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const calls: Array<OrganCallRecord> = []
    const organs = Organs.layer.pipe(
      Layer.provideMerge(cannedLayer({ reviewer: { report: "The run merged t-1.\n" } }, calls)),
    )
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
    // Claims its ticket, is compacted, commits and closes it.
    const compactsAndCloses = (world: World): SessionScript =>
      turn(
        [
          ...bash(
            "bd update t-1 --claim",
            Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
          ),
          hook(preCompact("auto")),
          ...bash(
            'git commit -am "Change (t-1)"',
            Effect.asVoid(
              Effect.orDie(
                world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
              ),
            ),
          ),
          ...bash("bd close t-1", Effect.asVoid(Effect.orDie(world.beads.close("t-1", "done")))),
        ],
        result("Closed t-1."),
      )
    const ran = await scenario(
      {
        config: { repo },
        git: { dir: repo },
        worktrees: { root },
        backlog: backlog().ticket("t-1").seeds,
        scripts: (world) => ({ "t-1": [compactsAndCloses(world)] }),
      },
      Effect.gen(function* () {
        yield* (yield* Git).addWorktree(repo, join(root, "t-1"), {
          branch: "tutti/t-1",
          base: "main",
        })
        const running = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", endLater: true }),
        )
        const outcome = yield* Fiber.join(running)
        const out = { write: () => {}, columns: () => 100, tty: false }
        yield* finish(
          outcome,
          Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }),
          false,
        )
        const dir = join(repo, reportsDir)
        const [name] = existsSync(dir) ? readdirSync(dir) : []
        return {
          infos: yield* compactionInfos,
          input: calls.find((each) => each.call.organ === "reviewer")?.input ?? "",
          report: name === undefined ? "" : readFileSync(join(dir, name), "utf8"),
        }
      }).pipe(Effect.provide(organs)),
    )
    if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
    const { infos, input } = ran.exit.value
    expectLog(ran, ["  t-1's worker's context was compacted (auto)"])
    expect(infos.map((r) => r.ticket)).toEqual(["t-1"])
    expect(input).toContain("compacted once")
  })
})
