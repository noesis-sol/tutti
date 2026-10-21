import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CanUseTool, OnElicitation } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Layer, Schedule, Stream, SubscriptionRef } from "effect"
import fc from "fast-check"
import { AgentHost, type Session } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import {
  featureLead,
  featureRequestFile,
  filedPlan,
  firstMessage,
  InterviewEnd,
  interviewPrompt,
  interviewWorker,
  pasted,
  startInterview,
} from "../src/agent/interview.ts"
import {
  Filing,
  filedSomething,
  type InterviewTools,
  makeInterviewTools,
  serverName,
  ticketLine,
} from "../src/agent/interviewTools.ts"
import type { ChosenServers } from "../src/agent/mcp.ts"
import {
  allowOwnTools,
  interviewBuiltins,
  interviewOptions,
  type WorkerCallbacks,
} from "../src/agent/options.ts"
import { type AppConfig, defaultSettings } from "../src/cli/AppConfig.ts"
import { maxPlanned } from "../src/project/planFile.ts"
import { Beads, BeadsFailed } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import {
  gone as goneStep,
  init,
  Recording,
  result,
  type Script,
  layer as scriptedHost,
  sessionState,
  tool,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

/** A new folder, its real path: the main checkout, where .tutti/run/ is written. */
const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-interview-")))

/** The main checkout's files, in git. */
const repoFiles: Readonly<Record<string, string>> = {
  "README.md": "# demo\n",
  "src/list.ts": "export const list = () => []\n",
}

type Answer = Awaited<ReturnType<InterviewTools["tools"][number]["handler"]>>

/** The text of a tool's answer. */
const textOf = (answer: Answer): string =>
  answer.content.map((part) => (part.type === "text" ? part.text : "")).join("")

/** Calls the interview's tool `name` with `input`, as the session would. */
const call = (tools: InterviewTools, name: string, input: Record<string, unknown>) => {
  const found = tools.tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return Effect.promise(() => found.handler(input as never, {}))
}

const ticket = (fields: Record<string, unknown>) => ({
  title: `Ticket ${String(fields.key)}`,
  description: "Why and what.",
  acceptance: "The tests pass.",
  type: "task",
  priority: 2,
  files: [],
  blocked_by: [],
  solo: false,
  ...fields,
})

/** file_feature's input: an epic and two tickets, the second after the first and solo. */
const proposal = {
  epic: { title: "A --json flag for list", description: "list prints JSON with --json." },
  tickets: [
    ticket({ key: "t1", title: "JSON output for list", type: "feature", files: ["src/list.ts"] }),
    ticket({ key: "t2", title: "Document --json", blocked_by: ["t1"], solo: true, priority: 1 }),
  ],
}

/** Runs `effect` with the interview's tools' services: an in-memory Beads over `seeds`, and git. */
const withTools = <A, E>(
  effect: (tools: InterviewTools) => Effect.Effect<A, E, Backlog | Beads>,
  options: {
    readonly seeds?: ReadonlyArray<Seed>
    readonly beads?: Layer.Layer<Beads, never, Beads>
  } = {},
) => {
  const backlog = beadsLayer(options.seeds ?? [])
  const beads = options.beads === undefined ? backlog : Layer.provideMerge(options.beads, backlog)
  return Effect.runPromise(
    Effect.flatMap(makeInterviewTools("/repo"), effect).pipe(
      Effect.provide(Layer.mergeAll(beads, memoryGit({ dir: "/repo", files: repoFiles }))),
    ),
  )
}

describe("interviewOptions", () => {
  const canUseTool: CanUseTool = async () => ({ behavior: "allow" })
  const onElicitation: OnElicitation = async () => ({ action: "decline" })
  const verifier = { matcher: "Agent", hooks: [async () => ({})] }
  const callbacks: WorkerCallbacks = {
    canUseTool,
    onElicitation,
    hooks: { PreToolUse: [verifier], PostToolUse: [verifier] },
    stderr: () => {},
  }

  const optionsFor = (askUserQuestion: boolean, resume = false) =>
    Effect.runPromise(
      Effect.map(makeInterviewTools("/work/project"), (tools) => {
        const base = appConfig({}, "/work/project")
        const config = {
          ...base,
          settings: {
            ...base.settings,
            workers: { ...base.settings.workers, ask_user_question: askUserQuestion },
          },
        }
        return {
          server: tools.server,
          options: interviewOptions({
            config,
            setup: { prompt: interviewPrompt, server: tools.server },
            chrome: false,
            callbacks,
            session: { _tag: resume ? "Resume" : "New", sessionId: "s-1" },
            env: { PATH: "/usr/bin" },
            abortController: new AbortController(),
          }),
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(beadsLayer(), memoryGit({ dir: "/work/project", files: repoFiles })),
        ),
      ),
    )

  test("its tools are the listed built-ins alone, its one MCP server tutti's, strictly", async () => {
    const { options, server } = await optionsFor(true)
    expect(options.tools).toEqual(["Read", "Grep", "Glob", "Agent", "AskUserQuestion"])
    expect(interviewBuiltins).toEqual(["Read", "Grep", "Glob", "Agent", "AskUserQuestion"])
    expect(Object.keys(options.mcpServers ?? {})).toEqual([serverName])
    expect(options.mcpServers?.[serverName]).toBe(server)
    expect(server).toMatchObject({ type: "sdk", name: "tutti" })
    expect(options.strictMcpConfig).toBe(true)
    expect(options.allowedTools).toBeUndefined()
  })

  test("a PreToolUse hook allows tutti's three tools, and only them, beside the workers' hooks", async () => {
    const { options } = await optionsFor(true)
    const pre = options.hooks?.PreToolUse ?? []
    expect(pre).toEqual([...(callbacks.hooks.PreToolUse ?? []), allowOwnTools])
    expect(allowOwnTools.matcher).toBe(
      "mcp__tutti__tickets_list|mcp__tutti__ticket_show|mcp__tutti__file_feature",
    )
    const [allow] = allowOwnTools.hooks
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__tutti__file_feature",
      tool_input: {},
      tool_use_id: "toolu_1",
      session_id: "s-1",
      transcript_path: "",
      cwd: "/work/project",
    } as const
    expect(await allow?.(input, "toolu_1", { signal: new AbortController().signal })).toMatchObject(
      {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      },
    )
  })

  test("it runs in the main checkout, its settings loaded, its instructions appended", async () => {
    const { options } = await optionsFor(true)
    expect(options.cwd).toBe("/work/project")
    expect(options.projectConfigRoot).toBe("/work/project")
    expect(options.settingSources).toEqual(["user", "project", "local"])
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: interviewPrompt,
      snapshot: true,
    })
    expect(options.sessionId).toBe("s-1")
    expect(options.resume).toBeUndefined()
    expect(options.canUseTool).toBe(callbacks.canUseTool)
    expect(options.onElicitation).toBe(callbacks.onElicitation)
    expect(options.permissionMode).toBe(defaultSettings.workers.permission_mode)
    expect(options.env).toEqual({ PATH: "/usr/bin" })
  })

  test("a resumed interview resumes its session", async () => {
    const { options } = await optionsFor(true, true)
    expect(options.resume).toBe("s-1")
    expect(options.sessionId).toBeUndefined()
  })

  test("workers.ask_user_question off takes AskUserQuestion from workers, not the interview", async () => {
    const { options } = await optionsFor(false)
    expect(options.disallowedTools).toBeUndefined()
    expect(options.tools).toContain("AskUserQuestion")
  })
})

