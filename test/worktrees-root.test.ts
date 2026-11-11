// The worktrees' root (src/run/worktreesRoot.ts): the default under ~/.tutti/worktrees and its name
// when another repository has it, its Time Machine exclusion through the TimeMachine test layer, and
// the move of the old <repo>-tutti worktrees over Git's test layer, on real folders.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, type FileSystem, Layer, Result } from "effect"
import { noFlags } from "../src/cli/flags.ts"
import { defaultSettings, defaultUserConfig, resolve } from "../src/cli/resolveConfig.ts"
import {
  findRoot,
  oldDefaultRoot,
  ownerFile,
  readyRoot,
  rootNames,
  sessionFolderName,
  unindexed,
  worktreesHome,
} from "../src/run/worktreesRoot.ts"
import { Git } from "../src/services/Git.ts"
import { emptyState, readState, type State, writeState } from "../src/services/Store.ts"
import type { TimeMachine } from "../src/services/TimeMachine.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import {
  TimeMachineCalls,
  type Options as TimeMachineOptions,
  layer as timeMachineLayer,
} from "../src/testing/TimeMachine.ts"

/** A temp folder with a home in it and a repository `project` with its old root beside it. */
const setUp = () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "tutti-worktrees-root-")))
  const home = join(top, "home")
  const repo = join(top, "code", "project")
  const projects = join(home, ".claude", "projects")
  mkdirSync(repo, { recursive: true })
  mkdirSync(projects, { recursive: true })
  return { top, home, repo, projects, old: oldDefaultRoot(repo) }
}

type Fixture = ReturnType<typeof setUp>

/** Runs `body` over Git's test layer in the fixture's repository and the TimeMachine test layer. */
const within = <A, E>(
  fixture: Fixture,
  body: Effect.Effect<
    A,
    E,
    Git | Repository | TimeMachine | TimeMachineCalls | FileSystem.FileSystem
  >,
  options: TimeMachineOptions = {},
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        Layer.mergeAll(gitLayer({ dir: fixture.repo }), timeMachineLayer(options)).pipe(
          Layer.provideMerge(BunServices.layer),
        ),
      ),
    ),
  )

/** The run's configuration on the default root, with `settings` changed. */
const defaultConfig = (fixture: Fixture, exclude = true) =>
  appConfig({
    repo: fixture.repo,
    worktreesDefault: true,
    settings: { ...defaultSettings, exclude_worktrees: exclude },
  })

const ready = (fixture: Fixture, platform: NodeJS.Platform = "darwin", exclude = true) =>
  readyRoot(defaultConfig(fixture, exclude), {
    platform,
    home: fixture.home,
    projects: fixture.projects,
  })

describe("the default root", () => {
  test("is ~/.tutti/worktrees/<the repository's folder name>, claimed with a .repo naming it", async () => {
    const fixture = setUp()
    const root = await within(fixture, ready(fixture))
    expect(root.root).toBe(join(fixture.home, ".tutti", "worktrees", "project"))
    expect(readFileSync(join(root.root, ownerFile), "utf8")).toBe(`${fixture.repo}\n`)
    expect(root.notes).toEqual([])
    expect(root.warnings).toEqual([])
  })

  test("another repository of the same name gets the name with a short hash of its path", async () => {
    const { home } = setUp()
    const first = "/a/app"
    const second = "/b/app"
    const names = rootNames(second)
    expect(names[1]).toMatch(/^app-[0-9a-f]{4}$/)
    const taken = join(worktreesHome(home), "app")
    mkdirSync(taken, { recursive: true })
    writeFileSync(join(taken, ownerFile), `${first}\n`)
    const find = (repo: string) =>
      Effect.runPromise(findRoot(home, repo).pipe(Effect.provide(BunServices.layer)))
    expect(await find(first)).toBe(taken)
    // Stable: the hashed name is the same each time, and its own once claimed.
    expect(await find(second)).toBe(join(worktreesHome(home), names[1] as string))
    expect(await find(second)).toBe(join(worktreesHome(home), names[1] as string))
    const hashed = join(worktreesHome(home), names[1] as string)
    mkdirSync(hashed)
    writeFileSync(join(hashed, ownerFile), "/c/app\n")
    expect(await find(second)).toBe(join(worktreesHome(home), names[2] as string))
  })

  test("AppConfig takes the root found on disk as its default, and a flag over it", () => {
    const sources = {
      repo: "/work/project",
      flags: noFlags,
      env: () => undefined,
      user: defaultUserConfig,
      settings: defaultSettings,
      worktreesDefault: "/home/me/.tutti/worktrees/project-3f9c",
    }
    const resolved = resolve(sources)
    if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
    expect(resolved.success.worktrees).toBe("/home/me/.tutti/worktrees/project-3f9c")
    expect(resolved.success.worktreesDefault).toBe(true)
    const given = resolve({
      ...sources,
      env: (name) => (name === "TUTTI_WORKTREES" ? "/trees" : undefined),
    })
    if (Result.isFailure(given)) throw new Error(given.failure.join("\n"))
    expect(given.success.worktrees).toBe("/trees")
    expect(given.success.worktreesDefault).toBe(false)
  })

  test("a repository holding the home folder keeps its worktrees beside it, as before", () => {
    const resolved = resolve({
      repo: "/home/me",
      flags: noFlags,
      env: () => undefined,
      user: defaultUserConfig,
      settings: defaultSettings,
      worktreesDefault: "/home/me/.tutti/worktrees/me",
    })
    if (Result.isFailure(resolved)) throw new Error(resolved.failure.join("\n"))
    expect(resolved.success.worktrees).toBe("/home/me-tutti")
    expect(resolved.success.worktreesDefault).toBe(false)
  })
})

