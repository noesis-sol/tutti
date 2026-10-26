// The start question's Spec option in the renderer (§ 5 item 3, § 7.1): the field for the spec's
// file or URL, its Tab completion in a fixture folder, its file browser, each refusal under it, a URL
// fetched through the HttpClient's test layer, the refine step, Shift+Tab back, and Esc or Ctrl+C
// cancelling at each step.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { specAsk } from "../src/run/choose.ts"
import {
  fetchOnce,
  fetchSpec,
  type LiveFetch,
  type SpecFetch,
  specUrl,
} from "../src/run/specSource.ts"
import { type Answer, layer as httpLayer } from "../src/testing/HttpClient.ts"
import { browserRowsShown, specFilesOnly } from "../src/ui/FileBrowser.tsx"
import { type SpecAsk, TicketCount, Work } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const size = { width: 100, height: 32 }

/** A folder of its own, the repository the field starts at, with `files` (a `/` ends a folder). */
const fixture = (files: Readonly<Record<string, string>>): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-start-spec-")))
  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith("/")) mkdirSync(join(dir, file), { recursive: true })
    else {
      mkdirSync(join(dir, file, ".."), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
  }
  return dir
}

const services = Effect.runSync(
  Effect.context<LiveFetch>().pipe(Effect.provide(Layer.mergeAll(BunServices.layer))),
)

/** What the question asks of a spec in `repo`, URLs answered as `answers` script them. */
const asking = (
  repo: string,
  answers: Readonly<Record<string, Answer | "never">> = {},
  home = "",
): SpecAsk => {
  const fetch: SpecFetch<LiveFetch> = (target) =>
    Effect.provide(fetchSpec(target, join(repo, "no-gh-here")), httpLayer(answers))
  return specAsk(repo, home, fetch, services)
}

/** The start question asking with `spec`, and what it answered. */
const start = (spec: SpecAsk) => {
  const answers: Array<Work> = []
  let cancelled = 0
  const node = (
    <StartQuestion
      spec={spec}
      theme={theme}
      count={TicketCount.Ready({ n: 3 })}
      answer={(work) => {
        answers.push(work)
      }}
      cancel={() => {
        cancelled++
      }}
    />
  )
  return { answers, cancelled: () => cancelled, node }
}

/** Down and Enter: the Spec option chosen. */
const chooseSpec = (rendered: Rendered) =>
  rendered.input((setup) => {
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
  })

const type = (rendered: Rendered, text: string) =>
  rendered.input((setup) => setup.mockInput.typeText(text))

const key = (
  rendered: Rendered,
  name: string,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
) =>
  rendered.input((setup) =>
    name === "tab"
      ? setup.mockInput.pressTab(modifiers)
      : setup.mockInput.pressKey(name, modifiers),
  )

const enter = (rendered: Rendered) => rendered.input((setup) => setup.mockInput.pressEnter())

/** The field's line, `> ` and what is typed. */
const fieldLine = (frame: Frame): string =>
  frame.chars
    .split("\n")
    .find((line) => line.includes("┃ > ") && !line.includes("Current tickets"))
    ?.trim() ?? ""

/** The frame once `holds` is true of it, within 5 s. */
const until = async (rendered: Rendered, holds: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    await rendered.input(() => Bun.sleep(10))
    const frame = await rendered.capture()
    if (holds(frame)) return frame
    if (Date.now() > deadline) throw new Error(`not seen in 5 s:\n${frame.chars}`)
  }
}

/** The hint's line: the last that names what Esc does. */
const hintOf = (frame: Frame): string =>
  frame.chars
    .split("\n")
    .filter((line) => /Esc (cancel|close|stop)/.test(line))
    .at(-1)
    ?.replace(/^[\s│]*|[\s│]*$/g, "") ?? ""

/** The frame's text, its lines joined with a space, without a field's bar or a box's sides. */
const flat = (frame: Frame): string =>
  frame.chars
    .split("\n")
    .map((line) => line.replace(/^\s*[┃│]?\s*/, "").replace(/\s*│?\s*$/, ""))
    .join(" ")