describe("the interview's instructions", () => {
  const notice = "Permission is hereby granted, free of charge, to any person obtaining a copy"

  test("they carry the grilling skill's MIT notice, as THIRD_PARTY_NOTICES.md does", () => {
    expect(interviewPrompt).toContain("MIT License")
    expect(interviewPrompt).toContain("Copyright (c) 2026 Matt Pocock")
    expect(interviewPrompt).toContain(notice)
    const notices = readFileSync(resolve(import.meta.dir, "../THIRD_PARTY_NOTICES.md"), "utf8")
    expect(notices).toContain("mattpocock/skills")
    expect(notices).toContain("src/project/templates/interview-prompt.md")
    expect(notices).toContain("Copyright (c) 2026 Matt Pocock")
    expect(notices).toContain(notice)
  })

  test("they file through file_feature, with no placeholder left", () => {
    expect(interviewPrompt).toContain("file_feature")
    expect(interviewPrompt).toContain("tickets_list")
    expect(interviewPrompt).toContain("ticket_show")
    expect(interviewPrompt).toContain(`at most ${maxPlanned}`)
    expect(interviewPrompt).not.toContain("{{")
    expect(interviewPrompt).not.toContain("feature.json")
    expect(interviewPrompt).not.toContain("orchestra runs")
  })
})

