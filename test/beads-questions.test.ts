import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { Beads, BeadsUnreadable, decodeQuestions, type TicketId } from "../src/services/Beads.ts"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/bd", name), "utf8")

/** The questions bd's output decodes to, by ID, or the error it gives. */
const questions = (stdout: string) => {
  const exit = Effect.runSyncExit(decodeQuestions("bd human list", stdout))
  return Exit.isSuccess(exit) ? exit.value.map((issue) => issue.id) : exit
}

describe("decoding bd human list --json", () => {
  test("bd's null, with or without its envelope, is no questions", () => {
    expect(questions("null\n")).toEqual([])
    expect(questions('{"data": null}\n')).toEqual([])
  })

  test("a list is its questions, an empty one none", () => {
    expect(questions("[]\n")).toEqual([])
    expect(questions(fixture("human-list.json"))).toEqual(["demo-n0n" as TicketId])
  })

  test("output that is neither null nor a list of issues is BeadsUnreadable", () => {
    for (const output of ["", "not json", "{}", "0", '"null"', '[{"id": 1}]', "[null]"]) {
      const exit = Effect.runSyncExit(decodeQuestions("bd human list", output))
      if (Exit.isSuccess(exit)) throw new Error(`${JSON.stringify(output)} decoded`)
      const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      expect(error?._tag === "Fail" ? error.error : undefined).toBeInstanceOf(BeadsUnreadable)
    }
  })
})

describe("Beads.questions", () => {
  test("is [] when bd human list --json prints null and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-beads-questions-"))
    const bin = join(dir, "bd")
    writeFileSync(bin, "#!/bin/sh\necho null\n")
    chmodSync(bin, 0o755)
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Beads, (beads) => beads.questions()),
        Beads.layer({ cwd: dir, command: bin }).pipe(Layer.provide(BunServices.layer)),
      ),
    )
    expect(result).toEqual([])
  })
})
