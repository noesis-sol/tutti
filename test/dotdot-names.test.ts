// A file or folder whose name starts with `..` is inside its parent: the paths shown from the
// repository or from `~` treat it so, and only `..` itself, alone or before a separator, as above.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit } from "effect"
import type { SetupProblem } from "../src/core/AppConfig.ts"
import { loadWorkerPrompt } from "../src/project/prompt.ts"
import { fromHome } from "../src/project/userConfig.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { shownPath, tildeOf } from "../src/ui/specPath.ts"

const where = { repo: "/home/me/shop", home: "/home/me" }

describe("the spec form's paths", () => {
  test("a spec named ..<name> in the repository is shown from the repository", () => {
    expect(shownPath("/home/me/shop/..spec.md", where)).toBe("..spec.md")
    expect(shownPath("/home/me/shop/..docs/a.md", where)).toBe("..docs/a.md")
  })

  test("a file beside the repository is still shown from ~", () => {
    expect(shownPath("/home/me/..shop.md", where)).toBe("~/..shop.md")
    expect(shownPath("/home/me/other/a.md", where)).toBe("~/other/a.md")
  })

  test("a folder named ..<name> in the home folder is shown from ~", () => {
    expect(tildeOf("/home/me/..specs/a.md", "/home/me")).toBe("~/..specs/a.md")
    expect(tildeOf("/home/me/..", "/home/me")).toBe("/home/me/..")
    expect(tildeOf("/home/a.md", "/home/me")).toBe("/home/a.md")
  })
})

describe("fromHome", () => {
  test("a folder named ..<name> in the home folder is shown from ~", () => {
    expect(fromHome("/home/me/..worktrees", "/home/me")).toBe("~/..worktrees")
    expect(fromHome("/home/other", "/home/me")).toBe("/home/other")
    expect(fromHome("/home/me", "/home/me")).toBe("/home/me")
  })
})

describe("the worker prompt's problems", () => {
  test("name a --prompt file named ..<name> in the project from its top", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-dotdot-")))
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(join(repo, ".tutti", "settings.json"), "{}\n")
    const prompt = join(repo, "..prompt.md")
    writeFileSync(prompt, "No placeholder.\n")
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          loadWorkerPrompt(TestAppConfig.appConfig({ prompt }, repo)),
          BunServices.layer,
        ),
      ),
    )
    if (Exit.isSuccess(exit)) throw new Error("it succeeded")
    const reason = exit.cause.reasons.find((each) => each._tag === "Fail")
    if (reason === undefined) throw new Error(`not a failure: ${Cause.pretty(exit.cause)}`)
    expect((reason.error as SetupProblem).problems).toEqual([
      "Worker prompt has no TICKET_ID placeholder: ..prompt.md (from --prompt or TUTTI_PROMPT).",
    ])
  })
})