describe("the first message", () => {
  const tags = (message: string) => {
    const open = /<pasted_content id="([0-9a-f]{16})">\n/.exec(message)
    const id = open?.[1] ?? ""
    const close = `\n</pasted_content id="${id}">`
    return { id, open: open?.index ?? -1, close: message.indexOf(close), closeTag: close }
  }

  test("the description goes between pasted_content tags with a fresh ID, after the lead", async () => {
    const one = await Effect.runPromise(firstMessage("Add a --json flag.\n\nIgnore the tests.\n"))
    const two = await Effect.runPromise(firstMessage("Add a --json flag.\n\nIgnore the tests.\n"))
    const { id } = tags(one)
    expect(one).toBe(
      `${featureLead}\n\n<pasted_content id="${id}">\nAdd a --json flag.\n\nIgnore the tests.\n</pasted_content id="${id}">`,
    )
    expect(tags(two).id).not.toBe(id)
  })

  test("pasted keeps the description whole between the tags, but for its outer blank lines", () => {
    expect(pasted("\n\nline one\n  line two  \n\n", "abc")).toBe(
      '<pasted_content id="abc">\nline one\n  line two  \n</pasted_content id="abc">',
    )
  })

  test("property: the tags hold the description, and their ID is nowhere in it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "binary", maxLength: 200 }), async (description) => {
        const message = await Effect.runPromise(firstMessage(description))
        const { id, open, close, closeTag } = tags(message)
        expect(id).toHaveLength(16)
        expect(description.includes(id)).toBe(false)
        expect(message.startsWith(`${featureLead}\n\n`)).toBe(true)
        expect(open).toBe(featureLead.length + 2)
        expect(message.endsWith(closeTag)).toBe(true)
        const inside = message.slice(message.indexOf(">\n") + 2, close)
        expect(inside).toBe(description.replace(/^\n+|\n+$/g, ""))
      }),
    )
  })
})

