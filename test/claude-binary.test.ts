import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract"
import { BunServices } from "@effect/platform-bun"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option } from "effect"
import fc from "fast-check"
import { Account, NotLoggedIn } from "../src/agent/Account.ts"
import {
  type Claude,
  embeddedVersion,
  parseVersion,
  rangeFrom,
  resolveClaude,
  resolveWith,
  type Sources,
  supportedRange,
  versionWarning,
} from "../src/agent/claudeBinary.ts"
import { AppConfig } from "../src/cli/AppConfig.ts"
import { check, type Started, type StartupFailed } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestGit from "../src/testing/Git.ts"

const root = join(import.meta.dir, "..")

// resolveClaude's tests start processes: a fake Claude Code's --version, a bun. Under load they
// outlast bun's 5 s default, whose timeout kills them with SIGTERM: "--version exited with 143".
setDefaultTimeout(30_000)

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-${name}-`)))

/** A stand-in Claude Code: a script that prints `version` as `claude --version` does. */
const fakeClaude = (dir: string, version: string, name = "claude") => {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\necho '${version} (Claude Code)'\n`)
  chmodSync(file, 0o755)
  return file
}

/** Sources that find nothing embedded and no command on PATH, with `overrides`. */
const sources = (overrides: Partial<Sources<never>> = {}): Sources<never> => ({
  cwd: "/work/project",
  embedded: null,
  extract: () => {
    throw new Error("nothing is embedded")
  },
  tidy: () => {},
  which: () => null,
  version: () => Effect.succeed(`${embeddedVersion} (Claude Code)`),
  ...overrides,
})

const resolved = (given: string | null, from: Sources<never>) =>
  Effect.runPromise(resolveWith(given, from))

