// tutti init --update's files written as one (§ 8.3, src/init/staged.ts), as init's setup is: the
// worker prompt, the verifier, the skill and the settings staged in memory, then put in together,
// the settings last. Each of the writes it makes on disk is failed in turn, and the project checked
// to be as it was.
import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, FileSystem, Layer } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"
import { skillPath, verifierPath } from "../src/init/checks.ts"
import { SetupNotWritten } from "../src/init/staged.ts"
import { updateTemplates } from "../src/init/update.ts"

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", "templates", name), "utf8")

const write = (repo: string, path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

/**
 * A project set up before tutti recorded template versions: an old worker prompt with the project's
 * own section and the Verify section, an old verifier and skill, settings recording no versions.
 */
const oldProject = () => {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "tutti-update-staged-"))), "repo")
  mkdirSync(join(repo, ".git"), { recursive: true })
  write(
    repo,
    ".tutti/worker-prompt.md",
    `${fixture("worker-prompt-2026-10-17.md")}\n## Project notes\n- Use pnpm.\n${fixture("verify-section-2026-10-19.md")}`,
  )
  write(repo, verifierPath, fixture("verifier-2026-10-19.md"))
  write(repo, skillPath, fixture("create-check-suite-2026-10-22.md"))
  write(repo, ".tutti/settings.json", `${JSON.stringify({ concurrent: 2 }, null, 2)}\n`)
  return repo
}

/** Every file under `repo` but the git folder: its path, mode and text. */
const tree = (repo: string): Record<string, string> => {
  const files: Record<string, string> = {}
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      const at = relative(repo, path)
      if (at === ".git") continue
      const info = statSync(path)
      if (info.isDirectory()) {
        files[`${at}/`] = ""
        walk(path)
      } else {
        files[at] = `${(info.mode & 0o777).toString(8)} ${readFileSync(path, "utf8")}`
      }
    }
  }
  walk(repo)
  return files
}

/** A write --update makes on disk, as the faulty file system sees it. */
interface Write {
  readonly op: string
  readonly path: string
}

/** Whether `path` is one of the staged writes' temporary files. */
const temporary = (path: string) => /\.tutti-\d+-[0-9a-f-]+\.(new|old)$/.test(path)

/**
 * `real`, seeing the writes made in `repo`: any write to a file of its own (which staging should
 * leave to its temporary files), the temporary files, their renames and the old files' copies; each
 * recorded in `seen`, and failed where `fails` says so.
 */
const faulty = (
  real: FileSystem.FileSystem,
  repo: string,
  seen: Array<Write>,
  fails: (index: number) => boolean,
): FileSystem.FileSystem => {
  const check = <A, R>(
    op: string,
    path: string,
    effect: Effect.Effect<A, PlatformError, R>,
  ): Effect.Effect<A, PlatformError, R> =>
    Effect.suspend(() => {
      if (!path.startsWith(`${repo}/`) || path.startsWith(join(repo, ".git"))) return effect
      if (op === "open" && !temporary(path)) return effect
      const write = { op, path: relative(repo, path) }
      seen.push(write)
      return fails(seen.length - 1)
        ? Effect.fail(
            systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: op,
              description: "failed on purpose",
              pathOrDescriptor: path,
            }),
          )
        : effect
    })
  return FileSystem.FileSystem.of({
    ...real,
    makeDirectory: (path, options) =>
      check("makeDirectory", path, real.makeDirectory(path, options)),
    open: (path, options) => check("open", path, real.open(path, options)),
    writeFile: (path, data, options) =>
      check("writeFile", path, real.writeFile(path, data, options)),
    writeFileString: (path, data, options) =>
      check("writeFileString", path, real.writeFileString(path, data, options)),
    chmod: (path, mode) => check("chmod", path, real.chmod(path, mode)),
    rename: (from, to) => check("rename", from, real.rename(from, to)),
    link: (from, to) => check("link", to, real.link(from, to)),
    copyFile: (from, to) => check("copyFile", to, real.copyFile(from, to)),
  })
}

/** Runs --update's writes in `repo` over the faulty file system: its writes in `seen`. */
const runUpdate = (repo: string, seen: Array<Write>, fails: (index: number) => boolean) => {
  const files = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) => faulty(real, repo, seen, fails)),
  ).pipe(Layer.provide(BunServices.layer))
  return Effect.runPromise(
    Effect.exit(
      updateTemplates(repo).pipe(Effect.provide(files), Effect.provide(BunServices.layer)),
    ),
  )
}

describe("tutti init --update written as one", () => {
  test("writes only temporary files, renamed in with the settings last", async () => {
    const repo = oldProject()
    const seen: Array<Write> = []
    const exit = await runUpdate(repo, seen, () => false)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.updates.map((each) => each.path)).toEqual([
        ".tutti/worker-prompt.md",
        verifierPath,
        skillPath,
      ])
    }
    // No file of the project's is written in place.
    expect(seen.filter((each) => each.op.startsWith("writeFile"))).toEqual([])
    const renames = seen.filter((each) => each.op === "rename")
    expect(renames).toHaveLength(4)
    expect(renames.at(-1)?.path).toMatch(/^\.tutti\/\.settings\.json\.tutti-/)
    expect(JSON.parse(readFileSync(join(repo, ".tutti", "settings.json"), "utf8"))).toEqual(
      expect.objectContaining({ concurrent: 2, templates: expect.any(Object) }),
    )
    expect(readFileSync(join(repo, ".tutti", "worker-prompt.md"), "utf8")).toContain(
      "## Project notes\n- Use pnpm.\n",
    )
  })

  test("each write failed in turn leaves the project as it was", async () => {
    const counted: Array<Write> = []
    expect(Exit.isSuccess(await runUpdate(oldProject(), counted, () => false))).toBe(true)
    expect(counted.length).toBeGreaterThanOrEqual(12)

    for (const [index, write] of counted.entries()) {
      const repo = oldProject()
      const before = tree(repo)
      // An old file's copy falls back from a link to a copy: both fail.
      const exit = await runUpdate(
        repo,
        [],
        (at) => at === index || (write.op === "link" && at === index + 1),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
        const error = reason?._tag === "Fail" ? reason.error : undefined
        expect(error).toBeInstanceOf(SetupNotWritten)
        expect((error as SetupNotWritten).message).toContain("failed on purpose")
        expect((error as SetupNotWritten).message).toContain("the setup's files are as they were")
      }
      expect([index, write.op, tree(repo)]).toEqual([index, write.op, before])
    }
  })
})
