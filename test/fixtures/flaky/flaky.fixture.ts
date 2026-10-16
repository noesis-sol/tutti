// A test that fails on its first run and passes on every run after, for test/test-script.test.ts.
// Not named *.test.ts, so bun test runs it only when given its path.
import { describe, expect, test } from "bun:test"
import { countRun } from "./counter.ts"

describe("fixture (flaky)", () => {
  test("passes on its second run", () => {
    expect(countRun()).toBeGreaterThan(1)
  })
})

test("always passes", () => expect(1).toBe(1))
