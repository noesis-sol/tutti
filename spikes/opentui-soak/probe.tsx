// The program checks.ts drives in a pseudo-terminal. It makes one renderer with the options given,
// logs what happens to it (keys, signals, the theme mode, destroy) as JSON lines to PROBE_LOG, and
// destroys it on the key `q`.
//
//   PROBE_LOG=probe.jsonl bun spikes/opentui-soak/probe.tsx --signals tutti|default

import { appendFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"

const { values } = parseArgs({
  options: {
    // tutti: exitOnCtrlC false and exitSignals [] (spec § 7.4); default: OpenTUI's defaults.
    signals: { type: "string", default: "tutti" },
    "theme-wait-ms": { type: "string", default: "1000" },
  },
})
const logFile = process.env.PROBE_LOG ?? "probe.jsonl"
const log = (record: object) => appendFileSync(logFile, `${JSON.stringify(record)}\n`)

const t0 = performance.now()
const renderer = await createCliRenderer(
  values.signals === "tutti" ? { exitOnCtrlC: false, exitSignals: [] } : {},
)
renderer.on("theme_mode", (mode) => log({ event: "theme_mode", mode }))
renderer.on("destroy", () => log({ event: "destroy-event" }))

let quitting = false
const quit = async () => {
  if (quitting) return
  quitting = true
  log({ event: "before-destroy", isRaw: process.stdin.isRaw, isDestroyed: renderer.isDestroyed })
  renderer.destroy()
  await renderer.closed
  log({ event: "after-destroy", isRaw: process.stdin.isRaw, isDestroyed: renderer.isDestroyed })
  process.stdout.write("AFTER-DESTROY\n")
  process.exit(0)
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => log({ event: "signal", signal, isDestroyed: renderer.isDestroyed }))
}
process.on("exit", (code) => log({ event: "exit", code, isDestroyed: renderer.isDestroyed }))

const Probe = () => {
  useKeyboard((key) => {
    log({ event: "key", name: key.name, ctrl: key.ctrl, isDestroyed: renderer.isDestroyed })
    if (key.name === "q") void quit()
  })
  return (
    <box border padding={1}>
      <text>PROBE-READY</text>
    </box>
  )
}

createRoot(renderer).render(<Probe />)
const createdMs = Math.round(performance.now() - t0)
log({
  event: "started",
  pid: process.pid,
  isRaw: process.stdin.isRaw,
  themeMode: renderer.themeMode,
  createdMs,
})
const waited = await renderer.waitForThemeMode(Number(values["theme-wait-ms"]))
log({ event: "waitForThemeMode", mode: waited, ms: Math.round(performance.now() - t0) - createdMs })
