// Throwaway spike for tutti-nrg.1.3 (spec § 14, M0 (3) and (4); § 4.1, § 4.6): strictMcpConfig,
// the verifier subagent in the foreground, and forwardSubagentText.
//
//   bun spikes/sdk-mcp/spike.ts <scenario> [--model <m>] [--variant <v>]
//
// Scenarios:
//   mcp        two sessions with one in-memory MCP server in `mcpServers`: a control without
//              strictMcpConfig (what this machine would load besides it) and one with
//              strictMcpConfig: true. Prints system/init's mcp_servers and mcpServerStatus().
//   subagent   one session per variant (or just --variant <v>) whose parent calls a project
//              subagent `verifier` defined in .claude/agents/verifier.md. The verifier runs
//              `sleep 8` and replies. Prints whether the Agent call ran in the foreground (its
//              tool_result arrives before the turn's result and isn't `async_launched`), and
//              whether the subagent's text came with parent_tool_use_id (forwardSubagentText).
//   all        both.
//
// Variants: default, fork0 (CLAUDE_CODE_FORK_SUBAGENT=0), def-bg-false (an `agents` option
// definition with background: false), fm-bg-false (frontmatter `background: false`), tool-false
// (the parent is told to pass run_in_background: false), no-bg
// (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1), hook-false (an in-process PreToolUse hook sets
// run_in_background: false on the verifier's Agent call), no-forward (no-bg with
// forwardSubagentText: false, the control for forwardSubagentText). Every variant but default
// sets CLAUDE_CODE_FORK_SUBAGENT=0, as tutti's workers will.
//
// Each session runs in a temp project with the machine's Claude login and writes every SDK message
// to $SPIKE_OUT/<scenario>-<time>/ (default: <tmpdir>/tutti-spike-sdk-mcp/). The summary lines it
// prints are what docs/spikes/03-sdk-mcp-subagents.md was written from.
//
// Not product code: no Effect, no tests. It spends a few cents of real model turns per session.

import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentDefinition,
  type CanUseTool,
  createSdkMcpServer,
  type HookCallbackMatcher,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

const argv = process.argv.slice(2)
const scenario = argv[0] ?? "help"
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const model = flag("model") ?? "haiku"
const onlyVariant = flag("variant")
const outRoot = process.env.SPIKE_OUT ?? join(tmpdir(), "tutti-spike-sdk-mcp")
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const outDir = join(outRoot, `${scenario}-${stamp}`)

const say = (line: string) => console.log(line)
const since = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`

// A temp project: a git-less directory with the files the scenario needs.
const makeProject = (name: string, files: Record<string, string>): string => {
  const dir = join(outDir, name, "project")
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, text)
  }
  return realpathSync(dir)
}

// One streaming-input session: sends `prompt`, reads messages until the first result, then keeps
// the session open for `afterResultMs` to catch what a background task sends later.
const runSession = async (
  name: string,
  prompt: string,
  options: Options,
  afterResultMs: number,
): Promise<{ messages: Array<{ at: number; message: SDKMessage }>; status: unknown }> => {
  const log = join(outDir, name, "messages.jsonl")
  mkdirSync(join(outDir, name), { recursive: true })
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const inbox = async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    }
    await finished
  }
  const t0 = Date.now()
  const q = query({ prompt: inbox(), options })
  const messages: Array<{ at: number; message: SDKMessage }> = []
  let status: unknown
  let timer: ReturnType<typeof setTimeout> | undefined
  const hardStop = setTimeout(() => finish(), 240_000)
  const reading = (async () => {
    for await (const message of q) {
      const at = Date.now() - t0
      messages.push({ at, message })
      appendFileSync(log, `${JSON.stringify({ at, message })}\n`)
      if (message.type === "result" && status === undefined) {
        status = await q.mcpServerStatus().catch((e: unknown) => `mcpServerStatus failed: ${e}`)
        timer = setTimeout(() => finish(), afterResultMs)
      }
    }
  })()
  await Promise.race([finished, reading])
  clearTimeout(timer)
  clearTimeout(hardStop)
  q.close()
  await reading.catch(() => {})
  say(`  [${name}] ${messages.length} messages in ${since(t0)}; log: ${log}`)
  return { messages, status }
}

const baseEnv = (extra: Record<string, string>): Record<string, string | undefined> => ({
  ...process.env,
  CLAUDE_AGENT_SDK_CLIENT_APP: "tutti-spike/0",
  ...extra,
})

// ---------------------------------------------------------------------------------------------
// mcp: strictMcpConfig

const scenarioMcp = async () => {
  say("== mcp: strictMcpConfig with one in-memory server")
  // A project .mcp.json server, approved in the project's local settings, so that it would load
  // without strictMcpConfig; and a project agent whose frontmatter declares its own MCP server.
  const files = {
    ".mcp.json": JSON.stringify({
      mcpServers: { "spike-project": { command: "bun", args: ["-e", "setTimeout(()=>{},60000)"] } },
    }),
    ".claude/settings.local.json": JSON.stringify({ enableAllProjectMcpServers: true }),
    ".claude/agents/helper.md": [
      "---",
      "name: helper",
      "description: A helper that is never called.",
      "mcpServers:",
      "  spike-agent-frontmatter:",
      "    command: bun",
      '    args: ["-e", "setTimeout(()=>{},60000)"]',
      "---",
      "You help.",
      "",
    ].join("\n"),
  }
  const stdioServer = join(import.meta.dir, "stdio-server.ts")
  for (const strict of [false, true]) {
    const name = strict ? "mcp-strict" : "mcp-control"
    const cwd = makeProject(name, files)
    const spike = createSdkMcpServer({ name: "spike-sdk", version: "0.0.0", tools: [] })
    const { messages, status } = await runSession(
      name,
      "Reply with the single word OK and nothing else.",
      {
        cwd,
        model,
        settingSources: ["user", "project", "local"],
        permissionMode: "default",
        // tutti passes definitions it resolved from the user's config (§ 4.6): a stdio one here.
        mcpServers: {
          "spike-sdk": spike,
          "spike-passed-stdio": { type: "stdio", command: "bun", args: [stdioServer] },
        },
        strictMcpConfig: strict,
        env: baseEnv({}),
        maxTurns: 1,
      },
      2_000,
    )
    const inits = messages.flatMap(({ message }) =>
      message.type === "system" && message.subtype === "init" ? [message] : [],
    )
    for (const [i, init] of inits.entries()) {
      say(`  [${name}] system/init #${i + 1}: apiKeySource=${init.apiKeySource}`)
      say(`    mcp_servers: ${JSON.stringify(init.mcp_servers)}`)
      say(`    plugins: ${JSON.stringify(init.plugins.map((p) => p.name))}`)
    }
    const servers = Array.isArray(status)
      ? status.map((s: { name: string; status: string; scope?: string; source?: string }) => ({
          name: s.name,
          status: s.status,
          scope: s.scope,
          source: s.source,
        }))
      : status
    say(`  [${name}] mcpServerStatus(): ${JSON.stringify(servers)}`)
  }
}

