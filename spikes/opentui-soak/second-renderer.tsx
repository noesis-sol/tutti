// The app of second-renderer-check.ts: a renderer in the alternate screen with a React tree, destroyed,
// a line on the main screen, then a second renderer with a tree of its own, which `q` destroys
// before a last line on the main screen.
import { type CliRendererConfig, createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

const config: CliRendererConfig = {
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  exitSignals: [],
}
const first = await createCliRenderer(config)
createRoot(first).render(<text>FIRST-TREE</text>)
await Bun.sleep(300)
first.destroy()
await Bun.sleep(300)
process.stdout.write("BETWEEN-RENDERERS\n")
const second = await createCliRenderer(config)
const mode = await second.waitForThemeMode(500)
createRoot(second).render(<text>SECOND-TREE</text>)
second.keyInput.on("keypress", (key) => {
  if (key.name !== "q") return
  second.destroy()
  setTimeout(() => {
    process.stdout.write("AFTER-SECOND\n")
    process.exit(0)
  }, 200)
})
await Bun.sleep(300)
process.stdout.write(`\x1b]0;READY ${mode}\x07`)