describe("the Spec option", () => {
  test("asks for the spec's file, naming Tab and Ctrl+O", async () => {
    const { node } = start(asking(fixture({})))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      const frame = await rendered.capture()
      expect(frame.chars).toContain("> Spec: build what a spec file describes")
      expect(frame.chars).toContain("┃ Spec file")
      expect(frame.chars).toContain("Tab completes its path, and Ctrl+O browses")
      expect(hintOf(frame)).toBe(
        "Enter confirm · Tab complete · ↓↑ completions · Ctrl+O browse · Shift+Tab back · Esc cancel",
      )
    })
  })

  test("a spec file found, then run as it is or refined with Claude first", async () => {
    const repo = fixture({ "docs/shop.md": "# Shop\n" })
    for (const [refine, keys] of [
      [false, []],
      [true, ["down"]],
    ] as const) {
      const { answers, node } = start(asking(repo))
      await withRender(node, size, async (rendered) => {
        await chooseSpec(rendered)
        await type(rendered, "docs/shop.md")
        await enter(rendered)
        const frame = await rendered.capture()
        expect(frame.chars).toContain("Refine it with Claude first?")
        expect(frame.chars).toContain("> Run it as it is")
        expect(frame.chars).toContain("  Refine it with Claude first")
        for (const each of keys) await rendered.input((setup) => setup.mockInput.pressArrow(each))
        await enter(rendered)
      })
      expect(answers).toEqual([Work.Spec({ given: join(repo, "docs/shop.md"), refine })])
    }
  })

  test("Shift+Tab goes back a step, keeping what was typed", async () => {
    const repo = fixture({ "shop.md": "# Shop\n" })
    const { answers, node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, "shop.md")
      await enter(rendered)
      expect((await rendered.capture()).chars).toContain("Refine it with Claude first?")
      await key(rendered, "tab", { shift: true })
      let frame = await rendered.capture()
      expect(frame.chars).not.toContain("Refine it with Claude first?")
      expect(fieldLine(frame)).toBe("┃ > shop.md")
      await key(rendered, "tab", { shift: true })
      frame = await rendered.capture()
      expect(frame.chars).not.toContain("┃ Spec file")
      await enter(rendered)
      expect(fieldLine(await rendered.capture())).toBe("┃ > shop.md")
      await enter(rendered)
      await enter(rendered)
    })
    expect(answers).toEqual([Work.Spec({ given: join(repo, "shop.md"), refine: false })])
  })

  test.each([
    ["Esc in the field", [], "escape"],
    ["Ctrl+C in the field", [], "ctrl+c"],
    ["Esc at the refine step", ["shop.md"], "escape"],
    ["Ctrl+C at the refine step", ["shop.md"], "ctrl+c"],
  ] as const)("%s cancels", async (_, typed, cancel) => {
    const repo = fixture({ "shop.md": "# Shop\n" })
    const { answers, cancelled, node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      for (const text of typed) {
        await type(rendered, text)
        await enter(rendered)
      }
      await rendered.input((setup) => {
        if (cancel === "escape") pressEscape(setup)
        else setup.mockInput.pressCtrlC()
      })
    })
    expect(cancelled()).toBe(1)
    expect(answers).toEqual([])
  })

  test("says why a path won't do under the field", async () => {
    const repo = fixture({ "folder/": "", "empty.md": " \n", "shop.md": "# Shop\n" })
    writeFileSync(join(repo, "binary.md"), Buffer.from([0x61, 0x00]))
    for (const [typed, said] of [
      ["", "type the spec's path or URL, or press Ctrl+O to browse for it"],
      ["nope.md", "no such file: nope.md"],
      ["folder", "folder is a folder"],
      ["/dev/null", "/dev/null isn't a file"],
      ["empty.md", "empty.md is empty"],
      ["binary.md", "binary.md doesn't look like text"],
    ] as const) {
      const { answers, node } = start(asking(repo))
      await withRender(node, size, async (rendered) => {
        await chooseSpec(rendered)
        await type(rendered, typed)
        await enter(rendered)
        const frame = await rendered.capture()
        expect(frame.chars).toContain(said)
        expect(frame.chars).not.toContain("Refine it with Claude first?")
        // Typing again clears what was said.
        await type(rendered, "x")
        expect((await rendered.capture()).chars).not.toContain(said)
      })
      expect(answers).toEqual([])
    }
  })
})