// ---------------------------------------------------------------------------------------------
// subagent: the verifier in the foreground, and forwardSubagentText

const VARIANTS = [
  "default",
  "fork0",
  "def-bg-false",
  "fm-bg-false",
  "tool-false",
  "no-bg",
  "hook-false",
  "no-forward",
] as const
type Variant = (typeof VARIANTS)[number]

const verifierPrompt =
  "You are the verifier. Run exactly this Bash command: `sleep 8 && echo verified-spike`. " +
  "Then reply with one line: VERIFIED followed by the command's output."

const verifierFile = (background: boolean | undefined) =>
  [
    "---",
    "name: verifier",
    "description: Checks a finished change. Give it the ticket's ID.",
    "tools: Bash",
    `model: ${model}`,
    ...(background === undefined ? [] : [`background: ${background}`]),
    "---",
    verifierPrompt,
    "",
  ].join("\n")

// Allows the verifier's sleep and nothing else that needs asking.
const canUseTool: CanUseTool = async (toolName, input) => {
  const command = typeof input.command === "string" ? input.command : ""
  if (toolName === "Bash" && command.startsWith("sleep ")) {
    return { behavior: "allow", updatedInput: input }
  }
  if (toolName === "Agent" || toolName === "Task") return { behavior: "allow", updatedInput: input }
  return { behavior: "deny", message: "The spike allows only the verifier's sleep." }
}

// An in-process PreToolUse hook that rewrites the verifier's Agent call to run in the foreground,
// without deciding its permission.
const foregroundHook: HookCallbackMatcher = {
  matcher: "Agent",
  hooks: [
    async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {}
      const toolInput = input.tool_input as Record<string, unknown>
      if (toolInput.subagent_type !== "verifier") return {}
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...toolInput, run_in_background: false },
        },
      }
    },
  ],
}

type Row = Record<string, string | number | boolean | undefined>

