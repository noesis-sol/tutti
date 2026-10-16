# Spike 03: `strictMcpConfig`, the verifier in the foreground, and `forwardSubagentText`

Ticket tutti-nrg.1.3, M0 spikes (3) and (4) (spec § 14), for § 4.1 and § 4.6.

- **Script:** `spikes/sdk-mcp/spike.ts` (with `spikes/sdk-mcp/stdio-server.ts`, a minimal stdio MCP
  server). Run it with `bun spikes/sdk-mcp/spike.ts mcp|subagent|all [--variant <v>] [--model <m>]`.
  Every SDK message goes to `$SPIKE_OUT/<scenario>-<time>/<session>/messages.jsonl`.
- **Versions:** `@anthropic-ai/claude-agent-sdk` 0.3.301 with its embedded Claude Code 2.1.301, Bun
  1.3, macOS arm64, 2026-10-16.
- **Account:** a claude.ai subscription login (`apiKeySource: "none"`) with six claude.ai connectors,
  six user MCP servers in `~/.claude.json` and five plugins. So the connector case was tested for
  real.
- **Model:** `haiku` for the parent and the subagent, in streaming input mode, as § 4.1 has it.

## Summary

| Item | Result |
|---|---|
| `strictMcpConfig: true` keeps everything but `mcpServers` out | **Yes.** No user, project, claude.ai connector or plugin server loaded |
| Sources in `system/init` | An SDK server (`createSdkMcpServer`) shows `source: "sdk"`. A stdio definition passed in `mcpServers` shows `source: "dynamic"`, **not the scope tutti resolved it from** (contradicts § 4.1) |
| `CLAUDE_CODE_FORK_SUBAGENT=0` keeps the verifier in the foreground | **No.** It only turns off the `fork` subagent type. The verifier still runs in the background (contradicts § 4.1) |
| `AgentDefinition.background: false` (SDK `agents` option or frontmatter) | **No effect.** Only `background: true` changes anything |
| `run_in_background: false` on the Agent call | **Works**, but only when the model passes it |
| An in-process `PreToolUse` hook that sets `run_in_background: false` on the verifier's call | **Works** whether or not the model passes it. **This is the option to use** |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | **Works**, but turns off every background task in the session, not just the verifier's |
| `forwardSubagentText: true` | **Yes.** The subagent's text arrives as `assistant` messages whose `parent_tool_use_id` is the Agent call's `tool_use` id. With `false`, no subagent text arrives (only its tool calls) |

## 1. `strictMcpConfig`

`bun spikes/sdk-mcp/spike.ts mcp` runs two sessions in a temp project with
`settingSources: ["user", "project", "local"]` and these MCP servers:

- `spike-sdk` passed in `mcpServers`: an in-memory server from `createSdkMcpServer`;
- `spike-passed-stdio` passed in `mcpServers`: a stdio definition, like the ones tutti resolves by name
  (§ 4.6);
- `spike-project` in the project's `.mcp.json`, approved through `enableAllProjectMcpServers` in
  `.claude/settings.local.json`;
- `spike-agent-frontmatter` declared in the frontmatter of a project agent `helper`, which is never
  called;
- whatever this machine's user config, plugins and claude.ai account bring.

The control session left `strictMcpConfig` off. Its first `system/init` listed 15 servers:

| Source | Servers |
|---|---|
| `user` | browserbase, firecrawl, exa, mnemos, inspo, photocraft |
| `project` | spike-project |
| `claudeai` | `claude.ai Claude Docs`, `claude.ai Vanguard Advisor Tools`, `claude.ai Adobe for creativity`, `claude.ai Google Drive`, `claude.ai Google Calendar`, `claude.ai Gmail` |
| `dynamic` | spike-passed-stdio |
| `sdk` | spike-sdk |

With `strictMcpConfig: true`, the first `system/init` listed only the two passed servers:

