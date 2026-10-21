// The user docs, README.md and the guides in docs/ (§ 14 M8), checked against the code: every run
// flag, init flag, settings key, user config key, event kind and colour role is documented where a
// reader looks for it; the example settings, user config and colour scheme are files tutti reads as
// they are; and every link between the docs leads to a file and a heading that are there.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { initFlags } from "../src/cli/commands.ts"
import { runFlags } from "../src/cli/flags.ts"
import { decodeConfig } from "../src/project/configFile.ts"
import { Settings } from "../src/project/settings.ts"
import { UserConfig } from "../src/project/userConfig.ts"
import { kinds } from "../src/run/events.ts"
import { loadScheme, roles } from "../src/ui/theme.ts"

const top = join(import.meta.dir, "..")
const guides = [
  "docs/running.md",
  "docs/workers.md",
  "docs/dashboard.md",
  "docs/setup.md",
  "docs/organs.md",
  "docs/events.md",
  "docs/colour-schemes.md",
]
const docs = ["README.md", ...guides]
const read = (file: string): string => readFileSync(join(top, file), "utf8")

/** The ```json blocks of `file`, parsed. */
const jsonBlocks = (file: string): ReadonlyArray<Record<string, unknown>> =>
  [...read(file).matchAll(/```json\n([\s\S]*?)```/g)].map((block) => JSON.parse(block[1] ?? ""))

/** The one ```json block of `file` that has `key`. */
const blockWith = (file: string, key: string): Record<string, unknown> => {
  const found = jsonBlocks(file).filter((block) => key in block)
  expect(found).toHaveLength(1)
  return found[0] ?? {}
}

/** Every key of `value`, nested ones as `outer.inner`. */
const keysOf = (value: unknown, prefix = ""): ReadonlyArray<string> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, inner]) => [
        `${prefix}${key}`,
        ...keysOf(inner, `${prefix}${key}.`),
      ])
    : []

interface JsonSchema {
  readonly properties?: Record<string, JsonSchema>
}

/** Every key the JSON Schema `schema` names, nested ones as `outer.inner`. */
const schemaKeys = (schema: JsonSchema, prefix = ""): ReadonlyArray<string> =>
  Object.entries(schema.properties ?? {}).flatMap(([key, inner]) => [
    `${prefix}${key}`,
    ...schemaKeys(inner, `${prefix}${key}.`),
  ])

/** A heading's anchor, as GitHub makes it. */
const anchorOf = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")

/** The anchors of `file`'s headings. */
const anchorsOf = (file: string): ReadonlySet<string> =>
  new Set(
    readFileSync(file, "utf8")
      .replace(/```[\s\S]*?```/g, "")
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) => anchorOf(line.replace(/^#+ /, ""))),
  )

/** camelCase as a flag's kebab-case name. */
const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

describe("the docs", () => {
  test("each guide is there, and the README links to it", () => {
    const readme = read("README.md")
    for (const guide of guides) {
      expect(existsSync(join(top, guide))).toBe(true)
      expect(readme).toContain(`](${guide})`)
    }
  })

  test("every link between them leads to a file and a heading that are there", () => {
    for (const doc of docs) {
      const text = read(doc).replace(/```[\s\S]*?```/g, "")
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (target === undefined || /^[a-z]+:/.test(target)) continue
        const [path, anchor] = target.split("#")
        const file = path === "" ? join(top, doc) : resolve(dirname(join(top, doc)), path ?? "")
        expect({ doc, target, there: existsSync(file) }).toEqual({ doc, target, there: true })
        if (anchor !== undefined && file.endsWith(".md")) {
          expect({ doc, target, there: anchorsOf(file).has(anchor) }).toEqual({
            doc,
            target,
            there: true,
          })
        }
      }
    }
  })

  test("the README names every command", () => {
    const readme = read("README.md")
    for (const command of ["init", "answer", "plan", "login", "colours", "update"]) {
      expect(readme).toContain(`tutti ${command}`)
    }
  })

  test("docs/running.md names every run flag", () => {
    const running = read("docs/running.md")
    for (const { name } of Object.values(runFlags)) expect(running).toContain(`--${name}`)
  })

  test("docs/setup.md names every init flag", () => {
    const setup = read("docs/setup.md")
    for (const name of Object.keys(initFlags)) expect(setup).toContain(`--${kebab(name)}`)
  })

  test("docs/setup.md's example settings are complete, and tutti reads them", () => {
    const example = blockWith("docs/setup.md", "checks")
    expect(Exit.isSuccess(decodeConfig(Settings, "settings.json", example))).toBe(true)
    const schema = JSON.parse(read("schema/settings.json")) as JsonSchema
    expect([...keysOf(example)].sort()).toEqual([...schemaKeys(schema)].sort())
  })

  test("docs/setup.md's example user config is complete, and tutti reads it", () => {
    const example = blockWith("docs/setup.md", "appearance")
    expect(Exit.isSuccess(decodeConfig(UserConfig, "config.json", example))).toBe(true)
    // It has no published JSON Schema, so the example names none.
    const keys = Object.keys(UserConfig.fields).filter((key) => key !== "$schema")
    expect(Object.keys(example).sort()).toEqual(keys.sort())
  })

  test("docs/events.md names every kind of record", () => {
    const events = read("docs/events.md")
    for (const kind of Object.keys(kinds)) expect(events).toContain(`\`${kind}\``)
  })

  test("docs/colour-schemes.md names every role", () => {
    const schemes = read("docs/colour-schemes.md")
    for (const role of roles) expect(schemes).toContain(`\`${role}\``)
  })

  test("docs/colour-schemes.md's example scheme is one tutti uses", async () => {
    const example = blockWith("docs/colour-schemes.md", "extends")
    const name = String(example.name)
    const dir = mkdtempSync(join(tmpdir(), "tutti-docs-"))
    const project = join(dir, "project")
    mkdirSync(project)
    writeFileSync(join(project, `${name}.json`), JSON.stringify(example))
    const loaded = await Effect.runPromise(
      loadScheme(name, { project, user: join(dir, "user") }).pipe(
        Effect.provide(BunServices.layer),
      ),
    )
    expect(loaded.fallback).toBeNull()
    expect(loaded.warnings).toEqual([])
  })
})
