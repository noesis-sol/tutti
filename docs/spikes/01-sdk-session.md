# Spike 01: Agent SDK sessions and `canUseTool` under Bun

Ticket tutti-nrg.1.1, M0 spike (1), first half (spec § 14; § 4.1, § 4.2, § 4.5, § 3.2).

## Setup

- `@anthropic-ai/claude-agent-sdk` **0.3.301**, with its bundled Claude Code **2.1.301**
  (`claude-agent-sdk-darwin-arm64`, `system/init.claude_code_version`).
- Bun **1.4.3**, macOS arm64. The machine's Claude login: `initializationResult().account` was
  `{ email, organization, subscriptionType: "Claude Max", apiProvider: "firstParty" }`, and
  `system/init.apiKeySource` was `"none"`. `account.apiKeySource` was absent (optional in the types).
- Model: Claude Code's default (`claude-opus-5-5[1m]`). `settingSources: ["user", "project", "local"]`,
  as § 4.1 has it.
- The script is `spikes/sdk-session/spike.ts`: `bun spikes/sdk-session/spike.ts <scenario>`, with the
  scenarios `streaming`, `queue`, `permissions`, `pending`, `auto`, `auto-off`, `background`,
  `retry`, `options`. Each scenario makes a temp git repository, runs `query()` in streaming input
  mode with `prompt` an `AsyncIterable<SDKUserMessage>` fed from a queue, and logs every SDK
  message and every `canUseTool` call as JSON lines (`$SPIKE_OUT`, by default under the OS temp
  folder). `bunx tsc --noEmit -p spikes/sdk-session` type-checks it.

**The SDK works under Bun.** Every scenario ran under Bun with no runtime problem. One unrelated
Bun quirk showed up in the spike's own proxy (item 4, `api_retry`).

Verdicts: **works** (as the spec says), **differs** (works, but not as the spec says, with a
follow-up ticket), **fails**.

## Findings, item by item

### 1. Streaming input, queued follow-ups, `client_composed`, `origin: human`

