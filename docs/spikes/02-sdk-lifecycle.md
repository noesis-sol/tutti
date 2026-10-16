# Spike 02: interrupt, close, resume and process groups

Ticket tutti-nrg.1.2, M0 spikes (1, second half) and (2) (spec § 14), for § 3.2 and § 4.8.

- **Script:** `spikes/sdk-lifecycle/spike.ts`. Run it with
  `bun spikes/sdk-lifecycle/spike.ts all`, or name experiments:
  `interrupt`, `close`, `resume`, `kill9`, `pgroup`, `rerun`. `SPIKE_CASES=a,b` runs only the named
  cases of `kill9` and `rerun` (the case names are the keys of their results). Each experiment
  prints `RESULT <name> {…}` on stdout; every SDK message goes to stderr, one line each. `all` takes
  about 25 minutes. The script type-checks with `bunx tsc --noEmit -p spikes/sdk-lifecycle`.
- **Versions:** `@anthropic-ai/claude-agent-sdk` 0.3.301 with its embedded Claude Code 2.1.301,
  Bun 1.4.3, macOS arm64 (Darwin 25.6), 2026-10-16.
- **Sessions:** model `haiku`, streaming input mode, `settingSources: []`, `permissionMode:
  "default"` with a `canUseTool` that allows everything unless the case says otherwise, in a fresh
  git folder under the system temp folder. The environment is the host's without its `CLAUDE*`
  variables, plus `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`.
- **A long turn** is "run `./wait.sh <n>` with the Bash tool, then reply DONE". `wait.sh` runs
  `sleep "$1"`. Claude Code's Bash tool refuses a standalone long `sleep` ("Blocked: standalone
  sleep …"), so the script stands in for it. Each `n` is unique (`40.540215`), so `pgrep -f` finds
  that turn's `sh` and `sleep` and nothing else.
- **The host role.** For the experiments that kill the host or signal its process group, the
  script starts itself as a child (`spike.ts host …`), detached into a process group of its own as a
  terminal's foreground job would be. That child holds the sessions and reports PIDs as JSON lines.
- **Spawn modes.** `sdk` is the SDK's own spawn. `same` is a pass-through `spawnClaudeCodeProcess`
  (same process group, but the script can watch the child and record each `kill()` the SDK sends).
  `group` starts claude with `detached: true`, so it leads a process group of its own. `reaped` is
  `group` plus a reaper (§ 4 below).

## Summary

| Item | Result |
|---|---|
| `interrupt()` receipt | **As specified.** It came back in 5 ms with `still_queued` listing both queued messages. The interrupted turn's result (`error_during_execution`) followed 17 ms after the call. The running Bash command was killed |
| Queued messages after a plain interrupt | **They run, at once.** The next turn started 10 ms after the interrupted result, and both messages were coalesced into it (`"BRAVO\nCHARLIE"`) |
| `interrupt_cancel_queued_v1` | **Advertised, and it works.** `interrupt({ cancelQueued: true })` returned `still_queued: []` with both under `cancelled`, and nothing ran after it. The SDK's `.d.ts` declares `interrupt()` with no parameter; the runtime takes `{ cancelQueued }` |
| `close()`, idle | Claude exits by itself on stdin EOF, **0.73 to 0.78 s** after `close()` (exit 0). The SDK sends no signal |
| `close()`, mid-turn | **Claude ignores the EOF.** The SDK sends SIGTERM at **2.00 s** (the grace). Claude exits 143 at 2.6 s, and its Bash children are gone. SIGKILL would follow 5 s after SIGTERM |
| `resume` with a drawn `sessionId` | **Works.** `system/init` and the result carry the drawn ID, and the resumed session remembers the first turn |
| `resume` and `sessionId` together | Refused: claude exits 1, so the stream throws `Claude Code process exited with code 1` |
| Resume after the worktree is removed | **No `startup_failure_reason`** (contradicts § 4.8). The spawn fails before claude runs (`posix_spawn` ENOENT), and the SDK reports it as `Claude Code native binary … exists but failed to launch. This usually means the binary does not match this system's libc …` |
| A worktree re-created (empty) at the same path | Resumes normally, transcript intact |
| `kill -9` of the host, workers idle | Each claude ends **0.8 s** later (stdin EOF), in either spawn mode |
| `kill -9` of the host, workers mid-turn | **Each claude runs on until its turn ends** (contradicts § 3.2). Here that was 63 to 65 s, after its 60 s Bash command finished, in either spawn mode |
| The same, with a per-worker reaper | The Bash commands are gone in 0.1 s and each claude in **2.9 s** |
| `spawnClaudeCodeProcess` in a process group of its own | **Works.** SIGINT to the host's group doesn't reach claude: the turn finished (`DONE`), and a later message got `PONG`. With the SDK's own spawn, the same SIGINT killed claude mid-turn, and the next message got no answer |
| Spike (2): `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` | **Re-runs the interrupted turn by itself,** with no message sent, and **raises the permission request again,** but **only if the turn was cut off.** After tutti's own quit (`interrupt()`, then `close()`), nothing runs: the interrupt records the turn as ended (contradicts § 4.8's plan) |
| `resume_reason` | `host_draining` (the value of `CLAUDE_CODE_RESUME_REASON`), on the rescue turn's assistant messages and on its result |
| tutti's own carry-on message | **Carries on in every case tried,** in one turn: the worker re-runs the call that was cut off and finishes |

