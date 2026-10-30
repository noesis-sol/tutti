// New feature's interview, the session side (§ 4.10): the breakdown's session in its feature mode
// (src/agent/breakdown.ts's startFeature), its options, its instructions, its first message, its
// tools filing a feature's tree, and its end.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CanUseTool, OnElicitation } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import {
  Deferred,
  Duration,
  Effect,
  Layer,
  Schedule,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import fc from "fast-check"
import { AgentHost, type Session } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import {
  BreakdownEnd,
  breakdownBuiltins,
  featureLead,
  featureMessage,
  featurePrompt,
  featureRequestFile,
  startFeature,
} from "../src/agent/breakdown.ts"
import {
  type BreakdownTools,
  filedAny,
  makeBreakdownTools,
  qualifiedBreakdownTools,
} from "../src/agent/breakdownTools.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { interviewWorker, pasted } from "../src/agent/inView.ts"
import type { ChosenServers } from "../src/agent/mcp.ts"
import {
  allowTools,
  interviewBuiltins,
  interviewOptions,
  type WorkerCallbacks,
} from "../src/agent/options.ts"
import { serverName, ticketLine } from "../src/agent/ticketTools.ts"
import { type AppConfig, defaultSettings } from "../src/cli/AppConfig.ts"
import type { Log } from "../src/run/log.ts"
import type { Beads, TicketId } from "../src/services/Beads.ts"
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
import { openFibers } from "./fibers.ts"
import { workersIn } from "./workerEnv.ts"

/** A new folder, its real path: the main checkout, where .tutti/run/ is written. */
const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-interview-")))

/** The main checkout's files, in git. */
const repoFiles: Readonly<Record<string, string>> = {
  "README.md": "# demo\n",
  "src/list.ts": "export const list = () => []\n",
}

type Answer = Awaited<ReturnType<BreakdownTools["tools"][number]["handler"]>>

/** The text of a tool's answer. */
const textOf = (answer: Answer): string =>
  answer.content.map((part) => (part.type === "text" ? part.text : "")).join("")

/** Calls the breakdown's tool `name` with `input`, as the session would. */
const call = (tools: BreakdownTools, name: string, input: Record<string, unknown>) => {
  const found = tools.tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return Effect.promise(() => found.handler(input as never, {}))
}

/** file_root's input: the feature's epic. */
const rootInput = {
  title: "A --json flag for list",
  description: "list prints JSON with --json.\n\n## Decisions\n\n- One flag.",
  priority: 1,
}

const issue = (fields: Record<string, unknown>) => ({
  parent: "",
  type: "task",
  priority: 2,
  description: "Why and what.",
  acceptance: "The tests pass.",
  labels: [],
  files: [],
  waits_for: [],
  ...fields,
})

/** file_breakdown's input under `root`: two tickets, the second after the first and solo. */
const treeInput = (root: string) => ({
  root,
  issues: [
    issue({ key: "json", title: "JSON output for list", type: "feature", files: ["src/list.ts"] }),
    issue({
      key: "docs",
      title: "Document --json",
      files: ["README.md"],
      labels: ["solo"],
      priority: 1,
      waits_for: ["json"],
    }),
  ],
})

/** Files the feature's epic, then its tree under it, as the session would; the two answers. */
const fileFeature = (tools: BreakdownTools) =>
  Effect.gen(function* () {
    const root = yield* call(tools, "file_root", rootInput)
    const epic = (yield* SubscriptionRef.get(tools.state)).root ?? ""
    const tree = yield* call(tools, "file_breakdown", treeInput(epic))
    return { root, tree }
  })

/** Runs `effect` with a feature's breakdown's tools: an in-memory Beads over `seeds`, and git. */
const withTools = <A, E>(
  effect: (tools: BreakdownTools) => Effect.Effect<A, E, Backlog | Beads>,
  options: { readonly seeds?: ReadonlyArray<Seed> } = {},
) =>
  Effect.runPromise(
    Effect.flatMap(
      makeBreakdownTools({
        repo: "/repo",
        spec: null,
        root: null,
        update: false,
        fibers: openFibers(),
      }),
      effect,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          beadsLayer(options.seeds ?? []),
          memoryGit({ dir: "/repo", files: repoFiles }),
        ),
      ),
    ),
  )

