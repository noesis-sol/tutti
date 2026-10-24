// The run's notifications (§ 7.9, notices.ts): what each record of the event stream notifies, in
// orchestra's words, the layer that sends them, and a whole run's notices.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { Event } from "../src/run/events.ts"
import { EventStream } from "../src/run/eventstream.ts"
import { line } from "../src/run/log.ts"
import { about, finished, notice, noticeWidth, notifying } from "../src/run/notices.ts"
import type { PhaseTag } from "../src/run/phase.ts"
import { run } from "../src/run/run.ts"
import { Git } from "../src/services/Git.ts"
import {
  bash,
  canUseTool,
  defers,
  result,
  type SessionScript,
  tool,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as appConfigLayer } from "../src/testing/AppConfig.ts"
import { layer as eventsLayer, Captured as Records } from "../src/testing/EventStream.ts"
import { Captured, layer as capturedLayer } from "../src/testing/Notifier.ts"
import { backlog, expectExitCode, scenario, type World } from "./harness.ts"

setDefaultTimeout(30_000)

const permission = (ticket: string, tool: string, summary: string): Event => ({
  kind: "attention",
  ticket,
  request: "r-1",
  type: "permission",
  tool,
  summary,
  default_to_no: false,
})

describe("notice", () => {
  test("says each outcome as orchestra does", () => {
    expect(
      notice({ kind: "closed", ticket: "t-12", title: "Add a --json flag to list", text: "" }),
    ).toBe("Closed t-12 · Add a --json flag to list")
    expect(
      notice({ kind: "deferred", ticket: "t-12", title: "x", detail: "by the worker", text: "" }),
    ).toBe("Set aside t-12 · by the worker")
    expect(
      notice({ kind: "warn", ticket: "t-12", aside: true, detail: "checks failed", text: "" }),
    ).toBe("Set aside t-12 · checks failed")
    expect(
      notice({
        kind: "asked",
        ticket: "t-12",
        title: "x",
        detail: "t-40: Which name should the flag have?",
        text: "",
      }),
    ).toBe("t-12 needs your answer · Which name should the flag have?")
    expect(notice({ kind: "stop", detail: "PAUSED", ticket: "t-12", text: "" })).toBe(
      "Stopped: PAUSED on t-12",
    )
    expect(notice({ kind: "stop", detail: "INTERRUPTED", text: "" })).toBe("Stopped: INTERRUPTED")
    expect(notice(permission("t-12", "Bash", "rm -rf build"))).toBe(
      "t-12 needs you · Allow Bash(rm -rf build)?",
    )
    expect(notice({ kind: "full_check", detail: "failed", suite: "test/e2e", text: "" })).toBe(
      "Full check failed · test/e2e",
    )
    expect(notice({ kind: "full_check", detail: "timed out", text: "" })).toBe(
      "Full check failed · setup",
    )
  })

  test("says a question a worker asks on screen", () => {
    expect(
      notice({
        kind: "attention",
        ticket: "t-3",
        request: "r-2",
        type: "question",
        questions: [{ question: "Which cache?", options: [{ label: "build" }] }],
        default_to_no: false,
      }),
    ).toBe("t-3 needs you · Which cache?")
  })

  test("doesn't notify the rest", () => {
    const quiet: ReadonlyArray<Event> = [
      { kind: "warn", ticket: "t-1", text: "LONG_RUNNING: t-1" },
      { kind: "warn", aside: true, text: "no ticket" },
      { kind: "hold", text: "HOLD: ENVIRONMENT" },
      { kind: "done", text: "READY_EMPTY" },
      { kind: "info", text: "worktree made" },
      { kind: "full_check", detail: "passed", text: "" },
      { kind: "usage_limit", status: "rejected", limit: "five_hour" },
      { kind: "triage", ticket: "t-1", title: "flaky", text: "" },
    ]
    for (const event of quiet) expect(notice(event)).toBeNull()
    expect(notice(permission("t-1", "Bash", "ls"), false)).toBeNull()
  })

  test("finished counts the tickets closed, set aside and needing you, as the totals do", () => {
    const tags = (...all: ReadonlyArray<PhaseTag>) => all.map((_tag) => ({ _tag }))
    expect(
      finished([
        ...tags(...Array<PhaseTag>(12).fill("Done")),
        ...tags("Deferred", "Review", "Blocked", "Asked", "Queued", "Waiting", "Stopped"),
      ]),
    ).toBe("Finished the run · 12 tickets closed · 2 set aside · 2 need you")
    expect(finished(tags("Done", "Blocked"))).toBe(
      "Finished the run · 1 ticket closed · 1 needs you",
    )
    expect(finished(tags("Done", "Review"))).toBe(
      "Finished the run · 1 ticket closed · 1 set aside",
    )
    expect(finished([])).toBe("Finished the run · no tickets closed")
  })

  test("about cuts a title longer than 60 characters with …, on one line", () => {
    const long = "word ".repeat(30)
    const said = about("Closed t-1", long)
    expect(said.startsWith("Closed t-1 · word word")).toBe(true)
    expect(said.endsWith("…")).toBe(true)
    expect([...said.slice("Closed t-1 · ".length)].length).toBeLessThanOrEqual(noticeWidth)
    expect(about("Closed t-1", "  two\n\tlines  ")).toBe("Closed t-1 · two lines")
    expect(about("Closed t-1", "")).toBe("Closed t-1")
  })

  test("about keeps any title a ticket author wrote to 60 characters, on one line", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (title) => {
        const said = about("Closed t-1", title)
        const over = said === "Closed t-1" ? "" : said.slice("Closed t-1 · ".length)
        expect(said.startsWith("Closed t-1")).toBe(true)
        expect([...over].length).toBeLessThanOrEqual(noticeWidth)
        expect(over).not.toMatch(/\s{2}|^\s|[\n\r\t]/u)
      }),
    )
  })
})

