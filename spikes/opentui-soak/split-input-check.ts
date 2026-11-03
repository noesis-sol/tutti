// What OpenTUI makes of a wheel report that arrives in two reads, the second after its stdin
// parser's 20 ms timeout (OpenTUI #1661), with its own parser and with the experimental native one
// (`experimental_nativeInput`, OTUI_NATIVE_INPUT_PARSER, OpenTUI #1794). It runs split-input.tsx
// in a pseudo-terminal that answers the colour queries and DA1, and prints what the app saw, step
// by step, for each parser.
//
//   bun spikes/opentui-soak/split-input-check.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DARK, spawnInPty } from "./pty.ts"

const folder = mkdtempSync(join(tmpdir(), "opentui-split-"))
const gap = 60

const run = async (native: boolean) => {
  const file = join(folder, `split-${native ? "native" : "own"}.jsonl`)
  writeFileSync(file, "")
  const pty = spawnInPty(["bun", join(import.meta.dir, "split-input.tsx")], {
    cols: 80,
    rows: 20,
    theme: DARK,
    keepOutput: true,
    env: { PROBE_LOG: file, NATIVE: native ? "1" : "0" },
  })
  // DA1 ends OpenTUI's startup queries: answer each, as a terminal does.
  let answered = 0
  const da1 = setInterval(() => {
    const asked = pty.output().split("\x1b[c").length - 1
    for (; answered < asked; answered++) pty.write("\x1b[?62;22c")
  }, 5)
  const records = () =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line))
  for (let i = 0; i < 100 && !records().some((r) => r.ready); i++) await Bun.sleep(50)
  const step = async (name: string, ...parts: string[]) => {
    writeFileSync(file, `${JSON.stringify({ step: name })}\n`, { flag: "a" })
    for (const [i, part] of parts.entries()) {
      if (i > 0) await Bun.sleep(gap)
      pty.write(part)
    }
    await Bun.sleep(150)
  }
  await step("whole report", "\x1b[<64;10;3M")
  await step("split after ESC [", "\x1b[", "<64;10;3M")
  await step("split after ESC [<6", "\x1b[<6", "4;10;3M")
  await step("split after ESC", "\x1b", "[<64;10;3M")
  await step("lone Esc", "\x1b")
  await step("typed ab", "ab")
  pty.proc.kill("SIGTERM")
  await Promise.race([pty.proc.exited, Bun.sleep(2000)])
  clearInterval(da1)
  pty.terminal.close()
  console.log(`${native ? "native parser" : "OpenTUI's own parser"}, DA1 answered ${answered}:`)
  const lines: string[] = []
  for (const r of records()) {
    if (r.step !== undefined) lines.push(`\n  ${r.step}:`)
    else if (r.ready) lines.push(`  ready, theme ${r.themeMode}`)
    else if (r.key !== undefined) lines.push(` key ${r.key}`)
    else if (r.input !== undefined) lines.push(` input "${r.input}"`)
    else if (r.mouse !== undefined) lines.push(` ${r.mouse} ${r.direction ?? ""}`.trimEnd())
  }
  console.log(lines.join(""), "\n")
}

await run(false)
await run(true)
process.exit(0)
