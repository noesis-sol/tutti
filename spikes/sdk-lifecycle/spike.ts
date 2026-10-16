#!/usr/bin/env bun
// M0 spike (tutti-nrg.1.2): the Agent SDK's session lifecycle under Bun.
//
//   bun spikes/sdk-lifecycle/spike.ts <experiment>...    run some experiments
//   bun spikes/sdk-lifecycle/spike.ts all                run every experiment
//
// Experiments: interrupt, close, resume, kill9, pgroup, rerun. Each one prints what it
// observed as one JSON object on stdout ("RESULT <name> {...}"); the SDK messages it saw go to
// stderr, one line each. The findings are in docs/spikes/02-sdk-lifecycle.md.
//
// It runs real Claude Code sessions (model haiku, no setting sources, so no hooks or MCP
// servers from your settings) in throwaway folders under the system temp folder. Throwaway
// code: not part of tutti, not type-checked or linted by scripts/check.sh.
//
// `host ...` is an internal role: a child Bun process holding sessions, for the experiments
// that kill the host (kill9, rerun) or signal its process group (pgroup).

import {
  type CanUseTool,
  getSessionMessages,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

const SCRIPT = new URL(import.meta.url).pathname
const MODEL = process.env.SPIKE_MODEL ?? "haiku"
const T0 = Date.now()

// ---------------------------------------------------------------------------------------------
// Small helpers

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const log = (...parts: unknown[]) => {
  const t = ((Date.now() - T0) / 1000).toFixed(2).padStart(7)
  process.stderr.write(`[${t}s ${process.pid}] ${parts.map(String).join(" ")}\n`)
}

const result = (name: string, value: unknown) => {
  process.stdout.write(`RESULT ${name} ${JSON.stringify(value, null, 2)}\n`)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pgidOf = (pid: number) => {
  const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" })
  return Number(out.stdout.trim()) || null
}

const childrenOf = (pid: number) => {
  const out = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
  return out.stdout.split("\n").filter(Boolean).map(Number)
}

// Processes whose command line contains `marker` (a unique sleep length): the Bash tool's
// grandchildren, which outlive or die with their claude.
const pidsMatching = (marker: string) => {
  const out = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" })
  return out.stdout.split("\n").filter(Boolean).map(Number)
}

const workspace = (label: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `tutti-spike-${label}-`)))
  spawnSync("git", ["init", "-q", dir])
  // Claude Code's Bash tool refuses a standalone long `sleep`, so the long turns run this.
  writeFileSync(join(dir, "wait.sh"), 'sleep "$1"\n', { mode: 0o755 })
  return dir
}

// SPIKE_CASES=a,b runs only the named cases of an experiment.
const wanted = (name: string) =>
  !process.env.SPIKE_CASES || process.env.SPIKE_CASES.split(",").includes(name)

// A unique sleep length, so pgrep can find this experiment's `sleep` and no one else's.
const uniqueSleep = (seconds: number) =>
  `${seconds}.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`

// The environment of a worker: this process's, without the variables of the Claude Code session
// that may be running this spike, plus the ones the experiment sets.
const workerEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("CLAUDE") || k === "AI_AGENT") continue
    env[k] = v
  }
  return { ...env, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1", ...extra }
}

// ---------------------------------------------------------------------------------------------
// The inbox: streaming input mode's AsyncIterable<SDKUserMessage>

