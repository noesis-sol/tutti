// The start question's Spec option as lines (§ 5 item 3, § 7.1), for TERM=dumb and fewer than 256
// colours: the spec's path or URL read as a line, with the renderer's checks and no completion or
// browser, run as it is; the end of input (Ctrl+D) cancels at each step.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { Effect, Exit } from "effect"
import { askLines } from "../src/run/choose.ts"
import { type SpecAsk, TicketCount, Work } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

// biome-ignore lint/suspicious/noControlCharactersInRegex: the output's escape sequences
const unstyled = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "")

const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-lines-")))
writeFileSync(join(repo, "shop.md"), "# Shop\n")
writeFileSync(join(repo, "empty.md"), "\n")

/** URLs answered: one that is a spec, the others failing as a fetch fails. */
const spec: SpecAsk = {
  where: { repo, home: "" },
  checkUrl: (url) =>
    Effect.succeed(
      url === "https://example.com/shop.md"
        ? null
        : `Cannot fetch the spec ${url} (chosen at the start): HTTP 404 Not Found.`,
    ),
}

/** The question asked over `typed`, the input ending after it: its exit, and what it wrote. */
const ask = async (typed: string) => {
  const stdin = new PassThrough()
  stdin.write(typed)
  stdin.end()
  let output = ""
  const exit = await Effect.runPromiseExit(
    askLines(
      stdin,
      (text) => {
        output += text
      },
      theme,
      TicketCount.Ready({ n: 3 }),
      spec,
    ),
  )
  return { exit, output: unstyled(output) }
}

describe("the Spec option as lines", () => {
  test("2 asks for the spec's path, from the repository, and runs it as it is", async () => {
    const { exit, output } = await ask("2\nshop.md\n")
    expect(exit).toEqual(Exit.succeed(Work.Spec({ given: join(repo, "shop.md"), refine: false })))
    expect(output).toContain("2. Spec: build what a spec file describes\n")
    expect(output).toContain("Spec file\n")
    // No completion or browser to name, and no refine step.
    expect(output).not.toContain("Ctrl+O")
    expect(output).not.toContain("Refine it")
  })

  test("asks again, saying why, until the path or URL names a spec", async () => {
    const { exit, output } = await ask(
      "2\n\nnope.md\nempty.md\nhttps://example.com/gone.md\n'shop.md'\n",
    )
    expect(exit).toEqual(Exit.succeed(Work.Spec({ given: join(repo, "shop.md"), refine: false })))
    expect(output).toContain("type the spec's path or URL\n")
    expect(output).toContain("no such file: nope.md\n")
    expect(output).toContain("empty.md is empty\n")
    expect(output).toContain("Fetching example.com…\n")
    expect(output).toContain(
      "Cannot fetch the spec https://example.com/gone.md (chosen at the start): HTTP 404 Not Found.\n",
    )
  })

  test("takes a URL that fetches", async () => {
    const { exit } = await ask("2\n  https://example.com/shop.md  \n")
    expect(exit).toEqual(
      Exit.succeed(Work.Spec({ given: "https://example.com/shop.md", refine: false })),
    )
  })

  test("the end of input cancels it at the path", async () => {
    const { exit } = await ask("2\nnope.md\n")
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("FormCancelled")
  })
})
