// tutti update's file beside the binary (src/update/update.ts's install): made before the download,
// written as atomicFile writes, and removed on every way the update fails.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { updateExit } from "../src/update/update.ts"
import { build, fakeTutti, fixture, installed, leftovers, run } from "./update-releases.ts"

describe("tutti update's file beside the binary", () => {
  test("a new binary that exits non-zero leaves the binary and nothing beside it", async () => {
    const { dir, exe } = installed()
    const { releases } = await fixture({
      tag: "v0.9.1",
      holds: { tutti: "#!/bin/sh\necho broken >&2\nexit 3\n" },
    })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(ran.error[0]).toBe("tutti update: the new binary doesn't run: it exited 3: broken")
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    expect(leftovers(dir)).toEqual([])
  })

  test("a release whose sum doesn't verify leaves nothing beside the binary", async () => {
    const { dir, exe } = installed()
    const { releases } = await fixture({ tag: "v0.9.1", tampered: true })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.failed)
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.0"))
    expect(leftovers(dir)).toEqual([])
  })

  test("leaves another writer's file beside the binary alone, and names its own apart", async () => {
    const { dir, exe } = installed()
    const other = join(dir, ".tutti.tutti-1-other.update")
    writeFileSync(other, "another update's")
    const { releases } = await fixture({ tag: "v0.9.1" })
    const ran = await run({}, build(exe), releases)
    expect(ran.code).toBe(updateExit.ok)
    expect(readFileSync(exe, "utf8")).toBe(fakeTutti("tutti v0.9.1"))
    expect(readdirSync(dir).sort()).toEqual([".tutti.tutti-1-other.update", "tutti"])
    expect(readFileSync(other, "utf8")).toBe("another update's")
  })
})