class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
  private ended = false

  push(text: string, uuid: string = randomUUID(), clientComposed = false) {
    const msg = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid,
      ...(clientComposed ? { client_composed: true } : {}),
    } as SDKUserMessage
    if (this.waiting) {
      const w = this.waiting
      this.waiting = undefined
      w({ value: msg, done: false })
    } else this.queue.push(msg)
    return uuid
  }

  end() {
    this.ended = true
    this.waiting?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const msg = this.queue.shift()
        if (msg) return Promise.resolve({ value: msg, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Spawners. "sdk" leaves spawning to the SDK; "same" spawns as the SDK does (the host's
// process group) but lets the spike watch the child; "group" starts claude detached, the
// leader of a process group of its own (setsid), as § 3.2 proposes.

// "reaped" is "group" plus a reaper: a sh in a group of its own whose stdin is a pipe from the
// host, which kills claude's process group when that pipe closes (the host has died).
// "deleted" (resume only) starts claude in its cwd through sh, which removes that folder just
// before exec: a worktree removed under a running claude.
type SpawnMode = "sdk" | "same" | "group" | "reaped" | "deleted"

type Watched = {
  pid: number
  child: ChildProcess
  spawnedAt: number
  exit: Promise<{ code: number | null; signal: string | null; at: number }>
  stderr: string[]
  // The signals the SDK sent with kill(), and when the forwarded abort signal fired
  kills: Array<{ signal: string; at: number }>
  abortedAt: number | null
}

const makeSpawner = (mode: Exclude<SpawnMode, "sdk">, watched: Watched[]) => {
  return (opts: SpawnOptions): SpawnedProcess => {
    const [command, args, cwd] =
      mode === "deleted"
        ? [
            "/bin/sh",
            [
              "-c",
              'cd "$0" && rm -rf "$0" && exec "$@"',
              opts.cwd ?? "",
              opts.command,
              ...opts.args,
            ],
            tmpdir(),
          ]
        : [opts.command, opts.args, opts.cwd]
    const child = spawn(command, args, {
      cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: mode === "group" || mode === "reaped",
      // opts.signal is not passed on, so that only the SDK's own kill() ends the child: the
      // spike records each call and when the signal fired.
    })
    const stderr: string[] = []
    child.stderr?.on("data", (d: Buffer) => {
      stderr.push(d.toString())
      if (stderr.length > 50) stderr.shift()
    })
    const w: Watched = {
      pid: child.pid ?? -1,
      child,
      spawnedAt: Date.now(),
      stderr,
      kills: [],
      abortedAt: null,
      exit: new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() }))
      }),
    }
    child.once("error", (e) => log("spawn error", e.message))
    const kill = child.kill.bind(child)
    child.kill = (signal?: NodeJS.Signals | number) => {
      w.kills.push({ signal: String(signal), at: Date.now() })
      log(`SDK sent ${signal} to claude ${w.pid}`)
      return w.pid > 0 ? kill(signal) : false // never signal pid -1 (every process)
    }
    opts.signal.addEventListener("abort", () => {
      w.abortedAt = Date.now()
      log(`forwarded abort signal fired for claude ${w.pid}`)
    })
    watched.push(w)
    log(`spawned claude pid ${w.pid} (${mode}, pgid ${pgidOf(w.pid)})`)
    if (mode === "reaped" && w.pid > 0) {
      const reaper = spawn("/bin/sh", ["-c", 'read _; kill -TERM -"$1"', "reaper", String(w.pid)], {
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      })
      // A worker that ends normally takes its reaper with it.
      child.once("exit", () => reaper.kill("SIGKILL"))
      log(`reaper pid ${reaper.pid} watches claude group ${w.pid}`)
    }
    return child as unknown as SpawnedProcess
  }
}

// ---------------------------------------------------------------------------------------------
// A session: one query() in streaming input mode, its messages recorded

type SessionOpts = {
  label: string
  cwd: string
  sessionId?: string
  resume?: string
  env?: Record<string, string>
  spawn?: SpawnMode
  canUseTool?: CanUseTool
}

const describe = (m: SDKMessage): string => {
  const a = m as Record<string, unknown>
  const extra: string[] = []
  if (a.resume_reason) extra.push(`resume_reason=${a.resume_reason}`)
  if (a.user_message_uuid) extra.push(`user_message_uuid=${a.user_message_uuid}`)
  if (m.type === "assistant") {
    const blocks = (m.message.content as unknown as Array<Record<string, unknown>>).map((b) =>
      b.type === "text"
        ? `text:${JSON.stringify(String(b.text).slice(0, 80))}`
        : b.type === "tool_use"
          ? `tool_use:${b.name}(${JSON.stringify(b.input).slice(0, 80)})`
          : String(b.type),
    )
    return `assistant ${blocks.join(" ")} ${extra.join(" ")}`
  }
  if (m.type === "result") {
    const r = a as Record<string, unknown>
    return `result ${r.subtype} is_error=${r.is_error} ${JSON.stringify(String(r.result ?? "").slice(0, 80))} startup_failure_reason=${r.startup_failure_reason} errors=${JSON.stringify(r.errors ?? [])} ${extra.join(" ")}`
  }
  if (m.type === "system") {
    const s = a as Record<string, unknown>
    if (s.subtype === "init") return `system/init session_id=${s.session_id} cwd=${s.cwd}`
    return `system/${s.subtype} ${JSON.stringify(s).slice(0, 200)}`
  }
  if (m.type === "user") {
    const content = (m.message as { content: unknown }).content
    const kinds = Array.isArray(content)
      ? content.map((b: Record<string, unknown>) =>
          b.type === "tool_result"
            ? `tool_result:${JSON.stringify(b.content).slice(0, 60)}`
            : `${b.type}:${JSON.stringify(b.text ?? "").slice(0, 60)}`,
        )
      : [JSON.stringify(String(content).slice(0, 60))]
    return `user uuid=${a.uuid} replay=${a.isReplay ?? false} ${kinds.join(" ")} ${extra.join(" ")}`
  }
  if (m.type === ("command_lifecycle" as string))
    return `command_lifecycle ${a.uuid} ${a.state ?? a.status ?? JSON.stringify(a).slice(0, 120)}`
  return `${m.type}${a.subtype ? `/${a.subtype}` : ""}`
}

