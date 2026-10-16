// Runs soak.tsx in a pseudo-terminal of a fixed size, so the soak needs no terminal of its own:
//
//   bun spikes/opentui-soak/run-soak.ts --minutes 30 --window 600 --out soak-600.jsonl
//
// Arguments other than --cols, --rows and --script (soak.tsx, or core-text.ts) go to the script.
// Prints the samples as they arrive.

import { parseArgs } from "node:util"
import { DARK, spawnInPty } from "./pty.ts"

const { values } = parseArgs({
  options: {
    cols: { type: "string", default: "160" },
    rows: { type: "string", default: "50" },
    out: { type: "string", default: "soak.jsonl" },
    script: { type: "string", default: "soak.tsx" },
  },
  strict: false,
})

// Everything but "--cols N", "--rows N" and "--script S" goes to the script.
const args: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? ""
  if (a === "--cols" || a === "--rows" || a === "--script") i++
  else args.push(a)
}

const out = String(values.out)
const pty = spawnInPty(["bun", `${import.meta.dir}/${String(values.script)}`, ...args], {
  cols: Number(values.cols),
  rows: Number(values.rows),
  theme: DARK,
  keepOutput: false,
})

let printed = 0
const report = async () => {
  const file = Bun.file(out)
  if (!(await file.exists())) return
  const lines = (await file.text()).split("\n").filter((l) => l !== "")
  for (const line of lines.slice(printed)) {
    const r = JSON.parse(line)
    if (r.event !== undefined) console.log(`${r.event} ${r.reason ?? ""}`.trim())
    else
      console.log(
        `minute ${r.minute}: rss ${(r.rssBytes / 2 ** 20).toFixed(1)} MB, footprint ${((r.vmmap?.footprintBytes ?? 0) / 2 ** 20).toFixed(1)} MB, malloc ${((r.vmmap?.mallocAllocatedBytes ?? 0) / 2 ** 20).toFixed(1)} MB, js heap ${(r.jscHeapBytes / 2 ** 20).toFixed(1)} MB, mounted ${r.mounted}, appended ${r.appended}, pty ${(pty.bytes() / 2 ** 20).toFixed(0)} MB`,
      )
  }
  printed = lines.length
}
const timer = setInterval(() => void report(), 5_000)
const code = await pty.proc.exited
clearInterval(timer)
await report()
pty.terminal.close()
console.log(`soak exited with ${code}`)
process.exit(code)
