#!/usr/bin/env bun
// tutti's entry point: the command line (src/cli/commands.ts). A bare `tutti` prints the version
// until the run is assembled.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { tutti } from "./cli/commands.ts"
import { tuttiVersion } from "./cli/version.ts"

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.flatMap(tuttiVersion, (version) => Command.run(tutti, { version })).pipe(
      // The command has said why on stderr.
      Effect.catchTag("CommandFailed", () =>
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
      Effect.provide(BunServices.layer),
    ),
  )
}