class Session {
  readonly inbox = new Inbox()
  readonly messages: Array<{ at: number; m: SDKMessage }> = []
  readonly watched: Watched[] = []
  readonly q: Query
  readonly done: Promise<{ error?: string }>
  private listeners: Array<() => void> = []
  private finished = false

  constructor(readonly o: SessionOpts) {
    const spawnMode = o.spawn ?? "same"
    const q = query({
      prompt: this.inbox,
      options: {
        cwd: o.cwd,
        model: MODEL,
        settingSources: [],
        permissionMode: "default",
        env: workerEnv(o.env),
        ...(o.sessionId ? { sessionId: o.sessionId } : {}),
        ...(o.resume ? { resume: o.resume } : {}),
        canUseTool:
          o.canUseTool ?? (async (_t, input) => ({ behavior: "allow", updatedInput: input })),
        ...(spawnMode === "sdk"
          ? {}
          : { spawnClaudeCodeProcess: makeSpawner(spawnMode, this.watched) }),
        stderr: (d: string) => {
          if (process.env.SPIKE_STDERR) log(`[${o.label} stderr]`, d.trimEnd())
        },
      },
    })
    this.q = q
    this.done = (async () => {
      try {
        for await (const m of q) {
          this.messages.push({ at: Date.now(), m })
          log(`[${o.label}]`, describe(m))
          for (const l of this.listeners) l()
        }
        log(`[${o.label}] stream ended`)
        return {}
      } catch (e) {
        log(`[${o.label}] stream threw:`, (e as Error).message)
        return { error: (e as Error).message }
      } finally {
        this.finished = true
        for (const l of this.listeners) l()
      }
    })()
  }

  send(text: string, uuid?: string) {
    const id = this.inbox.push(text, uuid)
    log(`[${this.o.label}] sent ${id}: ${JSON.stringify(text.slice(0, 60))}`)
    return id
  }

  // Waits until a message satisfies pred (looking at those already seen too), or the timeout.
  async waitFor(pred: (m: SDKMessage) => boolean, timeoutMs: number, from = 0) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.messages.slice(from).find((x) => pred(x.m))
      if (hit) return hit
      if (this.finished || Date.now() > deadline) return undefined
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(t)
          this.listeners = this.listeners.filter((l) => l !== wake)
          resolve()
        }
        const t = setTimeout(wake, Math.max(0, deadline - Date.now()))
        this.listeners.push(wake)
      })
    }
  }

  results(from = 0) {
    return this.messages.slice(from).filter((x) => x.m.type === "result")
  }

  init() {
    return this.messages.find(
      (x) => x.m.type === "system" && (x.m as { subtype?: string }).subtype === "init",
    )?.m as (SDKMessage & { session_id: string; capabilities?: string[] }) | undefined
  }

  pid() {
    return this.watched[0]?.pid
  }
}

const isToolUse = (name: string) => (m: SDKMessage) =>
  m.type === "assistant" &&
  (m.message.content as Array<{ type: string; name?: string }>).some(
    (b) => b.type === "tool_use" && b.name === name,
  )
const isResult = (m: SDKMessage) => m.type === "result"
const isInit = (m: SDKMessage) =>
  m.type === "system" && (m as { subtype?: string }).subtype === "init"
const resultText = (m: SDKMessage | undefined) =>
  m && m.type === "result" ? String((m as { result?: unknown }).result ?? "") : undefined
const summary = (m: SDKMessage | undefined) => {
  if (!m) return null
  const a = m as Record<string, unknown>
  return {
    type: m.type,
    subtype: a.subtype ?? null,
    is_error: a.is_error ?? null,
    result: typeof a.result === "string" ? a.result.slice(0, 200) : null,
    resume_reason: a.resume_reason ?? null,
    startup_failure_reason: a.startup_failure_reason ?? null,
    errors: a.errors ?? null,
    session_id: a.session_id ?? null,
  }
}

const sleepPrompt = (seconds: string, word: string) =>
  `Use the Bash tool to run exactly this command, with no changes and not in the background: ` +
  `./wait.sh ${seconds}\nWhen it has finished, reply with the single word ${word} and nothing else.`

// ---------------------------------------------------------------------------------------------
// Experiment: interrupt() and its receipt

