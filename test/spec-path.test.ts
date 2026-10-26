// The start question's Spec file field, read (§ 5 item 3): what was typed as a path or a URL, with
// quotes, backslash-escaped spaces, ~ and relative paths; Tab's completions in a folder; the file
// browser's rows and moves; and the file's checks, each refusal in its words.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import fc from "fast-check"
import {
  cannotOpen,
  enterRow,
  moveBy,
  openBrowser,
  type ReadFolder,
  scrollBy,
  specFilesOnly,
  upFolder,
} from "../src/ui/FileBrowser.tsx"
import { causeOf, fileProblem, readFolder } from "../src/ui/specFiles.ts"
import {
  browserRows,
  completeHome,
  completing,
  completions,
  type Entry,
  folderLabel,
  isSpecName,
  readTyped,
  sharedStart,
  shownPath,
  unquoted,
  type Where,
} from "../src/ui/specPath.ts"

const where: Where = { repo: "/work/shop", home: "/home/me" }
const nothing = () => false

/** A path segment: no `/`, no quote or backslash, no space at its ends, not `.` or `..`. */
const segment = fc
  .stringMatching(/^[A-Za-z0-9._-][A-Za-z0-9 ._-]{0,10}[A-Za-z0-9._-]$|^[A-Za-z0-9_-]$/)
  .filter((name) => name !== "." && name !== "..")

const relativePath = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"))

describe("reading what was typed", () => {
  test("nothing, a URL, or a path from the repository or the home folder", () => {
    expect(readTyped("   ", where, nothing)).toEqual({ _tag: "Empty" })
    expect(readTyped(" https://example.com/spec.md ", where, nothing)).toEqual({
      _tag: "Url",
      url: "https://example.com/spec.md",
    })
    expect(readTyped("docs/spec.md", where, nothing)).toEqual({
      _tag: "Path",
      path: "/work/shop/docs/spec.md",
    })
    expect(readTyped("~", where, nothing)).toEqual({ _tag: "Path", path: "/home/me" })
    expect(readTyped("~/specs/a.md", where, nothing)).toEqual({
      _tag: "Path",
      path: "/home/me/specs/a.md",
    })
    expect(readTyped("/srv/a.md", where, nothing)).toEqual({ _tag: "Path", path: "/srv/a.md" })
    expect(readTyped("'/srv/my spec.md'", where, nothing)).toEqual({
      _tag: "Path",
      path: "/srv/my spec.md",
    })
    // ~ unknown: a folder of that name.
    expect(readTyped("~/a.md", { ...where, home: "" }, nothing)).toEqual({
      _tag: "Path",
      path: "/work/shop/~/a.md",
    })
  })

  test("a dropped file, its spaces escaped, is the file it names, where that is one", () => {
    const there = (path: string) => path === "/srv/my spec.md"
    expect(readTyped("/srv/my\\ spec.md", where, there)).toEqual({
      _tag: "Path",
      path: "/srv/my spec.md",
    })
    // Where it names nothing either way, the path as typed.
    expect(readTyped("/srv/no\\ spec.md", where, there)).toEqual({
      _tag: "Path",
      path: "/srv/no\\ spec.md",
    })
  })

  test("a relative path starts at the repository, ~/ at the home folder (property)", () => {
    fc.assert(
      fc.property(relativePath, (path) => {
        expect(readTyped(path, where, nothing)).toEqual({
          _tag: "Path",
          path: join(where.repo, path),
        })
        expect(readTyped(`~/${path}`, where, nothing)).toEqual({
          _tag: "Path",
          path: join(where.home, path),
        })
      }),
    )
  })

  test("quotes and the spaces around a path change nothing (property)", () => {
    fc.assert(
      fc.property(
        relativePath,
        fc.constantFrom("'", '"'),
        fc.stringMatching(/^ {0,3}$/),
        (path, quote, pad) => {
          const plain = readTyped(path, where, nothing)
          expect(readTyped(`${pad}${quote}${path}${quote}${pad}`, where, nothing)).toEqual(plain)
          expect(readTyped(`${pad}${path}${pad}`, where, nothing)).toEqual(plain)
        },
      ),
    )
  })

  test("a path with its spaces escaped reads as the path, where that names a file (property)", () => {
    fc.assert(
      fc.property(relativePath, (path) => {
        const full = join(where.repo, path)
        const escaped = path.replaceAll(" ", "\\ ")
        expect(readTyped(escaped, where, (at) => at === full)).toEqual({
          _tag: "Path",
          path: full,
        })
      }),
    )
  })

  test("a URL is told from a path: what starts with a scheme and :// (property)", () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ["https", "http"] }), (url) => {
        expect(readTyped(url, where, nothing)).toEqual({ _tag: "Url", url })
      }),
    )
    fc.assert(
      fc.property(relativePath, (path) => {
        expect(readTyped(path, where, nothing)._tag).toBe("Path")
      }),
    )
  })

  test("never fails, whatever is typed (property)", () => {
    fc.assert(
      fc.property(fc.string(), (typed) => {
        const read = readTyped(typed, where, nothing)
        if (read._tag === "Path") expect(read.path.startsWith("/")).toBe(true)
        if (read._tag === "Empty") expect(unquoted(typed)).toBe("")
      }),
    )
  })
})

