#!/usr/bin/env bun
// tutti's entry point. For now it prints the version from package.json and exits 0;
// the command line (src/cli/) replaces this body.
import { BunRuntime } from "@effect/platform-bun"
import { Console } from "effect"
import pkg from "../package.json" with { type: "json" }

export const version: string = pkg.version

if (import.meta.main) {
  BunRuntime.runMain(Console.log(version))
}