describe("Spotlight and Claude Code's session folders", () => {
  test("a folder under a hidden one, or under *.noindex, isn't indexed", () => {
    expect(unindexed("/Users/me/.tutti/worktrees/app/t-1")).toBe(true)
    expect(unindexed("/Users/me/trees.noindex/t-1")).toBe(true)
    expect(unindexed("/Users/me/Projects/app-tutti/t-1")).toBe(false)
  })

  test("a session folder is the path with each character but a letter or digit a dash", () => {
    expect(sessionFolderName("/Users/me/.tutti/worktrees/app/t-1.2")).toBe(
      "-Users-me--tutti-worktrees-app-t-1-2",
    )
    expect(sessionFolderName(`/${"a".repeat(199)}`)).toBe(`-${"a".repeat(199)}`)
    expect(sessionFolderName(`/${"a".repeat(200)}`)).toBeUndefined()
  })
})

describe("the Time Machine exclusion", () => {
  const callsOf = Effect.flatMap(TimeMachineCalls, (calls) => calls.calls)

  test("on macOS, ~/.tutti/worktrees is excluded once, and checked at each start", async () => {
    const fixture = setUp()
    const folder = worktreesHome(fixture.home)
    const run = await within(
      fixture,
      Effect.gen(function* () {
        const first = yield* ready(fixture)
        const second = yield* ready(fixture)
        // Its exclusion removed, the next start adds it again.
        yield* Effect.flatMap(TimeMachineCalls, (calls) => calls.unexclude(folder))
        yield* ready(fixture)
        return { first, second, calls: yield* callsOf }
      }),
    )
    expect(run.first.line).toBe(
      "~/.tutti/worktrees/project (excluded from Time Machine; not indexed by Spotlight)",
    )
    expect(run.second.line).toBe(run.first.line)
    expect(run.calls).toEqual([
      `isexcluded ${folder}`,
      `addexclusion ${folder}`,
      `isexcluded ${folder}`,
      `isexcluded ${folder}`,
      `addexclusion ${folder}`,
    ])
  })

  test("tmutil absent or failing warns, and the run goes on with its root", async () => {
    for (const options of [{ absent: true }, { failing: true }]) {
      const fixture = setUp()
      const root = await within(fixture, ready(fixture), options)
      expect(root.root).toBe(join(fixture.home, ".tutti", "worktrees", "project"))
      expect(root.line).toBe(
        "~/.tutti/worktrees/project (not excluded from Time Machine; not indexed by Spotlight)",
      )
      expect(root.warnings).toHaveLength(1)
      expect(root.warnings[0]).toStartWith(
        "the worktrees' folder ~/.tutti/worktrees can't be excluded from Time Machine (",
      )
      expect(root.warnings[0]).toEndWith(
        `tmutil addexclusion ${worktreesHome(fixture.home)} excludes it`,
      )
    }
  })

  test("exclude_worktrees false, or off macOS, asks tmutil nothing", async () => {
    const fixture = setUp()
    const off = await within(
      fixture,
      Effect.gen(function* () {
        const root = yield* ready(fixture, "darwin", false)
        return { root, calls: yield* callsOf }
      }),
    )
    expect(off.calls).toEqual([])
    expect(off.root.line).toBe(
      "~/.tutti/worktrees/project (not excluded from Time Machine: exclude_worktrees is false; not indexed by Spotlight)",
    )
    const linux = await within(
      fixture,
      Effect.gen(function* () {
        const root = yield* ready(fixture, "linux")
        return { root, calls: yield* callsOf }
      }),
    )
    expect(linux.calls).toEqual([])
    expect(linux.root.line).toBe("~/.tutti/worktrees/project")
  })

  test("an overridden root is excluded itself, and said indexed where it is", async () => {
    const fixture = setUp()
    const trees = join(fixture.top, "trees")
    const run = await within(
      fixture,
      Effect.gen(function* () {
        const root = yield* readyRoot(
          appConfig({ repo: fixture.repo, worktrees: trees, worktreesDefault: false }),
          { platform: "darwin", home: fixture.home, projects: fixture.projects },
        )
        return { root, calls: yield* callsOf }
      }),
    )
    expect(run.root.root).toBe(trees)
    expect(run.root.line).toBe(`${trees} (excluded from Time Machine; indexed by Spotlight)`)
    expect(run.calls).toEqual([`isexcluded ${trees}`, `addexclusion ${trees}`])
    // Nothing is moved from the old default for a root given.
    expect(existsSync(join(fixture.home, ".tutti"))).toBe(false)
  })
})

