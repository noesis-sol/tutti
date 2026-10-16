// A test that fails on every run, for test/test-script.test.ts. Not named *.test.ts, so bun test
// runs it only when given its path.
import { expect, test } from "bun:test"
import { countRun } from "./counter.ts"

test("fails on every run", () => {
  expect(countRun()).toBe(0)
})