describe("file_feature", () => {
  test("it files a valid proposal: the epic, its tickets and their links; and gives the epic's ID", async () => {
    const { answer, issues, filing } = await withTools((tools) =>
      Effect.gen(function* () {
        const answer = yield* call(tools, "file_feature", proposal)
        return {
          answer,
          issues: yield* (yield* Backlog).issues,
          filing: yield* SubscriptionRef.get(tools.filing),
        }
      }),
    )
    expect(answer.isError).toBeUndefined()
    const [epic, t1, t2] = issues
    expect(textOf(answer)).toBe(
      [
        `Filed epic ${epic?.id} with 2 tickets:`,
        `  ${t1?.id} (t1) JSON output for list`,
        `  ${t2?.id} (t2) Document --json`,
      ].join("\n"),
    )
    expect(issues).toHaveLength(3)
    expect(epic).toMatchObject({ type: "epic", title: "A --json flag for list", priority: 1 })
    expect(t1).toMatchObject({ parent: epic?.id, type: "feature", files: ["src/list.ts"] })
    expect(t2).toMatchObject({ parent: epic?.id, labels: ["solo"], priority: 1 })
    expect(t2?.dependencies).toContainEqual(expect.objectContaining({ id: t1?.id, type: "blocks" }))
    expect(filing._tag).toBe("Filed")
    expect(filedSomething(filing)).toBe(true)
    if (filing._tag === "Filed") expect(filing.filed.epic).toBe(epic?.id ?? "")
  })

  test("it files once: a second call is refused and files nothing more", async () => {
    const { second, issues } = await withTools((tools) =>
      Effect.gen(function* () {
        yield* call(tools, "file_feature", proposal)
        const second = yield* call(tools, "file_feature", proposal)
        return { second, issues: yield* (yield* Backlog).issues }
      }),
    )
    expect(second.isError).toBe(true)
    expect(textOf(second)).toContain(`already filed as epic ${issues[0]?.id}`)
    expect(issues).toHaveLength(3)
  })

  test("it rejects an invalid proposal with every reason, files nothing, and takes a fixed one", async () => {
    const invalid = {
      epic: { title: "", description: "" },
      tickets: [
        ticket({ key: "t1", blocked_by: ["t3"] }),
        ticket({ key: "t1", type: "story", priority: 7 }),
      ],
    }
    const { refused, before, filing, fixed, after } = await withTools((tools) =>
      Effect.gen(function* () {
        const refused = yield* call(tools, "file_feature", invalid)
        const before = yield* (yield* Backlog).issues
        const filing = yield* SubscriptionRef.get(tools.filing)
        const fixed = yield* call(tools, "file_feature", proposal)
        return { refused, before, filing, fixed, after: yield* (yield* Backlog).issues }
      }),
    )
    expect(refused.isError).toBe(true)
    const text = textOf(refused)
    expect(text).toStartWith("tutti refused the proposal; nothing was filed.")
    expect(text).toContain("- the plan's epic has no title")
    expect(text).toContain('- the plan has two tickets keyed "t1"')
    expect(text).toContain('- ticket t1 of the plan is blocked by "t3", which isn\'t in the plan')
    expect(text).toContain('- ticket t1 of the plan has the unknown type "story"')
    expect(text).toContain("- ticket t1 of the plan has the priority 7, not 0 to 4")
    expect(before).toEqual([])
    expect(filing).toEqual(Filing.None())
    expect(fixed.isError).toBeUndefined()
    expect(after).toHaveLength(3)
  })

  test("it rejects a proposal with no tickets, or tickets in a cycle", async () => {
    const answers = await withTools((tools) =>
      Effect.all([
        call(tools, "file_feature", { epic: proposal.epic, tickets: [] }),
        call(tools, "file_feature", {
          epic: proposal.epic,
          tickets: [
            ticket({ key: "a", blocked_by: ["b"] }),
            ticket({ key: "b", blocked_by: ["a"] }),
          ],
        }),
        call(tools, "file_feature", { epic: "an epic" }),
      ]),
    )
    expect(answers.map((a) => a.isError)).toEqual([true, true, true])
    expect(textOf(answers[0] as Answer)).toContain("the plan has no tickets and no questions")
    expect(textOf(answers[1] as Answer)).toContain("block each other in a cycle: a → b → a")
    expect(textOf(answers[2] as Answer)).toContain("the plan has no tickets")
  })

  test("filing that stops partway says what was filed, and nothing more is filed", async () => {
    const failingLinks = Layer.effect(
      Beads,
      Effect.gen(function* () {
        const beads = yield* Beads
        return Beads.of({
          ...beads,
          addDependency: () =>
            Effect.fail(
              new BeadsFailed({
                command: "bd dep add",
                exitCode: 1,
                stderr: "database is locked",
                noSuchIssue: false,
              }),
            ),
        })
      }),
    )
    const { stopped, filing, again } = await withTools(
      (tools) =>
        Effect.gen(function* () {
          const stopped = yield* call(tools, "file_feature", proposal)
          const filing = yield* SubscriptionRef.get(tools.filing)
          const again = yield* call(tools, "file_feature", proposal)
          return { stopped, filing, again }
        }),
      { beads: failingLinks },
    )
    expect(stopped.isError).toBe(true)
    expect(textOf(stopped)).toContain("tutti couldn't file the link")
    expect(textOf(stopped)).toContain("database is locked")
    expect(textOf(stopped)).toContain("Remove them with: bd delete")
    expect(filing._tag).toBe("Stopped")
    expect(filedSomething(filing)).toBe(true)
    expect(again.isError).toBe(true)
    expect(textOf(again)).toContain("already stopped partway")
  })
})

