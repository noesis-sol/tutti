// The soak: 16 cards updating at 10 Hz over a transcript scrollbox, run for --minutes with a memory
// sample written each minute. Run it in a terminal, or under run-soak.ts, which gives it a PTY:
//
//   bun spikes/opentui-soak/soak.tsx --minutes 30 --window 600 --out soak-600.jsonl
//
// --window is the number of transcript items mounted at most (spec § 7.5: 200, or 600 after
// scrolling back); `unbounded` keeps every item, as a control. To tell the parts apart:
// --cards 0 drops the cards, --append-every 0 stops appending items, --stream off stops the
// streamed message, and --preload sets the items there at the start. --gc collects garbage before
// each sample. --joined-card-text passes each card line to <text> as one string. --shrink-at M
// lowers the window to --shrink-to (200) after M minutes, as returning to the bottom of a
// transcript scrolled back to 600 items would. --clear-measures clears the performance timeline every 10 s.

import { parseArgs } from "node:util"
import { createCliRenderer, RGBA, SyntaxStyle } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./app.tsx"
import { sample } from "./memory.ts"
import { startProducer } from "./store.ts"

const { values } = parseArgs({
  options: {
    minutes: { type: "string", default: "30" },
    window: { type: "string", default: "600" },
    preload: { type: "string", default: "600" },
    cards: { type: "string", default: "16" },
    hz: { type: "string", default: "10" },
    "append-every": { type: "string", default: "10" },
    stream: { type: "string", default: "on" },
    gc: { type: "boolean", default: false },
    "joined-card-text": { type: "boolean", default: false },
    "clear-measures": { type: "boolean", default: false },
    "shrink-at": { type: "string" },
    "shrink-to": { type: "string", default: "200" },
    "sample-seconds": { type: "string", default: "60" },
    out: { type: "string", default: "soak.jsonl" },
  },
})

const minutes = Number(values.minutes)
const window = values.window === "unbounded" ? Number.POSITIVE_INFINITY : Number(values.window)
const sampleMs = Number(values["sample-seconds"]) * 1000
const out = Bun.file(values.out).writer()

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  exitSignals: [],
  screenMode: "alternate-screen",
  useMouse: false,
})
const style = SyntaxStyle.fromStyles(
  {
    keyword: { fg: RGBA.fromHex("#bb9af7"), bold: true },
    string: { fg: RGBA.fromHex("#9ece6a") },
    comment: { fg: RGBA.fromHex("#565f89"), italic: true },
    number: { fg: RGBA.fromHex("#ff9e64") },
    default: { fg: RGBA.fromHex("#c0caf5") },
  },
  renderer.nativeScene,
)
const producer = startProducer({
  cards: Number(values.cards),
  window,
  preload: Number(values.preload),
  hz: Number(values.hz),
  appendEvery: Number(values["append-every"]),
  stream: values.stream !== "off",
})
const root = createRoot(renderer)
root.render(
  <App
    runView={producer.runView}
    transcript={producer.transcript}
    style={style}
    perRow={4}
    joinedCardText={values["joined-card-text"]}
  />,
)

const write = (record: object) => {
  out.write(`${JSON.stringify(record)}\n`)
  out.flush()
}

let finished = false
const finish = async (reason: string) => {
  if (finished) return
  finished = true
  clearInterval(sampler)
  producer.stop()
  write({ event: "end", reason, ticks: producer.ticks() })
  renderer.destroy()
  await renderer.closed
  style.destroy()
  await out.end()
  process.exit(0)
}
// exitSignals: [] leaves the signals to us, as tutti's Effect runtime will take them (§ 7.4).
process.on("SIGTERM", () => void finish("SIGTERM"))
process.on("SIGINT", () => void finish("SIGINT"))

const started = performance.now()
let minute = 0
const takeSample = async () => {
  const t = producer.transcript.getSnapshot()
  // --gc: a full collection first, to tell memory the GC would free from memory held.
  if (values.gc) Bun.gc(true)
  const s = await sample(minute)
  write({
    ...s,
    ticks: producer.ticks(),
    frames: renderer.getStats().frameCount,
    mounted: t.items.length + (t.streaming === null ? 0 : 1),
    appended: t.total,
    width: renderer.width,
    height: renderer.height,
  })
  minute++
  if (performance.now() - started >= minutes * 60_000) await finish("done")
}
write({ event: "start", minutes, window: values.window, pid: process.pid, argv: process.argv })
// React's development build adds a performance.measure() per component render, which Bun keeps.
if (values["clear-measures"]) {
  setInterval(() => {
    performance.clearMeasures()
    performance.clearMarks()
  }, 10_000)
}
if (values["shrink-at"] !== undefined) {
  setTimeout(
    () => {
      producer.setWindow(Number(values["shrink-to"]))
      write({ event: "shrink", to: Number(values["shrink-to"]), ticks: producer.ticks() })
    },
    Number(values["shrink-at"]) * 60_000 + 2_500,
  )
}
// Minute 0 is taken once the first frames and the tree-sitter worker have settled.
setTimeout(() => void takeSample(), 5_000)
const sampler = setInterval(() => void takeSample(), sampleMs)
