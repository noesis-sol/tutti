// A test that makes a temp folder the way the suites do, and writes os.tmpdir() to the file
// TUTTI_FIXTURE_TMPDIR names, for test/test-tmpdir.test.ts. It fails when TUTTI_FIXTURE_FAIL is
// set. Not named *.test.ts, so bun test runs it only when given its path.
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("makes a temp folder", () => {
  const made = mkdtempSync(join(tmpdir(), "tutti-fixture-"))
  writeFileSync(process.env.TUTTI_FIXTURE_TMPDIR ?? "", tmpdir())
  expect(existsSync(made)).toBe(true)
  expect(process.env.TUTTI_FIXTURE_FAIL).toBeUndefined()
})