**Recommendation for § 4.8's next-run message: tutti's own `client_composed` carry-on message,
without `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`** (§ 7).

## 1. `interrupt()` and its receipt

`bun spikes/sdk-lifecycle/spike.ts interrupt`. Each case starts a session and sends A, the long
turn. Once the Bash call is running, it sends B ("Reply with the single word BRAVO.") and C
("… CHARLIE."), each with its own `uuid`, waits 0.8 s, and calls `interrupt()`. It then watches for
25 s.

- **Capabilities.** `system/init` listed `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`,
  `interrupt_send_now_v1`, `msg_lifecycle_v1`, `request_marker_lists_v1` and others.
- **The plain receipt:** `{ "still_queued": [B, C] }`, 5 ms after the call. The interrupted turn's
  result followed 17 ms after the call:
  - `subtype: "error_during_execution"`, `is_error: true`;
  - `errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]`;
  - just before it, two `user` messages: a `tool_result` "The user doesn't want to proceed with this
    tool use…" and the text `[Request interrupted by user for tool use]`. These are in the
    transcript too (§ 6);
  - the Bash command's `sh` and `sleep` were gone by then.
- **The survivors ran at once.** A new turn (a new `system/init`) started 10 ms after the
  interrupted result. B and C were coalesced into it, and it answered `"BRAVO\nCHARLIE"`, stamped
  with C's `user_message_uuid`.
