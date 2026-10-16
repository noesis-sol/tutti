#!/usr/bin/env bun
// tutti's entry point: the command line (src/cli/commands.ts). A bare `tutti` prints the version
// until the run is assembled.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { tutti } from "./cli/commands.ts"

export const version: string = pkg.version

if (import.meta.main) {
  BunRuntime.runMain(Command.run(tutti, { version }).pipe(Effect.provide(BunServices.layer)))
}
