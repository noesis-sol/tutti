// A revert's ticket IDs (src/services/scorecard.ts' revertsIn): bd's IDs whose prefix has hyphens of its
// own, as a project named my-app gets (`my-app-a3f2`), are read as well as single-hyphen ones, so a
// merged revert of such a ticket goes on its scorecard; anything tutti couldn't run as a ticket isn't.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Sha } from "../src/services/Git.ts"
import { revertsIn } from "../src/services/scorecard.ts"
import { ticketIdProblem } from "../src/services/Worktrees.ts"

const commit = (subject: string) => ({ hash: "abcdef1234" as Sha, subject })

describe("a revert's ticket IDs", () => {
  test("a prefix with hyphens of its own is read whole", () => {
    expect(revertsIn([commit('Revert "Add the stream (my-app-a3f2)"')], "my-app-b7c1")).toEqual([
      { ticket: "my-app-a3f2", commit: "abcdef1234" },
    ])
    expect(
      revertsIn([commit('Revert "Two (my-big-app-a3f2.1, my-app-c9.2.3)"')], "my-app-b7c1").map(
        (each) => each.ticket,
      ),
    ).toEqual(["my-big-app-a3f2.1", "my-app-c9.2.3"])
  })

  test("the merging ticket itself, a hyphenated one included, isn't its own revert", () => {
    expect(revertsIn([commit('Revert "Mine (my-app-a3f2)"')], "my-app-a3f2")).toEqual([])
  })

  test("words with no hyphen, or ones that end in a hyphen, aren't IDs", () => {
    expect(revertsIn([commit('Revert "Oops (docs, my-app-, -a3f2, my--a3f2)"')], "t-9")).toEqual([])
  })

  test("every ID read is a hyphenated name tutti can run as a ticket", () => {
    const part = fc.stringMatching(/^[A-Za-z0-9_]{1,6}$/)
    fc.assert(
      fc.property(
        fc.array(part, { minLength: 2, maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 99 }), { maxLength: 2 }),
        (parts, levels) => {
          const id = [parts.join("-"), ...levels].join(".")
          const found = revertsIn([commit(`Revert "Something (${id})"`)], "zz-other-1")
          expect(found.map((each) => each.ticket)).toEqual(id === "zz-other-1" ? [] : [id])
          expect(ticketIdProblem(id)).toBeUndefined()
        },
      ),
    )
  })
})
