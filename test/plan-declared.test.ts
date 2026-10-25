// tutti plan links two tickets over a function only when the repository declares it (tutti-wa23),
// as a run's scheduler holds them apart (tutti-ejkt.3): a library or everyday name both tickets
// mention (Effect.fn, JSON.stringify) links nothing.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { tuttiWith } from "../src/cli/commands.ts"
import type { Beads } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import type { RunLock } from "../src/services/RunLock.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { layer as lockLayer } from "../src/testing/RunLock.ts"

/** Runs `tutti plan` in a checkout of `files`, on disk and in git, with the backlog `seeds`. */
const plan = (files: Readonly<Record<string, string>>, seeds: ReadonlyArray<Seed>) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-plan-declared-")))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  const printed: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
    error: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Effect.context<Beads | Git | RunLock>()
      yield* Command.runWith(
        tuttiWith(Effect.succeed(dir), () => Layer.succeedContext(services)),
        { version: "test", renderErrors: false },
      )(["plan"]).pipe(Effect.provideService(Console.Console, console), Effect.ignore)
      return printed
    }).pipe(
      Effect.provide(Layer.mergeAll(beadsLayer(seeds), gitLayer({ dir, files }), lockLayer())),
      Effect.provide(BunServices.layer),
    ),
  )
}

const files = {
  "src/run/loop.ts": [
    'import { Effect } from "effect"',
    "export class Loop {",
    "  merge(id: string) {",
    "    return JSON.stringify(id)",
    "  }",
    "}",
    "export const waitSettled = Effect.fn('waitSettled')(function* () {})",
  ].join("\n"),
  "README.md": "# tutti\nCall waitSettled, or wrap a function in Effect.fn.\n",
}

describe("tutti plan over declared functions", () => {
  test("links no tickets over functions the repository doesn't declare", async () => {
    const printed = await plan(files, [
      { id: "t-1", priority: 1, description: "Report the totals with `JSON.stringify`." },
      { id: "t-2", priority: 2, description: "Log each wake with JSON.stringify()." },
      { id: "t-3", priority: 1, description: "Trace the check with `Effect.fn`." },
      { id: "t-4", priority: 2, description: "Wrap the merge step in Effect.fn()." },
    ])
    expect(printed).toEqual([
      "No links to add: no two of the 4 open tickets touch the same code without being ordered already.",
    ])
  })

  test("links tickets over a function or a method the repository declares", async () => {
    const printed = await plan(files, [
      { id: "t-1", priority: 1, description: "Retry in `Loop.merge`, with `JSON.stringify`." },
      {
        id: "t-2",
        priority: 2,
        description: "Log each rebase in Loop.merge(), via JSON.stringify.",
      },
      { id: "t-3", priority: 1, description: "Time out `waitSettled`." },
      { id: "t-4", priority: 2, description: "Log in waitSettled()." },
    ])
    expect(printed).toEqual([
      "Proposed 2 blocks links between the 4 open tickets:",
      "  t-2 (P2) waits for t-1 (P1): both touch Loop.merge",
      "  t-4 (P2) waits for t-3 (P1): both touch waitSettled",
      "Nothing changed. Add them with: tutti plan --apply",
    ])
  })
})
