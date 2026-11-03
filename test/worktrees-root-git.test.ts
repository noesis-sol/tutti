// The move of the old <repo>-tutti worktrees into ~/.tutti/worktrees/<repo> (src/run/worktreesRoot.ts)
// with real git: each worktree moved and repaired, git worktree list naming them where they went and
// each a working checkout on its branch, state.json rewritten; a failed move leaves git's records and
// every folder as they were.
import { expect } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { oldDefaultRoot, readyRoot } from "../src/run/worktreesRoot.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { emptyState, readState, writeState } from "../src/services/Store.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as timeMachineLayer } from "../src/testing/TimeMachine.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

/** A real repository with t-1 on its branch and a kept check's detached worktree in the old root. */
const setUp = () => {
  const repo = makeRepo()
  const old = oldDefaultRoot(repo.dir)
  const home = join(dirname(repo.dir), "home")
  const projects = join(home, ".claude", "projects")
  mkdirSync(projects, { recursive: true })
  repo.git(["worktree", "add", "--quiet", "-b", "tutti/t-1", join(old, "t-1"), "main"])
  repo.commit("t-1: Work", { "work.txt": "work\n" }, join(old, "t-1"))
  repo.git(["worktree", "add", "--quiet", "--detach", join(old, "full-check-abc"), "main"])
  return { repo, old, home, projects, root: join(home, ".tutti", "worktrees", "repo") }
}

type Fixture = ReturnType<typeof setUp>

const ready = (fixture: Fixture) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* writeState(fixture.repo.dir, {
        ...emptyState,
        tickets: {
          "t-1": {
            worktree: join(fixture.old, "t-1"),
            branch: "tutti/t-1",
            suspended: "quit",
            resumes: 0,
            metadata: {},
          },
        },
      })
      const root = yield* readyRoot(
        appConfig({
          repo: fixture.repo.dir,
          worktreesDefault: true,
          settings: defaultSettings,
        }),
        { platform: "linux", home: fixture.home, projects: fixture.projects },
      )
      // git lists the linked worktrees in the order of its records' names.
      const listed = yield* Effect.map(
        Effect.flatMap(Git, (git) => git.worktrees(fixture.repo.dir)),
        (all) => all.toSorted((a, b) => a.path.localeCompare(b.path)),
      )
      return { root, listed, state: yield* readState(fixture.repo.dir) }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Git.layer(), timeMachineLayer()).pipe(
          Layer.provideMerge(GitWriter.layer),
          Layer.provideMerge(BunServices.layer),
        ),
      ),
    ),
  )

slow.test("the old root's worktrees are moved and repaired, and work where they went", async () => {
  const fixture = setUp()
  const { root, listed, state } = await ready(fixture)
  expect(root.root).toBe(fixture.root)
  expect(root.notes).toEqual([
    `moved 2 worktrees from ${fixture.old} to ~/.tutti/worktrees/repo`,
    `removed ${fixture.old}, the worktrees' old folder, empty`,
  ])
  expect(listed.map((each) => [each.path, each.branch ?? null, each.prunable])).toEqual([
    [join(fixture.root, "full-check-abc"), null, false],
    [join(fixture.root, "t-1"), "tutti/t-1", false],
    [fixture.repo.dir, "main", false],
  ])
  const t1 = join(fixture.root, "t-1")
  expect(fixture.repo.git(["symbolic-ref", "--short", "HEAD"], t1).trim()).toBe("tutti/t-1")
  expect(readFileSync(join(t1, "work.txt"), "utf8")).toBe("work\n")
  expect(fixture.repo.git(["status", "--porcelain"], t1)).toBe("")
  expect(state.tickets["t-1"]?.worktree).toBe(t1)
  expect(existsSync(fixture.old)).toBe(false)
})

slow.test("a failed move leaves git's records and the folders as they were", async () => {
  const fixture = setUp()
  // A folder in the way of the second worktree.
  mkdirSync(join(fixture.root, "full-check-abc", "x"), { recursive: true })
  const { root, listed, state } = await ready(fixture)
  expect(root.root).toBe(fixture.old)
  expect(root.warnings).toHaveLength(1)
  expect(listed.map((each) => [each.path, each.prunable])).toEqual([
    [fixture.repo.dir, false],
    [join(fixture.old, "full-check-abc"), false],
    [join(fixture.old, "t-1"), false],
  ])
  expect(
    fixture.repo.git(["symbolic-ref", "--short", "HEAD"], join(fixture.old, "t-1")).trim(),
  ).toBe("tutti/t-1")
  expect(state.tickets["t-1"]?.worktree).toBe(join(fixture.old, "t-1"))
})
