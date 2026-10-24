// The START block says why the colour scheme asked for isn't used, and which files were ignored,
// a line per notice (§ 7.11).
import { describe, expect, test } from "bun:test"
import { noServersNote } from "../src/agent/mcp.ts"
import type { Started } from "../src/run/startup.ts"
import { orchestraWarning, startBlock } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { type LoadedScheme, orchestra } from "../src/ui/theme.ts"

const started = (scheme: LoadedScheme, warnings: ReadonlyArray<string> = []): Started => ({
  config: TestAppConfig.appConfig({ scheme }, "/work/project"),
  base: "main",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  account: TestAccount.accountProbe(),
  organs: { _tag: "AgentSdk" },
  warnings,
})

/** The block's lines after the START line. */
const notes = (s: Started): ReadonlyArray<string> => startBlock(s, "0.1.0").slice(1)

const fallback =
  "colour scheme 'dusk' isn't used: 'colours.frame': 'ansi:300' is not a palette slot (0–255)"
const ignored =
  "/work/project/.tutti/colour-schemes/orchestra.json is ignored: orchestra is built in"

describe("the START block's colour scheme notices", () => {
  test("says nothing of a scheme in use as asked", () => {
    expect(notes(started({ scheme: orchestra, fallback: null, warnings: [] }))).toEqual([
      "  billing: subscription",
      "  permission mode: auto",
      `  ${noServersNote}`,
      "  memory: about 1 GiB of memory, about 1 GiB per worker",
    ])
  })

  test("gives the fallback, then each ignored file, a line each, before the run's warnings", () => {
    const lines = notes(
      started({ scheme: orchestra, fallback, warnings: [ignored] }, [orchestraWarning(["tut-1"])]),
    )
    expect(lines.slice(-3)).toEqual([
      `  ${fallback}`,
      `  ${ignored}`,
      "  orchestra left workers on tut-1; finish them with orchestra first",
    ])
  })

  test("gives the ignored files' warnings when the scheme is used", () => {
    expect(notes(started({ scheme: orchestra, fallback: null, warnings: [ignored] })).at(-1)).toBe(
      `  ${ignored}`,
    )
  })

  test("keeps a notice to its line when a file's name carries control characters", () => {
    const lines = notes(
      started({
        scheme: orchestra,
        fallback: "colour scheme 'du\nsk\u001b[2J' isn't used: its name isn't found",
        warnings: [],
      }),
    )
    const last = lines.at(-1) as string
    expect(lines).toHaveLength(5)
    expect([..."\n\r\u001b"].some((c) => last.includes(c))).toBe(false)
  })
})
