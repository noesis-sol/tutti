// tutti login's live parts (§ 4.13, § 8.1): runInTerminal running a fake claude, a script in a
// temporary folder, on the terminal's stdin, stdout and stderr (test/fixtures/login/), the embedded
// Claude Code's lookup when there is none, and `bun src/main.ts login` with --claude naming a fake
// that fails, each problem a `tutti login:` line on stderr and exit 1.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Exit } from "effect"
import { embeddedVersion } from "../src/agent/claudeBinary.ts"
import { embeddedClaude, type LoginFailed, login, runInTerminal } from "../src/cli/login.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"

// Each test starts bun or a shell script, which bun's 5 s default fails beside other checks.
setDefaultTimeout(60_000)

const main = join(import.meta.dir, "..", "src", "main.ts")
const driver = join(import.meta.dir, "fixtures", "login", "run-in-terminal.ts")

/** A fresh folder for a test's own files. */
const folder = (): string => realpathSync(mkdtempSync(join(tmpdir(), "tutti-login-terminal-")))

/** An executable shell script `body` in `dir`, named claude: its path. */
const fakeClaude = (dir: string, body: string): string => {
  const path = join(dir, "claude")
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** `bun …args` started in `cwd` with `input` on its stdin: its exit code and output. */
const bun = async (
  cwd: string,
  args: ReadonlyArray<string>,
  input = "",
  env: Record<string, string> = {},
) => {
  const proc = Bun.spawn(["bun", ...args], {
    cwd,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...testEnv, ...env },
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("runInTerminal", () => {
  test("runs the command with its arguments on the terminal's stdio, and gives its exit code", async () => {
    const dir = folder()
    const claude = fakeClaude(
      dir,
      [
        `printf '%s\\n' "$@" > "${dir}/args"`,
        "echo 'Opening the browser'",
        "echo 'Paste the code:' >&2",
        "read -r code",
        'echo "read $code"',
        "exit 7",
      ].join("\n"),
    )
    const { code, stdout, stderr } = await bun(
      dir,
      [driver, claude, "auth", "login"],
      "the-pasted-code\n",
    )
    expect(readFileSync(join(dir, "args"), "utf8")).toBe("auth\nlogin\n")
    expect(stdout).toBe("Opening the browser\nread the-pasted-code\nexit 7\n")
    expect(stderr).toBe("Paste the code:\n")
    expect(code).toBe(0)
  })

  test("gives 0 for a command that succeeds", async () => {
    const dir = folder()
    const claude = fakeClaude(dir, "exit 0")
    const { stdout, stderr } = await bun(dir, [driver, claude, "auth", "login"])
    expect(stdout).toBe("exit 0\n")
    expect(stderr).toBe("")
  })

  const failure = (command: string) =>
    Effect.runPromise(
      runInTerminal({ command, args: ["auth", "login"] }).pipe(
        Effect.provide(BunServices.layer),
        Effect.flip,
      ),
    )

  test("fails with the reason a command that isn't there can't be started", async () => {
    const missing = join(folder(), "claude")
    const error = await failure(missing)
    expect(error._tag).toBe("LoginFailed")
    expect(error.problems).toHaveLength(1)
    expect(error.problems[0]).toStartWith(`couldn't run ${missing}: `)
    expect(error.problems[0]?.length).toBeGreaterThan(`couldn't run ${missing}: `.length)
  })

  test("fails with the reason a file that isn't executable can't be started", async () => {
    const dir = folder()
    const claude = join(dir, "claude")
    writeFileSync(claude, "#!/bin/sh\nexit 0\n")
    chmodSync(claude, 0o644)
    const error = await failure(claude)
    expect(error.problems).toHaveLength(1)
    expect(error.problems[0]).toStartWith(`couldn't run ${claude}: `)
  })
})

/** The package id of the platform package's Claude Code at `path`, as the SDK resolves it. */
const sdkClaudeId = (path: string): string => {
  const at = path.lastIndexOf("@anthropic-ai/")
  return path.slice(at)
}

describe("the embedded Claude Code's lookup", () => {
  const sdk = "@anthropic-ai/claude-agent-sdk"
  const platform = (): string => {
    const found = embeddedClaude()
    if (found === null) throw new Error("no platform package from source")
    return found
  }

  test("is none without the SDK", () => {
    expect(embeddedClaude("@anthropic-ai/no-such-sdk", [`${sdk}-darwin-arm64/claude`])).toBeNull()
  })

  test("is none where no platform package is installed, as in a source build without one", () => {
    expect(
      embeddedClaude(sdk, [`${sdk}-plan9-mips/claude`, `${sdk}-plan9-mips-musl/claude`]),
    ).toBeNull()
  })

  test("is the first platform package installed, past those that aren't", () => {
    const id = sdkClaudeId(platform())
    expect(embeddedClaude(sdk, [`${sdk}-plan9-mips/claude`, id])).toBe(platform())
  })

  test("with none, tutti login says so and runs nothing", () => {
    const ran: Array<string> = []
    const errors: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
    })
    const exit = Effect.runSync(
      login(
        (line) =>
          Effect.sync(() => {
            ran.push(line.command)
            return 0
          }),
        TestAccount.layer(),
        () => Effect.succeed({ path: null, warnings: [], problems: [] }),
        () => embeddedClaude(sdk, [`${sdk}-plan9-mips/claude`]),
      ).pipe(
        Effect.provide(TestAppConfig.layer(TestAppConfig.appConfig({ claude: null }))),
        Effect.provideService(Console.Console, console),
        Effect.exit,
      ),
    )
    expect(ran).toEqual([])
    expect(
      Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
        ? (exit.cause.reasons[0].error as LoginFailed).problems
        : [],
    ).toEqual(["no embedded Claude Code was found: run tutti login --claude <path>"])
  })
})

describe("tutti login", () => {
  /** `bun src/main.ts login …args` in a folder outside any repository, with its own home. */
  const tuttiLogin = (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
    const dir = folder()
    return bun(dir, [main, "login", ...args], "", {
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, ".config"),
      ...env,
    })
  }

  test("with --claude a Claude Code whose login fails, says its status and exits 1", async () => {
    const claude = fakeClaude(
      folder(),
      `if [ "$1" = --version ]; then echo "${embeddedVersion} (Claude Code)"; exit 0; fi\nexit 3`,
    )
    const { code, stdout, stderr } = await tuttiLogin(["--claude", claude])
    expect(stderr).toBe("tutti login: Claude Code's login exited with status 3\n")
    expect(stdout).toBe("")
    expect(code).toBe(1)
  })

  test("reads TUTTI_CLAUDE as --claude", async () => {
    const claude = fakeClaude(
      folder(),
      `if [ "$1" = --version ]; then echo "${embeddedVersion} (Claude Code)"; exit 0; fi\nexit 4`,
    )
    const { code, stderr } = await tuttiLogin([], { TUTTI_CLAUDE: claude })
    expect(stderr).toBe("tutti login: Claude Code's login exited with status 4\n")
    expect(code).toBe(1)
  })

  test("warns of a version it can't read, then runs the login all the same", async () => {
    const dir = folder()
    const claude = fakeClaude(
      dir,
      `if [ "$1" = --version ]; then echo "nightly"; exit 0; fi\ntouch "${dir}/ran"\nexit 2`,
    )
    const { code, stderr } = await tuttiLogin(["--claude", claude])
    const lines = stderr.trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toStartWith(
      `tutti login: couldn't read the version of the Claude Code at ${claude} (--claude) in its --version, "nightly"`,
    )
    expect(lines[1]).toBe("tutti login: Claude Code's login exited with status 2")
    expect(readFileSync(join(dir, "ran"), "utf8")).toBe("")
    expect(code).toBe(1)
  })

  test("with --claude a Claude Code that doesn't run, says why and runs no login", async () => {
    const dir = folder()
    const claude = fakeClaude(
      dir,
      `if [ "$1" = --version ]; then echo "broken" >&2; exit 5; fi\ntouch "${dir}/ran"\nexit 0`,
    )
    const { code, stdout, stderr } = await tuttiLogin(["--claude", claude])
    expect(stderr).toBe(
      `tutti login: The Claude Code at ${claude} (--claude) doesn't run: --version exited with 5: broken\n`,
    )
    expect(existsSync(join(dir, "ran"))).toBe(false)
    expect(stdout).toBe("")
    expect(code).toBe(1)
  })

  test("with --claude a command that isn't on PATH, says so", async () => {
    const { code, stderr } = await tuttiLogin(["--claude", "claude-nowhere"])
    expect(stderr).toBe(
      "tutti login: There is no claude-nowhere on PATH, for --claude claude-nowhere.\n",
    )
    expect(code).toBe(1)
  })
})