describe("Tab's completion", () => {
  const repo = fixture({
    "docs/a.md": "# a\n",
    "drafts/": "",
    "design.md": "# d\n",
    "deploy.sh": "echo\n",
    "dull.txt": "dull\n",
    ".dotted.md": "# .\n",
  })

  test("fills in the part the completions share and lists them; Ctrl+N and Ctrl+P go through them", async () => {
    const { node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, "d")
      await key(rendered, "tab")
      let frame = await rendered.capture()
      expect(fieldLine(frame)).toBe("┃ > d")
      for (const item of ["design.md", "docs/", "drafts/", "dull.txt"]) {
        expect(frame.chars).toContain(`    ${item}`)
      }
      expect(frame.chars).not.toContain("deploy.sh")
      expect(frame.chars).not.toContain(".dotted.md")
      expect(hintOf(frame)).toContain("↓↑ completions")
      await key(rendered, "n", { ctrl: true })
      frame = await rendered.capture()
      expect(fieldLine(frame)).toBe("┃ > design.md")
      expect(frame.chars).toContain("  > design.md")
      await key(rendered, "n", { ctrl: true })
      expect(fieldLine(await rendered.capture())).toBe("┃ > docs/")
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      expect(fieldLine(await rendered.capture())).toBe("┃ > drafts/")
      await key(rendered, "p", { ctrl: true })
      await rendered.input((setup) => setup.mockInput.pressArrow("up"))
      expect(fieldLine(await rendered.capture())).toBe("┃ > design.md")
      // Typing closes the list.
      await type(rendered, "x")
      expect((await rendered.capture()).chars).not.toContain("    dull.txt")
    })
  })

  test("one completion is filled in whole; a folder's then completes inside it", async () => {
    const { answers, node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, "do")
      await key(rendered, "tab")
      expect(fieldLine(await rendered.capture())).toBe("┃ > docs/")
      await key(rendered, "tab")
      expect(fieldLine(await rendered.capture())).toBe("┃ > docs/a.md")
      await enter(rendered)
      await enter(rendered)
    })
    expect(answers).toEqual([Work.Spec({ given: join(repo, "docs/a.md"), refine: false })])
  })

  test("hidden ones only once a . is typed", async () => {
    const { node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, ".")
      await key(rendered, "tab")
      expect(fieldLine(await rendered.capture())).toBe("┃ > .dotted.md")
    })
  })

  test("nothing completes a URL, and the hint doesn't name Tab for one", async () => {
    const { node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, "https://example.com/d")
      await key(rendered, "tab")
      const frame = await rendered.capture()
      expect(fieldLine(frame)).toBe("┃ > https://example.com/d")
      expect(hintOf(frame)).toBe("Enter confirm · Ctrl+O browse · Shift+Tab back · Esc cancel")
    })
  })
})

