// tutti init's setup written as one (§ 8.3, src/init/staged.ts): its files staged in memory, then
// written together, the settings last, so that a failed write leaves the old setup or the new one,
// never a worker prompt without settings. Each of the writes the setup makes on disk is failed in
// turn, in a fresh project and in one set up before, and what is left checked.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, FileSystem, Layer } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"
import { failedEnding } from "../src/cli/commands.ts"
import { type InitFlags, init } from "../src/init/init.ts"
import { commitStaged, SetupNotWritten, staging } from "../src/init/staged.ts"
import { InitFailed, type Machine, step } from "../src/init/steps.ts"
import { RunLock } from "../src/services/RunLock.ts"
import * as TestAccount from "../src/testing/Account.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import * as TestBeads from "../src/testing/Beads.ts"

/** A temp repository (its top and git folder) and a home folder for Claude Code's user config. */
const newProject = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-init-staged-")))
  const repo = join(root, "repo")
  const commonDir = join(repo, ".git")
  const home = join(root, "home")
  mkdirSync(commonDir, { recursive: true })
  mkdirSync(home)
  return { root, repo, commonDir, home }
}

type Project = ReturnType<typeof newProject>

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

/** A write the setup makes on disk, as the faulty file system sees it. */
interface Write {
  readonly op: string
  readonly path: string
}

/** Whether `path` is one of the setup's own temporary files. */
const temporary = (path: string) => /\.tutti-\d+-[0-9a-f-]+\.(new|old)$/.test(path)

/**
 * `real`, seeing the writes the setup makes in `repo` (but its git folder, where the run lock is):
 * the folders it makes, its temporary files, their modes and renames, and the old files' copies;
 * each recorded in `seen`, and failed where `fails` says so.
 */
const faulty = (
  real: FileSystem.FileSystem,
  repo: string,
  seen: Array<Write>,
  fails: (write: Write, index: number) => boolean,
): FileSystem.FileSystem => {
  const watched = (op: string, path: string) => {
    if (!path.startsWith(`${repo}/`) || path.startsWith(join(repo, ".git"))) return false
    if (op !== "makeDirectory" && !temporary(path)) return false
    return true
  }
  const check = <A, R>(
    op: string,
    path: string,
    effect: Effect.Effect<A, PlatformError, R>,
  ): Effect.Effect<A, PlatformError, R> =>
    Effect.suspend(() => {
      if (!watched(op, path)) return effect
      const write = { op, path: relative(repo, path) }
      seen.push(write)
      return fails(write, seen.length - 1)
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
    chmod: (path, mode) => check("chmod", path, real.chmod(path, mode)),
    rename: (from, to) => check("rename", from, real.rename(from, to)),
    link: (from, to) => check("link", to, real.link(from, to)),
    copyFile: (from, to) => check("copyFile", to, real.copyFile(from, to)),
  })
}

/** bd on the PATH, every command answered with nothing. */
const machine = (project: Project): Machine => ({
  run: () => Effect.succeed(""),
  which: (command) => (command === "bd" ? "/opt/bin/bd" : null),
  env: (name) => (name === "HOME" ? project.home : undefined),
  platform: "darwin",
  executable: () => false,
})

/** Runs init in `project` over the faulty file system: its writes in `seen`. */
const runInit = (
  project: Project,
  flags: InitFlags,
  seen: Array<Write>,
  fails: (write: Write, index: number) => boolean = () => false,
) => {
  const files = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) => faulty(real, project.repo, seen, fails)),
  ).pipe(Layer.provide(BunServices.layer))
  return Effect.runPromise(
    Effect.exit(
      init({
        repo: project.repo,
        commonDir: project.commonDir,
        branch: "main",
        version: "0.1.0",
        flags,
        form: null,
        scout: Effect.fail("there is no scout in these tests"),
        machine: machine(project),
        configure: Effect.succeed(TestAppConfig.appConfig({}, project.repo)),
        account: TestAccount.layer(),
        claudeConfig: join(project.home, ".claude.json"),
      }).pipe(
        Effect.provide(RunLock.layer),
        Effect.provide(TestBeads.layer([])),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: project.home } })),
        ),
        Effect.provide(files),
        Effect.provide(BunServices.layer),
      ),
    ),
  )
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected init to fail")
  const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
  if (reason?._tag !== "Fail") throw new Error(`no failure in ${String(exit.cause)}`)
  return reason.error
}

