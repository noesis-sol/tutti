// React's production build (§ 3.1). React 19.2's development build records a performance.measure()
// per component render and Bun keeps every entry, so a run's memory grows without bound
// (docs/spikes/05-opentui-soak.md § 2). bunfig.toml defines process.env.NODE_ENV as "production"
// for every bun run from the checkout, and the compiled binary is built with the same define
// (§ 12). The suites keep the development build: scripts/test.ts defines "test" over bunfig.toml.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { slow } from "./gates.ts"

const checkout = join(import.meta.dir, "..")
const probe = join(import.meta.dir, "fixtures/react-build/probe.ts")
const production = { reconciler: "production", react: "production" }

/** The environment without NODE_ENV, as a shell that doesn't set it passes it on. */
const shellEnv = (): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.NODE_ENV
  return env
}

const run = async (command: ReadonlyArray<string>, cwd: string): Promise<unknown> => {
  const proc = Bun.spawn([...command], { cwd, env: shellEnv(), stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(err).toBe("")
  expect(code).toBe(0)
  return JSON.parse(out)
}

describe("React's build", () => {
  test("bun runs tutti from the checkout with the production build", async () => {
    expect(await run(["bun", probe], checkout)).toEqual(production)
  })

  test("bun run from another folder with the checkout's bunfig.toml gets the production build", async () => {
    const elsewhere = realpathSync(tmpdir())
    expect(
      await run(["bun", `--config=${join(checkout, "bunfig.toml")}`, probe], elsewhere),
    ).toEqual(production)
  })

  // The control: Bun reads bunfig.toml from the current folder only.
  test("bun run from another folder without it gets the development build", async () => {
    expect(await run(["bun", probe], realpathSync(tmpdir()))).toEqual({
      reconciler: "development",
      react: "development",
    })
  })

  test("the suites keep the development build, which has act (run them with scripts/test.sh)", () => {
    const react: { readonly act?: unknown } = require("react")
    expect(String(require("react-reconciler"))).toContain("performance.measure")
    expect(react.act).toBeFunction()
  })

  // bun build --compile leaves a .bun-build file in its current folder (tutti-nrg.21), so it runs
  // in the temp folder, which is also where bunfig.toml can't reach: the define does it alone.
  slow.test(
    "a binary compiled with the release build's define gets the production build",
    async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-react-build-")))
      try {
        const binary = join(dir, "probe")
        const build = Bun.spawn(
          [
            "bun",
            "build",
            "--compile",
            "--define",
            'process.env.NODE_ENV:"production"',
            probe,
            "--outfile",
            binary,
          ],
          { cwd: dir, stdout: "pipe", stderr: "pipe" },
        )
        expect(await build.exited).toBe(0)
        expect(await run([binary], dir)).toEqual(production)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
