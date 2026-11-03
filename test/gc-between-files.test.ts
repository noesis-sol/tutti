// The preload (test/warm-up.ts, bunfig.toml) collects the garbage after each file, so that a test
// process running many files doesn't carry the garbage of those before into the next (tutti-3cri).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { testEnv } from "./env.ts"

const root = resolve(import.meta.dir, "..")

// Runs, in one worker process, a file that makes ~240 MB of garbage and then one that reads the
// heap's size, with the given preloads, and returns that size in MiB.
const heapAfterGarbage = (preloads: ReadonlyArray<string>): number => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-gc-"))
  writeFileSync(
    join(dir, "a.test.ts"),
    `import { test } from "bun:test"
test("makes garbage", () => {
  let kept: Array<Array<number>> = []
  for (let i = 0; i < 30; i++) kept.push(Array.from({ length: 1_000_000 }, (_, j) => j + 0.5))
  kept = []
  void kept
})
`,
  )
  writeFileSync(
    join(dir, "b.test.ts"),
    `import { test } from "bun:test"
import { heapStats } from "bun:jsc"
test("reads the heap", () => {
  console.log("HEAP " + heapStats().heapSize)
})
`,
  )
  const proc = Bun.spawnSync(
    [
      "bun",
      "test",
      "--parallel=1",
      ...preloads.flatMap((preload) => ["--preload", preload]),
      "./a.test.ts",
      "./b.test.ts",
    ],
    { cwd: dir, env: testEnv, stdout: "pipe", stderr: "pipe" },
  )
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`
  expect(proc.exitCode).toBe(0)
  const heap = output.match(/HEAP (\d+)/)?.[1]
  expect(heap).toBeDefined()
  return Number(heap) / 1024 / 1024
}

describe("the preload's garbage collection between files", () => {
  test("bun test preloads test/warm-up.ts", () => {
    expect(readFileSync(join(root, "bunfig.toml"), "utf8")).toContain(
      'preload = ["./test/warm-up.ts"]',
    )
  })

  test("the next file in the process starts without the garbage of the one before", () => {
    // Without the preload the garbage is still in the heap, which shows the test can see it.
    expect(heapAfterGarbage([])).toBeGreaterThan(100)
    expect(heapAfterGarbage([join(root, "test", "warm-up.ts")])).toBeLessThan(50)
  })
})
