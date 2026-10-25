// The npm package (§ 12 npm): package.json's bin, files and publishConfig, the launcher bin/tutti,
// the bundle scripts/build-npm.sh builds, and the workflow that publishes it (.github/workflows/
// npm.yml), which only GitHub runs. The launcher is run from a project holding .env files and a
// bunfig.toml preload, through a node_modules/.bin symlink as bunx makes, with a probe in place of
// the bundle; the slow tests build the real bundle and run it. scripts/check-npm.sh checks a packed
// tarball through bunx itself, which installs from the registry.
import { describe, expect, test } from "bun:test"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { testEnv } from "./env.ts"
import { slow } from "./gates.ts"

const checkout = resolve(import.meta.dir, "..")
const launcher = join(checkout, "bin/tutti")

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly env?: Record<string, string>
}
interface Job {
  readonly needs?: string | ReadonlyArray<string>
  readonly if?: string
  readonly outputs?: Record<string, string>
  readonly permissions?: Record<string, string>
  readonly steps: ReadonlyArray<Step>
}
interface Workflow {
  readonly on: Record<string, unknown>
  readonly jobs: Record<string, Job>
}

const npm = Bun.YAML.parse(
  readFileSync(join(checkout, ".github/workflows/npm.yml"), "utf8"),
) as Workflow
const job = (name: string): Job => {
  const found = npm.jobs[name]
  if (found === undefined) throw new Error(`no job ${name}`)
  return found
}
/** The NPM_TOKEN secret, as a workflow writes it. */
const secret = `\${{ secrets.NPM_TOKEN }}`
const runs = (j: Job) => j.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]))

/** The environment without NODE_ENV and the probe's variables, as a shell passes it on. */
const shellEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...testEnv }
  for (const name of [
    "NODE_ENV",
    "TUTTI_PROBE_ENV",
    "TUTTI_PROBE_LOCAL",
    "TUTTI_PROBE_PRODUCTION",
  ]) {
    delete env[name]
  }
  return { ...env, ...extra }
}

const run = (command: ReadonlyArray<string>, cwd: string, env = shellEnv()) => {
  const proc = Bun.spawnSync([...command], { cwd, env, stdout: "pipe", stderr: "pipe" })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

/**
 * A package folder holding the launcher, `<pkg>/bin/tutti`, and a project holding the three .env
 * files a run with NODE_ENV=production reads and a bunfig.toml whose preload sets a global, with the
 * launcher linked from its node_modules/.bin as an install links it.
 */
const setup = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-npm-package-")))
  const bin = join(dir, "pkg/bin")
  mkdirSync(join(bin, "bundle"), { recursive: true })
  copyFileSync(launcher, join(bin, "tutti"))
  const project = join(dir, "project")
  mkdirSync(join(project, "node_modules/.bin"), { recursive: true })
  symlinkSync("../../../pkg/bin/tutti", join(project, "node_modules/.bin/tutti"))
  writeFileSync(join(project, ".env"), "TUTTI_PROBE_ENV=env\n")
  writeFileSync(join(project, ".env.local"), "TUTTI_PROBE_LOCAL=local\n")
  writeFileSync(join(project, ".env.production"), "TUTTI_PROBE_PRODUCTION=production\n")
  writeFileSync(join(project, "preload.ts"), "Object.assign(globalThis, { tuttiPreload: true })\n")
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
  return { dir, bin, project, tutti: join(project, "node_modules/.bin/tutti") }
}

// What the bundle sees: its arguments, the .env files' variables and whether the preload ran.
const probe = `console.log(JSON.stringify({
  args: process.argv.slice(2),
  env: [process.env.TUTTI_PROBE_ENV, process.env.TUTTI_PROBE_LOCAL, process.env.TUTTI_PROBE_PRODUCTION],
  preload: "tuttiPreload" in globalThis,
}))
`