async function interruptOnce(cancelQueued: boolean) {
  const cwd = workspace("interrupt")
  const s = new Session({ label: cancelQueued ? "int-cancel" : "int-plain", cwd })
  const marker = uniqueSleep(40)
  const a = s.send(sleepPrompt(marker, "ALPHA"))
  const tool = await s.waitFor(isToolUse("Bash"), 120_000)
  await sleep(1500) // the sleep is running
  const sleepPidsBefore = pidsMatching(marker)
  const b = s.send("Reply with the single word BRAVO.")
  const c = s.send("Reply with the single word CHARLIE.")
  await sleep(800)
  const before = s.messages.length
  const t = Date.now()
  // The type says interrupt(): the runtime takes { cancelQueued } (see the report).
  const receipt = await (
    s.q.interrupt as unknown as (o?: { cancelQueued?: boolean }) => Promise<unknown>
  )(cancelQueued ? { cancelQueued: true } : undefined)
  const receiptMs = Date.now() - t
  const first = await s.waitFor(isResult, 30_000, before)
  const firstMs = first ? first.at - t : null
  await sleep(500)
  const sleepPidsAfter = pidsMatching(marker)
  // Then: do B and C run?
  await sleep(25_000)
  const later = s.results(before)
  const init = s.init()
  s.q.close()
  await s.done
  return {
    cancelQueued,
    capabilities: init?.capabilities ?? null,
    sawToolUse: Boolean(tool),
    sent: { a, b, c },
    receipt,
    receiptMs,
    interruptedResult: summary(first?.m),
    interruptedResultMsAfterInterrupt: firstMs,
    sleepRunningBefore: sleepPidsBefore.length,
    sleepRunningAfterResult: sleepPidsAfter.length,
    resultsAfterInterrupt: later.map((x) => summary(x.m)),
    userEchoes: s.messages
      .filter((x) => x.m.type === "user")
      .map((x) => (x.m as { uuid?: string }).uuid),
    otherSystem: s.messages
      .filter((x) => x.m.type === "system" && !isInit(x.m))
      .map((x) => describe(x.m))
      .slice(0, 30),
  }
}

async function expInterrupt() {
  result("interrupt", {
    plain: await interruptOnce(false),
    cancelQueued: await interruptOnce(true),
  })
}

// ---------------------------------------------------------------------------------------------
// Experiment: close() and the grace

async function closeOnce(midTurn: boolean) {
  const cwd = workspace("close")
  const s = new Session({ label: midTurn ? "close-busy" : "close-idle", cwd })
  const marker = uniqueSleep(40)
  if (midTurn) {
    s.send(sleepPrompt(marker, "DONE"))
    await s.waitFor(isToolUse("Bash"), 120_000)
    await sleep(1500)
  } else {
    s.send("Reply with the single word OK.")
    await s.waitFor(isResult, 120_000)
  }
  const w = s.watched[0]
  if (!w) throw new Error("no claude process watched")
  const sleepBefore = pidsMatching(marker).length
  const t = Date.now()
  let threw: string | null = null
  try {
    s.q.close()
  } catch (e) {
    threw = (e as Error).message
  }
  const closeReturnedMs = Date.now() - t
  const streamEnd = await s.done
  const streamEndedMs = Date.now() - t
  const exit = await Promise.race([w.exit, sleep(15_000).then(() => null)])
  await sleep(1000)
  return {
    midTurn,
    closeThrew: threw,
    closeReturnedMs,
    streamEnded: streamEnd,
    streamEndedMs,
    exit: exit
      ? { code: exit.code, signal: exit.signal, msAfterClose: exit.at - t }
      : "still running after 15 s",
    sdkKills: w.kills.map((k) => ({ signal: k.signal, msAfterClose: k.at - t })),
    abortSignalMsAfterClose: w.abortedAt ? w.abortedAt - t : null,
    sleepRunningBefore: sleepBefore,
    sleepRunningAfter: pidsMatching(marker).length,
    stderrTail: w.stderr.join("").slice(-400),
  }
}

async function expClose() {
  result("close", { idle: await closeOnce(false), midTurn: await closeOnce(true) })
}

// ---------------------------------------------------------------------------------------------
// Experiment: resume with a session ID the caller drew; resume once the worktree is gone

