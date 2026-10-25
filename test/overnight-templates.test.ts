// --overnight's templates fix (src/run/overnight.ts's updateAndCommit; tutti-kkb.46), on real git:
// the worker prompt brought up to date as tutti init --update does, committed on the branch the main
// checkout has checked out, the run's base, and read again for the run's workers; the START block's
// note of it gone.
import { expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { noServersNote } from "../src/agent/mcp.ts"
import { templateNotes } from "../src/init/templates.ts"
import { readConfigFile } from "../src/project/configFile.ts"
import { Settings } from "../src/project/settings.ts"
import { updateAndCommit, updateTemplatesMessage } from "../src/run/overnight.ts"
import type { Started } from "../src/run/startup.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

slow.describe("the templates fix", () => {
  slow.test(
    "brings the worker prompt up to date, commits it on the base, and reads it again",
    async () => {
      const repo = makeRepo()
      const old = readFileSync(
        join(import.meta.dir, "fixtures", "templates", "worker-prompt-2026-10-17.md"),
        "utf8",
      )
      repo.commit("Set up tutti", {
        ".tutti/worker-prompt.md": old,
        ".tutti/settings.json": `${JSON.stringify({ concurrent: 2 }, null, 2)}\n`,
      })
      const before = repo.head()
      const settings = await run(
        readConfigFile(Settings, join(repo.dir, ".tutti", "settings.json")),
      )
      const notes = await run(templateNotes(repo.dir, settings.templates, true))
      expect(notes.length).toBeGreaterThan(0)
      const config = TestAppConfig.appConfig({ settings }, repo.dir)
      const started: Started = {
        config,
        base: "main",
        prompt: { text: old, file: join(repo.dir, ".tutti", "worker-prompt.md") },
        mcp: { servers: [], note: noServersNote },
        account: TestAccount.accountProbe(config),
        organs: { _tag: "AgentSdk" },
        warnings: ["another warning", ...notes],
      }
      const git = Git.layer().pipe(Layer.provideMerge(GitWriter.layer))
      const after = await run(
        (
          updateAndCommit(started) as Effect.Effect<Started, string, Git | BunServices.BunServices>
        ).pipe(Effect.provide(git)),
      )
      // One commit on main, holding the files the update rewrote, and nothing left uncommitted.
      expect(repo.git(["rev-parse", "HEAD~1"]).trim()).toBe(before)
      expect(repo.git(["log", "-1", "--format=%B"]).trim()).toBe(updateTemplatesMessage)
      expect(repo.git(["status", "--porcelain"])).toBe("")
      const committed = repo.git(["show", "--name-only", "--format=", "HEAD"]).trim().split("\n")
      expect(committed).toContain(".tutti/worker-prompt.md")
      // The run's workers follow the prompt committed, and the START block no longer notes it.
      const now = readFileSync(join(repo.dir, ".tutti", "worker-prompt.md"), "utf8")
      expect(now).not.toBe(old)
      expect(after.prompt.text).toBe(now)
      expect(after.warnings).toEqual(["another warning"])
    },
  )
})
