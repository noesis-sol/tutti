// scripts/colour-scheme-schema.ts: writes schema/colour-scheme.json, the colour scheme format's
// JSON Schema for editors (§ 7.11), from its Effect Schema in src/ui/theme.ts. Run it with
// `bun scripts/colour-scheme-schema.ts` after changing the format; test/theme.test.ts fails while
// the file is out of date.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { colourSchemeJsonSchema } from "../src/ui/theme.ts"

/** The file's text, as the script writes it. */
export const colourSchemeSchemaText = (): string =>
  `${JSON.stringify(colourSchemeJsonSchema(), null, 2)}\n`

export const colourSchemeSchemaFile = join(import.meta.dir, "..", "schema", "colour-scheme.json")

if (import.meta.main) writeFileSync(colourSchemeSchemaFile, colourSchemeSchemaText())
