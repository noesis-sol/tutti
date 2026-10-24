// bd show's dependents (tutti-cxgo.1): asked for them, bd show runs with --include-dependents and
// the issue has `dependents`, each with how it links; asked for nothing, neither, as before. The
// worker view's whole ticket reads them, for what the ticket blocks.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { Beads, issueFor } from "../src/services/Beads.ts"
import { layer as backlogLayer } from "../src/testing/Beads.ts"

const shown = JSON.stringify([
  {
    id: "t-1",
    title: "One",
    status: "open",
    dependencies: [{ id: "t-0", title: "Epic", status: "open", dependency_type: "parent-child" }],
    dependents: [{ id: "t-2", title: "Two", status: "open", dependency_type: "blocks" }],
  },
])

/** A stand-in for bd that records its arguments and prints `shown`. */
const fakeBd = () => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-dependents-"))
  const bin = join(dir, "bd")
  writeFileSync(join(dir, "shown.json"), shown)
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\ncat '${dir}/shown.json'\n`)
  chmodSync(bin, 0o755)
  return { dir, bin, args: () => readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n") }
}

const live = <A, E>(fake: { dir: string; bin: string }, effect: Effect.Effect<A, E, Beads>) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(
        effect,
        Beads.layer({ cwd: fake.dir, command: fake.bin }).pipe(Layer.provide(BunServices.layer)),
      ),
    ),
  )

describe("bd show's dependents", () => {
  test("are decoded with how each links", () => {
    const issue = Effect.runSync(issueFor("t-1", "bd show t-1", shown))
    expect(issue.dependents?.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "t-2", type: "blocks" },
    ])
    expect(issue.parent).toBe("t-0")
  })

  test("the live layer asks for them only when told to", async () => {
    const fake = fakeBd()
    const asked = await live(
      fake,
      Effect.flatMap(Beads, (beads) => beads.show("t-1", { dependents: true })),
    )
    expect(fake.args()).toEqual(["show", "t-1", "--json", "--include-dependents"])
    expect(Exit.isSuccess(asked) && asked.value.dependents?.map((each) => each.id)).toEqual(["t-2"])
    await live(
      fake,
      Effect.flatMap(Beads, (beads) => beads.show("t-1")),
    )
    expect(fake.args()).toEqual(["show", "t-1", "--json"])
  })

  test("the test layer gives the issues linked to it, as bd does", () => {
    const issue = Effect.runSync(
      Effect.flatMap(Beads, (beads) => beads.show("a", { dependents: true })).pipe(
        Effect.provide(
          backlogLayer([{ id: "a" }, { id: "b", blockedBy: ["a"] }, { id: "c", parent: "a" }]),
        ),
      ),
    )
    expect(issue.dependents?.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "b", type: "blocks" },
      { id: "c", type: "parent-child" },
    ])
    const plain = Effect.runSync(
      Effect.flatMap(Beads, (beads) => beads.show("a")).pipe(
        Effect.provide(backlogLayer([{ id: "a" }, { id: "b", blockedBy: ["a"] }])),
      ),
    )
    expect(plain.dependents).toBeUndefined()
  })
})