describe("tickets_list and ticket_show", () => {
  const seeds: ReadonlyArray<Seed> = [
    { id: "test-1", title: "An epic", type: "epic", priority: 1 },
    {
      id: "test-2",
      title: "Parse the flag",
      parent: "test-1",
      description: "Parse --json.",
      acceptance: "It parses.",
      labels: ["solo"],
      metadata: { files: ["src/list.ts"] },
    },
    { id: "test-3", title: "Done already", status: "closed" },
  ]

  test("tickets_list lists the tickets not closed, one a line; all: true adds the closed", async () => {
    const [open, all, under] = await withTools(
      (tools) =>
        Effect.all([
          call(tools, "tickets_list", {}),
          call(tools, "tickets_list", { all: true }),
          call(tools, "tickets_list", { parent: "test-1" }),
        ]),
      { seeds },
    )
    expect(textOf(open)).toBe(
      [
        "test-1  open  P1  epic  An epic",
        "test-2  open  P2  task  Parse the flag  (under test-1)",
      ].join("\n"),
    )
    expect(textOf(all)).toContain("test-3  closed  P2  task  Done already")
    expect(textOf(under)).toBe("test-2  open  P2  task  Parse the flag  (under test-1)")
  })

  test("ticket_show shows a ticket's fields and texts; an unknown ID is an error", async () => {
    const [shown, missing] = await withTools(
      (tools) =>
        Effect.all([
          call(tools, "ticket_show", { id: "test-2" }),
          call(tools, "ticket_show", { id: "test-9" }),
        ]),
      { seeds },
    )
    const text = textOf(shown)
    expect(text).toStartWith("test-2: Parse the flag\nstatus: open\ntype: task\npriority: 2")
    expect(text).toContain("parent: test-1")
    expect(text).toContain("labels: solo")
    expect(text).toContain("files: src/list.ts")
    expect(text).toContain("\n## Description\n\nParse --json.")
    expect(text).toContain("\n## Acceptance criteria\n\nIt parses.")
    expect(text).not.toContain("## Notes")
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain("bd couldn't show test-9")
  })

  test("ticketLine puts an issue on one line", () => {
    expect(
      ticketLine({
        id: "x-1",
        title: "T",
        status: "open",
        type: "bug",
        description: "",
        design: "",
        acceptance: "",
        notes: "",
        assignee: "",
        labels: [],
        dependencies: [],
        metadata: {},
        files: [],
        predictedFiles: [],
        createdAt: "",
        closeReason: "",
      }),
    ).toBe("x-1  open  P?  bug  T")
  })
})

