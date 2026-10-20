// The release workflow's run job (§ 12 Releases): every archive it builds is run, on a runner of
// its own system and architecture, the musl ones in Alpine.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const checkout = resolve(import.meta.dir, "..")

interface Run {
  readonly target: string
  readonly runner: string
  readonly alpine?: boolean
}

const release = Bun.YAML.parse(
  readFileSync(join(checkout, ".github/workflows/release.yml"), "utf8"),
) as {
  readonly jobs: {
    readonly run: {
      readonly strategy: { readonly matrix: { readonly include: ReadonlyArray<Run> } }
    }
  }
}
const include = release.jobs.run.strategy.matrix.include

/** The targets with an entry, src/entries/<target>.ts. */
const entries = readdirSync(join(checkout, "src/entries"))
  .map((file) => file.replace(/\.ts$/, ""))
  .filter((name) => name !== "musl")
  .sort()

test("the release workflow runs every target's archive once", () => {
  expect(include.map((run) => run.target).sort()).toEqual(entries)
})

test("each archive runs on a runner of its system and architecture", () => {
  for (const { target, runner } of include) {
    const [os, arch] = target.split("-")
    if (os === "linux") {
      expect(runner).toStartWith("ubuntu-")
      expect(runner.endsWith("-arm")).toBe(arch === "arm64")
    } else {
      expect(os).toBe("darwin")
      expect(runner).toStartWith("macos-")
      expect(runner.endsWith("-intel")).toBe(arch === "x64")
    }
  }
})

test("the musl archives run in Alpine, the others on the runner", () => {
  for (const { target, alpine } of include) expect(alpine === true).toBe(target.endsWith("-musl"))
})