- **`cancelQueued: true`.** The receipt was `{ "still_queued": [], "cancelled": [B, C] }`, and no
  other turn ran in the next 25 s. The SDK's type is `interrupt(): Promise<SDKControlInterruptResponse
  | undefined>`, but its implementation is `interrupt(e)`, sending `cancel_queued: true` when
  `e?.cancelQueued === true`. The spike calls it through a cast.

§ 4.8 step 2 says "tutti cancels them where the CLI advertises `interrupt_cancel_queued_v1`, and
closing the session drops them anyway". The first half works. The second doesn't hold: the
survivors start their turn within milliseconds of the interrupted result, before tutti can close
the session, so their text is in the transcript and the closing kills that new turn mid-way
(tutti-nrg.25).

## 2. `close()` and the grace

`bun spikes/sdk-lifecycle/spike.ts close`, with the pass-through spawner, which records each
`kill()` the SDK sends. The forwarded `SpawnOptions.signal` is deliberately not passed to `spawn()`.

| Case | Stream ended | claude exited | Signals the SDK sent |
|---|---|---|---|
| Idle (after a finished turn) | 0.73 s after `close()` | 0.73 to 0.78 s, exit 0 | none |
| Mid-turn (Bash running) | 2.00 s | 2.6 s, exit 143 | SIGTERM at 2.00 s |

- `close()` returns at once (0 to 1 ms) and doesn't throw. The `for await` over the query ends
  without an error.
- The SDK's code matches: it ends stdin, and after `2000` ms sends SIGTERM if the child is still
  running. Then, after another 5 s, it sends SIGKILL.
- Mid-turn, claude ignores the EOF until SIGTERM. The Bash command it was running was gone after
  the exit, and the transcript records its `tool_result` as `Exit code 137`.
- The forwarded abort signal never fired, since no `abortController` was aborted.

§ 3.2 ("closing the subprocess's stdin and, after about 2 seconds of grace, aborting it") is right.
"Aborting" is SIGTERM, then SIGKILL 5 s later.

## 3. `resume` with a drawn `sessionId`, and a removed worktree

`bun spikes/sdk-lifecycle/spike.ts resume`.

1. A session started with `sessionId: <a UUID the script drew>` is told a codeword, then closed.
2. A session with `resume: <that UUID>` (no `sessionId`) is asked for the codeword. Its
   `system/init` and result carry the same session ID, and it answered with the codeword.
   `getSessionMessages(id, { dir })` read 4 messages back.
3. **`resume` together with `sessionId`** (without `forkSession`): claude exits with code 1 before
   any message.
4. **The worktree removed** (the folder deleted), then resumed with
   `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`:
   - The SDK's own spawn and the pass-through spawner both fail at once. Node's `spawn` can't
     `chdir` into the missing folder (`ENOENT … posix_spawn '…/claude'`), and the SDK throws
     `Claude Code native binary at …/claude exists but failed to launch. This usually means the
     binary does not match this system's libc …`. No message, no result. Without the variable it
     is the same.
   - **The folder removed after the spawn** (`sh -c 'cd "$0" && rm -rf "$0" && exec "$@"'`): claude
     prints `error: The current working directory was deleted, so that command didn't work. Please
     cd into a different directory and try again.` on stderr and exits 1. This is Bun's own startup
     error (the embedded claude is a Bun executable), so Claude Code's code never runs, and no
     result comes. It is the same with or without the variable.
   - **An unreadable folder** (mode `0100`) resumes normally.
5. **The worktree re-created**, empty, at the same path: resumes normally and remembers the
   codeword. Transcripts are keyed by the path.

So `startup_failure_reason: "cwd_unavailable"` doesn't come for a removed worktree
(tutti-nrg.23). tutti has to check the worktree itself before resuming. A spawn that fails is
`AgentStartFailed`, and its message (the libc text) shouldn't be shown as the reason.

## 4. `kill -9` of the host

`bun spikes/sdk-lifecycle/spike.ts kill9`. A host starts two sessions in one folder. It waits until
both have finished a short turn (idle), or both have their Bash call running (busy). It reports
their PIDs, and the script then sends it SIGKILL. The script watches each claude and each Bash
`sh`/`sleep` for up to 120 s, then kills whatever is left.

| Case | claude in | claude gone after the kill | Bash commands gone |
|---|---|---|---|
| idle, SDK spawn | the host's group | 0.8 s | n/a |
| idle, own group | its own group | 0.8 s | n/a |
| busy, SDK spawn | the host's group | **63.1 s, 63.3 s** | 59.2 to 59.4 s (when they finished) |
| busy, own group | its own group | **63.9 s, 64.8 s** | 60.3 to 60.4 s (when they finished) |
| busy, reaped | its own group | **2.9 s** | 0.1 s |

- **A busy worker outlives its host.** The host's death closes claude's stdin, as § 3.2 says. But
  claude reads that EOF only once its turn is over, as with `close()` mid-turn (§ 2). Here the turn
  ended when its 60 s command finished.
  - A real worker's turn can last many minutes, editing and committing in the worktree, with nobody
    watching. A worker that asks for permission meanwhile is answered with an error at once: its
    `canUseTool` stream has closed (§ 6).
  - The SDK's own guard, `process.on("exit")` sending SIGTERM to every child it tracks, doesn't run
    on SIGKILL.
- **No option ends claude when its parent dies.** The SDK's types and the binary have no parent-PID,
  orphan or stdin-EOF option.