describe("the Claude Code version", () => {
  test("is read from claude --version", () => {
    expect(parseVersion("2.1.301 (Claude Code)")).toEqual(
      Option.some({ major: 2, minor: 1, patch: 301 }),
    )
    expect(parseVersion("Claude Code v2.1.302\n")).toEqual(
      Option.some({ major: 2, minor: 1, patch: 302 }),
    )
    expect(parseVersion("claude: command not found")).toEqual(Option.none())
    expect(parseVersion("1.2.3.4")).toEqual(Option.none())
  })

  test("any x.y.z among other words is read back", () => {
    const part = fc.integer({ min: 0, max: 99_999 })
    const word = fc.string().map((s) => s.replace(/[\d.]/g, ""))
    fc.assert(
      fc.property(part, part, part, word, word, (major, minor, patch, before, after) => {
        const text = `${before} ${major}.${minor}.${patch} ${after}`
        expect(parseVersion(text)).toEqual(Option.some({ major, minor, patch }))
      }),
    )
  })

  test("the embedded one is the SDK's claudeCodeVersion", () => {
    const sdk = JSON.parse(
      readFileSync(join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"),
    ) as { readonly claudeCodeVersion: string }
    expect(embeddedVersion).toBe(sdk.claudeCodeVersion)
  })

  test("the range runs from the embedded one to 30 patch releases above it", () => {
    expect(rangeFrom({ major: 2, minor: 1, patch: 301 })).toEqual({
      from: { major: 2, minor: 1, patch: 301 },
      to: { major: 2, minor: 1, patch: 331 },
    })
    expect(supportedRange.from).toEqual(Option.getOrThrow(parseVersion(embeddedVersion)))
  })
})

describe("the version warning", () => {
  const range = rangeFrom({ major: 2, minor: 1, patch: 301 })
  const path = "/usr/local/bin/claude"

  test("none inside the range, both ends included", () => {
    for (const version of ["2.1.301", "2.1.315", "2.1.331"]) {
      expect(versionWarning(path, `${version} (Claude Code)`, range)).toBeNull()
    }
  })

  test("below the range, or above it, names the version, the range and the embedded one", () => {
    for (const version of ["2.1.300", "2.0.400", "1.9.999", "2.1.332", "2.2.0", "3.0.0"]) {
      const warning = versionWarning(path, `${version} (Claude Code)`, range)
      expect(warning).toBe(
        `the Claude Code at ${path} (--claude) is ${version}, outside the range: tutti supports ` +
          `2.1.301 to 2.1.331, and embeds ${embeddedVersion}. tutti runs it all the same`,
      )
    }
  })

  test("a --version with no version in it is a warning too", () => {
    const warning = versionWarning(path, "something else\u001b[2J\n", range)
    expect(warning).toContain(`couldn't read the version of the Claude Code at ${path}`)
    expect(warning).toContain('"something else"')
    expect(warning).not.toContain("\u001b")
  })
})

describe("the Claude Code sessions run", () => {
  test("from source: none, and the SDK resolves its own", async () => {
    expect(await resolved(null, sources())).toEqual({ path: null, warnings: [], problems: [] })
  })

  test("compiled: the embedded one, extracted, and other versions' copies tidied", async () => {
    const extracted: Array<string> = []
    const tidied: Array<string> = []
    const claude = await resolved(
      null,
      sources({
        embedded: "/$bunfs/root/claude-abc123",
        extract: (file) => {
          extracted.push(file)
          return "/tmp/claude-501/claude-agent-sdk-0123456789abcdef/claude-abc123"
        },
        tidy: (path) => tidied.push(path),
      }),
    )
    expect(extracted).toEqual(["/$bunfs/root/claude-abc123"])
    expect(tidied).toEqual(["/tmp/claude-501/claude-agent-sdk-0123456789abcdef/claude-abc123"])
    expect(claude).toEqual({
      path: "/tmp/claude-501/claude-agent-sdk-0123456789abcdef/claude-abc123",
      warnings: [],
      problems: [],
    })
  })

  test("compiled, extracted with the SDK's extractFromBunfs into a folder per version", async () => {
    // A $bunfs path is any with "$bunfs" in it, so a real folder named so stands in for Bun's.
    const bunfs = join(folder("bunfs"), "$bunfs", "root")
    mkdirSync(bunfs, { recursive: true })
    const embedded = fakeClaude(bunfs, embeddedVersion, "claude-abc123")
    const tmp = folder("claude-tmp")
    const before = process.env.CLAUDE_CODE_TMPDIR
    process.env.CLAUDE_CODE_TMPDIR = tmp
    try {
      const from = sources({ embedded, extract: extractFromBunfs })
      const first = await resolved(null, from)
      const again = await resolved(null, from)
      expect(first.problems).toEqual([])
      expect(first.path).toMatch(
        new RegExp(`^${tmp}/claude-\\d+/claude-agent-sdk-[0-9a-f]{16}/claude-abc123$`),
      )
      expect(again.path).toBe(first.path)
      const path = first.path ?? ""
      expect(readFileSync(path, "utf8")).toBe(readFileSync(embedded, "utf8"))
      expect(statSync(path).mode & 0o777).toBe(0o755)
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_TMPDIR
      else process.env.CLAUDE_CODE_TMPDIR = before
    }
  })

  test("compiled, the embedded one not extracted is a setup problem", async () => {
    const claude = await resolved(
      null,
      sources({
        embedded: "/$bunfs/root/claude-abc123",
        extract: (file) => file,
        tidy: (path) => {
          throw new Error(`tidied ${path}`)
        },
      }),
    )
    expect(claude.problems).toEqual([
      "tutti couldn't copy its embedded Claude Code out to a file it can run. Make room in the " +
        "temporary folder, set CLAUDE_CODE_TMPDIR to a folder with room, or run another Claude " +
        "Code with --claude <path>.",
    ])
  })

  test("--claude: that one, over the embedded one, its version checked", async () => {
    const checked: Array<string> = []
    const claude = await resolved(
      "/opt/claude/bin/claude",
      sources({
        embedded: "/$bunfs/root/claude-abc123",
        version: (path) => {
          checked.push(path)
          return Effect.succeed("2.1.250 (Claude Code)")
        },
      }),
    )
    expect(checked).toEqual(["/opt/claude/bin/claude"])
    expect(claude).toEqual({
      path: "/opt/claude/bin/claude",
      warnings: [
        Option.getOrThrow(
          Option.fromNullishOr(versionWarning("/opt/claude/bin/claude", "2.1.250")),
        ),
      ],
      problems: [],
    })
  })

  test("--claude inside the range: no warning", async () => {
    const claude = await resolved("/opt/claude/bin/claude", sources())
    expect(claude).toEqual({ path: "/opt/claude/bin/claude", warnings: [], problems: [] })
  })

  test("--claude with a relative path: from the folder tutti was started in", async () => {
    const claude = await resolved("bin/claude", sources({ cwd: "/work/project" }))
    expect(claude.path).toBe("/work/project/bin/claude")
  })

  test("--claude with a command's name: where it is on PATH", async () => {
    const found = await resolved(
      "claude",
      sources({ which: (name) => (name === "claude" ? "/usr/local/bin/claude" : null) }),
    )
    expect(found.path).toBe("/usr/local/bin/claude")
    const missing = await resolved("claude", sources())
    expect(missing.problems).toEqual(["There is no claude on PATH, for --claude claude."])
  })

  test("--claude that doesn't run is a setup problem", async () => {
    const claude = await resolved(
      "/opt/claude/bin/claude",
      sources({ version: () => Effect.fail("--version exited with 126: permission denied\n") }),
    )
    expect(claude.problems).toEqual([
      "The Claude Code at /opt/claude/bin/claude (--claude) doesn't run: --version exited with 126: permission denied",
    ])
  })
})

describe("resolveClaude", () => {
  const live = (given: string | null, cwd: string) =>
    Effect.runPromise(resolveClaude(given, cwd).pipe(Effect.provide(BunServices.layer)))

  test("from source, with no --claude, leaves it to the SDK", async () => {
    expect(await live(null, root)).toEqual({ path: null, warnings: [], problems: [] })
  })

  test("runs --claude's --version", async () => {
    const dir = folder("claude-flag")
    fakeClaude(dir, "2.1.200")
    const claude = await live("./claude", dir)
    expect(claude.path).toBe(join(dir, "claude"))
    expect(claude.problems).toEqual([])
    expect(claude.warnings).toEqual([
      Option.getOrThrow(Option.fromNullishOr(versionWarning(join(dir, "claude"), "2.1.200"))),
    ])
    expect(await live(fakeClaude(dir, embeddedVersion, "current"), dir)).toEqual({
      path: join(dir, "current"),
      warnings: [],
      problems: [],
    })
  })

  test("a --claude path with nothing there is a setup problem", async () => {
    const dir = folder("claude-missing")
    const claude = await live(join(dir, "claude"), dir)
    expect(claude.problems).toHaveLength(1)
    expect(claude.problems[0]).toStartWith(`The Claude Code at ${join(dir, "claude")} (--claude)`)
  })

  test("a compiled build's entry embeds its file before tutti starts", () => {
    // In a process of its own, as a compiled build's entry runs: embed() is the module's state.
    const bunfs = join(folder("entry"), "$bunfs", "root")
    mkdirSync(bunfs, { recursive: true })
    const embedded = fakeClaude(bunfs, embeddedVersion, "claude-entry")
    const tmp = folder("entry-tmp")
    const script = `
      import { Effect } from "effect"
      import { BunServices } from "@effect/platform-bun"
      import { embed, resolveClaude } from ${JSON.stringify(join(root, "src/agent/claudeBinary.ts"))}
      embed(${JSON.stringify(embedded)}, "darwin-arm64")
      const claude = await Effect.runPromise(
        resolveClaude(null, process.cwd()).pipe(Effect.provide(BunServices.layer)),
      )
      console.log(JSON.stringify(claude))
    `
    const ran = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: root,
      env: { ...process.env, CLAUDE_CODE_TMPDIR: tmp },
    })
    expect(ran.stderr.toString()).toBe("")
    const claude = JSON.parse(ran.stdout.toString()) as Claude
    expect(claude.problems).toEqual([])
    expect(claude.path).toMatch(new RegExp(`^${tmp}/claude-\\d+/claude-agent-sdk-[0-9a-f]{16}/`))
  })
})