async function expResume() {
  const cwd = workspace("resume")
  const id = randomUUID()
  const word = `PAPAYA${Math.floor(Math.random() * 1e4)}`

  const s1 = new Session({ label: "resume-1", cwd, sessionId: id })
  s1.send(`Remember this codeword: ${word}. Reply with the single word OK.`)
  const r1 = await s1.waitFor(isResult, 120_000)
  s1.q.close()
  await s1.done
  await s1.watched[0]?.exit

  const s2 = new Session({ label: "resume-2", cwd, resume: id })
  s2.send("What was the codeword I gave you? Reply with the codeword only.")
  const r2 = await s2.waitFor(isResult, 120_000)
  s2.q.close()
  await s2.done
  await s2.watched[0]?.exit
  const transcript = await getSessionMessages(id, { dir: cwd })

  // sessionId together with resume (the docs: not allowed unless forkSession)
  let both: unknown
  try {
    const s = new Session({ label: "resume-both", cwd, resume: id, sessionId: randomUUID() })
    s.send("Reply OK.")
    const r = await s.waitFor(isResult, 60_000)
    s.q.close()
    both = { result: summary(r?.m), stream: await s.done }
  } catch (e) {
    both = { threw: (e as Error).message }
  }

  // The worktree removed: with CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1 (workerEnv sets it)
  rmSync(cwd, { recursive: true, force: true })
  const gone = async (label: string, env: Record<string, string>, spawnMode: SpawnMode) => {
    const t = Date.now()
    try {
      const s = new Session({ label, cwd, resume: id, env, spawn: spawnMode })
      s.send("What was the codeword? Reply with the codeword only.")
      const r = await s.waitFor(isResult, 60_000)
      const stream = await Promise.race([s.done, sleep(20_000).then(() => "stream still open")])
      try {
        s.q.close()
      } catch {}
      return {
        result: summary(r?.m),
        stream,
        ms: Date.now() - t,
        messages: s.messages.map((x) => describe(x.m)),
        stderrTail: s.watched[0]?.stderr.join("").slice(-400) ?? null,
      }
    } catch (e) {
      return { threw: (e as Error).message, ms: Date.now() - t }
    }
  }
  const goneSdk = await gone("resume-gone-sdk", {}, "sdk")
  const goneSame = await gone("resume-gone-same", {}, "same")
  const goneNoFlag = await gone(
    "resume-gone-noflag",
    { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "0" },
    "sdk",
  )
  // The folder there when claude is spawned, then removed before claude starts
  mkdirSync(cwd, { recursive: true })
  const goneUnderClaude = await gone("resume-gone-under-claude", {}, "deleted")
  mkdirSync(cwd, { recursive: true })
  const goneUnderClaudeNoFlag = await gone(
    "resume-gone-under-claude-noflag",
    { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "0" },
    "deleted",
  )
  // The folder there but unreadable (search permission only)
  mkdirSync(cwd, { recursive: true })
  chmodSync(cwd, 0o100)
  const unreadable = await gone("resume-unreadable", {}, "same")
  chmodSync(cwd, 0o755)
  rmSync(cwd, { recursive: true, force: true })

  // The worktree re-created, empty, at the same path
  mkdirSync(cwd, { recursive: true })
  const s3 = new Session({ label: "resume-recreated", cwd, resume: id })
  s3.send("What was the codeword? Reply with the codeword only.")
  const r3 = await s3.waitFor(isResult, 120_000)
  s3.q.close()
  await s3.done

  result("resume", {
    drawnId: id,
    word,
    first: { init: s1.init()?.session_id, result: summary(r1?.m) },
    resumed: {
      initSessionId: s2.init()?.session_id,
      keptId: s2.init()?.session_id === id && (r2?.m as { session_id?: string })?.session_id === id,
      result: summary(r2?.m),
      rememberedWord: resultText(r2?.m)?.includes(word) ?? false,
    },
    transcriptMessages: transcript.length,
    sessionIdWithResume: both,
    worktreeGone: {
      sdkSpawn: goneSdk,
      customSpawn: goneSame,
      withoutStartupFailureResults: goneNoFlag,
      removedUnderClaude: goneUnderClaude,
      removedUnderClaudeWithoutStartupFailureResults: goneUnderClaudeNoFlag,
      unreadable,
    },
    worktreeRecreated: {
      initSessionId: s3.init()?.session_id,
      result: summary(r3?.m),
      rememberedWord: resultText(r3?.m)?.includes(word) ?? false,
    },
  })
}

// ---------------------------------------------------------------------------------------------
// The host role: a child process holding sessions, reporting on stdout as JSON lines

type HostEvent = Record<string, unknown> & { event: string }
const emit = (e: HostEvent) => process.stdout.write(`${JSON.stringify(e)}\n`)

