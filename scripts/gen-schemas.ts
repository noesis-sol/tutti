// scripts/gen-schemas.ts: writes the JSON Schemas tutti publishes in schema/, for editors and
// readers of the event stream, from their Effect Schemas: the settings (§ 8.4), the event records
// (§ 10) and the colour scheme format (§ 7.11). Run it with `bun scripts/gen-schemas.ts` after
// changing one of them; test/schemas.test.ts fails while a file is out of date.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { retiredSettings, Settings } from "../src/project/settings.ts"
import { EventRecord } from "../src/run/events.ts"
import { ColourScheme } from "../src/ui/theme.ts"

/** Where the published files are found, as `$schema` names them. */
const published = "https://raw.githubusercontent.com/noesis-sol/tutti/main/schema"

/** `schema`'s JSON Schema, as `schema/<name>` holds it; `strict` refuses unknown keys. */
const jsonSchema = (schema: Schema.Top, name: string, strict: boolean): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(
    schema,
    strict ? { onExcessProperty: "error" } : undefined,
  )
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${published}/${name}`,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
  }
}

/** The settings' schema without the keys they no longer read, so that an editor flags them. */
const withoutRetired = (schema: Record<string, unknown>): Record<string, unknown> => {
  const properties = { ...(schema.properties as Record<string, unknown>) }
  for (const key of Object.keys(retiredSettings)) delete properties[key]
  return { ...schema, properties }
}

/**
 * Each published schema, by its file's name in schema/. The settings and colour schemes refuse an
 * unknown key, as tutti does reading them; an event record may have keys a reader doesn't know.
 */
export const schemas = {
  "settings.json": () => withoutRetired(jsonSchema(Settings, "settings.json", true)),
  "events.json": () => jsonSchema(EventRecord, "events.json", false),
  "colour-scheme.json": () => jsonSchema(ColourScheme, "colour-scheme.json", true),
} as const

export type SchemaName = keyof typeof schemas

/** The file's text, as the script writes it. */
export const schemaText = (name: SchemaName): string =>
  `${JSON.stringify(schemas[name](), null, 2)}\n`

/** Where the file is. */
export const schemaFile = (name: SchemaName): string => join(import.meta.dir, "..", "schema", name)

if (import.meta.main) {
  for (const name of Object.keys(schemas) as Array<SchemaName>) {
    writeFileSync(schemaFile(name), schemaText(name))
  }
}