/** A first setup's flags: the runners given commands, and the verifier written. */
const firstFlags: InitFlags = {
  force: false,
  checkFast: "echo fast",
  checkFull: "echo full",
  verifier: true,
}

/** A second setup's: every file the first wrote replaced or changed. */
const secondFlags: InitFlags = {
  force: true,
  concurrent: 3,
  checkFast: "echo faster",
  checkFull: "echo fuller",
  verifier: true,
}

describe("init's setup written as one", () => {
  test("a fresh project: each write failed in turn leaves nothing of the setup", async () => {
    const counted: Array<Write> = []
    const once = newProject()
    expect(Exit.isSuccess(await runInit(once, firstFlags, counted))).toBe(true)
    // The folders, the temporary files, their modes and renames, the settings renamed in last.
    expect(counted.map((each) => each.op)).toContain("makeDirectory")
    expect(counted.filter((each) => each.op === "open").length).toBeGreaterThanOrEqual(6)
    const renames = counted.filter((each) => each.op === "rename")
    expect(renames.at(-1)?.path).toMatch(/^\.tutti\/\.settings\.json\.tutti-/)
    expect(existsSync(join(once.repo, ".tutti", "settings.json"))).toBe(true)

    for (const [index, write] of counted.entries()) {
      const project = newProject()
      const exit = await runInit(project, firstFlags, [], (_, at) => at === index)
      const error = failureOf(exit)
      expect(error).toBeInstanceOf(InitFailed)
      const failed = error as InitFailed
      expect(failed.step).toBe("the setup")
      expect(failed.message).toContain("cannot write ")
      expect(failed.message).toContain("failed on purpose")
      expect(failed.message).toContain("the setup's files are as they were")
      // The steps taken before: Beads.
      expect(failed.steps.map((each) => each.label)).toContain("Beads")
      expect([index, write.op, tree(project.repo)]).toEqual([index, write.op, {}])
    }
  })

  test("a project set up before: each write failed in turn leaves the old setup", async () => {
    const counted: Array<Write> = []
    const once = newProject()
    expect(Exit.isSuccess(await runInit(once, firstFlags, []))).toBe(true)
    writeFileSync(join(once.repo, ".tutti", "worker-prompt.md"), "Ours: TICKET_ID\n")
    expect(Exit.isSuccess(await runInit(once, secondFlags, counted))).toBe(true)
    // The second setup replaces files there: their copies, kept until the renames are done.
    expect(counted.map((each) => each.op)).toContain("link")
    expect(readFileSync(join(once.repo, ".tutti", "worker-prompt.md"), "utf8")).not.toBe(
      "Ours: TICKET_ID\n",
    )
    expect(JSON.parse(readFileSync(join(once.repo, ".tutti", "settings.json"), "utf8"))).toEqual(
      expect.objectContaining({ concurrent: 3 }),
    )

    for (const [index, write] of counted.entries()) {
      const project = newProject()
      expect(Exit.isSuccess(await runInit(project, firstFlags, []))).toBe(true)
      writeFileSync(join(project.repo, ".tutti", "worker-prompt.md"), "Ours: TICKET_ID\n")
      const before = tree(project.repo)
      // An old file's copy falls back from a link to a copy: both fail.
      const exit = await runInit(
        project,
        secondFlags,
        [],
        (each, at) => at === index || (each.op === "copyFile" && at === index + 1),
      )
      expect(failureOf(exit)).toBeInstanceOf(InitFailed)
      expect([index, write.op, tree(project.repo)]).toEqual([index, write.op, before])
    }
  })
})

/** Runs `effect` with the live file system. */
const live = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(Effect.exit(Effect.provide(effect, BunServices.layer)))

