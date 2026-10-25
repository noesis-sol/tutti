// Git.branches, the tickets' branches in one git for-each-ref where branchExists takes a show-ref
// each (tutti-ejkt.6): the branches under the folder by name, not its tags, nor branches elsewhere
// or of a longer folder name.

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import * as TestGit from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const liveGit = Git.layer().pipe(Layer.provide(GitWriter.layer), Layer.provide(BunServices.layer))

slow.describe("branches against a real repository", () => {
  test("lists the branches under the folder, by name", async () => {
    const repo = makeRepo()
    repo.branch("tutti/t-1")
    repo.branch("tutti/t-2.1")
    repo.branch("tuttix/t-3")
    repo.branch("other/t-4")
    repo.git(["tag", "tutti/t-5"])
    const names = await Effect.runPromise(
      Effect.flatMap(Effect.service(Git), (git) => git.branches(repo.dir, "tutti")).pipe(
        Effect.provide(liveGit),
      ),
    )
    expect([...names].sort()).toEqual(["tutti/t-1", "tutti/t-2.1"])
  })
})

describe("branches in the test layer", () => {
  test("lists the branches under the folder, as git does", async () => {
    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repo = (yield* TestGit.Repository).dir
        yield* git.createBranch(repo, "tutti/t-1", "main")
        yield* git.createBranch(repo, "tuttix/t-3", "main")
        return yield* git.branches(repo, "tutti")
      }).pipe(Effect.provide(TestGit.layer())),
    )
    expect(names).toEqual(["tutti/t-1"])
  })
})
