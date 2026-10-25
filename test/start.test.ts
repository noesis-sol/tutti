import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit } from "effect"
import fc from "fast-check"
import { AgentGone, AgentHost } from "../src/agent/AgentHost.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import {
  earlierNote,
  type FirstMessage,
  firstMessage,
  listedAtMost,
  type Start,
  type StartTicket,
  specOf,
  start,
} from "../src/run/start.ts"
import type { TicketId } from "../src/services/Beads.ts"
import type { Commit, Sha, StatusEntry } from "../src/services/Git.ts"
import { Store, type TicketRecord } from "../src/services/Store.ts"
import { type Earlier, nothingEarlier } from "../src/services/Worktrees.ts"
import { failStart, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { backlog, expectEvents, expectLog, type Ran, type Setup, scenario } from "./harness.ts"

const message = (fields: Partial<FirstMessage> = {}): FirstMessage => ({
  id: "t-1" as TicketId,
  branch: "tutti/t-1",
  base: "main",
  ticketLimit: null,
  scope: null,
  spec: null,
  earlier: nothingEarlier,
  ...fields,
})

const commit = (hash: string, subject: string): Commit => ({
  hash: hash as Sha,
  subject,
  message: `${subject}\n`,
})

const leftBehind: Earlier = {
  commits: [
    commit("abcdef1234567890abcdef1234567890abcdef12", "Half of it (t-1)"),
    commit("1234567890abcdef1234567890abcdef12345678", "Start on it (t-1)"),
  ],
  status: [
    { code: " M", path: "src/a.ts" },
    { code: "R ", path: "src/b.ts", from: "src/c.ts" },
    { code: "??", path: "notes.md" },
  ],
}

describe("firstMessage", () => {
  test("names the ticket and points to the rules in the system prompt", () => {
    expect(firstMessage(message())).toBe(
      "Your ticket is t-1. Your standing rules for it are in your system prompt: follow them " +
        "exactly, from claiming the ticket to closing it.\n",
    )
  })

  test("carries the spec, the time the ticket has and the --ticket scope line", () => {
    const text = firstMessage(
      message({
        spec: "docs/spec.md",
        ticketLimit: Duration.minutes(90),
        scope: "t-epic" as TicketId,
      }),
    )
    expect(text).toContain(
      "t-1 is part of the spec at docs/spec.md: read the sections of it that t-1 cites before " +
        "you start, and treat the spec as settled.",
    )
    expect(text).toContain(
      "You have about 1h30m for this ticket: a worker still going after that stops the run, so " +
        "pace yourself to it.",
    )
    expect(text).toContain(
      "This run works on t-epic and its subtickets only. File a follow-up that belongs to this " +
        "work as a child of t-epic (bd create --parent t-epic …) so this run picks it up; " +
        "anything else waits for a later run.",
    )
    expect(text).not.toContain("earlier attempt")
  })

  test("leaves out the scope line when the run is scoped to the ticket itself", () => {
    expect(firstMessage(message({ scope: "t-1" as TicketId }))).not.toContain("This run works on")
  })

  test("lists what an earlier attempt left: its commits and git status", () => {
    const text = firstMessage(message({ earlier: leftBehind }))
    expect(text).toContain(
      "An earlier attempt at this ticket left work on tutti/t-1: 2 commits that main doesn't " +
        "have and uncommitted changes. Read it before anything else, then build on it, or revert " +
        "it deliberately; don't start over, and don't commit or discard it unread.",
    )
    expect(text).toContain(
      "git log main..HEAD:\n\n    abcdef1 Half of it (t-1)\n    1234567 Start on it (t-1)",
    )
    expect(text).toContain(
      "git status:\n\n     M src/a.ts\n    R  src/c.ts -> src/b.ts\n    ?? notes.md",
    )
  })

  test("says one commit, or only uncommitted changes, as the attempt left them", () => {
    const [first] = leftBehind.commits
    expect(earlierNote("tutti/t-1", "main", { commits: [first as Commit], status: [] })).toContain(
      "left work on tutti/t-1: 1 commit that main doesn't have.",
    )
    const changes = earlierNote("tutti/t-1", "main", { commits: [], status: leftBehind.status })
    expect(changes).toContain("left work on tutti/t-1: uncommitted changes.")
    expect(changes).not.toContain("git log")
  })

  test("lists at most so many commits and counts the rest", () => {
    const commits = Array.from({ length: listedAtMost + 5 }, (_, i) =>
      commit(`${String(i).padStart(7, "0")}${"0".repeat(33)}`, `Commit ${i}`),
    )
    const text = earlierNote("tutti/t-1", "main", { commits, status: [] })
    expect(text).toContain(`Commit ${listedAtMost - 1}`)
    expect(text).not.toContain(`Commit ${listedAtMost}\n`)
    expect(text).toContain("    … and 5 more")
  })

  test("puts each commit and file on one line of its own, whatever a worker wrote", () => {
    const entry = fc.record({
      code: fc.constantFrom(" M", "M ", "??", "R ", "UU"),
      path: fc.string({ minLength: 1 }),
    })
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 5 }),
        fc.array(entry, { maxLength: 5 }),
        (subjects, status) => {
          const earlier: Earlier = {
            commits: subjects.map((subject, i) => commit(`${i}`.padStart(40, "a"), subject)),
            status: status as ReadonlyArray<StatusEntry>,
          }
          const lines = firstMessage(message({ earlier })).split("\n")
          const listed = lines.filter((line) => line.startsWith("    "))
          expect(listed).toHaveLength(subjects.length + status.length)
          for (const line of lines) {
            expect(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(line)).toBe(false)
          }
        },
      ),
    )
  })
})