describe("staging", () => {
  test("keeps what is written in memory and reads it back; the project is untouched", async () => {
    const project = newProject()
    writeFileSync(join(project.repo, "notes.txt"), "one\n")
    const exit = await live(
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem
        const staged = staging(real)
        const fs = staged.fs
        const folder = join(project.repo, "a", "b")
        yield* fs.makeDirectory(folder, { recursive: true })
        yield* fs.writeFileString(join(folder, "c.txt"), "c")
        yield* fs.chmod(join(folder, "c.txt"), 0o755)
        yield* fs.writeFileString(join(project.repo, "notes.txt"), "two\n", { flag: "a" })
        const lost = yield* Effect.result(fs.writeFileString(join(project.repo, "x", "y"), "y"))
        const moved = yield* Effect.result(fs.rename(join(folder, "c.txt"), join(folder, "d")))
        return {
          a: yield* fs.exists(join(project.repo, "a")),
          c: yield* fs.readFileString(join(folder, "c.txt")),
          notes: yield* fs.readFileString(join(project.repo, "notes.txt")),
          mode: (yield* fs.stat(join(folder, "c.txt"))).mode,
          lost: lost._tag,
          moved: moved._tag,
          writes: staged.writes().map((each) => [relative(project.repo, each.path), each.mode]),
        }
      }),
    )
    expect(exit).toEqual(
      Exit.succeed({
        a: true,
        c: "c",
        notes: "one\ntwo\n",
        mode: 0o755,
        lost: "Failure",
        moved: "Failure",
        writes: [
          ["a/b/c.txt", 0o755],
          ["notes.txt", null],
        ],
      }),
    )
    expect(tree(project.repo)).toEqual({ "notes.txt": "644 one\n" })
  })

  test("a file it couldn't take back is named, and left as written", async () => {
    const project = newProject()
    const seen: Array<Write> = []
    const prompt = join(project.repo, ".tutti", "worker-prompt.md")
    const settings = join(project.repo, ".tutti", "settings.json")
    const exit = await live(
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem
        // The settings' rename fails, and so does taking back the prompt.
        const broken = faulty(
          real,
          project.repo,
          seen,
          (write) => write.op === "rename" && write.path.includes("settings"),
        )
        const files = FileSystem.FileSystem.of({
          ...broken,
          remove: (path, options) =>
            path === prompt
              ? Effect.fail(systemError({ _tag: "Busy", module: "FileSystem", method: "remove" }))
              : real.remove(path, options),
        })
        const encode = (text: string) => new TextEncoder().encode(text)
        return yield* commitStaged(
          files,
          project.repo,
          [
            { path: settings, data: encode("{}\n"), mode: null },
            { path: prompt, data: encode("Work on TICKET_ID.\n"), mode: null },
          ],
          settings,
        )
      }),
    )
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(SetupNotWritten)
    expect((error as SetupNotWritten).left).toEqual([".tutti/worker-prompt.md"])
    expect((error as SetupNotWritten).message).toContain("cannot write .tutti/settings.json: ")
    expect((error as SetupNotWritten).message).toContain(
      ".tutti/worker-prompt.md could not be taken back",
    )
    expect(tree(project.repo)).toEqual({
      ".tutti/": "",
      ".tutti/worker-prompt.md": "644 Work on TICKET_ID.\n",
    })
  })
})

describe("what init says when its setup failed", () => {
  test("the steps taken before it, then why, with status 2", () => {
    const failed = new InitFailed({
      steps: [step("done", "Beads", "set up with bd init")],
      step: "the setup",
      reason: new SetupNotWritten({
        file: ".claude/agents/verifier.md",
        reason: "permission denied",
        left: [],
      }).message,
    })
    expect(failedEnding(failed, null, 80)).toEqual({
      stdout: ["✓ Beads  set up with bd init"],
      stderr:
        "tutti init: cannot write .claude/agents/verifier.md: permission denied; the setup's files are as they were",
      code: 2,
    })
  })
})
