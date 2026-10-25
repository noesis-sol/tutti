import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, Schema } from "effect"
import fc from "fast-check"
import { TicketId } from "../src/services/Beads.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import {
  BadTicketId,
  checkTicketId,
  ticketIdProblem,
  Worktrees,
} from "../src/services/Worktrees.ts"
import { layer as tempLayer, type WorktreeCall } from "../src/testing/Worktrees.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

const withWorktrees = <A, E>(use: (worktrees: Worktrees["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.service(Worktrees), use)

describe("checkTicketId", () => {
  test("gives back any ID ticketIdProblem takes, and BadTicketId saying why for any other", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 16 }), (text) => {
        const exit = Effect.runSync(Effect.exit(checkTicketId(text)))
        const why = ticketIdProblem(text)
        if (why === undefined) expect(exit).toEqual(Exit.succeed(text as TicketId))
        else expect(exit).toEqual(Exit.fail(new BadTicketId({ id: text, why })))
      }),
    )
  })

  test("a state.json or bd ID decodes as one unchecked: checkTicketId checks it", () => {
    const id = Schema.decodeUnknownSync(TicketId)("x-../../y")
    expect(id).toBe("x-../../y" as TicketId)
    expect(Effect.runSync(Effect.flip(checkTicketId(id)))).toBeInstanceOf(BadTicketId)
  })
})

describe("removing a ticket's worktree", () => {
  test("takes an ID unchecked, and the test layer deletes nothing for one prepare refuses", async () => {
    const parent = tempDir("tutti-remove-")
    const root = join(parent, "worktrees")
    mkdirSync(join(root, "x"), { recursive: true })
    mkdirSync(join(parent, "y"))
    const calls: Array<WorktreeCall> = []
    const id = "x/../../y" as TicketId
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          withWorktrees((w) => w.remove(id)),
          tempLayer({ root }, calls),
        ),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(calls).toEqual([{ op: "remove", id, force: false }])
    expect(readdirSync(parent).sort()).toEqual(["worktrees", "y"])
    expect(readdirSync(root)).toEqual(["x"])
  })

  slow.test("in a real repository, a bad ID names no branch, and nothing is removed", async () => {
    const repo = makeRepo()
    const root = join(dirname(repo.dir), "repo-tutti")
    const layer = Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
      Layer.provideMerge(Git.layer()),
      Layer.provideMerge(GitWriter.layer),
      Layer.provideMerge(BunServices.layer),
    )
    const run = <A, E>(effect: Effect.Effect<A, E, Worktrees>) =>
      Effect.runPromise(Effect.provide(effect, layer))
    const kept = await run(withWorktrees((w) => w.prepare("demo-1" as TicketId)))
    for (const id of ["x-../../y", "demo-1 --force", "x@{-1}"]) {
      await run(withWorktrees((w) => w.remove(id as TicketId)))
    }
    expect(existsSync(kept.path)).toBe(true)
    expect(repo.git(["branch", "--list", "--format=%(refname:short)", "tutti/*"]).trim()).toBe(
      "tutti/demo-1",
    )
  })
})