describe("the file browser", () => {
  /** The browser's top border: `╭─ <folder> ──…╮`. */
  const borderOf = (frame: Frame): string => {
    const line = frame.chars.split("\n").find((each) => each.includes("╭─ ")) ?? ""
    return line.slice(line.indexOf("╭─ ")).trim()
  }

  test("opens at the repository, folders first, other files greyed; Esc closes it, the question kept", async () => {
    const repo = fixture({
      "specs/x.md": "# x\n",
      "b.md": "# b\n",
      "run.sh": "echo\n",
      ".env": "x",
    })
    const { answers, cancelled, node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await key(rendered, "o", { ctrl: true })
      const frame = await rendered.capture()
      expect(borderOf(frame)).toStartWith(`╭─ ${repo}/ `)
      const lines = frame.chars.split("\n").map((line) => line.trim())
      const at = (text: string) => lines.findIndex((line) => line.includes(text))
      expect(at("> ..")).toBeGreaterThan(0)
      expect(at("specs/")).toBe(at("> ..") + 1)
      expect(at("b.md")).toBe(at("specs/") + 1)
      expect(at("run.sh")).toBe(at("b.md") + 1)
      expect(frame.chars).not.toContain(".env")
      expect(frame.chars).toContain(specFilesOnly)
      expect(hintOf(frame)).toBe("↑↓ move · ← up a folder · Enter open or choose · Esc close")
      await rendered.input((setup) => pressEscape(setup))
      const closed = await rendered.capture()
      expect(borderOf(closed)).toBe("")
      expect(closed.chars).toContain("┃ Spec file")
    })
    expect(cancelled()).toBe(0)
    expect(answers).toEqual([])
  })

  test("opens at the folder typed so far; Enter opens a folder, ← goes up, Enter on a spec chooses it", async () => {
    const repo = fixture({ "specs/x.md": "# x\n", "specs/y.md": "# y\n", "other/": "" })
    const { answers, node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, "specs/")
      await key(rendered, "o", { ctrl: true })
      expect(borderOf(await rendered.capture())).toStartWith(`╭─ ${join(repo, "specs")}/ `)
      await rendered.input((setup) => setup.mockInput.pressArrow("left"))
      let frame = await rendered.capture()
      expect(borderOf(frame)).toStartWith(`╭─ ${repo}/ `)
      // Back onto the folder it left.
      expect(frame.chars).toContain("> specs/")
      await enter(rendered)
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      await enter(rendered)
      frame = await rendered.capture()
      expect(borderOf(frame)).toBe("")
      expect(fieldLine(frame)).toBe("┃ > specs/y.md")
      await enter(rendered)
      await enter(rendered)
    })
    expect(answers).toEqual([Work.Spec({ given: join(repo, "specs/y.md"), refine: false })])
  })

  test("a greyed file can't be chosen; a click on a row does what Enter on it does", async () => {
    const repo = fixture({ "run.sh": "echo\n", "shop.md": "# Shop\n" })
    const { answers, node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await key(rendered, "o", { ctrl: true })
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      await enter(rendered)
      let frame = await rendered.capture()
      expect(borderOf(frame)).not.toBe("")
      const lines = frame.chars.split("\n")
      const y = lines.findIndex((line) => line.includes("shop.md"))
      const x = (lines[y] ?? "").indexOf("shop.md")
      await rendered.input((setup) => setup.mockMouse.click(x + 1, y))
      frame = await rendered.capture()
      expect(borderOf(frame)).toBe("")
      expect(fieldLine(frame)).toBe("┃ > shop.md")
    })
    expect(answers).toEqual([])
  })

  test("doesn't go into a folder it can't read, and says why", async () => {
    const repo = fixture({ "locked/a.md": "# a\n" })
    chmodSync(join(repo, "locked"), 0o000)
    try {
      const { node } = start(asking(repo))
      await withRender(node, size, async (rendered) => {
        await chooseSpec(rendered)
        await key(rendered, "o", { ctrl: true })
        await rendered.input((setup) => setup.mockInput.pressArrow("down"))
        await enter(rendered)
        const frame = await rendered.capture()
        expect(borderOf(frame)).toStartWith(`╭─ ${repo}/ `)
        // Wrapped in the browser: `cannot open <folder>: <cause>`.
        expect(frame.chars).toContain("cannot open")
        expect(frame.chars).toContain(`${join(repo, "locked")}:`)
        expect(frame.chars).toContain("permission denied")
      })
    } finally {
      chmodSync(join(repo, "locked"), 0o755)
    }
  })

  test("shows ten rows at a time, scrolled by ↓ and the wheel", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [`f${String(i).padStart(2, "0")}.md`, "# f\n"]),
    )
    const repo = fixture(files)
    const { node } = start(asking(repo))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await key(rendered, "o", { ctrl: true })
      let frame = await rendered.capture()
      const shown = (f: Frame) => Object.keys(files).filter((name) => f.chars.includes(name))
      // `..` and nine files.
      expect(browserRowsShown).toBe(10)
      expect(shown(frame)).toHaveLength(9)
      expect(frame.chars).not.toContain("f09.md")
      for (let i = 0; i < 10; i++) {
        await rendered.input((setup) => setup.mockInput.pressArrow("down"))
      }
      frame = await rendered.capture()
      expect(frame.chars).toContain("> f09.md")
      expect(frame.chars).not.toContain(" ..")
      const lines = frame.chars.split("\n")
      const y = lines.findIndex((line) => line.includes("f05.md"))
      await rendered.input((setup) => setup.mockMouse.scroll(50, y, "down"))
      await rendered.input((setup) => setup.mockMouse.scroll(50, y, "down"))
      await rendered.input((setup) => setup.mockMouse.scroll(50, y, "down"))
      await rendered.input((setup) => setup.mockMouse.scroll(50, y, "down"))
      frame = await rendered.capture()
      expect(frame.chars).toContain("f13.md")
      expect(shown(frame)).toHaveLength(10)
    })
  })

  test("shows fewer rows on a short screen", async () => {
    const repo = fixture(
      Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`f${i}.md`, "# f\n"])),
    )
    const { node } = start(asking(repo))
    await withRender(node, { width: 80, height: 12 }, async (rendered) => {
      await chooseSpec(rendered)
      await key(rendered, "o", { ctrl: true })
      const frame = await rendered.capture()
      const rows = frame.chars.split("\n").filter((line) => /f\d+\.md|\.\./.test(line))
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThan(browserRowsShown)
      expect(frame.chars).toContain("╭─ ")
      expect(frame.chars).toContain("╰")
    })
  })
})

