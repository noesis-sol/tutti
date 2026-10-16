// The cards' text updates without React: 16 bordered boxes of three TextRenderables each, their
// content set at 10 Hz through @opentui/core alone, sampled each minute like soak.tsx. It tells
// whether memory that grows with frequently updated text grows in OpenTUI core or in the React
// layer above it.
//
//   bun spikes/opentui-soak/run-soak.ts --script core-text.ts --minutes 10 --out core-text.jsonl

import { parseArgs } from "node:util"
import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core"
import { activities } from "./content.ts"
import { sample } from "./memory.ts"

const { values } = parseArgs({
  options: {
    minutes: { type: "string", default: "10" },
    "sample-seconds": { type: "string", default: "60" },
    out: { type: "string", default: "core-text.jsonl" },
  },
})
const out = Bun.file(values.out).writer()
const write = (record: object) => {
  out.write(`${JSON.stringify(record)}\n`)
  out.flush()
}

const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: false })
const grid = new BoxRenderable(renderer, { flexDirection: "column", width: "100%" })
renderer.root.add(grid)
const texts: TextRenderable[][] = []
for (let row = 0; row < 4; row++) {
  const line = new BoxRenderable(renderer, { flexDirection: "row" })
  grid.add(line)
  for (let col = 0; col < 4; col++) {
    const card = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      flexGrow: 1,
      flexBasis: 0,
      height: 5,
      paddingX: 1,
    })
    line.add(card)
    const fields = ["#c0caf5", "#7aa2f7", "#9ece6a"].map(
      (fg) => new TextRenderable(renderer, { content: "", fg, wrapMode: "none", truncate: true }),
    )
    for (const t of fields) card.add(t)
    texts.push(fields)
  }
}

let tick = 0
const interval = setInterval(() => {
  tick++
  texts.forEach(([a, b, c], i) => {
    if (a) a.content = `tut-${i} working ${Math.floor(tick / 10)}s`
    if (b) b.content = `Card ${i + 1}: ${activities[(i + 2) % activities.length]}`
    if (c) c.content = `▸ ${activities[Math.floor(tick / 7 + i) % activities.length]} #${tick}`
  })
}, 100)

let minute = 0
let finished = false
const finish = async (reason: string) => {
  if (finished) return
  finished = true
  clearInterval(interval)
  clearInterval(sampler)
  write({ event: "end", reason, ticks: tick })
  renderer.destroy()
  await renderer.closed
  await out.end()
  process.exit(0)
}
process.on("SIGTERM", () => void finish("SIGTERM"))
process.on("SIGINT", () => void finish("SIGINT"))

const started = performance.now()
const takeSample = async () => {
  write({
    ...(await sample(minute++)),
    ticks: tick,
    frames: renderer.getStats().frameCount,
    mounted: 0,
    appended: 0,
  })
  if (performance.now() - started >= Number(values.minutes) * 60_000) await finish("done")
}
write({ event: "start", script: "core-text", pid: process.pid })
setTimeout(() => void takeSample(), 5_000)
const sampler = setInterval(() => void takeSample(), Number(values["sample-seconds"]) * 1000)