const entries: ReadonlyArray<Entry> = [
  { name: "docs", folder: true },
  { name: "drafts", folder: true },
  { name: "design.md", folder: false },
  { name: "deploy.sh", folder: false },
  { name: "data.markdown", folder: false },
  { name: "dull.txt", folder: false },
  { name: ".dotfolder", folder: true },
  { name: ".draft.md", folder: false },
  { name: "README.MD", folder: false },
]

describe("Tab's completions", () => {
  test("folders and .md, .markdown and .txt files, as the whole path typed", () => {
    const at = { folder: "/work/shop", before: "", name: "d" }
    expect(completions(at, entries)).toEqual([
      "data.markdown",
      "design.md",
      "docs/",
      "drafts/",
      "dull.txt",
    ])
    expect(completions({ ...at, before: "specs/", name: "" }, entries)).toEqual([
      "specs/README.MD",
      "specs/data.markdown",
      "specs/design.md",
      "specs/docs/",
      "specs/drafts/",
      "specs/dull.txt",
    ])
  })

  test("hidden ones only once a . is typed", () => {
    expect(completions({ folder: "/x", before: "", name: "." }, entries)).toEqual([
      ".dotfolder/",
      ".draft.md",
    ])
  })

  test("in the folder typed so far, the repository with none; nothing completes a URL", () => {
    expect(completing("doc", where, nothing)).toEqual({
      folder: "/work/shop",
      before: "",
      name: "doc",
    })
    expect(completing("~/specs/sh", where, nothing)).toEqual({
      folder: "/home/me/specs",
      before: "~/specs/",
      name: "sh",
    })
    expect(completing("/srv/", where, nothing)).toEqual({
      folder: "/srv",
      before: "/srv/",
      name: "",
    })
    expect(completing("https://example.com/sp", where, nothing)).toBeNull()
    expect(completeHome("~", where)).toBe("~/")
    expect(completeHome("~", { ...where, home: "" })).toBeNull()
  })

  test("Tab fills in the part they share", () => {
    expect(sharedStart(["docs/", "drafts/"])).toBe("d")
    expect(sharedStart(["design.md", "deploy.md"])).toBe("de")
    expect(sharedStart(["a.md"])).toBe("a.md")
    expect(sharedStart([])).toBe("")
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 1 }), (list) => {
        const shared = sharedStart(list)
        for (const item of list) expect(item.startsWith(shared)).toBe(true)
      }),
    )
  })

  test("a spec's name ends in .md, .markdown or .txt", () => {
    expect(["a.md", "a.markdown", "a.txt", "A.MD"].every(isSpecName)).toBe(true)
    expect(["a.sh", "a.md.bak", "md"].some(isSpecName)).toBe(false)
  })
})

describe("the browser's rows", () => {
  test("`..` first, then folders, then files, each by name; dotfiles hidden", () => {
    expect(browserRows(entries, false)).toEqual([
      { _tag: "Up" },
      { _tag: "Folder", name: "docs" },
      { _tag: "Folder", name: "drafts" },
      { _tag: "File", name: "README.MD", spec: true },
      { _tag: "File", name: "data.markdown", spec: true },
      { _tag: "File", name: "deploy.sh", spec: false },
      { _tag: "File", name: "design.md", spec: true },
      { _tag: "File", name: "dull.txt", spec: true },
    ])
    expect(browserRows([], true)).toEqual([])
  })

  test("paths as the field and the border show them", () => {
    expect(shownPath("/work/shop/docs/a.md", where)).toBe("docs/a.md")
    expect(shownPath("/home/me/specs/a.md", where)).toBe("~/specs/a.md")
    expect(shownPath("/srv/a.md", where)).toBe("/srv/a.md")
    expect(folderLabel("/home/me/specs", "/home/me")).toBe("~/specs/")
    expect(folderLabel("/home/me", "/home/me")).toBe("~/")
    expect(folderLabel("/", "/home/me")).toBe("/")
  })
})

/** A folder of its own under the system's temporary folder, with `files` (a `/` ending a folder). */
const fixture = (files: ReadonlyArray<string>): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-field-")))
  for (const file of files) {
    if (file.endsWith("/")) mkdirSync(join(dir, file), { recursive: true })
    else writeFileSync(join(dir, file), `# ${file}\n`)
  }
  return dir
}