describe("a spec at a URL", () => {
  const url = "https://example.com/specs/shop.md"

  test("is fetched on Enter, a spinner in the field's place, then run", async () => {
    const repo = fixture({})
    const { answers, node } = start(asking(repo, { [url]: { body: "# Shop\n" } }))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, url)
      await enter(rendered)
      await until(rendered, (frame) => frame.chars.includes("Refine it with Claude first?"))
      await enter(rendered)
    })
    expect(answers).toEqual([Work.Spec({ given: url, refine: false })])
  })

  test("a fetch that fails says why under the field, the URL kept for fixing", async () => {
    const repo = fixture({})
    const { answers, node } = start(asking(repo, { [url]: { status: 500 } }))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, url)
      await enter(rendered)
      const frame = await until(rendered, (f) => f.chars.includes("Cannot fetch the spec"))
      expect(flat(frame)).toContain(
        `Cannot fetch the spec ${url} (chosen at the start): HTTP 500 Internal Server Error.`,
      )
      expect(fieldLine(frame)).toBe(`┃ > ${url}`)
    })
    expect(answers).toEqual([])
  })

  test("a URL that failed is fetched again on the next Enter, and what was fetched is kept", async () => {
    const repo = fixture({})
    let fetches = 0
    const flaky: SpecFetch<LiveFetch> = (target) => {
      fetches++
      return Effect.provide(
        fetchSpec(target, join(repo, "no-gh-here")),
        httpLayer(fetches === 1 ? { [url]: { status: 503 } } : { [url]: { body: "# Shop\n" } }),
      )
    }
    const once = fetchOnce(flaky, { failures: false })
    const { answers, node } = start(specAsk(repo, "", once, services))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, url)
      await enter(rendered)
      await until(rendered, (f) => flat(f).includes("HTTP 503 Service Unavailable"))
      await enter(rendered)
      await until(rendered, (f) => f.chars.includes("Refine it with Claude first?"))
      await enter(rendered)
    })
    expect(fetches).toBe(2)
    expect(answers).toEqual([Work.Spec({ given: url, refine: false })])
    // What was fetched is read again without fetching.
    await Effect.runPromise(
      once(Result.getOrThrow(specUrl(url, "chosen at the start"))).pipe(
        Effect.provideContext(services),
      ),
    )
    expect(fetches).toBe(2)
  })

  test("Esc during the fetch stops it, the question kept", async () => {
    const repo = fixture({})
    const { answers, cancelled, node } = start(asking(repo, { [url]: "never" }))
    await withRender(node, size, async (rendered) => {
      await chooseSpec(rendered)
      await type(rendered, url)
      await enter(rendered)
      let frame = await rendered.capture()
      expect(frame.chars).toContain("Fetching example.com…")
      expect(hintOf(frame)).toBe("Esc stop")
      await rendered.input((setup) => pressEscape(setup))
      frame = await rendered.capture()
      expect(frame.chars).not.toContain("Fetching example.com…")
      expect(fieldLine(frame)).toBe(`┃ > ${url}`)
    })
    expect(cancelled()).toBe(0)
    expect(answers).toEqual([])
  })
})