const scenarioSubagentVariant = async (variant: Variant): Promise<Row> => {
  const name = `subagent-${variant}`
  const cwd = makeProject(name, {
    ".claude/agents/verifier.md": verifierFile(variant === "fm-bg-false" ? false : undefined),
  })
  const env: Record<string, string> = {}
  if (variant !== "default") env.CLAUDE_CODE_FORK_SUBAGENT = "0"
  if (variant === "no-bg" || variant === "no-forward") env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1"
  const agents: Record<string, AgentDefinition> | undefined =
    variant === "def-bg-false"
      ? {
          verifier: {
            description: "Checks a finished change. Give it the ticket's ID.",
            prompt: verifierPrompt,
            tools: ["Bash"],
            model,
            background: false,
          },
        }
      : undefined
  const prompt = [
    'Use the Agent tool once, with subagent_type "verifier" and the prompt "Check ticket spike-1".',
    variant === "tool-false" ? "Pass run_in_background: false." : "",
    "When the verifier's answer is in front of you, reply with its VERIFIED line and stop.",
  ]
    .filter((s) => s !== "")
    .join(" ")
  const t0 = Date.now()
  const { messages } = await runSession(
    name,
    prompt,
    {
      cwd,
      model,
      settingSources: ["project", "local"],
      permissionMode: "default",
      canUseTool,
      forwardSubagentText: variant !== "no-forward",
      strictMcpConfig: true,
      ...(variant === "hook-false" ? { hooks: { PreToolUse: [foregroundHook] } } : {}),
      env: baseEnv(env),
      ...(agents ? { agents } : {}),
    },
    45_000,
  )
  // The parent's Agent call, its tool_result, the task messages and the subagent's own text.
  let agentCall: { id: string; input: Record<string, unknown>; at: number } | undefined
  let agentResult: { at: number; text: string; status: unknown } | undefined
  const results: number[] = []
  let taskStarted: { at: number; backgrounded: unknown } | undefined
  let taskNotification: number | undefined
  let subText = 0
  let subTextWithParent = 0
  let lastSubAt = -1
  for (const { at, message } of messages) {
    if (message.type === "result") results.push(at)
    if (message.type === "system" && message.subtype === "task_started" && !taskStarted) {
      taskStarted = { at, backgrounded: message.is_backgrounded }
    }
    if (message.type === "system" && message.subtype === "task_notification") taskNotification = at
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (
          message.parent_tool_use_id === null &&
          block.type === "tool_use" &&
          (block.name === "Agent" || block.name === "Task") &&
          !agentCall
        ) {
          agentCall = { id: block.id, input: block.input as Record<string, unknown>, at }
        }
        if (message.parent_tool_use_id !== null) {
          lastSubAt = at
          if (block.type === "text") {
            subText++
            if (message.parent_tool_use_id === agentCall?.id) subTextWithParent++
          }
        }
      }
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      if (message.parent_tool_use_id !== null) lastSubAt = at
      for (const block of message.message.content) {
        if (
          typeof block === "object" &&
          block.type === "tool_result" &&
          block.tool_use_id === agentCall?.id
        ) {
          const content = block.content
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c) => ("text" in c ? c.text : "")).join(" ")
                : ""
          const tur = message.tool_use_result as { status?: unknown } | undefined
          agentResult = { at, text: text.slice(0, 160).replace(/\s+/g, " "), status: tur?.status }
        }
      }
    }
  }
  const firstResult = results[0]
  const foreground =
    agentResult !== undefined &&
    agentResult.status !== "async_launched" &&
    lastSubAt >= 0 &&
    firstResult !== undefined &&
    lastSubAt < agentResult.at &&
    agentResult.at < firstResult
  const row: Row = {
    variant,
    agentCall: agentCall ? JSON.stringify(agentCall.input).slice(0, 120) : "none",
    toolResultStatus: String(agentResult?.status),
    toolResultText: agentResult?.text,
    taskStartedBackgrounded: String(taskStarted?.backgrounded),
    toolResultAt: agentResult?.at,
    lastSubagentMessageAt: lastSubAt,
    firstResultAt: firstResult,
    results: results.length,
    taskNotificationAt: taskNotification,
    subagentTextBlocks: subText,
    subagentTextWithParentId: subTextWithParent,
    foreground,
    took: since(t0),
  }
  say(`  [${name}] ${JSON.stringify(row)}`)
  return row
}

const scenarioSubagent = async () => {
  say("== subagent: does the verifier run in the foreground?")
  const variants = onlyVariant ? VARIANTS.filter((v) => v === onlyVariant) : VARIANTS
  if (variants.length === 0) throw new Error(`no variant ${onlyVariant}: ${VARIANTS.join(", ")}`)
  const rows: Row[] = []
  for (const v of variants) rows.push(await scenarioSubagentVariant(v))
  say("  summary:")
  for (const r of rows) {
    say(
      `    ${String(r.variant).padEnd(13)} foreground=${r.foreground} status=${r.toolResultStatus} ` +
        `backgrounded=${r.taskStartedBackgrounded} results=${r.results} ` +
        `subText=${r.subagentTextBlocks}/${r.subagentTextWithParentId}`,
    )
  }
}

// ---------------------------------------------------------------------------------------------

const main = async () => {
  mkdirSync(outDir, { recursive: true })
  say(`out: ${outDir}  model: ${model}`)
  if (scenario === "mcp") await scenarioMcp()
  else if (scenario === "subagent") await scenarioSubagent()
  else if (scenario === "all") {
    await scenarioMcp()
    await scenarioSubagent()
  } else {
    say("usage: bun spikes/sdk-mcp/spike.ts mcp|subagent|all [--model <m>] [--variant <v>]")
    process.exit(2)
  }
}

await main()
