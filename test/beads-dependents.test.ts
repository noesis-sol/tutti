// bd show's dependents (tutti-cxgo.1): asked for them, bd show runs with --include-dependents and
// the issue has `dependents`, each with how it links; asked for nothing, neither, as before. The
// worker view's whole ticket reads them, for what the ticket blocks.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { Beads, issueFor, type TicketId } from "../src/services/Beads.ts"
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
      { id: "t-2" as TicketId, type: "blocks" },
    ])
    expect(issue.parent).toBe("t-0" as TicketId)
  })

  test("the live layer asks for them only when told to", async () => {
    const fake = fakeBd()
    const asked = await live(
      fake,
      Effect.flatMap(Beads, (beads) => beads.show("t-1" as TicketId, { dependents: true })),
    )
    expect(fake.args()).toEqual(["show", "t-1", "--json", "--include-dependents"])
    expect(Exit.isSuccess(asked) && asked.value.dependents?.map((each) => each.id)).toEqual([
      "t-2" as TicketId,
    ])
    await live(
      fake,
      Effect.flatMap(Beads, (beads) => beads.show("t-1" as TicketId)),
    )
    expect(fake.args()).toEqual(["show", "t-1", "--json"])
  })

  test("the test layer gives the issues linked to it, as bd does", () => {
    const issue = Effect.runSync(
      Effect.flatMap(Beads, (beads) => beads.show("a" as TicketId, { dependents: true })).pipe(
        Effect.provide(
          backlogLayer([{ id: "a" }, { id: "b", blockedBy: ["a"] }, { id: "c", parent: "a" }]),
        ),
      ),
    )
    expect(issue.dependents?.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "b" as TicketId, type: "blocks" },
      { id: "c" as TicketId, type: "parent-child" },
    ])
    const plain = Effect.runSync(
      Effect.flatMap(Beads, (beads) => beads.show("a" as TicketId)).pipe(
        Effect.provide(backlogLayer([{ id: "a" }, { id: "b", blockedBy: ["a"] }])),
      ),
    )
    expect(plain.dependents).toBeUndefined()
  })

  test("bd ready counts them, without listing them", () => {
    const ready = Effect.runSync(
      Effect.flatMap(Beads, (beads) => beads.ready()).pipe(
        Effect.provide(backlogLayer([{ id: "a" }, { id: "b", blockedBy: ["a"] }])),
      ),
    )
    expect(
      ready.map(({ id, dependentCount, dependents }) => ({ id, dependentCount, dependents })),
    ).toEqual([{ id: "a" as TicketId, dependentCount: 1, dependents: undefined }])
    const decoded = Effect.runSync(
      issueFor(
        "t-1",
        "bd show t-1",
        JSON.stringify([{ id: "t-1", title: "One", status: "open", dependent_count: 2 }]),
      ),
    )
    expect(decoded.dependentCount).toBe(2)
  })
})