describe("startInterview, with the scripted host", () => {
  /** The interview's session's system/init: tutti's in-process server alone. */
  const interviewInit = init({
    mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }],
  })

  /** Runs `effect` in a fresh main checkout with the scripted host playing `script`. */
  const scenario = <A, E>(
    script: (ready: Deferred.Deferred<InterviewTools>) => Script,
    effect: (
      repo: string,
      ready: Deferred.Deferred<InterviewTools>,
    ) => Effect.Effect<A, E, AgentHost | Recording | Backlog | Beads | AppConfig | Git>,
  ) => {
    const repo = folder()
    return Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<InterviewTools>()
        return yield* effect(repo, ready).pipe(
          Effect.provide(
            scriptedHost({ [interviewWorker]: script(ready) }).pipe(
              Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
              Layer.provideMerge(
                Layer.mergeAll(
                  logLayer(),
                  eventsLayer(),
                  configLayer(appConfig({}, repo)),
                  beadsLayer(),
                  memoryGit({ dir: repo, files: repoFiles }),
                ),
              ),
            ),
          ),
        )
      }),
    ).then((value) => ({ repo, value }))
  }

  /** A turn that calls file_feature with `input` once the tools are ready, keeping its answer. */
  const filingTurn = (
    ready: Deferred.Deferred<InterviewTools>,
    input: Record<string, unknown>,
    answers: Array<Answer>,
  ): Script => [
    [
      wait,
      interviewInit,
      sessionState("running"),
      ...tool(
        "mcp__tutti__file_feature",
        input,
        Effect.flatMap(Deferred.await(ready), (tools) =>
          Effect.map(call(tools, "file_feature", input), (answer) => void answers.push(answer)),
        ),
      ),
      result("Filed. tutti shows the tickets next."),
      sessionState("idle"),
    ],
  ]

  test("it starts the session in the main checkout with the instructions and tutti's server", async () => {
    const answers: Array<Answer> = []
    const { repo, value } = await scenario(
      (ready) => filingTurn(ready, proposal, answers),
      (_, ready) =>
        Effect.gen(function* () {
          const interview = yield* startInterview("Add a --json flag to list.\n")
          yield* Deferred.succeed(ready, interview.tools)
          const ended = yield* interview.ended
          const recording = yield* Recording
          return { ended, sent: yield* recording.sentTo(interviewWorker), interview }
        }),
    )
    const { ended, sent, interview } = value
    const started = sent.find((s) => s._tag === "Started")
    const session = (started?._tag === "Started" ? started.session : undefined) as Session
    expect(session.sessionId).toBe(interview.sessionId)
    expect(session.cwd).toBe(repo)
    expect(session.interview?.prompt).toBe(interviewPrompt)
    expect(session.interview?.server).toBe(interview.tools.server)
    expect(session.interview?.server).toMatchObject({ type: "sdk", name: serverName })

    // The description: saved, and sent wrapped as the first message, composed by tutti.
    expect(readFileSync(join(repo, featureRequestFile), "utf8")).toBe(
      "Add a --json flag to list.\n",
    )
    const message = sent.find((s) => s._tag === "Message")
    const first = message?._tag === "Message" ? message.message : undefined
    expect(first?.client_composed).toBe(true)
    const content = String(first?.message.content)
    expect(content).toStartWith(`${featureLead}\n\n<pasted_content id="`)
    expect(content).toContain('">\nAdd a --json flag to list.\n</pasted_content id="')

    // file_feature filed the epic, the turn ended: the session is ended, the epic offered.
    expect(answers.map((a) => a.isError)).toEqual([undefined])
    expect(ended._tag).toBe("Filed")
    if (ended._tag !== "Filed") return
    expect(ended.epic).toBe("test-1")
    expect(ended.tickets).toBe(2)
    expect(ended.question).toBe("Start the run on test-1 (2 tickets)?")
    expect(ended.plan.epic.title).toBe("test-1 A --json flag for list")
    expect(ended.plan.tickets.map((t) => [t.key, t.title, t.after])).toEqual([
      ["test-1.1", "JSON output for list", []],
      ["test-1.2", "Document --json (solo)", ["test-1.1"]],
    ])
    expect(sent.at(-1)?._tag).toBe("Ended")
  })

  test("a proposal file_feature refuses leaves the interview open, nothing filed", async () => {
    const answers: Array<Answer> = []
    const invalid = { epic: proposal.epic, tickets: [] }
    const { value } = await scenario(
      (ready) => filingTurn(ready, invalid, answers),
      (_, ready) =>
        Effect.gen(function* () {
          const interview = yield* startInterview("A feature")
          yield* Deferred.succeed(ready, interview.tools)
          const host = yield* AgentHost
          yield* host.state(interviewWorker).pipe(
            Stream.filter((state) => state._tag === "Idle"),
            Stream.runHead,
          )
          const state = yield* host.current(interviewWorker)
          const filed = yield* interview.filedSomething
          yield* interview.leave
          const ended = yield* interview.ended
          return { state, filed, ended, issues: yield* (yield* Backlog).issues }
        }),
    )
    expect(answers[0]?.isError).toBe(true)
    expect(value.state._tag).toBe("Idle")
    expect(value.filed).toBe(false)
    expect(value.ended).toEqual(
      InterviewEnd.Ended({ why: "the interview was left", filing: Filing.None() }),
    )
    expect(value.issues).toEqual([])
  })

  test("a session that goes before filing ends the interview with why", async () => {
    const { value } = await scenario(
      () => [[wait, interviewInit, goneStep("Claude Code exited")]],
      () =>
        Effect.gen(function* () {
          const interview = yield* startInterview("A feature")
          return yield* interview.ended
        }),
    )
    expect(value).toEqual(InterviewEnd.Ended({ why: "Claude Code exited", filing: Filing.None() }))
  })

  test("filedPlan offers the filed tickets by their IDs", () => {
    const plan = filedPlan(
      {
        epic: { title: "E", description: "D" },
        tickets: [
          {
            key: "a",
            title: "A",
            type: "task",
            priority: 2,
            description: "",
            acceptance: "",
            files: ["x.ts"],
            blockedBy: [],
            solo: false,
          },
          {
            key: "b",
            title: "B",
            type: "bug",
            priority: 0,
            description: "",
            acceptance: "",
            files: [],
            blockedBy: ["a"],
            solo: true,
          },
        ],
        questions: [],
        notes: ["dropped"],
      },
      {
        epic: "p-1",
        tickets: new Map([
          ["a", "p-2"],
          ["b", "p-3"],
        ]),
      },
    )
    expect(plan).toEqual({
      epic: { title: "p-1 E", description: "D" },
      tickets: [
        { key: "p-2", type: "task", priority: 2, title: "A", files: ["x.ts"], after: [] },
        { key: "p-3", type: "bug", priority: 0, title: "B (solo)", files: [], after: ["p-2"] },
      ],
      notes: ["dropped"],
    })
  })
})