describe("the browser, moved", () => {
  const read: ReadFolder = readFolder

  test("opens at the folder given, else the repository, saying why", () => {
    const dir = fixture(["specs/", "specs/a.md", "b.md"])
    expect(openBrowser(join(dir, "specs"), dir, read, "").folder).toBe(join(dir, "specs"))
    expect(openBrowser(null, dir, read, "").folder).toBe(dir)
    const missing = openBrowser(join(dir, "gone"), dir, read, "")
    expect(missing.folder).toBe(dir)
    expect(missing.error).toStartWith(`cannot open ${join(dir, "gone")}: `)
  })

  test("↑ and ↓ stay in the list and in view; the wheel scrolls", () => {
    const names = Array.from({ length: 15 }, (_, i) => `f${String(i).padStart(2, "0")}.md`)
    const dir = fixture(names)
    let browsing = openBrowser(dir, dir, read, "")
    // `..`, then the 15 files.
    expect(browsing.rows).toHaveLength(16)
    browsing = moveBy(browsing, -1, 10)
    expect(browsing.at).toBe(0)
    browsing = moveBy(browsing, 12, 10)
    expect(browsing).toMatchObject({ at: 12, top: 3 })
    browsing = moveBy(browsing, 99, 10)
    expect(browsing).toMatchObject({ at: 15, top: 6 })
    browsing = scrollBy(browsing, -5, 10)
    expect(browsing).toMatchObject({ top: 1, at: 10 })
    browsing = scrollBy(browsing, -9, 10)
    expect(browsing).toMatchObject({ top: 0, at: 9 })
  })

  test("Enter opens a folder and chooses a spec; another file is greyed, not chosen", () => {
    const dir = fixture(["specs/", "specs/a.md", "run.sh"])
    let browsing = openBrowser(dir, dir, read, "")
    // `..`, specs, run.sh
    browsing = moveBy(browsing, 1, 10)
    const opened = enterRow(browsing, read, "", 10)
    expect(opened._tag).toBe("Browsing")
    if (opened._tag !== "Browsing") return
    expect(opened.browsing.folder).toBe(join(dir, "specs"))
    const chosen = enterRow(moveBy(opened.browsing, 1, 10), read, "", 10)
    expect(chosen).toEqual({ _tag: "Chosen", path: join(dir, "specs", "a.md") })
    const greyed = enterRow(moveBy(browsing, 1, 10), read, "", 10)
    expect(greyed).toMatchObject({ _tag: "Browsing", browsing: { error: specFilesOnly } })
  })

  test("← goes up a folder, onto the folder it left; `..` does the same", () => {
    const dir = fixture(["a/", "specs/", "specs/x.md"])
    const inSpecs = openBrowser(join(dir, "specs"), dir, read, "")
    const up = upFolder(inSpecs, read, "", 10)
    expect(up.folder).toBe(dir)
    expect(up.rows[up.at]).toEqual({ _tag: "Folder", name: "specs" })
    expect(enterRow(inSpecs, read, "", 10)).toMatchObject({
      _tag: "Browsing",
      browsing: { folder: dir },
    })
  })

  test("doesn't go into a folder it can't read, and says why", () => {
    const dir = fixture(["locked/", "locked/a.md"])
    chmodSync(join(dir, "locked"), 0o000)
    try {
      const browsing = moveBy(openBrowser(dir, dir, read, ""), 1, 10)
      const tried = enterRow(browsing, read, "", 10)
      expect(tried._tag).toBe("Browsing")
      if (tried._tag !== "Browsing") return
      expect(tried.browsing.folder).toBe(dir)
      expect(tried.browsing.error).toBe(`cannot open ${join(dir, "locked")}: permission denied`)
    } finally {
      chmodSync(join(dir, "locked"), 0o755)
    }
    expect(cannotOpen("/home/me/Documents", "/home/me", "operation not permitted")).toBe(
      "cannot open ~/Documents: operation not permitted",
    )
  })
})

describe("the file's checks", () => {
  test("each refusal in its words, the path as typed; a spec passes", () => {
    const dir = fixture(["spec.md", "folder/"])
    writeFileSync(join(dir, "empty.md"), " \n\n")
    writeFileSync(join(dir, "binary.md"), Buffer.from([0x61, 0x00, 0x62]))
    writeFileSync(join(dir, "locked.md"), "# x\n")
    chmodSync(join(dir, "locked.md"), 0o000)
    try {
      expect(fileProblem(join(dir, "spec.md"), "spec.md")).toBeNull()
      expect(fileProblem(join(dir, "nope.md"), "nope.md")).toBe("no such file: nope.md")
      expect(fileProblem(join(dir, "folder"), "folder")).toBe("folder is a folder")
      expect(fileProblem("/dev/null", "/dev/null")).toBe("/dev/null isn't a file")
      expect(fileProblem(join(dir, "empty.md"), "empty.md")).toBe("empty.md is empty")
      expect(fileProblem(join(dir, "binary.md"), "binary.md")).toBe(
        "binary.md doesn't look like text",
      )
      expect(fileProblem(join(dir, "locked.md"), "locked.md")).toBe(
        "cannot read locked.md: permission denied",
      )
      // A control character typed is never drawn.
      expect(fileProblem(join(dir, "x\x1b[2J.md"), "x\x1b[2J.md")).not.toContain("\x1b")
    } finally {
      chmodSync(join(dir, "locked.md"), 0o644)
    }
  })

  test("a cause is the system's words without the path", () => {
    const error = Object.assign(new Error("EACCES: permission denied, open '/x/y.md'"), {
      code: "EACCES",
    })
    expect(causeOf(error)).toBe("permission denied")
    expect(causeOf(new Error("something odd"))).toBe("something odd")
    expect(Result.isFailure(readFolder("/no/such/folder/here"))).toBe(true)
  })
})