async function host(args: string[]) {
  const [scenario, spawnMode = "same", cwd = "", ...rest] = args
  const mode = spawnMode as SpawnMode
  if (scenario === "busy") {
    // rest: <count> <marker>: start <count> sessions each in a long Bash sleep
    // (rest[2] = "idle": each session has finished a short turn instead)
    const count = Number(rest[0] ?? 1)
    const marker = rest[1] ?? uniqueSleep(60)
    const idle = rest[2] === "idle"
    const sessions = Array.from(
      { length: count },
      (_, i) => new Session({ label: `host-${idle ? "idle" : "busy"}-${i}`, cwd, spawn: mode }),
    )
    for (const s of sessions)
      s.send(idle ? "Reply with the single word OK." : sleepPrompt(marker, "DONE"))
    await Promise.all(sessions.map((s) => s.waitFor(idle ? isResult : isToolUse("Bash"), 120_000)))
    await sleep(1500)
    emit({
      event: "ready",
      pids: mode === "sdk" ? childrenOf(process.pid) : sessions.map((s) => s.pid()),
      sleeps: pidsMatching(marker),
    })
    await new Promise(() => {}) // until killed
  }
  if (scenario === "sigint") {
    // A session mid-turn when SIGINT reaches the host's process group
    let gotSigint = 0
    process.on("SIGINT", () => {
      gotSigint++
      log("host got SIGINT")
    })
    const s = new Session({ label: `host-sigint-${mode}`, cwd, spawn: mode })
    const marker = uniqueSleep(8)
    s.send(sleepPrompt(marker, "DONE"))
    await s.waitFor(isToolUse("Bash"), 120_000)
    await sleep(1000)
    const pid = mode === "sdk" ? childrenOf(process.pid)[0] : s.pid()
    emit({ event: "ready", pid, pgid: pid ? pgidOf(pid) : null, hostPgid: pgidOf(process.pid) })
    await sleep(3000) // the parent signals the group meanwhile
    const claudeAliveAfterSignal = pid ? alive(pid) : null
    const turn = await s.waitFor(isResult, 60_000)
    const before = s.messages.length
    s.send("Reply with the single word PONG.")
    const pong = await s.waitFor(isResult, 60_000, before)
    emit({
      event: "done",
      gotSigint,
      claudeAliveAfterSignal,
      turn: summary(turn?.m),
      pong: summary(pong?.m),
      stream: await Promise.race([s.done, sleep(100).then(() => "open")]),
      stderrTail: s.watched[0]?.stderr.join("").slice(-300) ?? null,
    })
    s.q.close()
    await s.done
    process.exit(0)
  }
  if (scenario === "pending") {
    // rest: <sessionId> <what>: a turn left at a permission request (canUseTool never answers),
    // or (what=busy) mid-way through a Bash sleep; then wait to be killed
    const [sessionId = randomUUID(), what = "pending", marker = uniqueSleep(30)] = rest
    const s = new Session({
      label: `host-${what}`,
      cwd,
      sessionId,
      spawn: mode,
      canUseTool: async (tool, input, opts) => {
        emit({
          event: "canUseTool",
          tool,
          input,
          toolUseID: (opts as { toolUseID?: string }).toolUseID,
        })
        if (what === "pending") return new Promise(() => {})
        return { behavior: "allow", updatedInput: input }
      },
    })
    const uuid = s.send(sleepPrompt(marker, "DONE"))
    await s.waitFor(isToolUse("Bash"), 120_000)
    await sleep(1500)
    emit({ event: "ready", uuid, pids: mode === "sdk" ? childrenOf(process.pid) : [s.pid()] })
    await new Promise(() => {})
  }
  throw new Error(`unknown host scenario ${scenario}`)
}

// Starts a host in a process group of its own (as a terminal's foreground job would be).
const startHost = (args: string[]) => {
  const child = spawn(process.execPath, [SCRIPT, "host", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
    env: process.env,
  })
  const events: HostEvent[] = []
  const waiters: Array<() => void> = []
  createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      events.push(JSON.parse(line))
    } catch {
      log("host said:", line)
    }
    for (const w of waiters.splice(0)) w()
  })
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  )
  const next = async (event: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const e = events.find((x) => x.event === event)
      if (e) return e
      if (Date.now() > deadline) return undefined
      await Promise.race([new Promise<void>((r) => waiters.push(r)), sleep(500)])
    }
  }
  return { child, events, next, exit }
}

// Polls pids after a kill until all are gone or the timeout; when each one went.
const watchDeaths = async (pids: number[], timeoutMs: number) => {
  const t = Date.now()
  const gone: Record<number, number | null> = Object.fromEntries(pids.map((p) => [p, null]))
  while (Date.now() - t < timeoutMs && Object.values(gone).some((v) => v === null)) {
    for (const p of pids) if (gone[p] === null && !alive(p)) gone[p] = Date.now() - t
    await sleep(100)
  }
  return gone
}

// ---------------------------------------------------------------------------------------------
// Experiment: kill -9 of the host; does each worker's claude end?