describe("the startup checks", () => {
  const project = () => {
    const repo = join(folder("claude-startup"), "repo")
    mkdirSync(join(repo, ".tutti"), { recursive: true })
    writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
    writeFileSync(join(repo, ".tutti", "worker-prompt.md"), "Work on TICKET_ID.\n")
    mkdirSync(join(repo, ".beads"))
    return repo
  }

  const run = (repo: string, claude: Claude, account: Layer.Layer<Account, never, AppConfig>) =>
    Effect.runPromise(
      Effect.exit(
        check({
          cwd: repo,
          env: {},
          config: (top) => Effect.succeed(TestAppConfig.appConfig({ claude: "claude" }, top)),
          beads: () => TestBeads.layer(),
          claude: (given) =>
            given === "claude" ? Effect.succeed(claude) : Effect.die(`given ${given}`),
          account,
        }),
      ).pipe(
        Effect.provide(TestGit.layer({ dir: repo })),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: join(repo, "..", "home") } })),
        ),
        Effect.provide(BunServices.layer),
      ),
    )

  // A probe that is logged in only when it runs the Claude Code at `path`.
  const probeRunning = (path: string) =>
    Layer.effect(
      Account,
      Effect.gen(function* () {
        const config = yield* AppConfig
        return Account.of({
          probe:
            config.claude === path
              ? Effect.succeed(TestAccount.accountProbe())
              : Effect.fail(new NotLoggedIn()),
        })
      }),
    )

  test("the probe and the run get the resolved Claude Code, and its warning", async () => {
    const repo = project()
    const path = "/usr/local/bin/claude"
    const exit: Exit.Exit<Started, StartupFailed> = await run(
      repo,
      { path, warnings: ["an old Claude Code"], problems: [] },
      probeRunning(path),
    )
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    expect(exit.value.config.claude).toBe(path)
    expect(exit.value.warnings).toEqual(["an old Claude Code"])
  })

  test("its problems stop the run beside the others", async () => {
    const repo = project()
    const exit = await run(
      repo,
      { path: "claude", warnings: [], problems: ["There is no claude on PATH"] },
      TestAccount.layer(new NotLoggedIn()),
    )
    if (Exit.isSuccess(exit)) throw new Error("the checks passed")
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    expect(failure?._tag === "Fail" ? failure.error.problems : []).toEqual([
      "There is no claude on PATH",
      "Not logged in to Claude: run claude /login, or tutti login",
    ])
  })
})
