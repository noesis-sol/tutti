// makeFoldersUnder, the one way tutti makes its folders under .tutti/run: missing ones made, the
// last with the mode asked for, nothing made through a link, and why they aren't all there.

import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeFoldersUnder } from "../src/native/libc.ts"

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-make-folders-")))

describe("makeFoldersUnder", () => {
  test("makes the missing folders, the last with its mode", () => {
    const repo = tempDir()
    mkdirSync(join(repo, ".tutti"))
    expect(makeFoldersUnder(repo, ".tutti/run/attention", { mode: 0o700 })).toBeUndefined()
    expect(statSync(join(repo, ".tutti/run")).isDirectory()).toBe(true)
    expect(statSync(join(repo, ".tutti/run/attention")).mode & 0o777).toBe(0o700)
  })

  test("folders already there are no problem", () => {
    const repo = tempDir()
    mkdirSync(join(repo, ".tutti/run"), { recursive: true })
    expect(makeFoldersUnder(repo, ".tutti/run")).toBeUndefined()
  })

  test("stops at a link, saying so, and makes nothing through it", () => {
    const repo = tempDir()
    const outside = tempDir()
    symlinkSync(outside, join(repo, ".tutti"))
    expect(makeFoldersUnder(repo, ".tutti/run/workers/t-1")).toBe(".tutti is a symbolic link")
    expect(readdirSync(outside)).toEqual([])
  })

  test("stops at a file, saying so", () => {
    const repo = tempDir()
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(join(repo, ".tutti/run"), "")
    expect(makeFoldersUnder(repo, ".tutti/run/workers")).toBe(".tutti/run isn't a folder")
  })

  test("says why a folder can't be made", () => {
    const repo = tempDir()
    expect(makeFoldersUnder(join(repo, "missing"), ".tutti")).toStartWith(".tutti can't be made: ")
  })
})
