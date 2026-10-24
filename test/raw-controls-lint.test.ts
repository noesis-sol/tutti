// The lint on raw bidi controls, C1 controls and line and paragraph separators in the source
// (biome.json, test/lint/raw-controls.grit), the scan for those the plugin misses, and Biome's
// formatter keeping their escapes as they are (tutti-hgdi).
import { describe, expect, test } from "bun:test"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

/** The character with this code, raw. */
const raw = (code: number): string => String.fromCharCode(code)

/** The JavaScript escape of the character with this code, as the source spells it. */
const escaped = (code: number): string =>
  `${String.fromCharCode(0x5c)}u${code.toString(16).padStart(4, "0")}`

const flagged = [0x80, 0x9b, 0x9f, 0x61c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066]
const allowed = [0xe9, 0x4e2d, 0x200b, 0x200d, 0x2014, 0x2192, 0x2026]

// Biome on a copy of its configuration and plugins, with the probes in the folder.
const biome = (probes: Record<string, string>, ...args: ReadonlyArray<string>) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-raw-controls-"))
  cpSync(join(root, "biome.json"), join(dir, "biome.json"))
  cpSync(join(root, "test/lint"), join(dir, "test/lint"), { recursive: true })
  for (const [file, text] of Object.entries(probes)) {
    mkdirSync(join(dir, file, ".."), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const proc = Bun.spawnSync(
    [join(root, "node_modules/.bin/biome"), ...args, "--vcs-enabled=false", "--reporter=github"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  )
  return { dir, out: proc.stdout.toString().replaceAll(`${realpathSync(dir)}/`, "") }
}

/** The plugin's findings, as `file:line:column`, sorted. */
const findings = (out: string): ReadonlyArray<string> =>
  out
    .split("\n")
    .flatMap((line) => {
      const match = /^::error title=plugin,file=([^,]+),line=(\d+),endLine=\d+,col=(\d+)/.exec(line)
      return match === null ? [] : [`${match[1]}:${match[2]}:${match[3]}`]
    })
    .sort()

describe("the lint on raw controls", () => {
  test("flags each raw bidi control, C1 control and separator in a string, in src/ and test/", () => {
    const probes: Record<string, string> = {}
    for (const code of flagged) {
      const name = code.toString(16)
      probes[`src/s${name}.ts`] = `export const a = 1\nexport const b = "x${raw(code)}y"\n`
      probes[`test/t${name}.test.ts`] = `export const a = "x${raw(code)}y"\n`
    }
    const found = findings(biome(probes, "lint").out)
    expect(found).toEqual(
      flagged
        .flatMap((code) => {
          const name = code.toString(16)
          return [`src/s${name}.ts:2:18`, `test/t${name}.test.ts:1:18`]
        })
        .sort(),
    )
  }, 30_000)

  test("points at the template, regex, JSX text or key that holds one", () => {
    const bidi = raw(0x202e)
    const { out } = biome(
      {
        "src/template.ts": `export const a = 1\nexport const b = \`x${bidi} \${a} y\`\n`,
        "src/regex.ts": `export const a = /[${bidi}]/\n`,
        "src/jsx.tsx": `export const a = <div>x${raw(0x2066)}y</div>\n`,
        "src/key.ts": `export const a = { "k${bidi}": 1, b: 2 }\n`,
        "src/lines.ts": `export const a =\n  "one" +\n  "two${bidi}"\n`,
      },
      "lint",
    )
    expect(findings(out)).toEqual([
      "src/jsx.tsx:1:23",
      "src/key.ts:1:20",
      "src/lines.ts:3:3",
      "src/regex.ts:1:18",
      "src/template.ts:2:19",
    ])
  }, 30_000)

  test("flags the file for one in a comment between its code", () => {
    // One before the first code or after the last is outside the file's text for the plugin: the
    // scan below finds those.
    const { out } = biome(
      {
        "src/line.ts": `export const a = 1\n// see ${raw(0x202e)} here\nexport const b = 2\n`,
        "src/block.ts": `export const a = 1\n/* ${raw(0x9b)} */\nexport const b = 2\n`,
        "src/header.ts": `// ${raw(0x202e)}\nexport const a = 1\n`,
      },
      "lint",
    )
    expect(findings(out)).toEqual(["src/block.ts:1:1", "src/line.ts:1:1"])
  }, 30_000)

  test("leaves escapes and other characters alone", () => {
    const text = [
      `export const a = "${flagged.map(escaped).join(" ")}"`,
      `export const b = /[${escaped(0x202a)}-${escaped(0x202e)}]/`,
      `export const c = "${allowed.map(raw).join(" ")} \u{1f389}"`,
      `// ${allowed.map(raw).join(" ")}`,
      "",
    ].join("\n")
    expect(findings(biome({ "src/fine.ts": text }, "lint").out)).toEqual([])
  }, 30_000)
})

// The characters the plugin flags, as ranges of codes.
const rawRanges: ReadonlyArray<readonly [number, number]> = [
  [0x80, 0x9f],
  [0x61c, 0x61c],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]

/** Each raw control in the text, as `line:column U+code`. */
const rawControls = (text: string): ReadonlyArray<string> =>
  text.split("\n").flatMap((line, index) =>
    [...line].flatMap((char, column) => {
      const code = char.codePointAt(0) ?? 0
      return rawRanges.some(([low, high]) => code >= low && code <= high)
        ? [`${index + 1}:${column + 1} U+${code.toString(16).toUpperCase().padStart(4, "0")}`]
        : []
    }),
  )

describe("the source", () => {
  test("holds no raw control, in its code or its comments", () => {
    // The plugin misses a comment before a file's first code or after its last.
    const found = ["src", "test", "scripts", "skills", "bin"].flatMap((top) =>
      readdirSync(join(root, top), { recursive: true, encoding: "utf8" }).flatMap((file) => {
        const path = join(root, top, file)
        if (!statSync(path).isFile()) return []
        return rawControls(readFileSync(path, "utf8")).map((at) => `${top}/${file}:${at}`)
      }),
    )
    expect(found).toEqual([])
  })

  test("the scan finds a raw control in a comment", () => {
    expect(rawControls(`// a\n// b${raw(0x202e)}c${raw(0x9b)}`)).toEqual([
      "2:5 U+202E",
      "2:7 U+009B",
    ])
    expect(rawControls(`"${escaped(0x202e)}" ${allowed.map(raw).join("")}`)).toEqual([])
  })
})

describe("Biome's formatter", () => {
  test("keeps the escapes of bidi controls, C1 controls and separators", () => {
    // tutti-hgdi: the raw characters a test was found with came from the agent's Write and Edit,
    // which decode such escapes in their input, not from biome check --write.
    const strings = flagged.map(escaped).join(" ")
    const text = `export const a = '${strings}'\nexport const b = \`${strings}\`\n`
    const { dir } = biome({ "src/probe.ts": text }, "check", "--write")
    expect(readFileSync(join(dir, "src/probe.ts"), "utf8")).toBe(
      `export const a = "${strings}"\nexport const b = \`${strings}\`\n`,
    )
  }, 30_000)
})
