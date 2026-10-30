// What a breakdown's tickets are checked against (src/project/planFile.ts): each ticket's files,
// kept where they can be the repository's, and a cycle of blocked-by links among tickets.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { checkFiles, planCycle } from "../src/project/planFile.ts"

const tracked = ["README.md", "CLAUDE.md", "src/list.ts", "src/main.ts"]

describe("checkFiles", () => {
  test("keeps only files that can be the repository's, whatever it is given", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 6 }), (files) => {
        const checked = checkFiles([{ key: "t1", files }], tracked)
        for (const f of checked.files[0] ?? []) {
          expect(f.startsWith("/") || f.startsWith("../") || f === "..").toBe(false)
          expect(f.includes("\\")).toBe(false)
        }
      }),
    )
  })

  test("trims and dedupes what it keeps, with a note for each file dropped", () => {
    const checked = checkFiles(
      [
        { key: "t1", files: ["src", " src/list.ts ", "./src/list.ts", "/etc/passwd", ""] },
        { key: "t2", files: ["src/new.ts", "nowhere/x.ts"] },
      ],
      tracked,
    )
    expect(checked.files).toEqual([["src/list.ts"], ["src/new.ts"]])
    expect(checked.notes).toEqual([
      `dropped "src" from t1's files: a directory, not a file`,
      `dropped "/etc/passwd" from t1's files: not a path inside the repository`,
      `dropped "nowhere/x.ts" from t2's files: not in the repository, and its directory nowhere/ doesn't exist`,
    ])
  })

  test("with newFolders, keeps a new file in a folder of its own", () => {
    const checked = checkFiles([{ key: "t1", files: ["nowhere/x.ts"] }], [], { newFolders: true })
    expect(checked).toEqual({ files: [["nowhere/x.ts"]], notes: [] })
  })
})

describe("planCycle", () => {
  test("finds a cycle of blocked-by links, starting and ending with one key", () => {
    expect(
      planCycle([
        { key: "t1", blockedBy: ["t3"] },
        { key: "t2", blockedBy: ["t1"] },
        { key: "t3", blockedBy: ["t2"] },
      ]),
    ).toEqual(["t1", "t3", "t2", "t1"])
  })

  test("finds none among links that end", () => {
    expect(
      planCycle([
        { key: "t1", blockedBy: [] },
        { key: "t2", blockedBy: ["t1"] },
        { key: "t3", blockedBy: ["t1", "t2", "elsewhere"] },
      ]),
    ).toBeUndefined()
  })
})
