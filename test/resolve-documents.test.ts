import { describe, expect, test } from "bun:test"
import type { RebaseStop } from "../src/run/handback.ts"
import { resolvePrompt } from "../src/run/told.ts"
import type { TicketId } from "../src/services/Beads.ts"
import type { Sha } from "../src/services/Git.ts"

const check = "scripts/check-fast.sh"

const stopOn = (files: ReadonlyArray<string>): RebaseStop => ({
  ticket: { id: "a" as TicketId, title: "A", branch: "tutti/a", worktree: "/w/a" },
  onto: "abc" as Sha,
  fork: "123" as Sha,
  head: "def" as Sha,
  own: 1,
  files,
})

const testsAsked =
  "run the tests of the code you changed and of the files that conflicted in the foreground until they pass"

describe("the prompt for a rebase stopped on conflicts", () => {
  test("on documents only, asks for the resolution and the rebase, not the tests", () => {
    const prompt = resolvePrompt(
      stopOn([".orchestra/specs/tutti-spec.md", "notes.txt"]),
      "main",
      check,
    )
    expect(prompt).toStartWith(
      "tutti: main moved on while you worked; rebasing tutti/a onto it stopped on conflicts in .orchestra/specs/tutti-spec.md, notes.txt. ",
    )
    expect(prompt).toContain("GIT_EDITOR=true git rebase --continue")
    expect(prompt).not.toContain(testsAsked)
    expect(prompt).toContain(
      `As only documents conflicted, run no tests once the rebase has finished: leave the whole check, '${check}', to tutti, which runs it on the branch next.`,
    )
    expect(prompt).toContain(
      "If the rebase stops on another commit on conflicts in code, then once it has finished run the tests of the code you changed and of those files in the foreground until they pass",
    )
    expect(prompt).toEndWith("Say DONE when the rebase is complete.")
  })

  test("on code only, asks for the tests of the change and of the files", () => {
    const prompt = resolvePrompt(stopOn(["src/a.ts", "src/b.ts"]), "main", check)
    expect(prompt).toContain(testsAsked)
    expect(prompt).not.toContain("documents conflicted")
    expect(prompt).toContain(
      `Leave the whole check, '${check}', to tutti: it runs it on the branch next.`,
    )
    expect(prompt).toEndWith("Say DONE when the rebase is complete and those tests pass.")
  })

  test("on documents and code, asks for the tests as on code alone", () => {
    const prompt = resolvePrompt(stopOn(["CHANGELOG.md", "src/a.ts"]), "main", check)
    expect(prompt).toContain(testsAsked)
    expect(prompt).not.toContain("documents conflicted")
    expect(prompt).toEndWith("Say DONE when the rebase is complete and those tests pass.")
  })

  test("keeps the setup's step either way", () => {
    const setup = "As the rebase brings in a change to package.json, run the setup. "
    for (const files of [["README.md"], ["src/a.ts"]]) {
      expect(resolvePrompt(stopOn(files), "main", check, setup)).toContain(
        `instead of resolving it. ${setup}`,
      )
    }
  })
})
