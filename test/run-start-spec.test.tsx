// A spec chosen at the start question, on the run's side (§ 5 item 3, § 4.14): the line that keeps
// it in sight once the renderer has gone, the spec read as --spec's is and taken (one git ignores,
// or in .git, ends the run with exit 2, naming it `chosen at the start`; else the lock is rewritten
// with it), and its breakdown's organ lines drawn in the renderer, Ctrl+C stopping it.
import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { eraseLine } from "../src/print/organLine.ts"
import { screenOut } from "../src/print/screenOut.ts"
import { cannotRunSpec, readChosenSpec, takeSpec } from "../src/run/choose.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { OrganScreen, organLines } from "../src/ui/OrganScreen.tsx"
import { chosenLines, specLine, Work } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"
import { withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

describe("the spec chosen, kept in sight", () => {
  test("names its path or URL, and whether it is refined first", () => {
    expect(specLine("/work/shop/docs/shop.md", false)).toBe(
      "Spec: /work/shop/docs/shop.md, run as it is",
    )
    expect(specLine("/work/shop/docs/shop.md", true)).toBe(
      "Spec: /work/shop/docs/shop.md, refined with Claude first",
    )
    // A URL without its query, which may hold a token.
    expect(specLine("https://example.com/shop.md?token=abc#top", false)).toBe(
      "Spec: https://example.com/shop.md, run as it is",
    )
    expect(chosenLines(Work.Spec({ given: "/a\x1b[2J.md", refine: false }))).toEqual([
      "Spec: /a.md, run as it is",
    ])
  })
})

describe("the spec chosen, read as --spec's", () => {
  const layer = Git.layer().pipe(
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )
  const read = (repo: string, given: string) =>
    Effect.runPromise(readChosenSpec(given, repo, () => Effect.never).pipe(Effect.provide(layer)))

  slow.test("is the spec, from its absolute path", async () => {
    const repo = makeRepo()
    repo.write({ "docs/shop.md": "# Shop\n" })
    const spec = await read(repo.dir, join(repo.dir, "docs/shop.md"))
    expect(Result.isSuccess(spec) && spec.success).toMatchObject({
      path: "docs/shop.md",
      from: "chosen at the start",
      copy: false,
    })
  })

  slow.test("one git ignores, or in .git, can't be run: exit 2's words", async () => {
    const repo = makeRepo()
    repo.commit("ignore drafts", { ".gitignore": "drafts/\n" })
    repo.write({ "drafts/shop.md": "# Shop\n" })
    writeFileSync(join(repo.dir, ".git", "shop.md"), "# Shop\n")
    expect(await read(repo.dir, join(repo.dir, "drafts/shop.md"))).toEqual(
      Result.fail(
        "tutti cannot run that spec: git ignores drafts/shop.md, where the spec (chosen at the start) is kept, and workers only see committed files: move the spec, or stop ignoring that path (git check-ignore -v drafts/shop.md says where).",
      ),
    )
    expect(await read(repo.dir, join(repo.dir, ".git/shop.md"))).toEqual(
      Result.fail(
        cannotRunSpec(
          `The spec ${join(repo.dir, ".git/shop.md")} (chosen at the start) is in the repository's .git folder, which git doesn't commit: move it.`,
        ),
      ),
    )
  })
})

describe("the spec chosen, taken", () => {
  const layer = Git.layer().pipe(
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )
  /** `given` taken in `repo`: what it said, the holders the lock was rewritten with, its outcome. */
  const take = async (repo: string, given: string, refine = false) => {
    const out: Array<string> = []
    const error: Array<string> = []
    const rewritten: Array<string> = []
    const taken = await Effect.runPromise(
      takeSpec(Work.Spec({ given, refine }) as Extract<Work, { _tag: "Spec" }>, {
        repo,
        fetch: () => Effect.never,
        out: (text) => {
          out.push(text)
        },
        error: (text) =>
          Effect.sync(() => {
            error.push(text)
          }),
        rewrite: (spec) =>
          Effect.sync(() => {
            rewritten.push(spec.path)
          }),
      }).pipe(Effect.provide(layer)),
    )
    return { out, error, rewritten, taken }
  }

  slow.test("prints the line, then rewrites the lock with the spec", async () => {
    const repo = makeRepo()
    repo.write({ "docs/shop.md": "# Shop\n" })
    const given = join(repo.dir, "docs/shop.md")
    const { out, error, rewritten, taken } = await take(repo.dir, given, true)
    expect(out).toEqual([`Spec: ${given}, refined with Claude first\n`])
    expect(error).toEqual([])
    expect(rewritten).toEqual(["docs/shop.md"])
    expect(taken).toMatchObject({ _tag: "Taken", spec: { path: "docs/shop.md" } })
  })

  slow.test("an ignored spec: the line, why, and exit 2, the lock left as it is", async () => {
    const repo = makeRepo()
    repo.commit("ignore drafts", { ".gitignore": "drafts/\n" })
    repo.write({ "drafts/shop.md": "# Shop\n" })
    const given = join(repo.dir, "drafts/shop.md")
    const { out, error, rewritten, taken } = await take(repo.dir, given)
    expect(out).toEqual([`Spec: ${given}, run as it is\n`])
    expect(error).toHaveLength(1)
    expect(error[0]).toStartWith("tutti cannot run that spec: git ignores drafts/shop.md")
    expect(rewritten).toEqual([])
    expect(taken).toEqual({ _tag: "Refused", exitCode: 2 })
  })
})

describe("the breakdown's organ lines in the renderer", () => {
  test("a line erased and rewritten is the line rewritten", () => {
    const drawn = screenOut(() => 80)
    drawn.out.write("committed the spec docs/shop.md\n")
    drawn.out.write(`${eraseLine}⣾ Breaking the spec down 0:01`)
    drawn.out.write(`${eraseLine}⣽ Breaking the spec down 0:02`)
    expect(drawn.text.get()).toBe("committed the spec docs/shop.md\n⣽ Breaking the spec down 0:02")
    drawn.out.write(`${eraseLine}◆ Spec broken down\n`)
    expect(drawn.text.get()).toBe("committed the spec docs/shop.md\n◆ Spec broken down\n")
    const lines = organLines(drawn.text.get(), 80, 1)
    expect(lines.map((line) => line.map((each) => each.text).join(""))).toEqual([
      "◆ Spec broken down",
    ])
  })

  test("shows them, and Ctrl+C stops the breakdown", async () => {
    const drawn = screenOut(() => 80)
    drawn.out.write(`${eraseLine}⣾ Breaking the spec down with Claude… (Ctrl+C stops) 0:03`)
    let stopped = 0
    const node = (
      <OrganScreen
        theme={theme}
        text={drawn.text}
        stop={() => {
          stopped++
        }}
      />
    )
    await withRender(node, { width: 80, height: 10 }, async (rendered) => {
      const frame = await rendered.capture()
      expect(frame.chars).toContain("⣾ Breaking the spec down with Claude… (Ctrl+C stops) 0:03")
      expect(frame.chars).toContain("Ctrl+C stop")
      await rendered.input((setup) => setup.mockInput.pressCtrlC())
    })
    expect(stopped).toBe(1)
  })
})