/** The notices `events` give through the notifying EventStream, TestClock moved on by `gaps`. */
const notified = (events: ReadonlyArray<Event | number>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stream = yield* EventStream
      for (const event of events) {
        if (typeof event === "number") yield* TestClock.adjust(event)
        else yield* stream.emit(event)
      }
      return {
        notices: yield* (yield* Captured).notices,
        records: (yield* (yield* Records).records).length,
      }
    }).pipe(
      Effect.provide(
        notifying.pipe(
          Layer.provideMerge(Layer.mergeAll(eventsLayer(), capturedLayer)),
          Layer.provideMerge(Layer.mergeAll(appConfigLayer(), TestClock.layer())),
        ),
      ),
    ),
  )

describe("the notifying EventStream", () => {
  test("records every event and notifies those that notify", async () => {
    const given = await notified([
      { kind: "info", text: "worktree made" },
      { kind: "closed", ticket: "t-1", title: "One", text: "" },
    ])
    expect(given).toEqual({ notices: ["Closed t-1 · One"], records: 2 })
  })

  test("notifies the first request in 30 seconds", async () => {
    const given = await notified([
      permission("t-1", "Bash", "rm -rf build"),
      permission("t-2", "Bash", "ls"),
      29_999,
      permission("t-3", "Edit", "a.ts"),
      1,
      permission("t-4", "Bash", "make"),
    ])
    expect(given.notices).toEqual([
      "t-1 needs you · Allow Bash(rm -rf build)?",
      "t-4 needs you · Allow Bash(make)?",
    ])
  })

  test("notifies a stop once, though the run's closing line records it again", async () => {
    const given = await notified([
      { kind: "stop", detail: "PAUSED", ticket: "t-1", text: "PAUSED: t-1" },
      { kind: "stop", detail: "PAUSED", ticket: "t-1", text: "PAUSED: t-1; TICKET_LIMIT: t-2" },
    ])
    expect(given.notices).toEqual(["Stopped: PAUSED on t-1"])
  })
})

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-notices-${name}-`)))

/** Claims its ticket, runs `commands` once allowed to, commits and closes it, as a worker does. */
const finishes = (
  world: World,
  root: string,
  id: string,
  commands: ReadonlyArray<string>,
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...commands.flatMap((command) => [
        canUseTool("Bash", { command }),
        ...tool("Bash", { command }),
      ]),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

describe("a whole run", () => {
  test("notifies what needs you, what merged, what was set aside, and that it finished", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const tickets = ["t-1", "t-2"]
    const ran = await scenario(
      {
        config: { repo, settings: { ...appConfig().settings, concurrent: 1 } },
        backlog: backlog().ticket("t-1", { title: "Add a flag" }).ticket("t-2").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({
          "t-1": [finishes(world, root, "t-1", ["rm -rf build", "rm -rf dist"])],
          "t-2": [
            defers("t-2", {
              claim: Effect.asVoid(Effect.orDie(world.beads.update("t-2", { claim: true }))),
              defer: Effect.asVoid(Effect.orDie(world.beads.defer("t-2"))),
            }),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of tickets) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        return yield* run({ version: "0.1.0-test", base: "main", start: [line`START tutti`] })
      }),
    )
    expectExitCode(ran, 0)
    expect(ran.notices).toEqual([
      "t-1 needs you · Allow Bash(rm -rf build)?",
      "Closed t-1 · Add a flag",
      "Set aside t-2 · by the worker",
      "Finished the run · 1 ticket closed · 1 set aside",
    ])
  })
})
