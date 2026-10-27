import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Exit, Option } from "effect"
import fc from "fast-check"
import { type SchemaName, schemaFile, schemas, schemaText } from "../scripts/gen-schemas.ts"
import { decodeConfig, formatDuration, parseDuration } from "../src/project/configFile.ts"
import { retiredSettings, Settings } from "../src/project/settings.ts"
import { kinds } from "../src/run/events.ts"
import { timestamp } from "../src/run/localTime.ts"

interface JsonSchema {
  readonly properties?: Record<string, JsonSchema>
  readonly anyOf?: ReadonlyArray<JsonSchema>
  readonly required?: ReadonlyArray<string>
  readonly enum?: ReadonlyArray<unknown>
  readonly pattern?: string
  readonly default?: unknown
}

const document = (name: SchemaName): JsonSchema => JSON.parse(schemaText(name))

for (const name of Object.keys(schemas) as Array<SchemaName>) {
  test(`schema/${name} is up to date: run bun scripts/gen-schemas.ts`, () => {
    expect(readFileSync(schemaFile(name), "utf8")).toBe(schemaText(name))
  })
}

test("schema/settings.json has every settings key but the retired, and refuses others", () => {
  const settings = document("settings.json") as JsonSchema & { additionalProperties: boolean }
  expect(Object.keys(settings.properties ?? {})).toEqual(
    Object.keys(Settings.fields).filter((key) => !Object.hasOwn(retiredSettings, key)),
  )
  expect(Object.keys(retiredSettings)).toEqual([])
  expect(Object.keys(settings.properties ?? {})).toContain("keep_awake")
  expect(settings.additionalProperties).toBe(false)
})

// An object of every key's default, the way a file giving them all would.
const defaults = (schema: JsonSchema): unknown =>
  schema.properties === undefined
    ? schema.default
    : Object.fromEntries(
        Object.entries(schema.properties)
          .map(([key, inner]) => [key, defaults(inner)] as const)
          .filter(([, value]) => value !== undefined),
      )

test("schema/settings.json's defaults are the ones a missing key takes", () => {
  const file = ".tutti/settings.json"
  const given = defaults(document("settings.json"))
  expect(given).toHaveProperty("checks.fast.timeout", "30m")
  expect(given).toHaveProperty("queue.exclude_types", ["epic"])
  expect(decodeConfig(Settings, file, given)).toEqual(decodeConfig(Settings, file, {}))
})

const settingsKey = (...path: Array<string>): JsonSchema => {
  let schema = document("settings.json")
  for (const key of path) schema = schema.properties?.[key] ?? {}
  return schema
}

const patternOf = (schema: JsonSchema): RegExp => new RegExp(schema.pattern ?? "(?!)", "u")

test("schema/settings.json's time pattern takes the times the settings read", () => {
  const positive = patternOf(settingsKey("checks", "fast", "timeout"))
  const nonNegative = patternOf(settingsKey("environment_hold", "probe"))
  expect(positive.test("0")).toBe(false)
  expect(nonNegative.test("0")).toBe(true)
  const time = fc
    .array(fc.tuple(fc.nat(10_000), fc.constantFrom("ms", "s", "m", "h")), { minLength: 1 })
    .map((parts) => parts.map(([n, unit]) => `${n}${unit}`).join(""))
  fc.assert(
    fc.property(time, (text) => {
      expect(positive.test(text)).toBe(true)
      expect(nonNegative.test(text)).toBe(true)
    }),
  )
  fc.assert(
    fc.property(fc.string(), (text) => {
      expect(nonNegative.test(text)).toBe(Option.isSome(parseDuration(text)))
    }),
  )
  fc.assert(
    fc.property(fc.nat(10 ** 9), (ms) => {
      expect(nonNegative.test(formatDuration(Option.getOrThrow(parseDuration(`${ms}ms`))))).toBe(
        true,
      )
    }),
  )
})

test("schema/events.json has a record for every kind, with v, time, run and kind", () => {
  const records = document("events.json").anyOf ?? []
  expect(records.map((record) => record.properties?.kind?.enum?.[0])).toEqual(Object.keys(kinds))
  for (const record of records) {
    expect(record.required).toEqual(expect.arrayContaining(["v", "time", "run", "kind"]))
  }
})

test("schema/events.json's time pattern takes the times records are written with", () => {
  const records = document("events.json").anyOf ?? []
  const time = patternOf(records[0]?.properties?.time ?? {})
  fc.assert(
    fc.property(
      fc.date({ min: new Date("2000-01-01"), max: new Date("9999-01-01"), noInvalidDate: true }),
      (date) => {
        expect(time.test(timestamp(date))).toBe(true)
      },
    ),
  )
})

test("the published settings schema decodes the spec's example's $schema", () => {
  const file = ".tutti/settings.json"
  const $schema = "https://raw.githubusercontent.com/noesis-sol/tutti/main/schema/settings.json"
  expect((document("settings.json") as { $id: string }).$id).toBe($schema)
  expect(Exit.isSuccess(decodeConfig(Settings, file, { $schema }))).toBe(true)
})
