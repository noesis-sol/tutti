// The lint on a bare run of spaces as a segment in src/ui (biome.json, test/lint/bare-spaces.grit):
// a gap is named in src/ui/spacing.ts for what it separates (tutti-6bwa.2).
import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

/** The plugin's findings on the probes, linted with a copy of the configuration and plugins. */
const findings = (probes: Record<string, string>): ReadonlyArray<string> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-bare-spaces-"))
  cpSync(join(root, "biome.json"), join(dir, "biome.json"))
  cpSync(join(root, "test/lint"), join(dir, "test/lint"), { recursive: true })
  for (const [file, text] of Object.entries(probes)) {
    mkdirSync(join(dir, file, ".."), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const proc = Bun.spawnSync(
    [join(root, "node_modules/.bin/biome"), "lint", "--vcs-enabled=false", "--reporter=github"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  )
  return proc.stdout
    .toString()
    .replaceAll(`${realpathSync(dir)}/`, "")
    .split("\n")
    .flatMap((line) => {
      const match = /^::error title=plugin,file=([^,]+),line=(\d+),endLine=\d+,col=(\d+)/.exec(line)
      return match === null ? [] : [`${match[1]}:${match[2]}:${match[3]}`]
    })
    .sort()
}

describe("the lint on bare spaces in src/ui", () => {
  test("flags a segment of nothing but spaces, with a look and a target or without", () => {
    const text = [
      'import { seg } from "./line.tsx"',
      'export const a = [seg(" "), seg("  ", null), seg("   ", null, 0)]',
      "export const b = [seg(' '), seg(`  `)]",
      "",
    ].join("\n")
    expect(findings({ "src/ui/probe.ts": text, "src/ui/worker/probe.ts": text })).toEqual(
      [
        "src/ui/probe.ts:2:23",
        "src/ui/probe.ts:2:33",
        "src/ui/probe.ts:2:50",
        "src/ui/probe.ts:3:23",
        "src/ui/probe.ts:3:33",
        "src/ui/worker/probe.ts:2:23",
        "src/ui/worker/probe.ts:2:33",
        "src/ui/worker/probe.ts:2:50",
        "src/ui/worker/probe.ts:3:23",
        "src/ui/worker/probe.ts:3:33",
      ].sort(),
    )
  }, 30_000)

  test("leaves named gaps, padding, spaces with words and other folders alone", () => {
    const fine = [
      'import { seg } from "./line.tsx"',
      'import { fieldGap } from "./spacing.ts"',
      "const short = 3",
      'export const a = [seg(fieldGap), seg(" ".repeat(short)), seg(" · "), seg(" a"), seg("")]',
      'export const b = [seg(short > 0 ? "> " : "  "), other("  ")]',
      "",
    ].join("\n")
    const elsewhere = 'import { seg } from "./ui/line.tsx"\nexport const a = seg("  ")\n'
    expect(findings({ "src/ui/fine.ts": fine, "src/elsewhere.ts": elsewhere })).toEqual([])
  }, 30_000)
})
