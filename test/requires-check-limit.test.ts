// requires_check's installs run within the limit the host gives, the run's merge-check limit (a
// --check-timeout or TUTTI_CHECK_TIMEOUT staying), not the worktree's checks.fast.timeout
// (src/run/requiresTools.ts's checkIn; tutti-yz0g).
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect } from "effect"
import { checkIn, makeRequiresTools } from "../src/run/requiresTools.ts"
import { openFibers } from "./fibers.ts"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

/** A checkout whose merge check may take 20 minutes, with a slow install on its list. */
const checkout = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-requires-limit-")))
  mkdirSync(join(dir, ".tutti"))
  writeFileSync(
    join(dir, ".tutti", "settings.json"),
    JSON.stringify({
      checks: { fast: { command: "true", timeout: "20m" } },
      requires: [{ name: "slow", check: "test -f done", install: "sleep 30; touch done" }],
    }),
  )
  return dir
}

const said = (answer: { content: ReadonlyArray<unknown> }) =>
  answer.content.map((c) => (c as { text: string }).text).join("\n")

describe("requires_check's install limit", () => {
  test("is the one given, not the worktree's checks.fast.timeout", async () => {
    const dir = checkout()
    const started = Date.now()
    const answer = said(await run(checkIn(dir, dir, {}, Duration.millis(300))))
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(answer).toContain("slow: missing: 'sleep 30; touch done' failed: timed out")
    expect(existsSync(join(dir, "done"))).toBe(false)
  })

  test("the server's requires_check keeps to the limit it was made with", async () => {
    const dir = checkout()
    const tools = await run(makeRequiresTools(dir, dir, openFibers(), Duration.millis(300)))
    const check = tools.tools[0]
    if (check === undefined) throw new Error("no requires_check")
    const started = Date.now()
    expect(said(await check.handler({}, {}))).toContain("failed: timed out")
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
