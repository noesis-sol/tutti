// The service methods at process and I/O boundaries carry their names as spans (Effect.fn): bd's
// calls through Beads, and the run's state through Store.update.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Effect, Layer, Tracer } from "effect"
import { Beads } from "../src/services/Beads.ts"
import { Store } from "../src/services/Store.ts"

/** A tracer that records the name of every span it starts. */
const recording = () => {
  const names: Array<string> = []
  const tracer = Tracer.make({
    span: (options) => {
      names.push(options.name)
      return new Tracer.NativeSpan(options)
    },
  })
  return { names, tracer }
}

describe("the boundaries' spans", () => {
  test("a bd call is a span named for the Beads method, though it fails", async () => {
    const { names, tracer } = recording()
    const dir = mkdtempSync(join(tmpdir(), "tutti-spans-"))
    await Effect.runPromise(
      Effect.flatMap(Beads, (beads) => Effect.ignore(beads.list())).pipe(
        Effect.withTracer(tracer),
        Effect.provide(
          Beads.layer({ cwd: dir, command: join(dir, "no-bd") }).pipe(
            Layer.provide(BunServices.layer),
          ),
        ),
      ),
    )
    expect(names).toContain("Beads.list")
  })

  test("a write of the run's state is a span named Store.update", async () => {
    const { names, tracer } = recording()
    const repo = mkdtempSync(join(tmpdir(), "tutti-spans-"))
    await Effect.runPromise(
      Effect.flatMap(Store, (store) => store.update((state) => state)).pipe(
        Effect.withTracer(tracer),
        Effect.provide(
          Store.layer({
            repo,
            run: { pid: 4242, started: "2026-10-25T08:00:00Z", version: "0.1.0" },
          }).pipe(Layer.provide(BunFileSystem.layer)),
        ),
      ),
    )
    expect(names).toContain("Store.update")
  })
})