/** A folder at `path` with a file in it, as a worktree's checkout. */
const folder = (path: string) => {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, "README.md"), "# demo\n")
}

/** Worktrees under the old root, in Git's test layer and as folders: t-1, t-2 and a kept check's. */
const oldWorktrees = (fixture: Fixture) =>
  Effect.gen(function* () {
    const git = yield* Git
    for (const id of ["t-1", "t-2"]) {
      folder(join(fixture.old, id))
      yield* git.addWorktree(fixture.repo, join(fixture.old, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
    }
    folder(join(fixture.old, "full-check-abc"))
    yield* git.addDetachedWorktree(fixture.repo, join(fixture.old, "full-check-abc"), "main")
    folder(join(fixture.old, ".trash", "t-0-x1", "t-0"))
  })

const savedState = (fixture: Fixture): State => ({
  ...emptyState,
  tickets: {
    "t-1": {
      session: "11111111-1111-1111-1111-111111111111",
      worktree: join(fixture.old, "t-1"),
      branch: "tutti/t-1",
      suspended: "quit",
      resumes: 0,
      metadata: {},
    },
    "t-9": { worktree: "/elsewhere/t-9", resumes: 0, metadata: {} },
  },
})

describe("moving the old root's worktrees", () => {
  const worktreePaths = (fixture: Fixture) =>
    Effect.map(
      Effect.flatMap(Git, (git) => git.worktrees(fixture.repo)),
      (all) => all.map((each) => each.path),
    )

  test("each worktree, the kept check's and the trash moved, git repaired, state.json rewritten, the session folder renamed", async () => {
    const fixture = setUp()
    const root = join(fixture.home, ".tutti", "worktrees", "project")
    const oldSession = join(fixture.projects, sessionFolderName(join(fixture.old, "t-1")) as string)
    folder(oldSession)
    const run = await within(
      fixture,
      Effect.gen(function* () {
        yield* oldWorktrees(fixture)
        yield* writeState(fixture.repo, savedState(fixture))
        const ready_ = yield* ready(fixture)
        return {
          ready: ready_,
          paths: yield* worktreePaths(fixture),
          state: yield* readState(fixture.repo),
        }
      }),
    )
    expect(run.ready.root).toBe(root)
    expect(run.ready.notes).toEqual([
      `moved 3 worktrees from ${fixture.old} to ~/.tutti/worktrees/project`,
      `removed ${fixture.old}, the worktrees' old folder, empty`,
    ])
    expect(run.ready.warnings).toEqual([])
    expect(run.paths).toEqual([
      fixture.repo,
      join(root, "t-1"),
      join(root, "t-2"),
      join(root, "full-check-abc"),
    ])
    for (const name of ["t-1", "t-2", "full-check-abc"]) {
      expect(existsSync(join(root, name, "README.md"))).toBe(true)
    }
    expect(existsSync(join(root, ".trash", "t-0-x1", "t-0", "README.md"))).toBe(true)
    expect(existsSync(fixture.old)).toBe(false)
    expect(run.state.tickets["t-1"]?.worktree).toBe(join(root, "t-1"))
    expect(run.state.tickets["t-9"]?.worktree).toBe("/elsewhere/t-9")
    expect(existsSync(oldSession)).toBe(false)
    expect(existsSync(join(fixture.projects, sessionFolderName(join(root, "t-1")) as string))).toBe(
      true,
    )
  })

  test("a worktree whose session folder can't be renamed is left until its ticket ends", async () => {
    const fixture = setUp()
    const root = join(fixture.home, ".tutti", "worktrees", "project")
    folder(join(fixture.projects, sessionFolderName(join(fixture.old, "t-1")) as string))
    // Its new name is taken already.
    folder(join(fixture.projects, sessionFolderName(join(root, "t-1")) as string))
    const run = await within(
      fixture,
      Effect.gen(function* () {
        yield* oldWorktrees(fixture)
        yield* writeState(fixture.repo, savedState(fixture))
        const ready_ = yield* ready(fixture)
        return {
          ready: ready_,
          paths: yield* worktreePaths(fixture),
          state: yield* readState(fixture.repo),
          again: yield* ready(fixture),
        }
      }),
    )
    expect(run.ready.root).toBe(root)
    expect(run.ready.notes).toEqual([
      `moved 2 worktrees from ${fixture.old} to ~/.tutti/worktrees/project`,
      `left 1 worktree in ${fixture.old} until its ticket ends, as its Claude Code session can't be moved: t-1`,
    ])
    expect(run.paths).toEqual([
      fixture.repo,
      join(fixture.old, "t-1"),
      join(root, "t-2"),
      join(root, "full-check-abc"),
    ])
    expect(run.state.tickets["t-1"]?.worktree).toBe(join(fixture.old, "t-1"))
    // The new root has the repository's worktrees now: the next start moves nothing.
    expect(run.again.notes).toEqual([])
    expect(existsSync(join(fixture.old, "t-1", "README.md"))).toBe(true)
  })

  test("a failed move leaves everything where it was, and the run uses the old root", async () => {
    const fixture = setUp()
    const oldSession = join(fixture.projects, sessionFolderName(join(fixture.old, "t-1")) as string)
    folder(oldSession)
    const run = await within(
      fixture,
      Effect.gen(function* () {
        yield* oldWorktrees(fixture)
        yield* writeState(fixture.repo, savedState(fixture))
        yield* Effect.flatMap(Repository, (repository) => repository.fail("worktree repair"))
        const ready_ = yield* ready(fixture)
        return {
          ready: ready_,
          paths: yield* worktreePaths(fixture),
          state: yield* readState(fixture.repo),
        }
      }),
    )
    expect(run.ready.root).toBe(fixture.old)
    expect(run.ready.notes).toEqual([])
    expect(run.ready.warnings).toHaveLength(1)
    expect(run.ready.warnings[0]).toStartWith(
      `the worktrees in ${fixture.old} can't be moved to ~/.tutti/worktrees/project (`,
    )
    expect(run.ready.line).toStartWith(`${fixture.old} (`)
    expect(run.paths).toEqual([
      fixture.repo,
      join(fixture.old, "t-1"),
      join(fixture.old, "t-2"),
      join(fixture.old, "full-check-abc"),
    ])
    for (const name of ["t-1", "t-2", "full-check-abc"]) {
      expect(existsSync(join(fixture.old, name, "README.md"))).toBe(true)
    }
    expect(existsSync(join(fixture.old, ".trash", "t-0-x1", "t-0", "README.md"))).toBe(true)
    expect(existsSync(oldSession)).toBe(true)
    expect(run.state).toEqual(savedState(fixture))
  })

  test("a folder in the way fails the move before anything is moved", async () => {
    const fixture = setUp()
    folder(join(fixture.home, ".tutti", "worktrees", "project", "t-2"))
    const run = await within(
      fixture,
      Effect.gen(function* () {
        yield* oldWorktrees(fixture)
        const ready_ = yield* ready(fixture)
        return { ready: ready_, paths: yield* worktreePaths(fixture) }
      }),
    )
    expect(run.ready.root).toBe(fixture.old)
    expect(run.ready.warnings[0]).toContain("t-2 is there already")
    expect(run.paths.slice(1)).toEqual([
      join(fixture.old, "t-1"),
      join(fixture.old, "t-2"),
      join(fixture.old, "full-check-abc"),
    ])
  })
})
