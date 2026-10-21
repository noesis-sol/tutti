// bd answers an ID it has no issue for with an issue whose ID starts with it (a deleted ticket's
// follow-up, say), and its writes act on that issue (bd 1.3.1). The live layer takes such an answer
// for bd having no such issue, and writes nothing to bd for it, as orchestra 0.8.5 does.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import { Beads, type BeadsError, beadsWhy, issueFor } from "../src/services/Beads.ts"
import { machineWhich } from "./env.ts"
import { slow } from "./gates.ts"

/**
 * A stand-in for bd with the issues `ids`, answering bd show as bd does: the issue by the ID, or else
 * the first whose ID starts with it. Every call is logged, one line each.
 */
const prefixBd = (ids: ReadonlyArray<string>) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-beads-prefix-"))
  const bin = join(dir, "bd")
  const issue = `{"id":"%s","title":"T","status":"open"}`
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> '${dir}/calls'
ids='${ids.join(" ")}'
if [ "$1" = show ]; then
  for id in $ids; do
    if [ "$id" = "$2" ]; then printf '[${issue}]' "$id"; exit 0; fi
  done
  for id in $ids; do
    case "$id" in "$2"*) printf '[${issue}]' "$id"; exit 0;; esac
  done
  echo '{"error":"no issues found matching the provided IDs"}'
  exit 1
fi
case "$1" in
  create) printf '${issue}' new-1 ;;
  dep) echo '[]' ;;
  *) printf '${issue}' "$2" ;;
esac
`,
  )
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, "calls"), "")
  return {
    dir,
    bin,
    calls: () => readFileSync(join(dir, "calls"), "utf8").trimEnd().split("\n").filter(Boolean),
  }
}

const live = <A>(
  fake: { readonly dir: string; readonly bin: string },
  f: (beads: Beads["Service"]) => Effect.Effect<A, BeadsError>,
) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(
        Effect.flatMap(Beads, f),
        Beads.layer({ cwd: fake.dir, command: fake.bin }).pipe(Layer.provide(BunServices.layer)),
      ),
    ),
  )

/** The typed failure of the exit, or what it gave instead. */
const failureOf = <A>(exit: Exit.Exit<A, BeadsError>): BeadsError | string => {
  if (Exit.isSuccess(exit)) return `succeeded with ${JSON.stringify(exit.value)}`
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  return reason === undefined ? `${exit.cause}` : reason.error
}

const notFound = (error: BeadsError | string) =>
  typeof error !== "string" && error._tag === "BeadsFailed" && error.noSuchIssue

/** The calls that aren't bd show: what the layer wrote to bd. */
const writes = (calls: ReadonlyArray<string>) => calls.filter((call) => !call.startsWith("show "))

describe("bd's prefix match for an ID it has no issue for", () => {
  test("show takes another ID for bd having no such ticket", async () => {
    const fake = prefixBd(["t-x.1"])
    const error = failureOf(await live(fake, (beads) => beads.show("t-x")))
    expect(notFound(error)).toBe(true)
    expect(typeof error !== "string" && beadsWhy(error)).toBe(
      "bd has no such ticket: bd show t-x --json gave t-x.1, another ticket",
    )
  })

  test("show still gives the issue by the ID, beside the ones it prefixes", async () => {
    const fake = prefixBd(["t-x.1", "t-x"])
    const exit = await live(fake, (beads) => beads.show("t-x"))
    expect(Exit.isSuccess(exit) && exit.value.id).toBe("t-x")
  })

  test("the metadata and links of a deleted ticket are not found either", async () => {
    const fake = prefixBd(["t-x.1"])
    expect(notFound(failureOf(await live(fake, (beads) => beads.metadata("t-x"))))).toBe(true)
    expect(notFound(failureOf(await live(fake, (beads) => beads.dependencies("t-x"))))).toBe(true)
    expect(writes(fake.calls())).toEqual([])
  })

  test("nothing is written to bd for a deleted ticket", async () => {
    const fake = prefixBd(["t-x.1"])
    const attempts: ReadonlyArray<(beads: Beads["Service"]) => Effect.Effect<unknown, BeadsError>> =
      [
        (beads) => beads.update("t-x", { appendNotes: "a note" }),
        (beads) => beads.update("t-x", { status: "open" }),
        (beads) => beads.close("t-x", "done"),
        (beads) => beads.defer("t-x", { reason: "later" }),
        (beads) => beads.addLabel("t-x", "solo"),
        (beads) => beads.removeLabel("t-x", "solo"),
        (beads) => beads.setMetadata("t-x", "files", "a.ts"),
        (beads) => beads.unsetMetadata("t-x", "files"),
        (beads) => beads.addDependency("t-x", "t-x.1"),
        (beads) => beads.addDependency("t-x.1", "t-x"),
      ]
    for (const attempt of attempts) {
      expect(notFound(failureOf(await live(fake, attempt)))).toBe(true)
    }
    expect(writes(fake.calls())).toEqual([])
  })

  test("filing under a deleted parent, or linked to a deleted ticket, files nothing", async () => {
    const fake = prefixBd(["t-x.1", "t-y"])
    for (const link of [
      { parent: "t-x" },
      { blockedBy: ["t-y", "t-x"] },
      { blocks: ["t-x"] },
      { discoveredFrom: ["t-x"] },
    ]) {
      const error = failureOf(await live(fake, (beads) => beads.create({ title: "T", ...link })))
      expect(notFound(error)).toBe(true)
      expect(typeof error !== "string" && beadsWhy(error)).toStartWith("bd has no such ticket")
    }
    expect(writes(fake.calls())).toEqual([])
  })

  test("a write to a ticket bd has goes ahead, after a show of each ID", async () => {
    const fake = prefixBd(["t-x.1", "t-y"])
    expect(Exit.isSuccess(await live(fake, (beads) => beads.addLabel("t-x.1", "solo")))).toBe(true)
    const filed = await live(fake, (beads) =>
      beads.create({ title: "T", parent: "t-y", blockedBy: ["t-x.1"] }),
    )
    expect(Exit.isSuccess(filed) && filed.value.id).toBe("new-1")
    expect(fake.calls()).toEqual([
      "show t-x.1 --json",
      "label add t-x.1 solo --json",
      "show t-y --json",
      "show t-x.1 --json",
      "create --json --title=T --parent=t-y --deps=blocked-by:t-x.1",
    ])
  })

  test("a checked filing shows nothing first", async () => {
    const fake = prefixBd(["t-y"])
    await live(fake, (beads) => beads.create({ title: "T", parent: "t-y", checked: true }))
    await live(fake, (beads) => beads.addDependency("t-y", "t-z", "blocks", { checked: true }))
    expect(fake.calls()).toEqual([
      "create --json --title=T --parent=t-y",
      "dep add t-y t-z --json --type=blocks",
    ])
  })

  test("a show that fails otherwise leaves the write to bd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-beads-prefix-"))
    const bin = join(dir, "bd")
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$*" >> '${dir}/calls'\n[ "$1" = show ] && { echo 'database locked' >&2; exit 1; }\necho '{"id":"t-1","title":"T","status":"closed"}'\n`,
    )
    chmodSync(bin, 0o755)
    const exit = await live({ dir, bin }, (beads) => beads.close("t-1"))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(readFileSync(join(dir, "calls"), "utf8").trimEnd().split("\n")).toEqual([
      "show t-1 --json",
      "close t-1 --json",
    ])
  })

  test("issueFor: an answer by any ID that only starts with the one asked is not found", () => {
    const word = fc.stringMatching(/^[a-z0-9.-]{1,12}$/)
    fc.assert(
      fc.property(word, word, (id, rest) => {
        const other = `${id}${rest}`
        const stdout = JSON.stringify([{ id: other, title: "T", status: "open" }])
        const exit = Effect.runSyncExit(issueFor(id, `bd show ${id} --json`, stdout))
        expect(notFound(failureOf(exit))).toBe(true)
        const asked = Effect.runSyncExit(issueFor(other, `bd show ${other} --json`, stdout))
        expect(Exit.isSuccess(asked) && asked.value.id).toBe(other)
      }),
    )
  })
})