describe("the npm package", () => {
  test("is public, its bin the launcher and its files the launcher and the bundle", () => {
    expect(pkg).not.toHaveProperty("private")
    expect(pkg.publishConfig).toEqual({ access: "public" })
    expect(pkg.bin).toEqual({ tutti: "bin/tutti" })
    expect(pkg.files).toContain("bin/tutti")
    expect(pkg.files).toContain("bin/bundle/")
    expect(pkg.scripts.prepack).toBe("scripts/build-npm.sh")
    expect(statSync(launcher).mode & 0o111).toBe(0o111)
  })

  test("the bundle is git-ignored, and the launcher isn't", () => {
    expect(run(["git", "check-ignore", "-q", "bin/bundle/tutti.js"], checkout).code).toBe(0)
    expect(run(["git", "check-ignore", "-q", "bin/tutti"], checkout).code).toBe(1)
  })

  test("the launcher is a #!/bin/sh script that execs bun on the bundle beside it, without .env or bunfig.toml", () => {
    const text = readFileSync(launcher, "utf8")
    expect(text.startsWith("#!/bin/sh\n")).toBe(true)
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      'exec bun --no-env-file --config=/dev/null "$(dirname "$(readlink -f "$0")")/bundle/tutti.js" "$@"',
    )
  })

  test("run through a node_modules/.bin link, the launcher passes the arguments and neither the .env files nor the preload", () => {
    const { bin, project, tutti } = setup()
    writeFileSync(join(bin, "bundle/tutti.js"), probe)
    const args = ["colours", "a b", "", "--x=$HOME", "*"]
    const result = run([tutti, ...args], project, shellEnv({ NODE_ENV: "production" }))
    expect(result.err).toBe("")
    expect(JSON.parse(result.out)).toEqual({ args, env: [null, null, null], preload: false })
  })

  // The control: bun runs the same bundle as a bin is run without the launcher, and gets both.
  test("the bundle run without the launcher reads the .env files and runs the preload", () => {
    const { bin, project } = setup()
    writeFileSync(join(bin, "bundle/tutti.js"), probe)
    const result = run(
      ["bun", join(bin, "bundle/tutti.js")],
      project,
      shellEnv({ NODE_ENV: "production" }),
    )
    expect(JSON.parse(result.out)).toEqual({
      args: [],
      env: ["env", "local", "production"],
      preload: true,
    })
  })

  slow.describe("its bundle", () => {
    // Built once, beside a launcher, with the checkout's node_modules where an install puts them.
    const built = (() => {
      let made: ReturnType<typeof setup> | undefined
      return () => {
        if (made !== undefined) return made
        made = setup()
        symlinkSync(join(checkout, "node_modules"), join(made.dir, "pkg/node_modules"))
        const build = run(
          ["scripts/build-npm.sh", "--out", join(made.bin, "bundle")],
          checkout,
          shellEnv(),
        )
        expect(build.err).toBe("")
        expect(build.code).toBe(0)
        return made
      }
    })()

    test("has React's production build", () => {
      const bundle = readFileSync(join(built().bin, "bundle/tutti.js"), "utf8")
      // The development reconciler records a performance.measure() per render (§ 3.1).
      expect(bundle).toContain("react-reconciler")
      expect(bundle).not.toContain("performance.measure")
    }, 60_000)

    test("runs through the launcher, with the commit in its version", () => {
      const { project, tutti } = built()
      const head = run(["git", "rev-parse", "HEAD"], checkout).out.trim().slice(0, 12)
      const result = run([tutti, "--version"], project)
      expect(result.code).toBe(0)
      expect(result.out).toStartWith(`tutti v${pkg.version} ${head}`)
    }, 60_000)

    // TUTTI_COLOUR_SCHEME is the --colour-scheme flag: read from .env, tutti colours would say the
    // scheme it names isn't used.
    test("doesn't read the project's .env through the launcher", () => {
      const { dir, project, tutti } = built()
      writeFileSync(join(project, ".env"), "TUTTI_COLOUR_SCHEME=from-dotenv\n")
      const env = shellEnv({ NO_COLOR: "1", XDG_CONFIG_HOME: join(dir, "config") })
      delete env.TUTTI_COLOUR_SCHEME
      const through = run([tutti, "colours"], project, env)
      expect(through.code).toBe(0)
      expect(through.out).not.toContain("from-dotenv")
      const bare = run(["bun", join(dir, "pkg/bin/bundle/tutti.js"), "colours"], project, env)
      expect(bare.out).toContain("used instead of 'from-dotenv'")
    }, 60_000)
  })
})

describe("the npm workflow", () => {
  test("runs on version tags, and by hand for a tag", () => {
    expect(npm.on.push).toEqual({ tags: ["v*"] })
    expect(npm.on).toHaveProperty("workflow_dispatch.inputs.tag.required", true)
  })

  test("packs, checks and publishes only when the NPM_TOKEN secret is set", () => {
    const token = job("token")
    expect(token.steps.some((step) => step.env?.NPM_TOKEN === secret)).toBe(true)
    expect(job("pack").needs).toBe("token")
    expect(job("pack").if).toBe("needs.token.outputs.set == 'true'")
    expect(job("check").needs).toBe("pack")
    expect(job("publish").needs).toEqual(["check", "release-check"])
  })

  test("packs the release bundle once, checks that tarball as bunx runs it, and publishes it", () => {
    const pack = runs(job("pack")).join("\n")
    expect(pack).toContain("scripts/build-npm.sh --release")
    expect(pack).toContain("bun pm pack --ignore-scripts")
    expect(runs(job("check")).join("\n")).toContain("scripts/check-npm.sh")
    const publish = job("publish")
    expect(runs(publish).join("\n")).toContain("npm publish dist/npm/*.tgz")
    expect(publish.steps.some((step) => step.env?.NPM_TOKEN === secret)).toBe(true)
  })
})