```json
"mcp_servers": [
  { "name": "spike-passed-stdio", "status": "connected", "source": "dynamic" },
  { "name": "spike-sdk", "status": "connected", "source": "sdk" }
]
```

`mcpServerStatus()` after the turn agreed. It gives `scope: "dynamic"` for both, and
`source: "dynamic"` or `"sdk"`.

What this shows:

- **claude.ai connectors stay out under `strictMcpConfig`.** That's what § 4.6 needed M0 to confirm.
  So do user servers, project `.mcp.json` servers and servers in agent frontmatter. (The frontmatter
  server didn't appear in the control either: such servers load only when their agent runs.)
- **Plugins still load** under `strictMcpConfig` (the same five, in `system/init`'s `plugins`).
  None of this machine's plugins declares an MCP server, so the run doesn't show whether a plugin's
  server is kept out. The SDK's doc comment says it is.
- **A passed definition shows `source: "dynamic"`**, whatever scope tutti found it in (local, project
  or user). Only SDK-type servers show `sdk`. § 4.1 says each server has "source `sdk` or the scope
  tutti passed". tutti can't pass a scope, so the check must accept `dynamic` for passed definitions
  (follow-up tutti-nrg.12).
- **claude.ai connectors show `source: "claudeai"`** and are named `claude.ai <Name>`. That's
  how tutti can tell, in its setup check, that a name refers to a connector (§ 4.6).
- **`status` can be `pending`** in the first `system/init` (servers were still connecting in the
  first control run; all of them were `connected` in the second). The check on `system/init`
  should compare names and sources, not statuses.

## 2. The verifier in the foreground

`bun spikes/sdk-mcp/spike.ts subagent` runs one session per variant. Each temp project has a
subagent `verifier` in `.claude/agents/verifier.md` (tools: Bash) that runs
`sleep 8 && echo verified-spike` and replies `VERIFIED …`. The parent is told to call it with the
Agent tool and reply with its VERIFIED line. Every variant except `default` sets
`CLAUDE_CODE_FORK_SUBAGENT=0`, as tutti's workers will.

The verifier counts as running **in the foreground** when the Agent call's `tool_result` isn't
`async_launched`, comes after the subagent's last message, and comes before the turn's first
`result`. So the parent's turn waited for the verifier.

| Variant | What it sets | Agent `tool_result` | `task_started.is_backgrounded` | `result`s | Foreground |
|---|---|---|---|---|---|
| `default` | nothing | `async_launched` at 2.0 s | true | 2 (3.0 s, then after the verifier ended at 12.5 s) | no |
| `fork0` | `CLAUDE_CODE_FORK_SUBAGENT=0` | `async_launched` | true | 2 | **no** |
| `def-bg-false` | + SDK `agents: { verifier: { …, background: false } }` | `async_launched` | true | 2 | **no** |
| `fm-bg-false` | + frontmatter `background: false` | `async_launched` | true | 2 | **no** |
| `tool-false` | + the prompt tells the model to pass `run_in_background: false` (it did) | `completed`, the verifier's report, at 12.3 s | false | 1 (13.8 s) | yes |
| `hook-false` | + a `PreToolUse` hook (matcher `Agent`) returning `updatedInput` with `run_in_background: false` when `subagent_type` is `verifier` (the model didn't pass the flag) | `completed` at 13.9 s | false | 1 (14.8 s) | yes |
| `no-bg` | + `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | `completed` at 13.2 s | false | 1 (14.2 s) | yes |

In the background variants the parent's turn ended about 3 s in, with a `result`, while the
verifier was still running. When the verifier finished, a `task_notification` came, and a second
turn started and ended with a second `result`. A worker in that state looks done for its first
`result` while its verifier is still running.

### Why, from Claude Code 2.1.301's code

The embedded binary decides with this (de-minified):

```js
const callerIsSubagent = callerIsInProcessTeammate || callerIsHeadlessSubagent
const asyncByDefault = (isCoordinator && !callerIsInProcessTeammate) || forceAsync
  || (!callerIsSubagent && wantsBackground !== false)          // wantsBackground = input.run_in_background
const runAsync = wantsBackground === true || agent.background === true
  || (!isBuiltInWebFetchAgent(agent) && asyncByDefault)
shouldRunAsync = isRemoteLaunch || (runAsync && !backgroundTasksDisabled)
```

- Agents launched from the main thread run in the background by default. The Agent tool's own
  description says so too: "Agents run in the background by default".
- An agent definition's `background` only ever turns the background **on**. `background: false` is
  the same as leaving it out.
- `run_in_background: false` on the call turns off the default. `backgroundTasksDisabled`
  (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`) overrides everything except remote launches.
- `CLAUDE_CODE_FORK_SUBAGENT` feeds only the fork gate: `=0` disables the `fork` subagent type
  (`subagent_type: "fork"`, which inherits the parent's context and always runs in the background).
  It has no part in `shouldRunAsync`. Keeping it at `0` stays harmless and keeps forks away from
  workers, but it isn't what keeps the verifier in the foreground.

### The option that keeps the verifier in the foreground

**An in-process `PreToolUse` hook on the Agent tool that sets `run_in_background: false` when the
call's `subagent_type` is the verifier.** It goes in the `hooks` tutti already passes
(`activityHooks`, § 4.1):

```ts
PreToolUse: [{
  matcher: "Agent",
  hooks: [async (input) =>
    input.hook_event_name === "PreToolUse" &&
    (input.tool_input as { subagent_type?: string }).subagent_type === verifierName
      ? { hookSpecificOutput: { hookEventName: "PreToolUse",
          updatedInput: { ...(input.tool_input as object), run_in_background: false } } }
      : {}],
}]
```

- It works whether or not the model passes the flag. The worker prompt's "run it in the foreground"
  stays as guidance.
- It sets no `permissionDecision`, so the permission flow (`canUseTool`, auto mode) is unchanged.
- It touches only the verifier. Other subagents and background Bash commands keep working.
- The `assistant` message in the stream still shows the model's original input, without
  `run_in_background`. Transcripts show what the model asked for, not what ran.

`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` also works, and needs no hook. But it turns off every
background task in the session: other subagents, and (from the code above, not run in this spike)
background Bash too. That would also enforce § 4.11's "checks in the foreground" rule, so it's a
policy choice for the spec revision. The SDK's `AgentDefinition.background: false` and
`CLAUDE_CODE_FORK_SUBAGENT=0`, the two options § 4.1 names, don't work. The spec revision is
follow-up tutti-nrg.13.

## 3. `forwardSubagentText`

In every variant run with `forwardSubagentText: true`, the verifier's reply arrived as an `assistant`
message with a `text` block and `parent_tool_use_id` set to the `tool_use` id of the parent's Agent
call. That held in the background variants too. In the foreground variants it arrived before the
Agent call's `tool_result`, so a nested transcript (§ 7.5) can be built in order.

The `no-forward` variant (`no-bg` with `forwardSubagentText: false`) is the control. It got the
verifier's tool calls and results (with `parent_tool_use_id`), but no subagent text blocks.

## Contradictions with the spec, and their follow-ups

1. **§ 4.1, "each with source `sdk` or the scope tutti passed".** Definitions passed in `mcpServers`
   show `source: "dynamic"`. → tutti-nrg.12, related to tutti-nrg.3.6.
2. **§ 4.1, `CLAUDE_CODE_FORK_SUBAGENT=0` "so the verifier subagent can run in the foreground", with
   `AgentDefinition.background: false` as the fallback; Appendix A, "Kept, verified in M0".**
   Neither works. The verifier runs in the foreground through a `PreToolUse` hook setting
   `run_in_background: false` (or `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`). → tutti-nrg.13, related
   to tutti-nrg.3.8.

§ 4.6's claim that `strictMcpConfig` keeps claude.ai connectors out holds.
