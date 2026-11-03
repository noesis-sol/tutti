// The app of split-input-check.ts: a focused <input> over a box that logs its mouse events, with
// OpenTUI's own stdin parser, or its experimental native one with NATIVE=1. It logs each key, each
// change of the input and each mouse event to PROBE_LOG (JSON lines), and stops on SIGTERM.
import { appendFileSync } from "node:fs"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

const out = process.env.PROBE_LOG ?? "/dev/null"
const log = (record: unknown) => appendFileSync(out, `${JSON.stringify(record)}\n`)
const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  exitSignals: [],
  experimental_nativeInput: process.env.NATIVE === "1",
})
renderer.keyInput.on("keypress", (key) => log({ key: key.name }))
const App = () => (
  <box
    flexDirection="column"
    onMouse={(event) => log({ mouse: event.type, direction: event.scroll?.direction })}
  >
    <text>PROBE</text>
    <input focused width={40} onInput={(value: string) => log({ input: value })} />
  </box>
)
createRoot(renderer).render(<App />)
await Bun.sleep(400)
log({ ready: true, themeMode: renderer.themeMode })
process.on("SIGTERM", () => {
  renderer.destroy()
  setTimeout(() => process.exit(0), 100)
})