describe("specOf", () => {
  test("is the path the metadata's spec names", () => {
    expect(specOf({ spec: " docs/spec.md " })).toBe("docs/spec.md")
    expect(specOf({})).toBeNull()
    expect(specOf({ spec: "" })).toBeNull()
    expect(specOf({ spec: 3 })).toBeNull()
    expect(specOf({ spec: "a\nb" })).toBeNull()
  })

  test("is null or one printable line, whatever the metadata holds", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const spec = specOf({ spec: value })
        if (spec !== null) {
          expect(spec).toBe(String(value).trim())
          expect(/[\p{C}\n]/u.test(spec)).toBe(false)
        }
      }),
    )
  })
})

/** A temp folder for worktrees, with `t-1`'s made already when an earlier attempt left it. */
const worktreesRoot = (made: ReadonlyArray<string> = []) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-start-")))
  for (const id of made) mkdirSync(join(root, id))
  return root
}

/** What a start gave, the ticket's phase after it, and what state.json had on the ticket. */
interface Started {
  readonly start: Start
  readonly phase: TicketPhase | undefined
  readonly record: TicketRecord | undefined
  /** What state.json had on the ticket as its session started, if it was started. */
  readonly atStart: ReadonlyArray<TicketRecord | undefined>
}

/** Dispatches `ticket` and starts it on main, in the run's scenario. */
const starting = (
  ticket: StartTicket,
  setup: Setup,
  send?: AgentHost["Service"]["send"],
): Promise<Ran<Started>> =>
  scenario(
    setup,
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const store = yield* Store
      const host = yield* AgentHost
      yield* ledger.transition(ticket.id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(ticket.id, Move.Dispatched())
      // The host as the run sees it, noting what state.json has on the ticket as its session starts.
      const atStart: Array<TicketRecord | undefined> = []
      const watched = AgentHost.of({
        ...host,
        send: send ?? host.send,
        start: (id, session) =>
          Effect.andThen(
            Effect.map(store.ticket(id), (record) => void atStart.push(record)),
            host.start(id, session),
          ),
      })
      const started = yield* start(ticket, "main").pipe(Effect.provideService(AgentHost, watched))
      return {
        start: started,
        phase: (yield* ledger.current).tickets.get(ticket.id)?.phase,
        record: yield* store.ticket(ticket.id),
        atStart,
      } satisfies Started
    }).pipe(Effect.provide(Ledger.layer)),
  )

const result = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the start failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The default settings, with workers.ticket_limit set. */
const withTicketLimit = (limit: Duration.Duration) => {
  const { settings } = appConfig()
  return { ...settings, workers: { ...settings.workers, ticket_limit: limit } }
}

const t1: StartTicket = { id: "t-1" as TicketId, title: "One ticket", metadata: {} }