// The machine's bd, which the tests' PATH leaves out (test/env.ts).
const bd = machineWhich("bd")

describe("against a real bd", () => {
  ;(bd !== null ? slow.test : test.skip)(
    "a deleted parent is not taken for its subticket",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tutti-bd-prefix-"))
      const sh = (...cmd: Array<string>) => {
        const result = Bun.spawnSync(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`)
        return result.stdout.toString()
      }
      const real = bd ?? "bd"
      // bd's v2 envelope, or the bare issue.
      const idOf = (output: string): string => {
        const json = JSON.parse(output)
        return (json.data ?? json).id
      }
      sh("git", "init", "-q")
      sh(real, "init", "--quiet", "--prefix", "pm", "--skip-hooks", "--skip-agents")
      const parent = idOf(sh(real, "create", "--json", "--title=Parent"))
      const child = idOf(sh(real, "create", "--json", "--title=Child", `--parent=${parent}`))
      sh(real, "delete", parent, "--force")
      const fake = { dir, bin: real }
      expect(notFound(failureOf(await live(fake, (beads) => beads.show(parent))))).toBe(true)
      expect(notFound(failureOf(await live(fake, (beads) => beads.addLabel(parent, "x"))))).toBe(
        true,
      )
      const filed = failureOf(await live(fake, (beads) => beads.create({ title: "Under", parent })))
      expect(notFound(filed)).toBe(true)
      const left = await live(fake, (beads) =>
        Effect.all([beads.show(child), beads.list({ all: true })]),
      )
      if (Exit.isFailure(left)) throw new Error(`${left.cause}`)
      const [shown, all] = left.value
      expect(shown.labels).toEqual([])
      expect(all.map((issue) => issue.id)).toEqual([child])
    },
    120_000,
  )
})
