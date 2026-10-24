import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, Option, Result } from "effect"
import {
  type AppConfigValue,
  defaultSettings,
  defaultUserConfig,
  load,
  resolve,
} from "../src/cli/AppConfig.ts"
import { noFlags, type RunFlagName } from "../src/cli/flags.ts"
import { live } from "../src/run/startup.ts"

const repo = "/work/project"
const sub = "/work/project/sub"

const configOf = (
  flags: Partial<Record<RunFlagName, string>>,
  env: Record<string, string> = {},
  cwd: string | null = sub,
): AppConfigValue => {
  const resolved = resolve({
    repo,
    ...(cwd === null ? {} : { cwd }),
    flags: {
      ...noFlags,
      ...Object.fromEntries(Object.entries(flags).map(([key, text]) => [key, Option.some(text)])),
    },
    env: (name) => env[name],
    user: defaultUserConfig,
    settings: defaultSettings,
  })
  if (Result.isFailure(resolved)) throw new Error(`expected a config, got ${resolved.failure}`)
  return resolved.success
}

describe("a flag's relative path is taken from the folder tutti was started in", () => {
  test("--prompt, --worktrees and --claude all from it", () => {
    const config = configOf({
      prompt: "./p.md",
      worktrees: "../../trees",
      claude: "bin/claude",
    })
    expect(config.prompt).toBe(join(sub, "p.md"))
    expect(config.worktrees).toBe("/work/trees")
    expect(config.claude).toBe(join(sub, "bin", "claude"))
  })

  test("from a linked worktree beside the main checkout", () => {
    const config = configOf({ prompt: "../x.md" }, {}, "/work/project-tutti/t-1")
    expect(config.prompt).toBe("/work/project-tutti/x.md")
  })

  test("an absolute path and a command name stay as they are", () => {
    const config = configOf({ prompt: "/p.md", worktrees: "/trees", claude: "claude" })
    expect(config.prompt).toBe("/p.md")
    expect(config.worktrees).toBe("/trees")
    expect(config.claude).toBe("claude")
  })

  test("the worktrees must still be outside the repository", () => {
    const resolved = resolve({
      repo,
      cwd: sub,
      flags: { ...noFlags, worktrees: Option.some("trees") },
      env: () => undefined,
      user: defaultUserConfig,
      settings: defaultSettings,
    })
    expect(resolved).toEqual(
      Result.fail([
        "--worktrees (or TUTTI_WORKTREES) (/work/project/sub/trees) must be outside the repository, or git sees the worktrees as untracked files.",
      ]),
    )
  })

  test("without a folder given, from the repository", () => {
    const config = configOf({ prompt: "p.md", claude: "./claude" }, {}, null)
    expect(config.prompt).toBe(join(repo, "p.md"))
    expect(config.claude).toBe(join(repo, "claude"))
  })
})

describe("a variable's relative path is taken from the main checkout", () => {
  test("TUTTI_PROMPT, TUTTI_WORKTREES and TUTTI_CLAUDE", () => {
    const config = configOf(
      {},
      { TUTTI_PROMPT: "p.md", TUTTI_WORKTREES: "../trees", TUTTI_CLAUDE: "./bin/claude" },
    )
    expect(config.prompt).toBe(join(repo, "p.md"))
    expect(config.worktrees).toBe("/work/trees")
    expect(config.claude).toBe(join(repo, "bin", "claude"))
  })

  test("a flag over its variable is taken from the folder tutti was started in", () => {
    const config = configOf({ prompt: "p.md" }, { TUTTI_PROMPT: "q.md" })
    expect(config.prompt).toBe(join(sub, "p.md"))
  })

  test("the default worker prompt is the main checkout's", () => {
    expect(configOf({}).prompt).toBe(join(repo, ".tutti", "worker-prompt.md"))
  })
})

describe("a run's configuration", () => {
  test("takes its flags' paths from the folder it was started in, its variables' from the project", async () => {
    const project = mkdtempSync(join(tmpdir(), "tutti-flag-paths-"))
    const xdg = mkdtempSync(join(tmpdir(), "tutti-xdg-"))
    const started = join(project, "sub")
    const exit = await Effect.runPromise(
      Effect.exit(
        load({ ...noFlags, prompt: Option.some("p.md") }, project, started).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { TUTTI_CLAUDE: "bin/claude", XDG_CONFIG_HOME: xdg, HOME: "/nowhere" },
              }),
            ),
          ),
          Effect.provide(BunServices.layer),
        ),
      ),
    )
    if (!Exit.isSuccess(exit)) throw new Error(`expected a config, got ${exit.cause}`)
    expect(exit.value.prompt).toBe(join(started, "p.md"))
    expect(exit.value.claude).toBe(join(project, "bin", "claude"))
  })

  test("as a run's startup checks read it, from the folder the run was started in", async () => {
    const project = mkdtempSync(join(tmpdir(), "tutti-flag-paths-"))
    const xdg = mkdtempSync(join(tmpdir(), "tutti-xdg-"))
    const started = join(project, "sub")
    const exit = await Effect.runPromise(
      Effect.exit(
        live(started, { ...noFlags, worktrees: Option.some("../../trees") })
          .config(project)
          .pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: xdg, HOME: "/nowhere" } }),
              ),
            ),
            Effect.provide(BunServices.layer),
          ),
      ),
    )
    if (!Exit.isSuccess(exit)) throw new Error(`expected a config, got ${exit.cause}`)
    expect(exit.value.worktrees).toBe(join(project, "..", "trees"))
  })
})