describe("the interview's session, with the live host over the fake Claude Code", () => {
  const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

  test("Claude Code is given the listed tools, tutti's server alone, strictly", async () => {
    const dir = folder()
    const log = join(dir, "fake.jsonl")
    const noServers: ChosenServers = { servers: [], note: null }
    const scenario = {
      log,
      init: { mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }] },
    }
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: noServers,
      account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
      env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) },
    })
    const lines = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : []
    const { args, initialize, state } = await Effect.runPromise(
      Effect.gen(function* () {
        const interview = yield* startInterview("A feature")
        const host = yield* AgentHost
        yield* host.state(interviewWorker).pipe(
          Stream.filter((s) => s._tag === "Idle" || s._tag === "Gone"),
          Stream.runHead,
          Effect.timeout(Duration.seconds(10)),
        )
        yield* Effect.sync(lines).pipe(
          Effect.repeat({
            until: (all) => all.some((l) => l.stdin !== undefined),
            schedule: Schedule.spaced(Duration.millis(20)),
          }),
          Effect.timeout(Duration.seconds(10)),
        )
        const state = yield* host.current(interviewWorker)
        yield* interview.leave
        const all = lines()
        const args = (all.find((l) => l.args !== undefined)?.args ?? []) as ReadonlyArray<string>
        const initialize = all
          .flatMap((l) => (l.stdin === undefined ? [] : [l.stdin as Record<string, unknown>]))
          .map((m) => m.request as Record<string, unknown> | undefined)
          .find((r) => r?.subtype === "initialize")
        return { args, initialize, state }
      }).pipe(
        Effect.provide(
          host.pipe(
            Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
            Layer.provideMerge(
              Layer.mergeAll(
                logLayer(),
                eventsLayer(),
                configLayer(appConfig({ claude: fake }, dir)),
                beadsLayer(),
                memoryGit({ dir, files: repoFiles }),
                BunServices.layer,
              ),
            ),
          ),
        ),
      ),
    )
    // tutti's server passes system/init's check: the session wasn't ended as a setup problem.
    expect(state._tag).toBe("Idle")
    const after = (flag: string) => {
      const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`))
      const arg = args[i] ?? ""
      return arg.includes("=") ? arg.slice(flag.length + 1) : (args[i + 1] ?? "")
    }
    expect(after("--tools")).toBe("Read,Grep,Glob,Agent,AskUserQuestion")
    expect(args.some((a) => a.startsWith("--allowedTools"))).toBe(false)
    expect(args).toContain("--strict-mcp-config")
    // tutti's in-process server is passed in the initialize request; no other server is passed.
    expect(args.some((a) => a.startsWith("--mcp-config"))).toBe(false)
    expect(initialize?.sdkMcpServers).toEqual([serverName])
    expect(initialize?.appendSystemPrompt).toBe(interviewPrompt)
  })
})
