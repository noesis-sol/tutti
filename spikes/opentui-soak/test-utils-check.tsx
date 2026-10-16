// Checks captureCharFrame and captureSpans from @opentui/react/test-utils at a fixed size: the
// frame has exactly the requested size, two renders of the same tree give the same characters and
// spans, and the spans carry the colours the tree asked for.
//
//   bun spikes/opentui-soak/test-utils-check.tsx [--print]

import { RGBA, SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"
import { App } from "./app.tsx"
import { startProducer } from "./store.ts"

const print = process.argv.includes("--print")
const WIDTH = 100
const HEIGHT = 40

const results: { check: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail })
}

type Capture = { chars: string; spans: string; frame: ReturnType<Setup["captureSpans"]> }
type Setup = Awaited<ReturnType<typeof testRender>>

// The syntax style needs the renderer's scene, which exists only once testRender has made it.
const StyledApp = ({ producer }: { producer: ReturnType<typeof startProducer> }) => {
  const renderer = useRenderer()
  const [style] = useState(() =>
    SyntaxStyle.fromStyles(
      { keyword: { fg: RGBA.fromHex("#bb9af7") }, default: { fg: RGBA.fromHex("#c0caf5") } },
      renderer.nativeScene,
    ),
  )
  return (
    <App runView={producer.runView} transcript={producer.transcript} style={style} perRow={4} />
  )
}

const render = async (): Promise<Capture> => {
  // A producer with no ticks yet: a fixed state, so that two renders can be compared.
  const producer = startProducer({
    cards: 16,
    window: 200,
    preload: 30,
    hz: 10,
    appendEvery: 10,
    stream: true,
  })
  producer.stop()
  const setup = await testRender(<StyledApp producer={producer} />, {
    width: WIDTH,
    height: HEIGHT,
  })
  await setup.flush()
  await setup.waitForVisualIdle()
  const chars = setup.captureCharFrame()
  const frame = setup.captureSpans()
  const spans = JSON.stringify(frame)
  // dispose() unmounts the root from the renderer's destroy event; in act(), React doesn't warn.
  await act(async () => {
    await setup.dispose()
  })
  return { chars, spans, frame }
}

const first = await render()
const second = await render()
if (print) console.log(first.chars)

const lines = first.chars.split("\n").filter((_, i, all) => i < all.length - 1 || all[i] !== "")
check(
  "captureCharFrame has the requested size",
  lines.length === HEIGHT && lines.every((l) => Bun.stringWidth(l) === WIDTH),
  `${lines.length} lines, widths ${[...new Set(lines.map((l) => Bun.stringWidth(l)))].join(",")}`,
)
check(
  "captureSpans has the requested size",
  first.frame.cols === WIDTH &&
    first.frame.rows === HEIGHT &&
    first.frame.lines.length === HEIGHT &&
    first.frame.lines.every((l) => l.spans.reduce((n, s) => n + s.width, 0) === WIDTH),
  `cols ${first.frame.cols}, rows ${first.frame.rows}, lines ${first.frame.lines.length}`,
)
check("captureCharFrame is the same on a second render", first.chars === second.chars)
check("captureSpans is the same on a second render", first.spans === second.spans)
const cardLine = first.frame.lines.find((l) => l.spans.some((s) => s.text.includes("Card 1:")))
const cardSpan = cardLine?.spans.find((s) => s.text.includes("Card 1:"))
const [r, g, b] = cardSpan?.fg.toInts() ?? []
check(
  "captureSpans carries the requested colour",
  r === 0x7a && g === 0xa2 && b === 0xf7,
  `"Card 1:" span fg ${cardSpan === undefined ? "missing" : `rgb(${r}, ${g}, ${b})`}`,
)
check(
  "the transcript is stuck to the bottom",
  first.chars.includes("Thinking aloud") || /Step \d+|src\/\w+\.ts/.test(first.chars),
  "the streaming tail or the last items are on screen",
)

for (const r of results)
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `: ${r.detail}` : ""}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
