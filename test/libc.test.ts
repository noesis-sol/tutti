import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import fc from "fast-check"
import {
  close,
  createExclusive,
  flockExclusiveNonBlocking,
  isCloseOnExec,
  O,
  openCloexec,
  openUnder,
  unlock,
} from "../src/native/libc.ts"

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect)

const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-libc-")))

const modeOf = (path: string) => statSync(path).mode & 0o777

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const gone = async (pid: number) => {
  const deadline = Date.now() + 5000
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20)
}

const toKill: Array<number> = []

afterEach(() => {
  for (const pid of toKill.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL")
})

const holderScript = join(import.meta.dir, "fixtures/libc/holder.ts")

/** Starts the holder and waits for its `held` line; returns its PID and its sleep's, if any. */
const startHolder = async (lock: string, ...args: Array<string>) => {
  const holder = Bun.spawn(["bun", holderScript, lock, ...args], {
    stdout: "pipe",
    stderr: "inherit",
  })
  toKill.push(holder.pid)
  let out = ""
  const decoder = new TextDecoder()
  for await (const chunk of holder.stdout) {
    out += decoder.decode(chunk)
    if (/^(held|refused)$/m.test(out)) break
  }
  expect(out).toMatch(/^held$/m)
  const child = /^child (\d+)$/m.exec(out)?.[1]
  if (child !== undefined) toKill.push(Number(child))
  return { holder: holder.pid, child: child === undefined ? undefined : Number(child) }
}

/** Whether this process can take the lock on `path` now, through an open file of its own. */
const lockable = (path: string): boolean => {
  const fd = run(openCloexec(path, O.RDWR | O.CREAT))
  try {
    return run(flockExclusiveNonBlocking(fd))
  } finally {
    run(close(fd))
  }
}

describe("constants", () => {
  // From darwin's <sys/fcntl.h>, and Linux's <asm-generic/fcntl.h> with the arm64 and x86 overrides.
  const expected: Record<string, Record<keyof typeof O, number>> = {
    darwin: {
      RDONLY: 0,
      WRONLY: 1,
      RDWR: 2,
      CREAT: 0x200,
      EXCL: 0x800,
      TRUNC: 0x400,
      APPEND: 0x8,
      NOFOLLOW: 0x100,
      DIRECTORY: 0x100000,
      CLOEXEC: 0x1000000,
    },
    "linux-x64": {
      RDONLY: 0,
      WRONLY: 1,
      RDWR: 2,
      CREAT: 0x40,
      EXCL: 0x80,
      TRUNC: 0x200,
      APPEND: 0x400,
      NOFOLLOW: 0x20000,
      DIRECTORY: 0x10000,
      CLOEXEC: 0x80000,
    },
    "linux-arm64": {
      RDONLY: 0,
      WRONLY: 1,
      RDWR: 2,
      CREAT: 0x40,
      EXCL: 0x80,
      TRUNC: 0x200,
      APPEND: 0x400,
      NOFOLLOW: 0x8000,
      DIRECTORY: 0x4000,
      CLOEXEC: 0x80000,
    },
  }

  test("match the system headers for this platform and architecture", () => {
    const key = process.platform === "darwin" ? "darwin" : `${process.platform}-${process.arch}`
    expect(expected[key]).toBeDefined()
    expect({ ...O }).toEqual(expected[key] as Record<keyof typeof O, number>)
  })
})

describe("openCloexec", () => {
  test("opens with FD_CLOEXEC and creates the file with the mode asked", () => {
    const dir = tempDir()
    const path = join(dir, "file")
    const fd = run(openCloexec(path, O.WRONLY | O.CREAT, 0o600))
    expect(run(isCloseOnExec(fd))).toBe(true)
    writeSync(fd, "written")
    run(close(fd))
    // Without darwin arm64's padding, the variadic mode is garbage (140 rather than 600).
    expect(modeOf(path)).toBe(0o600)
    expect(readFileSync(path, "utf8")).toBe("written")
  })

  test("fails with errno's name", () => {
    const error = failure(openCloexec(join(tempDir(), "missing", "file"), O.RDONLY))
    expect(error._tag).toBe("LibcError")
    expect(error.code).toBe("ENOENT")
  })
})

describe("flock", () => {
  test("a second open file is refused until the first unlocks", () => {
    const path = join(tempDir(), "tutti.lock")
    const first = run(openCloexec(path, O.RDWR | O.CREAT))
    expect(run(flockExclusiveNonBlocking(first))).toBe(true)
    expect(lockable(path)).toBe(false)
    run(unlock(first))
    expect(lockable(path)).toBe(true)
    run(close(first))
  })

  test("is refused in a second process, and released on kill -9 of the holder", async () => {
    const path = join(tempDir(), "tutti.lock")
    const { holder } = await startHolder(path, "cloexec")
    expect(lockable(path)).toBe(false)
    process.kill(holder, "SIGKILL")
    await gone(holder)
    expect(lockable(path)).toBe(true)
  })

  test("isn't inherited by a child started with a plain fork and exec", async () => {
    const path = join(tempDir(), "tutti.lock")
    const { holder, child } = await startHolder(path, "cloexec", "system")
    expect(child).toBeDefined()
    process.kill(holder, "SIGKILL")
    await gone(holder)
    expect(alive(child as number)).toBe(true)
    expect(lockable(path)).toBe(true)
  })

  test("the control: a descriptor without O_CLOEXEC is inherited and keeps the lock", async () => {
    const path = join(tempDir(), "tutti.lock")
    writeFileSync(path, "")
    const { holder, child } = await startHolder(path, "plain", "system")
    process.kill(holder, "SIGKILL")
    await gone(holder)
    expect(alive(child as number)).toBe(true)
    expect(lockable(path)).toBe(false)
  })
})

describe("createExclusive", () => {
  test("creates a file with mode 0600, and fails when it exists", () => {
    const path = join(tempDir(), "req-1.json")
    const fd = run(createExclusive(path))
    expect(run(isCloseOnExec(fd))).toBe(true)
    run(close(fd))
    expect(modeOf(path)).toBe(0o600)
    const error = failure(createExclusive(path))
    expect(error._tag).toBe("LibcError")
    expect(error.code).toBe("EEXIST")
  })

  test("doesn't create through a link", () => {
    const dir = tempDir()
    const outside = join(dir, "outside")
    symlinkSync(outside, join(dir, "req-1.json"))
    expect(failure(createExclusive(join(dir, "req-1.json"))).code).toBe("EEXIST")
    expect(() => statSync(outside)).toThrow()
  })
})

describe("openUnder", () => {
  /** A worktree with .tutti/run/check.log, a folder outside it, and a link to the worktree. */
  const layout = () => {
    const base = tempDir()
    const tree = join(base, "tree")
    const outside = join(base, "outside")
    mkdirSync(join(tree, ".tutti/run"), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(tree, ".tutti/run/check.log"), "inside")
    writeFileSync(join(outside, "secret"), "outside")
    symlinkSync(tree, join(base, "tree-link"))
    return { base, tree, outside }
  }

  test("opens a plain path below the directory, close-on-exec", () => {
    const { tree } = layout()
    const fd = run(openUnder(tree, ".tutti/run/check.log", O.WRONLY | O.APPEND))
    expect(run(isCloseOnExec(fd))).toBe(true)
    writeSync(fd, " more")
    run(close(fd))
    expect(readFileSync(join(tree, ".tutti/run/check.log"), "utf8")).toBe("inside more")
  })

  test("creates a file with the mode asked", () => {
    const { tree } = layout()
    const fd = run(openUnder(tree, ".tutti/run/setup.log", O.WRONLY | O.CREAT | O.EXCL, 0o600))
    run(close(fd))
    expect(modeOf(join(tree, ".tutti/run/setup.log"))).toBe(0o600)
  })

  test("follows a link to the directory itself", () => {
    const { base } = layout()
    const fd = run(openUnder(join(base, "tree-link"), ".tutti/run/check.log", O.RDONLY))
    run(close(fd))
  })

  test("refuses a symlinked folder, naming it", () => {
    const { tree, outside } = layout()
    symlinkSync(outside, join(tree, ".tutti/run/out"))
    const error = failure(openUnder(tree, ".tutti/run/out/secret", O.RDONLY))
    expect(error._tag).toBe("SymlinkRefused")
    expect(error).toMatchObject({ component: ".tutti/run/out", path: ".tutti/run/out/secret" })
  })

  test("refuses a symlinked first component, even one pointing inside", () => {
    const { tree } = layout()
    symlinkSync(join(tree, ".tutti"), join(tree, "linked"))
    expect(failure(openUnder(tree, "linked/run/check.log", O.RDONLY))).toMatchObject({
      _tag: "SymlinkRefused",
      component: "linked",
    })
  })

  test("refuses a symlinked file, for reading and for creating", () => {
    const { tree, outside } = layout()
    symlinkSync(join(outside, "secret"), join(tree, ".tutti/run/out-file"))
    symlinkSync(join(outside, "new"), join(tree, ".tutti/run/dangling"))
    for (const [name, flags] of [
      ["out-file", O.RDONLY],
      ["out-file", O.WRONLY | O.TRUNC],
      ["dangling", O.WRONLY | O.CREAT],
      ["dangling", O.WRONLY | O.CREAT | O.EXCL],
    ] as const) {
      expect(failure(openUnder(tree, `.tutti/run/${name}`, flags))).toMatchObject({
        _tag: "SymlinkRefused",
        component: `.tutti/run/${name}`,
      })
    }
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside")
    expect(() => statSync(join(outside, "new"))).toThrow()
  })

  test("reports a missing file or a file in place of a folder as the libc error", () => {
    const { tree } = layout()
    expect(failure(openUnder(tree, ".tutti/run/missing", O.RDONLY))).toMatchObject({
      _tag: "LibcError",
      code: "ENOENT",
    })
    expect(failure(openUnder(tree, ".tutti/run/check.log/x", O.RDONLY))).toMatchObject({
      _tag: "LibcError",
      code: "ENOTDIR",
    })
  })

  test("refuses absolute paths and empty, . or .. components before any call", () => {
    const { tree } = layout()
    for (const path of ["/etc/passwd", ".tutti/../.tutti/run/check.log", "./x", "a//b", "", "a/"]) {
      expect(failure(openUnder(tree, path, O.RDONLY))._tag).toBe("PathRefused")
    }
  })

  test("refuses any path with a component that isn't plain", () => {
    const { tree } = layout()
    const plain = fc.stringMatching(/^[a-z.]{1,4}$/).filter((s) => s !== "." && s !== "..")
    const bad = fc.constantFrom("", ".", "..")
    fc.assert(
      fc.property(
        fc.array(plain, { maxLength: 3 }),
        bad,
        fc.array(plain, { maxLength: 3 }),
        (before, part, after) => {
          const path = [...before, part, ...after].join("/")
          expect(failure(openUnder(tree, path, O.RDONLY | O.CREAT))._tag).toBe("PathRefused")
        },
      ),
    )
  })
})
