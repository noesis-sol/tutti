// whichOnPath, where --keep-awake's command, init's tools and --claude's `claude` are looked for: on
// process.env's PATH as it is now, the one a command is run with, not the one tutti started with.

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { whichOnPath } from "../src/services/onPath.ts"
import { withVariable } from "./env.ts"

describe("whichOnPath", () => {
  test("finds a command only process.env's changed PATH has, and gives its path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-which-on-path-"))
    const command = join(dir, "tutti-only-here")
    writeFileSync(command, "#!/bin/sh\n")
    chmodSync(command, 0o755)
    expect(await withVariable("PATH", dir, async () => whichOnPath("tutti-only-here"))).toBe(
      command,
    )
    expect(whichOnPath("tutti-only-here")).toBeNull()
  })
})
