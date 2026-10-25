// Beads.respond (src/services/Beads.ts), --auto-answer's answer to a question ticket: bd human
// respond with the response as one argument, after bd shows the question, as each write does,
// judged by its exit code.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { Beads, BeadsFailed, type TicketId } from "../src/services/Beads.ts"

const show = join(import.meta.dir, "fixtures/bd", "show-b.json")

/** A bd that shows the fixture's issue, logs every other call's arguments and exits `code`. */
const fakeBd = (code: number) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-beads-respond-"))
  const bin = join(dir, "bd")
  const log = join(dir, "calls")
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `if [ "$1" = show ]; then cat '${show}'; exit 0; fi`,
      `for arg in "$@"; do printf '%s\\n' "$arg" >> '${log}'; done`,
      `exit ${code}`,
    ].join("\n"),
  )
  chmodSync(bin, 0o755)
  return { dir, bin, log }
}

const respond = (bd: ReturnType<typeof fakeBd>, response: string) =>
  Effect.runPromiseExit(
    Effect.provide(
      Effect.flatMap(Beads, (beads) => beads.respond("demo-mtp.2" as TicketId, response)),
      Beads.layer({ cwd: bd.dir, command: bd.bin }).pipe(Layer.provide(BunServices.layer)),
    ),
  )

describe("Beads.respond", () => {
  test("runs bd human respond with the response whole, as one argument", async () => {
    const bd = fakeBd(0)
    const response = 'SQLite (the recommended option, chosen by "tutti --auto-answer")'
    const exit = await respond(bd, response)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(readFileSync(bd.log, "utf8").split("\n")).toEqual([
      "human",
      "respond",
      "demo-mtp.2",
      `--response=${response}`,
      "--json",
      "",
    ])
  })

  test("fails BeadsFailed when bd exits other than 0", async () => {
    const exit = await respond(fakeBd(1), "A")
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    expect(error?._tag === "Fail" ? error.error : undefined).toBeInstanceOf(BeadsFailed)
  })
})
