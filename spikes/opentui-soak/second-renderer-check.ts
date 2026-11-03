// Whether a second renderer works after the first's destroy() (spec § 7.1): second-renderer.tsx in a
// pseudo-terminal, which says whether each tree was drawn, the alternate screen entered and left
// twice, the second renderer's keys heard and the terminal's modes restored at the end.
//
//   bun spikes/opentui-soak/second-renderer-check.ts
import { join } from "node:path"
import { DARK, spawnInPty } from "./pty.ts"

const pty = spawnInPty(["bun", join(import.meta.dir, "second-renderer.tsx")], {
  cols: 60,
  rows: 10,
  theme: DARK,
  keepOutput: true,
})
const before = pty.terminal.localFlags
await pty.waitFor("READY", 5000)
pty.write("x")
await Bun.sleep(200)
pty.write("q")
const exited = await Promise.race([pty.proc.exited.then(() => true), Bun.sleep(3000).then(() => false)])
const out = pty.output()
const count = (s: string) => out.split(s).length - 1
console.log({
  exited,
  exitCode: pty.proc.exitCode,
  enteredAlternateScreen: count("\x1b[?1049h"),
  leftAlternateScreen: count("\x1b[?1049l"),
  firstTreeDrawn: out.includes("FIRST-TREE"),
  secondTreeDrawn: out.includes("SECOND-TREE"),
  printedBetween: out.includes("BETWEEN-RENDERERS"),
  secondHeardQ: out.includes("AFTER-SECOND"),
  termiosRestored: pty.terminal.localFlags === before,
})
pty.terminal.close()
process.exit(exited ? 0 : 1)