- **The reaper works.** For each worker, the `reaped` spawner also starts
  `/bin/sh -c 'read _; kill -TERM -"$1"' reaper <claude pgid>`. That `sh` is detached into a group
  of its own, so a terminal's signals don't reach it, and its stdin is a pipe from the host.
  - When the host dies, that pipe closes, `read` returns, and the reaper sends SIGTERM to claude's
    whole process group.
  - When a worker ends normally, the host kills its reaper.
  - The Bash commands went in 0.1 s, and claude after its graceful SIGTERM shutdown, 2.9 s.

§ 3.2's "When tutti is killed (`kill -9`), each worker's stdin closes with it and the worker ends"
holds only for idle workers (tutti-nrg.22).

## 5. A process group of its own, and SIGINT

`bun spikes/sdk-lifecycle/spike.ts pgroup`. A host, the leader of its own group, starts one session
on an 8 s Bash command. Once the command is running, the script sends SIGINT to the host's whole
group (`kill(-pgid, SIGINT)`), as Ctrl+C in a terminal does. The host catches SIGINT, waits for the
turn's result, then sends "Reply with the single word PONG."

| | claude's group | After SIGINT | The turn | PONG |
|---|---|---|---|---|
| SDK spawn | the host's | claude dead | `error_during_execution` (interrupted), stream ended | no answer |
| own group (`detached: true`) | its own (pgid = its pid) | claude alive | `success`, "DONE" | `success`, "PONG" |

- With `detached: true`, the SDK talks to claude as before: the stdio pipes are what matter.
- The `pid` of the returned `ChildProcess` is claude's, so the SDK's `kill()` reaches it.
- This confirms § 3.2. tutti also has to end those groups itself when it dies (§ 4).

## 6. Spike (2): resuming an interrupted turn

`bun spikes/sdk-lifecycle/spike.ts rerun`. Each case leaves a session mid-turn: either **busy**
(its Bash command running), or **pending** (Bash asked for permission and `canUseTool` never
answers). It ends the session one of four ways:

- `close`: `close()` alone, so claude gets SIGTERM after the grace;
- `interrupt+close`: tutti's quit, step 2's `interrupt()` and then step 5's `close()`;
- `kill9`: the host killed, its reaper ending claude;
- `crash`: the host and claude's group both killed with SIGKILL.