describe("start", () => {
  test("a fresh start: a new worktree, the session ID saved, the session started and told", async () => {
    const root = worktreesRoot()
    const ran = await starting(
      { ...t1, metadata: { spec: "docs/spec.md" } },
      {
        backlog: backlog().ticket("t-1", { title: "One ticket" }).seeds,
        scripts: { "t-1": [turn([])] },
        worktrees: { root },
        config: { ticket: "t-epic" as TicketId },
      },
    )
    const started = result(ran)
    expect(started.start._tag).toBe("Started")
    if (started.start._tag !== "Started") return
    const { worker } = started.start
    const path = join(root, "t-1")
    expect(worker.worktree).toMatchObject({ path, branch: "tutti/t-1", reused: false })
    expect(ran.worktreeCalls).toEqual([{ op: "prepare", id: "t-1" as TicketId }])
    expect(started.record).toMatchObject({
      session: worker.session,
      worktree: path,
      branch: "tutti/t-1",
    })
    expect(ran.sent.map((sent) => sent._tag)).toEqual(["Started", "Message"])
    const [first, second] = ran.sent
    expect(first).toMatchObject({
      ticket: "t-1",
      session: { sessionId: worker.session, cwd: path },
    })
    expect(second?._tag === "Message" ? second.message : undefined).toMatchObject({
      client_composed: true,
      uuid: worker.message,
      session_id: worker.session,
      message: {
        content: firstMessage({
          id: "t-1" as TicketId,
          branch: "tutti/t-1",
          base: "main",
          ticketLimit: null,
          scope: "t-epic" as TicketId,
          spec: "docs/spec.md",
          earlier: nothingEarlier,
        }),
      },
    })
    expect(started.phase?._tag).toBe("Working")
    expectLog(ran, [`  worktree ${path} on tutti/t-1`])
    expect(existsSync(join(path, ".tutti", "run"))).toBe(true)
  })

  test("the session ID is saved in state.json once the session has begun, not before", async () => {
    const ran = await starting(t1, {
      backlog: backlog().ticket("t-1").seeds,
      scripts: { "t-1": [turn([])] },
    })
    const started = result(ran)
    if (started.start._tag !== "Started") throw new Error("not started")
    expect(started.atStart).toHaveLength(1)
    expect(started.atStart[0]?.session).toBeUndefined()
    expect(started.record?.session).toBe(started.start.worker.session)
    expect(started.start.worker.session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test("each start draws a new session ID", async () => {
    const ids = await Promise.all(
      [1, 2].map(async () => {
        const started = result(
          await starting(t1, {
            backlog: backlog().ticket("t-1").seeds,
            scripts: { "t-1": [turn([])] },
          }),
        )
        return started.start._tag === "Started" ? started.start.worker.session : ""
      }),
    )
    expect(ids[0]).not.toBe(ids[1])
  })

  test("a reused worktree: the first message names what the earlier attempt left", async () => {
    const root = worktreesRoot(["t-1"])
    const ran = await starting(t1, {
      backlog: backlog().ticket("t-1").seeds,
      scripts: { "t-1": [turn([])] },
      worktrees: { root, earlier: { "t-1": leftBehind } },
      config: { settings: withTicketLimit(Duration.minutes(30)) },
    })
    const started = result(ran)
    expect(started.start._tag).toBe("Started")
    const sent = ran.sent.find((each) => each._tag === "Message")
    const text = sent?._tag === "Message" ? String(sent.message.message.content) : ""
    expect(text).toContain("Your ticket is t-1.")
    expect(text).toContain("You have about 30m for this ticket")
    expect(text).toContain(
      "An earlier attempt at this ticket left work on tutti/t-1: 2 commits that main doesn't " +
        "have and uncommitted changes.",
    )
    expect(text).toContain("    abcdef1 Half of it (t-1)")
    expect(text).toContain("    R  src/c.ts -> src/b.ts")
    expectLog(ran, [`  reusing worktree ${join(root, "t-1")} (tutti/t-1)`])
  })

  test("a start that fails sets the ticket aside, its worktree left and its session forgotten", async () => {
    const root = worktreesRoot()
    const ran = await starting(t1, {
      backlog: backlog().ticket("t-1", { title: "One ticket" }).seeds,
      scripts: { "t-1": [[failStart("Claude Code exited", "cwd_unavailable")]] },
      worktrees: { root },
    })
    const started = result(ran)
    expect(started.start).toMatchObject({
      _tag: "SetAside",
      why: "its worker didn't start",
      deferred: true,
    })
    expect(started.phase).toMatchObject({ _tag: "Deferred", why: "its worker didn't start" })
    expect(started.record?.session).toBeUndefined()
    expect(ran.sent.map((sent) => sent._tag)).toEqual(["Started", "Ended"])
    const issue = ran.issues.find((each) => each.id === "t-1")
    expect(issue?.status).toBe("deferred")
    expect(issue?.notes).toContain("tutti: t-1's worker didn't start")
    const path = join(root, "t-1")
    expectLog(ran, [
      `  START_FAILED: t-1's worker didn't start: Claude Code refused to start: cwd_unavailable -> deferred; worktree ${path} left as it is`,
    ])
    expectEvents(ran, ["phase", "deferred"])
    expect(ran.events.find((each) => each.kind === "deferred")).toMatchObject({
      ticket: "t-1",
      title: "One ticket",
      detail: "its worker didn't start",
    })
    expect(existsSync(path)).toBe(true)
  })

  test("a session that ends before its first message sets the ticket aside", async () => {
    // As the live host has it when the session went before the message was pushed.
    const ran = await starting(
      t1,
      { backlog: backlog().ticket("t-1").seeds, scripts: { "t-1": [turn([])] } },
      (ticket) => Effect.fail(new AgentGone({ ticket, why: "it has no open session" })),
    )
    expect(result(ran).start).toMatchObject({ _tag: "SetAside", deferred: true })
    expectLog(ran, [/START_FAILED: t-1's worker didn't start: its session ended at once/])
  })

  test("BAD_TICKET_ID: an ID that can't name a worktree is set aside before anything is made", async () => {
    const id = "t-..x" as TicketId
    const ran = await starting(
      { id, title: "Bad", metadata: {} },
      { backlog: backlog().ticket(id, { title: "Bad" }).seeds, scripts: {} },
    )
    const started = result(ran)
    expect(started.start).toMatchObject({ _tag: "SetAside", deferred: true })
    expect(started.phase?._tag).toBe("Deferred")
    expect(ran.worktreeCalls).toEqual([])
    expect(ran.sent).toEqual([])
    expect(started.record).toBeUndefined()
    expectLog(ran, [
      `  BAD_TICKET_ID: IDs with path characters can't be run: ${id} -> deferred without starting a worker; rename it (bd rename ${id} <new-id>), then bd undefer <new-id>`,
    ])
    expect(ran.issues.find((each) => each.id === id)?.status).toBe("deferred")
  })

  test("RUN_FILES_OUTSIDE: a link in place of .tutti sets the ticket aside without a session", async () => {
    const root = worktreesRoot(["t-1"])
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "tutti-outside-")))
    symlinkSync(outside, join(root, "t-1", ".tutti"))
    const ran = await starting(t1, {
      backlog: backlog().ticket("t-1").seeds,
      scripts: { "t-1": [turn([])] },
      worktrees: { root },
    })
    const started = result(ran)
    expect(started.start).toMatchObject({
      _tag: "SetAside",
      why: "its worktree's .tutti is a symlink",
      deferred: true,
    })
    expect(started.phase?._tag).toBe("Deferred")
    expect(ran.sent).toEqual([])
    expect(started.record).toBeUndefined()
    const link = join(root, "t-1", ".tutti")
    expectLog(ran, [
      `  RUN_FILES_OUTSIDE: its worktree's .tutti is a symlink -> t-1 deferred without starting a worker; remove the link ${link}, then bd undefer t-1`,
    ])
    expect(existsSync(join(outside, "run"))).toBe(false)
  })

  test("a run folder that can't be opened is a failed start: set aside", async () => {
    const root = worktreesRoot(["t-1"])
    writeFileSync(join(root, "t-1", ".tutti"), "not a folder\n")
    const ran = await starting(t1, {
      backlog: backlog().ticket("t-1").seeds,
      scripts: { "t-1": [turn([])] },
      worktrees: { root },
    })
    expect(result(ran).start).toMatchObject({ _tag: "SetAside", why: "its worker didn't start" })
    expect(ran.sent).toEqual([])
    expectLog(ran, [/START_FAILED: t-1's worker didn't start: its \.tutti\/run can't be opened: /])
  })

  test("DEFER_FAILED: a ticket bd can't defer is still kept out of the run", async () => {
    const id = "t-..x" as TicketId
    const ran = await starting({ id, title: "Bad", metadata: {} }, { scripts: {} })
    const started = result(ran)
    expect(started.start).toMatchObject({ _tag: "SetAside", deferred: false })
    expect(started.phase?._tag).toBe("Deferred")
    expectLog(ran, [
      /^ {2}DEFER_FAILED: IDs with path characters can't be run: t-\.\.x, and bd could not defer it: .*; kept out of this run, rename it with: bd rename t-\.\.x <new-id>$/,
    ])
    expect(ran.events.find((each) => each.kind === "warn")).toMatchObject({
      ticket: id,
      aside: true,
    })
  })
})
