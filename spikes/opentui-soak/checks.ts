// biome-ignore-all lint/suspicious/noControlCharactersInRegex: the patterns are terminal escape sequences
// The renderer-option checks of the spike, each run against probe.tsx in a pseudo-terminal:
//
//   1. exitOnCtrlC false and exitSignals [] leave Ctrl+C, SIGINT, SIGTERM and SIGHUP to the app,
//      and OpenTUI's defaults don't (for comparison).
//   2. renderer.destroy() restores the terminal: termios, and every private mode it set.
//   3. waitForThemeMode() answers from the terminal's colours, the theme_mode event follows a
//      colour-scheme change (DSR 997), and with no answer waitForThemeMode() times out to null.
//
//   bun spikes/opentui-soak/checks.ts

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DARK, LIGHT, type Pty, spawnInPty, type Theme } from "./pty.ts"

type Record_ = { event: string; [key: string]: unknown }

const results: { check: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`)
}

const dir = mkdtempSync(join(tmpdir(), "opentui-probe-"))
let runs = 0

const start = (signals: "tutti" | "default", theme: Theme | null, themeWaitMs = 1000) => {
  const logFile = join(dir, `probe-${++runs}.jsonl`)
  const pty = spawnInPty(
    [
      "bun",
      `${import.meta.dir}/probe.tsx`,
      "--signals",
      signals,
      "--theme-wait-ms",
      String(themeWaitMs),
    ],
    { cols: 80, rows: 24, theme, keepOutput: true, env: { PROBE_LOG: logFile } },
  )
  const records = (): Record_[] => {
    try {
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  const waitRecord = async (pred: (r: Record_) => boolean, timeoutMs = 3000) => {
    const until = performance.now() + timeoutMs
    while (performance.now() < until) {
      const found = records().find(pred)
      if (found !== undefined) return found
      await Bun.sleep(25)
    }
    return undefined
  }
  return { pty, records, waitRecord }
}

const alive = (pty: Pty) => pty.proc.exitCode === null && pty.proc.signalCode === null

const exited = async (pty: Pty, timeoutMs = 3000) =>
  Promise.race([pty.proc.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)])

// Private modes (CSI ? n h / l) and the Kitty keyboard stack (CSI > n u / CSI < u) in the output.
const modes = (text: string) => {
  const set = new Set<string>()
  const reset = new Set<string>()
  for (const m of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    for (const n of (m[1] ?? "").split(";")) (m[2] === "h" ? set : reset).add(n)
  }
  const kittyPush = (text.match(/\x1b\[>\d+u/g) ?? []).length
  const kittyPop = (text.match(/\x1b\[<\d*u/g) ?? []).length
  return { set, reset, kittyPush, kittyPop }
}

// --- 1, 2 and 3 with tutti's options, a dark terminal --------------------------------------------
{
  const { pty, records, waitRecord } = start("tutti", DARK)
  const before = pty.terminal.localFlags
  await pty.waitFor("PROBE-READY")
  const started = await waitRecord((r) => r.event === "started")
  const during = pty.terminal.localFlags
  const waited = await waitRecord((r) => r.event === "waitForThemeMode")
  check(
    "waitForThemeMode() resolves from the terminal's OSC 11 background",
    waited?.mode === "dark",
    `createCliRenderer took ${String(started?.createdMs)} ms; themeMode then ${String(started?.themeMode)}; waitForThemeMode() gave ${String(waited?.mode)} ${String(waited?.ms)} ms later`,
  )

  pty.write("\x03")
  const ctrlC = await waitRecord((r) => r.event === "key" && r.name === "c" && r.ctrl === true)
  await Bun.sleep(300)
  check(
    "exitOnCtrlC false: Ctrl+C reaches the app as a key, the renderer stays",
    ctrlC !== undefined && ctrlC.isDestroyed === false && alive(pty),
    `key logged: ${ctrlC !== undefined}, alive: ${alive(pty)}`,
  )

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    pty.proc.kill(signal)
    const got = await waitRecord((r) => r.event === "signal" && r.signal === signal)
    await Bun.sleep(300)
    check(
      `exitSignals []: ${signal} reaches the app's handler, the renderer stays`,
      got !== undefined &&
        got.isDestroyed === false &&
        alive(pty) &&
        !records().some((r) => r.event === "destroy-event"),
      `handler ran: ${got !== undefined}, destroyed: ${String(got?.isDestroyed)}, alive: ${alive(pty)}`,
    )
  }

  // A colour-scheme change: the terminal reports DSR 997 (mode 2031), OpenTUI asks for the colours
  // again and emits theme_mode.
  pty.setTheme(LIGHT)
  pty.write("\x1b[?997;2n")
  const changed = await waitRecord((r) => r.event === "theme_mode" && r.mode === "light")
  const emitted = records()
    .filter((r) => r.event === "theme_mode")
    .map((r) => r.mode)
  check(
    "theme_mode is emitted after a DSR 997 colour-scheme report",
    changed !== undefined,
    `theme_mode events: ${emitted.join(", ")}`,
  )
  const subscribed = pty.output().includes("\x1b[?2031h")
  check(
    "OpenTUI subscribes to colour-scheme reports (CSI ? 2031 h)",
    subscribed,
    subscribed ? "sent at start" : "not sent",
  )

  pty.mark()
  pty.write("q")
  const done = await exited(pty)
  const after = pty.terminal.localFlags
  const destroyed = records().find((r) => r.event === "after-destroy")
  check(
    "destroy() restores termios (raw mode off)",
    done && before === after && during !== before && destroyed?.isRaw === false,
    `localFlags before 0x${before.toString(16)}, while running 0x${during.toString(16)}, after 0x${after.toString(16)}; stdin.isRaw after ${String(destroyed?.isRaw)}`,
  )
  await Bun.write(join(dir, "tutti-dark.out"), pty.output())
  const all = modes(pty.output())
  const unreset = [...all.set].filter((n) => !all.reset.has(n))
  const tail = pty.sinceMark()
  const leftAlt = tail.indexOf("\x1b[?1049l")
  const printed = tail.indexOf("AFTER-DESTROY")
  check(
    "destroy() resets every private mode it set and pops the Kitty keyboard flags",
    unreset.length === 0 && all.kittyPush <= all.kittyPop,
    `set ${[...all.set].join(",")}; not reset: ${unreset.join(",") || "none"}; kitty push ${all.kittyPush}, pop ${all.kittyPop}`,
  )
  // A query sent while shutting down would be answered after raw mode is off, onto the shell.
  const queries = tail.match(
    /\x1b\]\d+;\?|\x1b\[\??\d*\$p|\x1b\[6n|\x1b\[>?0?c|\x1b\[\?u|\x1b\[14t/g,
  )
  check(
    "destroy() sends no terminal queries",
    queries === null,
    queries === null ? "none" : queries.map((q) => JSON.stringify(q)).join(" "),
  )
  check(
    "after destroy() the app writes to the main screen",
    leftAlt >= 0 && printed > leftAlt,
    `left the alternate screen at ${leftAlt}, printed at ${printed}`,
  )
  check("the app exits with 0", pty.proc.exitCode === 0, `exit ${pty.proc.exitCode}`)
  pty.terminal.close()
}

// --- No answer to the colour queries -------------------------------------------------------------
{
  const { pty, waitRecord } = start("tutti", null, 1000)
  await pty.waitFor("PROBE-READY")
  const t0 = performance.now()
  const waited = await waitRecord((r) => r.event === "waitForThemeMode", 4000)
  const elapsed = performance.now() - t0
  check(
    "waitForThemeMode(1000) resolves null when the terminal doesn't answer",
    waited !== undefined && waited.mode === null,
    `gave ${String(waited?.mode)} after about ${Math.round(elapsed)} ms`,
  )
  pty.write("q")
  await exited(pty)
  pty.terminal.close()
}

// --- OpenTUI's defaults, for comparison ----------------------------------------------------------
for (const how of ["Ctrl+C", "SIGINT", "SIGTERM"] as const) {
  const { pty, records, waitRecord } = start("default", DARK)
  await pty.waitFor("PROBE-READY")
  await waitRecord((r) => r.event === "waitForThemeMode")
  if (how === "Ctrl+C") pty.write("\x03")
  else pty.proc.kill(how)
  const destroyed = await waitRecord((r) => r.event === "destroy-event")
  const gone = await exited(pty, 2000)
  const keyed = records().some((r) => r.event === "key" && r.name === "c")
  const handled = records().some((r) => r.event === "signal" && r.signal === how)
  check(
    `defaults: ${how} destroys the renderer`,
    destroyed !== undefined,
    `destroyed: ${destroyed !== undefined}, process exited: ${gone} (code ${pty.proc.exitCode}, signal ${pty.proc.signalCode}), key reached the app: ${keyed}, app's handler ran: ${handled}`,
  )
  if (!gone) pty.proc.kill("SIGKILL")
  await pty.proc.exited
  pty.terminal.close()
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; logs in ${dir}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