It then resumes the session with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` and
`CLAUDE_CODE_RESUME_REASON=host_draining`. It sends nothing, and watches for 60 s for a
`system/init` and 75 s for a result.

| Case | The transcript ends with | Resumed with the variables, nothing sent |
|---|---|---|
| busy, close | the Bash `tool_result` `Exit code 137` | **The turn re-runs:** the Bash call again (a new `tool_use` id), then "DONE" |
| busy, close, without the variables | the same | nothing runs; no `system/init` either |
| busy, interrupt+close | `[Request interrupted by user for tool use]` | **nothing runs** |
| busy, kill9 (reaped) | `Exit code 137` | the turn re-runs, "DONE" |
| busy, crash | the `tool_use`, with no result | the turn re-runs, "DONE" |
| pending, close | `tool_result` `Tool permission request failed: AbortError: Tool permission stream closed before response received` | the turn re-runs; **`canUseTool` is called again** for the same command |
| pending, interrupt+close | `[Request interrupted by user for tool use]` | **nothing runs** |
| pending, kill9 (reaped) | the same AbortError, then a second Bash `tool_use` | the turn re-runs; `canUseTool` called again |
| pending, crash | the `tool_use`, with no result | the turn re-runs; `canUseTool` called again |

- **`resume_reason`** is `host_draining` on the rescue turn's assistant messages and on its result.
  Their `user_message_uuid` is the interrupted turn's own prompt.
- **A permission request asked again is a new request.** Its `toolUseID` is new, since the model
  makes the call again rather than the old request being replayed. tutti's Attention will see a new
  request, not the old one.
- **What the re-run needs.** It happens only when the transcript shows a turn that was cut off.
  `interrupt()` records the turn as ended by the user, so the turn isn't re-run, with or without
  the variables.
  - A clean quit as § 4.8 describes it (step 2 interrupts every worker) therefore never gets the
    SDK's re-run (tutti-nrg.24). Only a quit that skipped the interrupt, a `kill -9`, or a crash
    would.
- **At a permission prompt when the host dies,** the CLI fails the pending request
  (`AbortError: Tool permission stream closed`) and the model goes on with its turn: in `kill9`, it
  made the Bash call a second time before the reaper's SIGTERM ended it. A worker with no host
  doesn't stop at a prompt. Without the reaper, it would keep going until its turn ended (§ 4).

Then **tutti's own carry-on message**: resumed the same way, but with a `client_composed` message
saying tutti was stopped and to carry on with the interrupted turn.

| Case | Variables | Result |
|---|---|---|
| busy, interrupt+close | none | one turn: the Bash call again, then "DONE" |
| busy, crash | none | one turn: the Bash call again, then "DONE" |
| pending, interrupt+close | none | one turn: `canUseTool` asked again, the call made, "DONE" |
| busy, close | both | **one** turn: the rescue turn (`resume_reason: host_draining`), with the message folded into it. Its result carries the message's `user_message_uuid`. No second turn |

## 7. Recommendation: how resumed workers are told to carry on

**Keep § 4.8's own `client_composed` carry-on message, and don't set
`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`.**

- **tutti's quit interrupts first,** so the SDK's re-run never happens after the usual quit. It
  needs a turn that was cut off. Dropping step 2's interrupt to get the re-run would also mean no
  receipt to cancel queued messages with, and no wait for the workers' results. The turn would be
  cut by SIGTERM 2 s into `close()` all the same.
- **The message works after every ending tried:** the clean quit, a crash that left a `tool_use`
  with no result, and a pending permission request. It always took one turn, which re-did the call
  that was cut off.
- **tutti sends a message on every start anyway,** with the per-start facts (§ 4.1). The carry-on
  text belongs in it.
- **Nothing is lost on a `kill -9` or a crash.** The variable would re-run such a turn without a
  message, but tutti's message does the same, and with both, the message just folds into the rescue
  turn. One mechanism is simpler to test.
- **What tutti still has to handle:**
  - A pending permission request comes back as a new request, after either mechanism. Attention
    mustn't expect the old request ID, and the old one is gone with its session.
  - Turns are matched by `user_message_uuid`. A rescue turn would be stamped with the interrupted
    prompt's uuid, and tutti's message with its own.

## Other observations

- **`system/init` comes only with a turn.** A resumed session that is sent nothing, and has nothing
  to re-run, emits no `system/init` at all. tutti can't wait for `system/init` before sending the
  first message of a resumed session.
- **`settingSources: []` still loads skills from the user's setup.** `system/commands_changed`
  listed a skill from this machine's user configuration. It doesn't matter for these results.
- **A failed custom spawn.** When the pass-through spawner's child failed to start (no PID), the SDK
  still called its `kill("SIGTERM")`, then `kill("SIGKILL")`. tutti's spawner must never pass a
  missing PID to `process.kill`: `-1` would signal every process the user owns.
- **Foreground Bash calls emit task events.** A foreground Bash call that runs for a few seconds
  emits `system/task_started` and `system/task_notification`, as background tasks do.

## Contradictions with the spec, and their tickets

| § | The spec says | Observed | Ticket |
|---|---|---|---|
| 3.2 Ending a session; 15.2 | "When tutti is killed (`kill -9`), each worker's stdin closes with it and the worker ends" | A busy worker runs until its turn ends. A per-worker reaper fixes it | tutti-nrg.22 |
| 4.8 Resume limits | "`cwd_unavailable` when the worktree was removed" | No result and no `startup_failure_reason`: the spawn fails (ENOENT, misreported as a libc mismatch), or Bun exits 1 | tutti-nrg.23 |
| 4.8 The next run | If the variable re-runs the turn and raises the permission request again, tutti uses it in place of its own message | It does both, but not after tutti's quit, whose interrupt marks the turn ended | tutti-nrg.24 |
| 4.8 Quitting, step 2 | Queued messages: "closing the session drops them anyway" | After a plain interrupt they start a turn within 10 ms, before the close. Only `cancelQueued` drops them | tutti-nrg.25 |