describe("a feature's breakdown's options", () => {
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
      Effect.map(
        makeBreakdownTools({
          repo: "/work/project",
          spec: null,
          root: null,
          update: false,
          fibers: openFibers(),
        }),
        (tools) => {
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
              setup: {
                prompt: featurePrompt,
                server: tools.server,
                builtins: breakdownBuiltins(true),
                allowed: qualifiedBreakdownTools,
                headless: false,
                effort: null,
                tools: tools.tools,
              },
              chrome: false,
              callbacks,
              session: { _tag: resume ? "Resume" : "New", sessionId: "s-1" },
            }),
          }
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(beadsLayer(), memoryGit({ dir: "/work/project", files: repoFiles })),
        ),
      ),
    )

  test("its tools are the interview's built-ins alone, its one MCP server tutti's, strictly", async () => {
    const { options, server } = await optionsFor(true)
    expect(options.tools).toEqual(["Read", "Grep", "Glob", "Agent", "AskUserQuestion"])
    expect(breakdownBuiltins(true)).toEqual(interviewBuiltins)
    expect(options.tools).not.toContain("Bash")
    expect(options.tools).not.toContain("Edit")
    expect(options.tools).not.toContain("Write")
    expect(Object.keys(options.mcpServers ?? {})).toEqual([serverName])
    expect(options.mcpServers?.[serverName]).toBe(server)
    expect(server).toMatchObject({ type: "sdk", name: "tutti" })
    expect(options.strictMcpConfig).toBe(true)
    expect(options.allowedTools).toBeUndefined()
  })

  test("a PreToolUse hook allows the breakdown's four tools, and only them, beside the workers' hooks", async () => {
    const { options } = await optionsFor(true)
    const pre = options.hooks?.PreToolUse ?? []
    expect(pre.slice(0, -1)).toEqual([...(callbacks.hooks.PreToolUse ?? [])])
    const own = pre.at(-1)
    expect(own?.matcher).toBe(allowTools(qualifiedBreakdownTools).matcher)
    expect(own?.matcher).toBe(
      "mcp__tutti__tickets_list|mcp__tutti__ticket_show|mcp__tutti__file_root|mcp__tutti__file_breakdown",
    )
    const [allow] = own?.hooks ?? []
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__tutti__file_breakdown",
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
      append: featurePrompt,
      snapshot: true,
    })
    expect(options.sessionId).toBe("s-1")
    expect(options.resume).toBeUndefined()
    expect(options.canUseTool).toBe(callbacks.canUseTool)
    expect(options.onElicitation).toBe(callbacks.onElicitation)
    expect(options.permissionMode).toBe(defaultSettings.workers.permission_mode)
  })

  test("a resumed breakdown resumes its session", async () => {
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

describe("the feature mode's instructions", () => {
  const notice = "Permission is hereby granted, free of charge, to any person obtaining a copy"

  test("the breakdown's template carries the grilling skill's MIT notice, as THIRD_PARTY_NOTICES.md does", () => {
    const template = readFileSync(
      resolve(import.meta.dir, "../src/project/templates/spec-prompt.md"),
      "utf8",
    )
    expect(template).toContain("MIT License")
    expect(template).toContain("Copyright (c) 2026 Matt Pocock")
    expect(template).toContain(notice)
    const notices = readFileSync(resolve(import.meta.dir, "../THIRD_PARTY_NOTICES.md"), "utf8")
    expect(notices).toContain("mattpocock/skills")
    expect(notices).toContain("src/project/templates/spec-prompt.md")
    expect(notices).not.toContain("interview-prompt.md")
    expect(notices).toContain("Copyright (c) 2026 Matt Pocock")
    expect(notices).toContain(notice)
  })

  test("they talk the feature through in rounds of numbered questions with recommended answers", () => {
    expect(featurePrompt).toStartWith("# Feature breakdown\n")
    expect(featurePrompt).toContain("## The interview")
    expect(featurePrompt).toContain("**design tree**")
    expect(featurePrompt).toContain("❓ **Q1**")
    expect(featurePrompt).toContain("➡️ <your recommended answer>")
    expect(featurePrompt).toContain(
      "Use AskUserQuestion only where a question is a discrete choice",
    )
    expect(featurePrompt).toContain("<pasted_content>")
  })

  test("they file through file_root and file_breakdown, with no spec, placeholder or notice left", () => {
    expect(featurePrompt).toContain("`file_root`, once: the root epic")
    expect(featurePrompt).toContain("`file_breakdown`, once")
    expect(featurePrompt).toContain("tickets_list")
    expect(featurePrompt).toContain("ticket_show")
    expect(featurePrompt).toContain("starts the run on it without asking")
    expect(featurePrompt).not.toContain("{{")
    expect(featurePrompt).not.toContain("<!--")
    expect(featurePrompt).not.toContain("MIT License")
    expect(featurePrompt).not.toContain("The environment first")
    expect(featurePrompt).not.toContain("Spikes")
    expect(featurePrompt).not.toContain("metadata `spec`")
    expect(featurePrompt).not.toContain("the spec's sections")
    expect(featurePrompt).not.toContain("file_feature")
    expect(featurePrompt).not.toContain("orchestra runs")
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
    const one = await Effect.runPromise(featureMessage("Add a --json flag.\n\nIgnore the tests.\n"))
    const two = await Effect.runPromise(featureMessage("Add a --json flag.\n\nIgnore the tests.\n"))
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
        const message = await Effect.runPromise(featureMessage(description))
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

describe("a feature's tree, filed with the breakdown's tools", () => {
  test("file_root files the epic and file_breakdown its tickets and links, with no spec metadata", async () => {
    const { answers, issues, state } = await withTools((tools) =>
      Effect.gen(function* () {
        const answers = yield* fileFeature(tools)
        return {
          answers,
          issues: yield* (yield* Backlog).issues,
          state: yield* SubscriptionRef.get(tools.state),
        }
      }),
    )
    expect(answers.root.isError).toBeUndefined()
    expect(answers.tree.isError).toBeUndefined()
    const [epic, json, docs] = issues
    expect(textOf(answers.root)).toBe(`Filed the root epic ${epic?.id}.`)
    expect(textOf(answers.tree)).toBe(
      [
        "Filed 0 epics and 2 tickets:",
        `  ${json?.id} (json) JSON output for list`,
        `  ${docs?.id} (docs) Document --json`,
      ].join("\n"),
    )
    expect(issues).toHaveLength(3)
    expect(epic).toMatchObject({ type: "epic", title: "A --json flag for list", priority: 1 })
    expect(json).toMatchObject({ parent: epic?.id, type: "feature", files: ["src/list.ts"] })
    expect(docs).toMatchObject({ parent: epic?.id, labels: ["solo"], priority: 1 })
    expect(docs?.dependencies).toContainEqual(
      expect.objectContaining({ id: json?.id, type: "blocks" }),
    )
    for (const filed of issues) expect(filed.metadata.spec).toBeUndefined()
    expect(state).toMatchObject({ root: epic?.id, environment: null, epics: 1, tickets: 2 })
    expect(state.answer._tag).toBe("Filed")
    expect(filedAny(state)).toBe(true)
  })

  test("file_breakdown before file_root is refused, and nothing is filed", async () => {
    const { answer, issues, state } = await withTools((tools) =>
      Effect.gen(function* () {
        const answer = yield* call(tools, "file_breakdown", treeInput("test-1"))
        return {
          answer,
          issues: yield* (yield* Backlog).issues,
          state: yield* SubscriptionRef.get(tools.state),
        }
      }),
    )
    expect(answer.isError).toBe(true)
    expect(textOf(answer)).toContain("file it with file_root first")
    expect(issues).toEqual([])
    expect(filedAny(state)).toBe(false)
  })

  test("a tree in a cycle is refused with its reason, files nothing, and a fixed one is taken", async () => {
    const { refused, before, fixed, after } = await withTools((tools) =>
      Effect.gen(function* () {
        yield* call(tools, "file_root", rootInput)
        const epic = (yield* SubscriptionRef.get(tools.state)).root ?? ""
        const cycle = {
          root: epic,
          issues: [
            issue({ key: "a", title: "A", waits_for: ["b"] }),
            issue({ key: "b", title: "B", waits_for: ["a"] }),
          ],
        }
        const refused = yield* call(tools, "file_breakdown", cycle)
        const before = yield* (yield* Backlog).issues
        const fixed = yield* call(tools, "file_breakdown", treeInput(epic))
        return { refused, before, fixed, after: yield* (yield* Backlog).issues }
      }),
    )
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toStartWith("tutti refused the answer; nothing was filed.")
    expect(textOf(refused)).toContain("make a cycle")
    expect(before).toHaveLength(1)
    expect(fixed.isError).toBeUndefined()
    expect(after).toHaveLength(3)
  })

  test("the tree may wait for an open ticket outside it, by its ID", async () => {
    const { answer, issues } = await withTools(
      (tools) =>
        Effect.gen(function* () {
          yield* call(tools, "file_root", rootInput)
          const epic = (yield* SubscriptionRef.get(tools.state)).root ?? ""
          const answer = yield* call(tools, "file_breakdown", {
            root: epic,
            issues: [issue({ key: "a", title: "A", waits_for: ["old-1"] })],
          })
          return { answer, issues: yield* (yield* Backlog).issues }
        }),
      { seeds: [{ id: "old-1", title: "Parse the flags" }] },
    )
    expect(answer.isError).toBeUndefined()
    expect(issues.at(-1)?.dependencies).toContainEqual(
      expect.objectContaining({ id: "old-1", type: "blocks" }),
    )
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
        id: "x-1" as TicketId,
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

describe("startFeature, with the scripted host", () => {
  /** The session's system/init: tutti's in-process server alone. */
  const sessionInit = init({
    mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }],
  })

  /** Runs `effect` in a fresh main checkout with the scripted host playing `script`. */
  const scenario = <A, E>(
    script: (ready: Deferred.Deferred<BreakdownTools>) => Script,
    effect: (
      repo: string,
      ready: Deferred.Deferred<BreakdownTools>,
    ) => Effect.Effect<
      A,
      E,
      AgentHost | Recording | Backlog | Beads | AppConfig | Git | Log | Scope.Scope
    >,
  ) => {
    const repo = folder()
    return Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<BreakdownTools>()
        return yield* effect(repo, ready).pipe(
          Effect.scoped,
          Effect.provide(
            scriptedHost({ [interviewWorker]: script(ready) }).pipe(
              Layer.provideMerge(
                Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
              ),
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

  /** A turn that runs `filing` with the tools once they are ready, then ends. */
  const filingTurn = (
    ready: Deferred.Deferred<BreakdownTools>,
    filing: (tools: BreakdownTools) => Effect.Effect<unknown>,
  ): Script => [
    [
      wait,
      sessionInit,
      sessionState("running"),
      ...tool(
        "mcp__tutti__file_breakdown",
        {},
        Effect.asVoid(Effect.flatMap(Deferred.await(ready), filing)),
      ),
      result("Filed. The run starts next."),
      sessionState("idle"),
    ],
  ]

  test("it starts the session in the main checkout in the feature mode, and ends it once filed", async () => {
    const { repo, value } = await scenario(
      (ready) => filingTurn(ready, fileFeature),
      (_, ready) =>
        Effect.gen(function* () {
          const breakdown = yield* startFeature({
            description: "Add a --json flag to list.\n",
            effort: null,
          })
          yield* Deferred.succeed(ready, breakdown.tools)
          const ended = yield* breakdown.ended
          const recording = yield* Recording
          return { ended, sent: yield* recording.sentTo(interviewWorker), breakdown }
        }),
    )
    const { ended, sent, breakdown } = value
    expect(breakdown.worker).toBe(interviewWorker)
    const started = sent.find((s) => s._tag === "Started")
    const session = (started?._tag === "Started" ? started.session : undefined) as Session
    expect(session.sessionId).toBe(breakdown.sessionId)
    expect(session.cwd).toBe(repo)
    const kind = session.kind
    if (kind?._tag !== "Interview") throw new Error(`not an interview's session: ${kind?._tag}`)
    expect(kind.prompt).toBe(featurePrompt)
    expect(kind.server).toBe(breakdown.tools.server)
    expect(kind.server).toMatchObject({ type: "sdk", name: serverName })
    expect(kind.builtins).toEqual(["Read", "Grep", "Glob", "Agent", "AskUserQuestion"])
    expect(kind.allowed).toEqual(qualifiedBreakdownTools)
    expect(kind.headless).toBe(false)

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

    // The tree filed, the turn ended: the session is ended, the epic handed back.
    expect(ended._tag).toBe("Filed")
    if (ended._tag !== "Filed") return
    expect(ended.root).toBe("test-1" as TicketId)
    expect(ended.state).toMatchObject({ epics: 1, tickets: 2 })
    expect(sent.at(-1)?._tag).toBe("Ended")
  })

  test("a tree the tools refuse leaves the session open, nothing filed, until it is left", async () => {
    const { value } = await scenario(
      (ready) => filingTurn(ready, (tools) => call(tools, "file_breakdown", treeInput("test-1"))),
      (_, ready) =>
        Effect.gen(function* () {
          const breakdown = yield* startFeature({ description: "A feature", effort: null })
          yield* Deferred.succeed(ready, breakdown.tools)
          const host = yield* AgentHost
          yield* host.state(interviewWorker).pipe(
            Stream.filter((state) => state._tag === "Idle"),
            Stream.runHead,
          )
          const state = yield* host.current(interviewWorker)
          const filed = filedAny(yield* SubscriptionRef.get(breakdown.state))
          yield* breakdown.leave
          const ended = yield* breakdown.ended
          return { state, filed, ended, issues: yield* (yield* Backlog).issues }
        }),
    )
    expect(value.state._tag).toBe("Idle")
    expect(value.filed).toBe(false)
    expect(value.ended._tag).toBe("Left")
    expect(value.issues).toEqual([])
  })

  test("a session that goes before filing ends the breakdown with why", async () => {
    const { value } = await scenario(
      () => [[wait, sessionInit, goneStep("Claude Code exited")]],
      () =>
        Effect.gen(function* () {
          const breakdown = yield* startFeature({ description: "A feature", effort: null })
          return yield* breakdown.ended
        }),
    )
    expect(value).toEqual(
      BreakdownEnd.Failed({
        why: "its session ended: Claude Code exited",
        state: { root: null, environment: null, epics: 0, tickets: 0, answer: value.state.answer },
      }),
    )
    expect(value.state.answer._tag).toBe("None")
  })
})

describe("a feature's breakdown, with the live host over the fake Claude Code", () => {
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
      account: { billing: { _tag: "Subscription", keyUnused: false } },
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
        const breakdown = yield* startFeature({ description: "A feature", effort: null })
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
        yield* breakdown.leave
        const all = lines()
        const args = (all.find((l) => l.args !== undefined)?.args ?? []) as ReadonlyArray<string>
        const initialize = all
          .flatMap((l) => (l.stdin === undefined ? [] : [l.stdin as Record<string, unknown>]))
          .map((m) => m.request as Record<string, unknown> | undefined)
          .find((r) => r?.subtype === "initialize")
        return { args, initialize, state }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          host.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                attentionLayer(waitForTest),
                transcriptsLayer(),
                ClaudeCode.layer.pipe(
                  Layer.provide(
                    workersIn({ ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) }),
                  ),
                ),
              ),
            ),
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
    expect(initialize?.appendSystemPrompt).toBe(featurePrompt)
  })
})