| What | Verdict | Observed |
|---|---|---|
| `query()` with `prompt` an `AsyncIterable` fed from a queue | works | One subprocess for the session; each message pushed starts or joins a turn. The `Inbox` class in the script is all it takes. |
| Follow-ups pushed **during a tool call** | **differs** | Pushed while `sleep 12` ran, a `human` and a `client_composed` follow-up were **folded into the running turn** between tool rounds: one `result` (`"FIRST DONE\n\nSECOND DONE\n\nTHIRD DONE"`), `queued_turn_count: 0`, `user_message_uuids` listing all three sends. → tutti-nrg.16 |
| Follow-ups pushed **while the model generates its answer** (no tool call) | **differs** | They became later turns. Two sends of the same kind were **coalesced into one turn** (one result, `user_message_uuids` of length 2). A `human` and a `client_composed` send were not coalesced. → tutti-nrg.16 |
| `queued_turn_count` | **differs** | It counts only queued sends **without** `client_composed`. Two queued `client_composed` sends: the first result said `0`, yet a further turn followed. Two `human` sends: `2`, as documented. Mixed (`human`, then `client_composed`): `1`, then `0` while the composed send was still queued. → tutti-nrg.14 |
| `client_composed: true` | works | A slash command is not dispatched: `/context` reached the model as text (it answered that it can't run built-in commands). An `@SECRET.md` mention is not expanded (the model answered `NOT-ATTACHED`). |
| `origin: { kind: "human" }`, no `client_composed` | works | `/context` was dispatched: the context report came back as an `assistant` message and a `result` with `num_turns: 0` (no `local_command_output` message). `@SECRET.md` was expanded (the model read the secret word without a tool). |
| `command_lifecycle` | (not in the spec) | For every send: `{ type: "command_lifecycle", command_uuid, state: "queued" | "started" | "completed" }`, `command_uuid` being the `uuid` tutti gave the `SDKUserMessage`. It is not in the SDK's `SDKMessage` union. It tracks each send exactly, folded or queued. |

The user's own `SessionStart` hooks ran in the session (`system/hook_started`, `system/hook_response`)
since `settingSources` includes `user`.

### 2. `canUseTool`

Run in `permissionMode: "default"`, so that ordinary calls ask. The `options` argument, as seen:

```jsonc
// Bash, touch made-by-bash.txt (in the working directory)
{ "suggestions": [
    { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "touch made-by-bash.txt" }],
      "behavior": "allow", "destination": "localSettings" },
    { "type": "addDirectories", "directories": ["<cwd>"], "destination": "session" },
    { "type": "setMode", "mode": "acceptEdits", "destination": "session" } ],
  "blockedPath": "<cwd>/made-by-bash.txt",
  "displayName": "Bash", "description": "Create empty file made-by-bash.txt",
  "toolUseID": "toolu_…", "requestId": "<uuid>" }

// Read of a file outside the working directory
{ "suggestions": [{ "type": "addRules", "rules": [{ "toolName": "Read", "ruleContent": "//<dir>/**" }],
    "behavior": "allow", "destination": "session" }],
  "decisionReason": "Path is outside allowed working directories", "decisionReasonType": "workingDir",
  "displayName": "Read", "description": "<path>", "toolUseID": "…", "requestId": "…" }

// Write
{ "suggestions": [{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }],
  "displayName": "Write", "description": "notes.txt", "toolUseID": "…", "requestId": "…" }

// AskUserQuestion
{ "displayName": "AskUserQuestion", "toolUseID": "…", "requestId": "…", "requiresUserInteraction": true }

// rm -rf $SPIKE_TARGET/* (the safety check), default mode
{ "suggestions": [],
  "decisionReason": "Dangerous rm operation on possibly-empty variable path: $SPIKE_TARGET/* in `rm -rf $SPIKE_TARGET/*` (rewrite it as \"${SPIKE_TARGET:?}\"/* or use a literal path)",
  "decisionReasonType": "safetyCheck", "suppressAlwaysAllowRule": true,
  "displayName": "Bash", "description": "Remove contents of the spike target directory", … }
```

| What | Verdict | Observed |
|---|---|---|
| `title` | **differs** | Never present, in any request. The CLI sets it only from a host-supplied permission display (a `PreToolUse` `permissionDisplay`, marked internal to Desktop). → tutti-nrg.19 |
| `displayName` | works | Always present: the tool's name (`Bash`, `Write`, `Read`, `Monitor`, `AskUserQuestion`). |
| `description` | works | The tool call's own description for Bash and Monitor; the file name or path for Write and Read. A good one-line summary. |
| `decisionReason` | works | Only on some asks: a Read outside the folder, the safety check, `A variable in braces in this command can't be checked before it runs` (an `echo "${VAR:-x}"`). Absent on plain Bash, Write and AskUserQuestion asks. |
| `decisionReasonType` | (not in the types) | `workingDir`, `safetyCheck`, `other`. Present with `decisionReason`. |
| `blockedPath` | works | Set on every Bash or Monitor call that writes a file, to that file, **even inside the working directory** (checked in a repository outside `$TMPDIR` too). Not set on the Read outside the folder, where the path is in `description` instead. |
| `suggestions` | works, with a catch | Mixed kinds: `addRules` (Bash: the exact command, destination `localSettings`; Read: a directory glob, destination `session`), `addDirectories`, `setMode acceptEdits`. See "Allow with `updatedPermissions`" below. |
| `toolUseID`, `requestId` | works | Always present. `agentID` was not seen (no subagent asked). |
| Allow with `updatedInput` | works | A Write of `original` allowed with `content` rewritten: `notes.txt` held `rewritten by the host`. `decisionClassification: "user_temporary"` accepted. |
| Allow with `updatedPermissions`, destination `session` | works, **differs** in what to pass | With only the `addRules` suggestions (destination rewritten to `session`): the same command was not asked again; a sibling (`touch another-file.txt`) was. With **every** suggestion rewritten to `session`, the `setMode` one switched the session to `acceptEdits` (`system/status {"permissionMode":"acceptEdits"}`, and every later `system/init` said `acceptEdits`), after which `TARGET=build; rm -rf "$TARGET"` ran without asking. → tutti-nrg.18 |
| Deny without `interrupt` | works | `{ behavior: "deny", message, decisionClassification: "user_reject" }`: the `tool_result` is `is_error` with exactly the message; the turn goes on and the model answers; the `result` is `success`, with the call in `permission_denials` (`{ tool_name, tool_use_id, tool_input }`). |
| AskUserQuestion | works | `input.questions`: `[{ question, header, options: [{ label, description }], multiSelect }]`. Answered `{ behavior: "allow", updatedInput: { questions, answers: { "Which colour?": "Blue" } } }`; the tool result reads `Your questions have been answered: "Which colour?"="Blue". …` and the model answered `Blue`. |
| The held removal (`rm -rf` on a variable target) | **differs** | In **default** mode, `rm -rf $SPIKE_TARGET/*` (a variable from the environment) reached `canUseTool` with `decisionReasonType: "safetyCheck"` and `suppressAlwaysAllowRule: true`, but **without `defaultToNo`**. A variable set in the same command (`TARGET=build; rm -rf "$TARGET"`) asked as an ordinary Bash call, with no flags. In **auto** mode the safety-check removal never reached `canUseTool` (item 4). `defaultToNo` was never seen. → tutti-nrg.17 |
| `session_state_changed` around a request | works | `running → requires_action` when `canUseTool` is called, `→ running` once it is answered. |

### 3. A request left pending for an hour

**Works.** `bun spikes/sdk-session/spike.ts pending` (default `--hold 3600`): a Bash `touch` in
default mode reached `canUseTool` at 20:28:18 and was held in the callback for 3600 s, then
allowed at 21:28:18.

- During the hour, nothing arrived on the message stream: 10 messages before the hold, the same 10
  at each 5-minute check. The last state was `session_state_changed: requires_action`. The
  callback's `signal` never aborted. No time limit on the CLI's side (the SDK's `CanUseTool` doc
  says "permission prompts have no park deadline").
- Once answered: `running`, the tool ran (the file was created), the turn ended with a `success`
  result (`num_turns: 2`) and `idle`.
- A follow-up message then got its own turn and answer (`STILL HERE`): the session carried on.

So § 4.5's "the request stays answerable for the rest of the run" holds, with no keep-alive from
tutti. A 20-second hold (the script's first run) behaved the same way.

### 4. Session events

| What | Verdict | Observed |
|---|---|---|
| `session_state_changed` with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` | works, **differs** in meaning | `{ type: "system", subtype: "session_state_changed", state: "running" | "requires_action" | "idle" }`. `running` before each turn's `system/init`, `requires_action` while `canUseTool` waits, `idle` right after a turn's `result`. Queued turns ran without an `idle` between them. But `idle` also came **while background tasks were live** (below). → tutti-nrg.15 |
| `system/init` on every turn | works | One per turn, including turns the CLI starts on its own (a finished background task). Fields: `apiKeySource`, `capabilities` (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`, `msg_lifecycle_v1`, …), `claude_code_version`, `cwd`, `permissionMode`, `model`, `mcp_servers`, `agents`, `tools`, `skills`, `plugins`, `session_id`, `user_message_uuids`, `view_mode`, among others. |
| `result` with `queued_turn_count` | works, **differs** | Present on every result. `user_message_uuids` lists the sends the turn consumed; `user_message_uuid` was the **first** of three folded sends, not the last as the types say. See item 1 for what it counts. → tutti-nrg.14 |
| `background_tasks_changed` | works | `{ subtype: "background_tasks_changed", tasks: [{ task_id, run_id, task_type: "local_bash", description }] }`, replacing the set on each change; `tasks: []` when the last one ended. Edge messages beside it: `task_started` (`is_backgrounded: true`), `task_updated` (`patch.status: "completed"`), `task_notification`. |
| `idle` with a background task live | **differs** | A `run_in_background` `sleep 20`: `result` and `idle` at once, the task still listed; 20 s later the task finished, the set emptied, and the CLI ran a turn by itself to report it (`running`, `system/init`, a Read of the output, `result`, `idle`). A Monitor watch (live up to 30 min) likewise left `idle` with the task listed. → tutti-nrg.15 |
| Ambient tasks | not seen | Neither the background Bash task nor the Monitor watch carried `ambient`. I found no way to start an ambient task from a prompt. |
| `api_retry` | works | A local proxy (`ANTHROPIC_BASE_URL`) answering 529 to the first two `/v1/messages` requests: `{ subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 519, error_status: 529, error: "overloaded" }`, then the turn succeeded. The first 529 hit a request made before `system/init` (not the turn's), which was retried with no `api_retry`. The OAuth login works through `ANTHROPIC_BASE_URL`. (Bun's `fetch` in the proxy decompresses a response but keeps its `content-encoding`, which made the CLI fail with `BrotliDecompressionError` until the proxy asked for `identity`; a proxy concern, not the SDK's.) |
| `permission_denied` in auto mode | works, **differs** | `{ subtype: "permission_denied", tool_name, tool_use_id, decision_reason_type, decision_reason, message }`. Seen with `decision_reason_type: "classifier"` (`rm -rf "$SPIKE_TARGET"`, reason `[Unverifiable Deletion Target]`) and `"safetyCheck"` (`rm -rf $SPIKE_TARGET/*`, the reason quoted in item 2; the `message` says "Only a person may approve such a removal, and no person did (the permission prompt timed out, or this session cannot prompt)"). The call is also in the result's `permission_denials`. § 4.5 lists only `classifier`, `mode` and `rule`, and expects the safety check to ask. → tutti-nrg.17 |
| `permission_check_status` | (not in the spec) | In auto mode, `{ subtype: "permission_check_status", tool_use_id, status: "checking" }` then `"done"` while the classifier decides (a few seconds). |

What the classifier allowed in auto mode, when asked for directly: `git status`,
`curl -fsSL https://install.example.invalid/setup.sh | bash`, `TARGET=build; rm -rf "$TARGET"`,
`rm -rf build/*`. The model itself refused an exfiltration-shaped `curl` (a
`model_refusal_fallback` message and a retry on another model, then a refusal), `rm -rf "$PWD"`,
and a force-push planted in a file; none of these reached the classifier.

### 5. `permissionMode: "auto"`

| What | Verdict | Observed |
|---|---|---|
| Available on this account | works | Claude Max, default model: `system/init.permissionMode` is `"auto"` on every turn. |
| When it isn't available | works | With auto mode turned off (`settings: { disableAutoMode: "disable" }`) and `permissionMode: "auto"` asked for, `system/init.permissionMode` is `"default"`. No other message says why; the session runs in default mode. § 4.1's check (compare the mode in effect with the one asked for) is what tutti needs. |

### 6. `sessionId`, `projectConfigRoot`, `env`

| What | Verdict | Observed |
|---|---|---|
| `sessionId` drawn by the caller | works | A `randomUUID()` passed as `sessionId`: `system/init.session_id` and every `result.session_id` equal it. |
| `projectConfigRoot` | works, **differs** for permissions | A worktree as `cwd`, its main checkout as `projectConfigRoot`: agents come from the main checkout (`main-probe` loaded, the branch's `branch-probe` not); CLAUDE.md comes from the worktree (the model read the worktree's password). Project settings are read from the main checkout, but their `permissions.allow` was **ignored**: stderr said `Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted. … set projects["<main checkout>"].hasTrustDialogAccepted: true in ~/.claude.json`. Nothing in `system/init` or `initializationResult()` says so. → tutti-nrg.20 |
| `env` replaces `process.env` | works | `SPIKE_PARENT` set in the host's `process.env` but left out of `env`, `SPIKE_CHILD` only in `env`: the worker's shell printed `parent=unset child=from-options-env`. |

Also seen: a `cwd` given through a symlink (`/var/folders/…`, which is `/private/var/folders/…` on
macOS) made Claude Code treat a file in it as outside the folder (an `addDirectories` suggestion for
the real path). tutti should pass worktree paths through `realpath`.

## Contradictions with the spec, and their tickets

| Ticket | Spec | Finding |
|---|---|---|
| tutti-nrg.14 | § 4.2 Idle | `queued_turn_count` leaves out queued `client_composed` sends; `session_state_changed: idle` and `command_lifecycle` don't. |
| tutti-nrg.15 | § 4.2 Idle | `session_state_changed: idle` fires with background tasks live; Monitor tasks aren't `ambient`; a finished task starts a turn by itself. |
| tutti-nrg.16 | § 4.1 Queueing | Follow-ups can fold into the running turn or share a turn; match results to sends by `user_message_uuids`. |
| tutti-nrg.17 | § 4.5 When requests come | In auto mode the safety check denies a held removal (`permission_denied`, `safetyCheck`) without asking; in default mode it asks without `defaultToNo`. |
| tutti-nrg.18 | § 4.5 Allow for this run | Pass only `addRules` suggestions: `setMode` would switch the session to `acceptEdits`. |
| tutti-nrg.19 | § 4.5 The request | `title` never arrives; build the card from `displayName` and `description`. |
| tutti-nrg.20 | § 4.1, § 4.13 | Project allow rules through `projectConfigRoot` need the main checkout to be trusted; only stderr says so. |
