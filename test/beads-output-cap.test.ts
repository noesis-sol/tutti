// bd's output past exec's cap (§ 3.3): only its last bytes are kept, so a read or a write's issue
// isn't decoded from them. bd exiting 0 fails as BeadsUnreadable saying the output ran past the
// cap, rather than "not JSON"; failing, it fails with bd's exit code.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import {
  Beads,
  BeadsFailed,
  BeadsUnreadable,
  beadsWhy,
  type TicketId,
} from "../src/services/Beads.ts"

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const cap = 64

/** A bd that prints `stdout` and exits with `code`, whatever it is asked. */
const fakeBd = (stdout: string, code = 0) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-beads-output-cap-"))
  writeFileSync(join(dir, "out"), stdout)
  const bin = join(dir, "bd")
  writeFileSync(bin, `#!/bin/sh\ncat '${join(dir, "out")}'\nexit ${code}\n`)
  chmodSync(bin, 0o755)
  return { dir, bin }
}

const withBd = <A, E>(
  fake: { dir: string; bin: string },
  use: (beads: Beads["Service"]) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.exit(
      Effect.flatMap(Beads, use).pipe(
        Effect.provide(
          Beads.layer({ cwd: fake.dir, command: fake.bin, maxOutputBytes: cap }).pipe(
            Layer.provide(BunServices.layer),
          ),
        ),
      ),
    ),
  )

const issue = (id: string) => ({ id, title: "T", status: "open" })
const list = (count: number) =>
  JSON.stringify(Array.from({ length: count }, (_, i) => issue(`t-${i}`)))

describe("bd's output past exec's cap", () => {
  test("a list within the cap is read whole", async () => {
    const exit = await withBd(fakeBd(list(1)), (beads) => beads.list({ all: true }))
    expect(Exit.isSuccess(exit) && exit.value.map((one) => one.id)).toEqual(["t-0" as TicketId])
  })

  test("a list past the cap fails saying so, not as JSON it can't read", async () => {
    const fake = fakeBd(list(20))
    const reads: ReadonlyArray<(beads: Beads["Service"]) => Effect.Effect<unknown, unknown>> = [
      (beads) => beads.list({ all: true }),
      (beads) => beads.ready(),
      (beads) => beads.show("t-0" as TicketId),
    ]
    for (const read of reads) {
      const error = failure(await withBd(fake, read))
      expect(error).toBeInstanceOf(BeadsUnreadable)
      expect(beadsWhy(error as BeadsUnreadable)).toBe(
        `bd's output ran past ${cap} bytes, and only the last were kept`,
      )
    }
  })

  test("an output whose last bytes are JSON on their own isn't read as bd's answer", async () => {
    // Without the guard, the kept tail "   …[]" decodes as an empty list.
    const exit = await withBd(fakeBd(`${" ".repeat(cap)}[]`), (beads) => beads.list({ all: true }))
    expect(failure(exit)).toBeInstanceOf(BeadsUnreadable)
  })

  test("a failed read past the cap still fails with bd's exit code", async () => {
    const exit = await withBd(fakeBd(list(20), 3), (beads) => beads.list({ all: true }))
    const error = failure(exit)
    expect(error).toBeInstanceOf(BeadsFailed)
    expect(error).toMatchObject({ exitCode: 3 })
  })

  test("a write whose issue runs past the cap fails saying so", async () => {
    const big = JSON.stringify({ ...issue("t-1"), description: "x".repeat(cap) })
    const exit = await withBd(fakeBd(big), (beads) => beads.create({ title: "T" }))
    const error = failure(exit)
    expect(error).toBeInstanceOf(BeadsUnreadable)
    expect(beadsWhy(error)).toContain(`ran past ${cap} bytes`)
  })
})