async function kill9Once(mode: SpawnMode, idle: boolean) {
  const cwd = workspace("kill9")
  const marker = uniqueSleep(60)
  const h = startHost(["busy", mode, cwd, "2", marker, idle ? "idle" : "busy"])
  const ready = await h.next("ready", 180_000)
  if (!ready) {
    h.child.kill("SIGKILL")
    return { mode, error: "host never ready" }
  }
  const pids = (ready.pids as number[]).filter(Boolean)
  const sleeps = ready.sleeps as number[]
  const pgids = Object.fromEntries(pids.map((p) => [p, pgidOf(p)]))
  process.kill(h.child.pid!, "SIGKILL")
  // The Bash sleep lasts 60 s from about 2 s before the kill: watch past its end.
  const [claudeGoneMs, sleepGoneMs] = await Promise.all([
    watchDeaths(pids, 120_000),
    watchDeaths(sleeps, 120_000),
  ])
  const left = [...pids, ...sleeps].filter(alive)
  for (const p of left) process.kill(p, "SIGKILL") // tidy up what this experiment started
  return {
    mode,
    idle,
    hostPid: h.child.pid,
    claudePids: pids,
    pgids,
    claudeGoneMs,
    sleepPids: sleeps,
    sleepGoneMs,
    stillAliveAfter120s: left,
  }
}

async function expKill9() {
  const cases: Array<[string, SpawnMode, boolean]> = [
    ["idleSdkSpawn", "sdk", true],
    ["idleOwnGroup", "group", true],
    ["busySdkSpawn", "sdk", false],
    ["busyOwnGroup", "group", false],
    ["busyReaped", "reaped", false],
  ]
  const out: Record<string, unknown> = {}
  for (const [name, mode, idle] of cases) if (wanted(name)) out[name] = await kill9Once(mode, idle)
  result("kill9", out)
}

// ---------------------------------------------------------------------------------------------
// Experiment: SIGINT to the host's process group, claude in the same group or its own

async function pgroupOnce(mode: SpawnMode) {
  const cwd = workspace("pgroup")
  const h = startHost(["sigint", mode, cwd])
  const ready = await h.next("ready", 180_000)
  if (!ready) {
    h.child.kill("SIGKILL")
    return { mode, error: "host never ready" }
  }
  process.kill(-h.child.pid!, "SIGINT") // what Ctrl+C in a terminal does to its foreground job
  const done = await h.next("done", 180_000)
  const exit = await Promise.race([h.exit, sleep(10_000).then(() => null)])
  if (!exit) h.child.kill("SIGKILL")
  return { mode, ready, done: done ?? "no answer from the host", hostExit: exit }
}

async function expPgroup() {
  result("pgroup", {
    sdkSpawn: await pgroupOnce("sdk"),
    ownGroup: await pgroupOnce("group"),
  })
}

// ---------------------------------------------------------------------------------------------
// Spike (2): CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1 with CLAUDE_CODE_RESUME_REASON=host_draining

// kill9: the host killed, its reaper ending claude (SIGTERM to the group); crash: the host and
// claude's group both killed with SIGKILL (a power cut); close and interrupt+close: tutti's
// quit, without and with step 2's interrupt.
type Ending = "kill9" | "crash" | "interrupt+close" | "close"

// Leaves a session mid-turn (busy in a Bash sleep, or at a permission request nobody answers),
// ended as `ending` says. Returns its session ID and the uuid of the interrupted message.
async function leaveInterrupted(cwd: string, what: "busy" | "pending", ending: Ending) {
  const id = randomUUID()
  const marker = uniqueSleep(20)
  if (ending === "kill9" || ending === "crash") {
    const h = startHost(["pending", ending === "kill9" ? "reaped" : "group", cwd, id, what, marker])
    const ready = await h.next("ready", 180_000)
    const asked = h.events.filter((e) => e.event === "canUseTool")
    const pids = ((ready?.pids as number[]) ?? []).filter(Boolean)
    process.kill(h.child.pid!, "SIGKILL")
    if (ending === "crash") for (const p of pids) process.kill(-p, "SIGKILL")
    await watchDeaths(pids, 30_000)
    for (const p of pidsMatching(marker)) process.kill(p, "SIGKILL")
    return { id, uuid: ready?.uuid as string | undefined, asked, marker }
  }
  const asked: unknown[] = []
  const s = new Session({
    label: `leave-${what}-${ending}`,
    cwd,
    sessionId: id,
    canUseTool: async (tool, input, opts) => {
      asked.push({ tool, input, toolUseID: (opts as { toolUseID?: string }).toolUseID })
      if (what === "pending") return new Promise(() => {})
      return { behavior: "allow", updatedInput: input }
    },
  })
  const uuid = s.send(sleepPrompt(marker, "DONE"))
  await s.waitFor(isToolUse("Bash"), 120_000)
  await sleep(1500)
  let receipt: unknown = null
  if (ending === "interrupt+close") {
    receipt = await s.q.interrupt()
    await s.waitFor(isResult, 15_000)
  }
  s.q.close()
  await s.done
  await s.watched[0]?.exit
  return { id, uuid, asked, receipt, marker }
}

