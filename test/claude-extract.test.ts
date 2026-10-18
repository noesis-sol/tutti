import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract"
import {
  extractedCopy,
  extractionBase,
  type Known,
  knownFor,
  staleAfterMs,
  staleCopies,
  tidyExtracted,
} from "../src/agent/claudeExtract.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-${name}-`)))

const uid = process.getuid?.() ?? 0

/** An embedded file in a stand-in $bunfs, with its checksum and size as the manifest has them. */
const embedded = (content = "#!/bin/sh\necho '2.1.301 (Claude Code)'\n") => {
  const bunfs = join(folder("bunfs"), "$bunfs", "root")
  mkdirSync(bunfs, { recursive: true })
  const file = join(bunfs, "claude-abc123.")
  writeFileSync(file, content)
  const known: Known = {
    checksum: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  }
  return { file, known }
}

/** `extractFromBunfs` of `file` with CLAUDE_CODE_TMPDIR at a new folder: its copy and its base. */
const extracted = (file: string) => {
  const tmp = folder("claude-tmp")
  const before = process.env.CLAUDE_CODE_TMPDIR
  process.env.CLAUDE_CODE_TMPDIR = tmp
  try {
    return { copy: extractFromBunfs(file), base: join(tmp, `claude-${uid}`) }
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_TMPDIR
    else process.env.CLAUDE_CODE_TMPDIR = before
  }
}

const daysAgo = (path: string, days: number) => {
  const then = new Date(Date.now() - days * staleAfterMs)
  utimesSync(path, then, then)
}

describe("the manifest's Claude Code", () => {
  test("each target a build embeds has its checksum and size", () => {
    for (const target of [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "linux-arm64-musl",
      "linux-x64-musl",
    ]) {
      const known = knownFor(target)
      expect(known?.checksum).toMatch(/^[0-9a-f]{64}$/)
      expect(known?.size).toBeGreaterThan(0)
    }
    expect(knownFor("plan9-mips")).toBeNull()
  })
})

describe("the extraction folder", () => {
  test("CLAUDE_CODE_TMPDIR's, else /tmp on macOS, else the system's, per user", () => {
    expect(extractionBase({ CLAUDE_CODE_TMPDIR: "/scratch" }, "linux", 501)).toBe(
      "/scratch/claude-501",
    )
    expect(extractionBase({}, "darwin", 501)).toBe("/tmp/claude-501")
    expect(extractionBase({}, "linux", 1000)).toBe(join(tmpdir(), "claude-1000"))
    expect(extractionBase({}, "win32", undefined)).toBeNull()
  })

  test("is where the SDK's extractFromBunfs puts its copy", () => {
    const { file } = embedded()
    const { copy, base } = extracted(file)
    expect(dirname(dirname(copy))).toBe(base)
    expect(extractionBase({ CLAUDE_CODE_TMPDIR: dirname(base) }, process.platform, uid)).toBe(base)
  })
})

describe("the copy already extracted", () => {
  test("is found by the manifest's checksum, without reading the embedded file", () => {
    const { file, known } = embedded()
    const { copy, base } = extracted(file)
    chmodSync(file, 0o000)
    try {
      expect(extractedCopy(file, known, base, uid)).toBe(copy)
    } finally {
      chmodSync(file, 0o644)
    }
  })

  test("none before the first extraction", () => {
    const { file, known } = embedded()
    expect(extractedCopy(file, known, join(folder("claude-tmp"), `claude-${uid}`), uid)).toBeNull()
  })

  test("not another version's, nor one of another size", () => {
    const { file, known } = embedded()
    const { base } = extracted(file)
    expect(extractedCopy(file, { ...known, checksum: "f".repeat(64) }, base, uid)).toBeNull()
    expect(extractedCopy(file, { ...known, size: known.size + 1 }, base, uid)).toBeNull()
  })

  test("not one in a folder others can open, or another user's", () => {
    const { file, known } = embedded()
    const { copy, base } = extracted(file)
    expect(extractedCopy(file, known, base, uid + 1)).toBeNull()
    chmodSync(base, 0o755)
    expect(extractedCopy(file, known, base, uid)).toBeNull()
    chmodSync(base, 0o700)
    expect(extractedCopy(file, known, base, uid)).toBe(copy)
  })

  test("not a symlink in its place", () => {
    const { file, known } = embedded()
    const base = join(folder("claude-tmp"), `claude-${uid}`)
    const version = join(base, `claude-agent-sdk-${known.checksum.slice(0, 16)}`)
    mkdirSync(version, { recursive: true, mode: 0o700 })
    chmodSync(base, 0o700)
    symlinkSync(file, join(version, "claude-abc123."))
    expect(extractedCopy(file, known, base, uid)).toBeNull()
  })
})

describe("other versions' copies", () => {
  /** An extraction base holding `keep`'s folder and others, every one two days old. */
  const base = () => {
    const dir = join(folder("claude-tmp"), `claude-${uid}`)
    const version = (hash: string, files: ReadonlyArray<string> = ["claude-abc123."]) => {
      const path = join(dir, `claude-agent-sdk-${hash}`)
      mkdirSync(path, { recursive: true })
      for (const file of files) writeFileSync(join(path, file), "binary")
      daysAgo(path, 2)
      return path
    }
    const keep = join(version("0000000000000000"), "claude-abc123.")
    return { dir, version, keep }
  }

  test("a day untouched are stale; the one in use, fresh ones and others' files aren't", () => {
    const { dir, version, keep } = base()
    const old = version("1111111111111111")
    const fresh = version("2222222222222222")
    utimesSync(fresh, new Date(), new Date())
    version("3333333333333333", ["notes.txt"])
    version("not-a-version")
    writeFileSync(join(dir, "claude-agent-sdk-4444444444444444"), "a file")
    expect(staleCopies(dir, keep, uid, Date.now())).toEqual([old])
    expect(staleCopies(dir, keep, uid + 1, Date.now())).toEqual([])
    expect(staleCopies(join(dir, "missing"), keep, uid, Date.now())).toEqual([])
  })

  test("are removed off the startup path, and the copy in use is touched", async () => {
    const { dir, version, keep } = base()
    const old = version("1111111111111111")
    tidyExtracted(keep, dir, uid)
    expect(Date.now() - statSync(dirname(keep)).mtimeMs).toBeLessThan(staleAfterMs)
    await Bun.sleep(20)
    expect(existsSync(old)).toBe(false)
    expect(readFileSync(keep, "utf8")).toBe("binary")
  })

  test("their cleanup keeps no process running", () => {
    const { dir, keep } = base()
    const script = `
      import { tidyExtracted } from ${JSON.stringify(join(import.meta.dir, "../src/agent/claudeExtract.ts"))}
      tidyExtracted(${JSON.stringify(keep)}, ${JSON.stringify(dir)}, ${uid})
    `
    const started = Date.now()
    const ran = Bun.spawnSync([process.execPath, "--eval", script], { timeout: 10_000 })
    expect(ran.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
