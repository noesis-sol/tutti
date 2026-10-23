// tutti started from a git hook, a `rebase --exec` or a shell that exports GIT_DIR has git's local
// variables in its environment: the git commands, checks and workers it starts go without them, so
// git in a worktree acts on that worktree, not on the repository they name (tutti-m6hh). The rest of
// git's variables, the user's own configuration, stay.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, Option } from "effect"
import { workerEnv } from "../src/agent/env.ts"
import { type Command, exec } from "../src/services/exec.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { gitLocalVariable, gitLocalVariables, withoutGitLocal } from "../src/services/gitEnv.ts"
import { machineWhich, withVariable } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Real processes, and real git in the slow test.
setDefaultTimeout(30_000)

const sh = (script: string, more: Partial<Command> = {}): Command => ({
  command: "sh",
  args: ["-c", script],
  timeLimit: "10 seconds",
  ...more,
})

const stdout = async (command: Command): Promise<string> => {
  const exit = await Effect.runPromise(
    Effect.exit(Effect.provide(exec(command), BunServices.layer)),
  )
  if (Exit.isFailure(exit)) throw new Error(`exec failed: ${exit.cause}`)
  return exit.value.stdout
}

describe("git's local variables", () => {
  test("are the ones git rev-parse --local-env-vars prints", () => {
    const git = machineWhich("git")
    if (git === null) return
    const printed = Bun.spawnSync([git, "rev-parse", "--local-env-vars"]).stdout.toString()
    const names = printed.split("\n").filter((name) => name !== "")
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(gitLocalVariables.has(name)).toBe(true)
  })

  test("withoutGitLocal drops them and unset variables, and lays its own over the rest", () => {
    expect(
      withoutGitLocal(
        {
          GIT_DIR: "/elsewhere/.git",
          GIT_WORK_TREE: "/elsewhere",
          GIT_INDEX_FILE: "/elsewhere/.git/index",
          GIT_AUTHOR_NAME: "Someone",
          GIT_SSH_COMMAND: "ssh -i key",
          HOME: "/home/someone",
          UNSET: undefined,
        },
        { GIT_TERMINAL_PROMPT: "0", HOME: "/home/other" },
      ),
    ).toEqual({
      GIT_AUTHOR_NAME: "Someone",
      GIT_SSH_COMMAND: "ssh -i key",
      HOME: "/home/other",
      GIT_TERMINAL_PROMPT: "0",
    })
    expect(gitLocalVariable("GIT_COMMON_DIR")).toBe(true)
    expect(gitLocalVariable("GIT_EDITOR")).toBe(false)
  })

  test("a worker's environment goes without them, and keeps git's others", () => {
    const env = workerEnv({
      subscription: true,
      billing: "subscription",
      env: {
        PATH: "/usr/bin",
        GIT_DIR: "/elsewhere/.git",
        GIT_WORK_TREE: "/elsewhere",
        GIT_INDEX_FILE: "/elsewhere/.git/index",
        GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
        GIT_AUTHOR_EMAIL: "someone@example.invalid",
      },
    })
    for (const name of gitLocalVariables) expect(env[name]).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
    expect(env.GIT_AUTHOR_EMAIL).toBe("someone@example.invalid")
  })

  test("a command exec runs goes without tutti's, and gets those it is given", async () => {
    const script = 'echo "${GIT_DIR-unset} ${GIT_WORK_TREE-unset} ${TUTTI_EXEC_KEPT-unset}"'
    const out = await withVariable("GIT_DIR", "/elsewhere/.git", () =>
      withVariable("GIT_WORK_TREE", "/elsewhere", () =>
        withVariable("TUTTI_EXEC_KEPT", "kept", () => stdout(sh(script))),
      ),
    )
    expect(out).toBe("unset unset kept\n")
    const given = await withVariable("GIT_DIR", "/elsewhere/.git", () =>
      stdout(sh(script, { env: { GIT_DIR: "/given/.git" } })),
    )
    expect(given).toBe("/given/.git unset unset\n")
  })

  slow.test("git in a worktree acts on the worktree while GIT_DIR names the main one", async () => {
    const repo = makeRepo()
    const worktree = repo.worktree("tutti/a")
    const layer = Git.layer().pipe(
      Layer.provideMerge(GitWriter.layer),
      Layer.provideMerge(BunServices.layer),
    )
    const branch = await withVariable("GIT_DIR", `${repo.dir}/.git`, () =>
      withVariable("GIT_WORK_TREE", repo.dir, () =>
        Effect.runPromise(
          Effect.provide(
            Effect.flatMap(Effect.service(Git), (git) => git.currentBranch(worktree)),
            layer,
          ),
        ),
      ),
    )
    expect(branch).toEqual(Option.some("tutti/a"))
  })
})