// § 4.8's own way: a client_composed message saying the worker was interrupted.
const CARRY_ON =
  "tutti was stopped while you were working, and has resumed this session. Your last turn was " +
  "interrupted: carry on with it from where you were."

async function resumeAndWatch(
  cwd: string,
  id: string,
  withEnv: boolean,
  withMessage: boolean,
  label: string,
) {
  const asked: unknown[] = []
  const s = new Session({
    label,
    cwd,
    resume: id,
    env: withEnv
      ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1", CLAUDE_CODE_RESUME_REASON: "host_draining" }
      : {},
    canUseTool: async (tool, input, opts) => {
      asked.push({ tool, input, toolUseID: (opts as { toolUseID?: string }).toolUseID })
      return { behavior: "allow", updatedInput: input }
    },
  })
  // Without a message: does a turn start on its own? With one: does it carry on, and does it
  // run once or twice?
  let carryOn: string | null = null
  if (withMessage) {
    carryOn = randomUUID()
    s.inbox.push(CARRY_ON, carryOn, true)
  }
  const init = await s.waitFor(isInit, 60_000)
  const r = await s.waitFor(isResult, 75_000)
  if (r) await s.waitFor(isResult, 30_000, s.messages.indexOf(r) + 1) // a second turn?
  const resumeReasons = s.messages
    .map((x) => (x.m as { resume_reason?: string }).resume_reason)
    .filter(Boolean)
  s.q.close()
  await s.done
  return {
    withEnv,
    carryOnMessage: carryOn,
    results: s.results().map((x) => summary(x.m)),
    sawInit: Boolean(init),
    initSessionId: (init?.m as { session_id?: string } | undefined)?.session_id ?? null,
    turnRanByItself: Boolean(r),
    result: summary(r?.m),
    resumeReasons,
    canUseToolCalls: asked,
    bashReRun: s.messages.some((x) => isToolUse("Bash")(x.m)),
    messages: s.messages.map((x) => describe(x.m)).slice(0, 40),
  }
}

async function expRerun() {
  const out: Record<string, unknown> = {}
  // [what the turn was doing, how it ended, resumed with the env, resumed with tutti's message]
  const cases: Array<["busy" | "pending", Ending, boolean, boolean]> = [
    ["busy", "close", true, false],
    ["busy", "close", false, false], // control: no env
    ["busy", "interrupt+close", true, false],
    ["busy", "kill9", true, false],
    ["busy", "crash", true, false],
    ["pending", "close", true, false],
    ["pending", "interrupt+close", true, false],
    ["pending", "kill9", true, false],
    ["pending", "crash", true, false],
    // tutti's own carry-on message, without the env and with it
    ["busy", "interrupt+close", false, true],
    ["busy", "crash", false, true],
    ["pending", "interrupt+close", false, true],
    ["busy", "close", true, true],
  ]
  for (const [what, ending, withEnv, withMessage] of cases) {
    const name = `${what}/${ending}${withEnv ? "" : "/no-env"}${withMessage ? "/message" : ""}`
    if (!wanted(name)) continue
    const cwd = workspace("rerun")
    log(`--- rerun case ${name}`)
    const left = await leaveInterrupted(cwd, what, ending)
    const transcriptTail = (await getSessionMessages(left.id, { dir: cwd })).slice(-3).map((m) => ({
      type: m.type,
      content: JSON.stringify((m.message as { content?: unknown })?.content ?? null).slice(0, 160),
    }))
    const resumed = await resumeAndWatch(cwd, left.id, withEnv, withMessage, `rerun-${name}`)
    out[name] = { left, transcriptTail, resumed }
  }
  result("rerun", out)
}

// ---------------------------------------------------------------------------------------------

const experiments: Record<string, () => Promise<void>> = {
  interrupt: expInterrupt,
  close: expClose,
  resume: expResume,
  kill9: expKill9,
  pgroup: expPgroup,
  rerun: expRerun,
}

const main = async () => {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === "host") return host(args)
  const names = cmd === "all" ? Object.keys(experiments) : [cmd, ...args].filter(Boolean)
  if (names.length === 0 || names.some((n) => !(n! in experiments))) {
    console.error(`usage: bun ${SCRIPT} all | ${Object.keys(experiments).join(" | ")} ...`)
    process.exit(2)
  }
  log(`bun ${Bun.version}, model ${MODEL}`)
  for (const n of names) {
    log(`=== ${n}`)
    await experiments[n!]!()
  }
  process.exit(0)
}

await main()
