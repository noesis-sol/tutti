// A commit's hash as a type of its own (Git.ts's Sha): made where git gives it or Sha.parse reads
// it, and undefined, not "", where git couldn't say. The marks in state.json leave out a commit not
// known, and read the "" an earlier run wrote as none; the lines and prompts say nothing of it.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { aheadJson, rebasedAheadOf } from "../src/run/ahead.ts"
import { attemptAt, leftAt } from "../src/run/branch.ts"
import { markUnchecked, uncheckedKey, uncheckedOf } from "../src/run/check.ts"
import { type HandBack, handBackOver, handBackTaken } from "../src/run/handback.ts"
import { line } from "../src/run/log.ts"
import { Sha } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { layer as memoryStore } from "../src/testing/Store.ts"

const hash = "0123456789abcdef0123456789abcdef01234567" as Sha

describe("Sha.parse", () => {
  test("takes a commit hash, abbreviated or whole, and nothing else", () => {
    expect(Sha.parse(hash)).toBe(hash)
    expect(Sha.parse("abc1234")).toBe("abc1234" as Sha)
    for (const not of ["", "abc12", "--upload-pack=x", "ABC1234", " abc1234", 7, null, undefined]) {
      expect(Sha.parse(not)).toBeUndefined()
    }
  })

  test("gives a hash git can't take for an option or a range, whatever it is given", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.jsonValue()), (value) => {
        const parsed = Sha.parse(value)
        if (parsed !== undefined) expect(parsed).toMatch(/^[0-9a-f]{7,64}$/)
      }),
    )
  })
})

describe("the marks in state.json", () => {
  test("an earlier run's \"\" for a commit git couldn't say is read as none", () => {
    expect(uncheckedOf({ fork: "", head: "" })).toEqual({ fork: undefined, head: undefined })
    expect(rebasedAheadOf({ orig: hash, onto: "", head: "", behind: "tutti/a" })).toEqual({
      orig: hash,
      onto: undefined,
      head: undefined,
      behind: "tutti/a",
      setUp: false,
    })
  })

  test("the train's mark leaves out a commit not known, and reads back as it was", () => {
    const mark = { orig: hash, onto: undefined, head: undefined, behind: "tutti/a", setUp: true }
    expect(aheadJson(mark)).toEqual({ orig: hash, behind: "tutti/a", setUp: true })
    expect(rebasedAheadOf(aheadJson(mark))).toEqual(mark)
    const known = { ...mark, onto: "abc1234" as Sha, head: "def5678" as Sha }
    expect(rebasedAheadOf(aheadJson(known))).toEqual(known)
  })

  test("the rebased-and-unchecked mark leaves out a commit not known", async () => {
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        yield* markUnchecked("a", { fork: hash, head: undefined })
        return (yield* (yield* Store).metadata("a"))[uncheckedKey]
      }).pipe(Effect.provide(memoryStore())),
    )
    expect(saved).toEqual({ fork: hash })
    expect(uncheckedOf(saved)).toEqual({ fork: hash, head: undefined })
  })
})

describe("what is said of a commit git couldn't say", () => {
  const handBack: HandBack = {
    ticket: { id: "b", title: "Ticket b", branch: "tutti/b", worktree: "/w/b" },
    mode: "fixing",
    prompt: "",
    what: line``,
    onto: "1111111111aaaa" as Sha,
    to: "2222222222bbbb" as Sha,
    done: Effect.succeed(false),
  }

  test("a hand-back taken as it is names no commit", () => {
    const told = handBackTaken(handBack, "20m", undefined, "scripts/check-fast.sh")
    expect(told).toContain("takes tutti/b as it is now, to check with 'scripts/check-fast.sh'")
    expect(told).not.toContain(" at ")
  })

  test("a hand-back over with nothing committed keeps none of it", () => {
    expect(handBackOver(handBack, "20m", undefined)).toContain(
      "Nothing of your attempt was committed, so none of it is kept.",
    )
  })

  test("a branch not put back is left where it is, its worker's attempt not named", () => {
    expect(leftAt(undefined)).toBe("where it is")
    expect(leftAt(hash)).toBe("at 0123456789")
    expect(attemptAt(undefined)).toBe("")
    expect(attemptAt(hash)).toBe(" (its worker's attempt is 0123456789)")
  })
})
