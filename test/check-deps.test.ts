// scripts/check-deps.ts, which has scripts/test.ts run nothing on a node_modules behind bun.lock
// (tutti-a8q2): the main checkout ran the suites on OpenTUI 0.7.0 a week after the bump to 0.8.1.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  lockedVersion,
  packageFolder,
  staleDependencies,
  staleReport,
} from "../scripts/check-deps.ts"
import { testEnv } from "./env.ts"

const script = resolve(import.meta.dir, "../scripts/check-deps.ts")

// bun.lock as bun writes it, trailing commas and all: the project's dependencies, a package nested
// in another, the other platforms' optional ones, and a git dependency.
const lock = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "@opentui/core": "0.8.1",
        "zod": "4.6.7",
      },
      "devDependencies": {
        "typescript": "7.0.2",
      },
    },
  },
  "packages": {
    "@opentui/core": ["@opentui/core@0.8.1", "", {}, "sha512-a"],
    "@opentui/core-darwin-arm64": ["@opentui/core-darwin-arm64@0.8.1", "", {}, "sha512-b"],
    "@opentui/core-linux-x64": ["@opentui/core-linux-x64@0.8.1", "", {}, "sha512-c"],
    "body-parser": ["body-parser@2.2.0", "", {}, "sha512-d"],
    "body-parser/content-type": ["content-type@1.0.5", "", {}, "sha512-e"],
    "from-git": ["from-git@github:someone/from-git#abc123", {}, "someone-from-git-abc123"],
    "typescript": ["typescript@7.0.2", "", {}, "sha512-f"],
    "zod": ["zod@4.6.7", "", {}, "sha512-g"],
  },
}
`

/** A project with that bun.lock and these packages installed, by bun.lock key and version. */
const project = (installed: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), "tutti-check-deps-"))
  writeFileSync(join(root, "bun.lock"), lock)
  for (const [key, version] of Object.entries(installed)) {
    const folder = packageFolder(root, key)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: key, version }))
  }
  return root
}

const upToDate = {
  "@opentui/core": "0.8.1",
  "@opentui/core-darwin-arm64": "0.8.1",
  "body-parser": "2.2.0",
  "body-parser/content-type": "1.0.5",
  typescript: "7.0.2",
  zod: "4.6.7",
}

describe("packageFolder", () => {
  test("is node_modules' folder for a bun.lock key, scoped and nested", () => {
    expect(packageFolder("/p", "zod")).toBe("/p/node_modules/zod")
    expect(packageFolder("/p", "@opentui/core")).toBe("/p/node_modules/@opentui/core")
    expect(packageFolder("/p", "body-parser/content-type")).toBe(
      "/p/node_modules/body-parser/node_modules/content-type",
    )
    expect(packageFolder("/p", "@types/node/undici-types")).toBe(
      "/p/node_modules/@types/node/node_modules/undici-types",
    )
    expect(packageFolder("/p", "a/@s/b")).toBe("/p/node_modules/a/node_modules/@s/b")
  })
})

describe("lockedVersion", () => {
  test("is the version of a name@version entry, scoped or not", () => {
    expect(lockedVersion("zod@4.6.7")).toBe("4.6.7")
    expect(lockedVersion("@opentui/core@0.8.1")).toBe("0.8.1")
    expect(lockedVersion("react-reconciler@0.33.0-rc.1")).toBe("0.33.0-rc.1")
  })

  test("is none for a git or file dependency", () => {
    expect(lockedVersion("from-git@github:someone/from-git#abc123")).toBeUndefined()
    expect(lockedVersion("local@file:../local")).toBeUndefined()
  })
})

describe("staleDependencies", () => {
  test("is empty when node_modules has what bun.lock resolves", () => {
    expect(staleDependencies(project(upToDate))).toEqual([])
  })

  test("names each package installed at another version than bun.lock's", () => {
    const root = project({
      ...upToDate,
      "@opentui/core": "0.7.0",
      "@opentui/core-darwin-arm64": "0.7.0",
      "body-parser/content-type": "1.0.4",
    })
    expect(staleDependencies(root)).toEqual([
      "@opentui/core 0.7.0 is installed, bun.lock has 0.8.1",
      "@opentui/core-darwin-arm64 0.7.0 is installed, bun.lock has 0.8.1",
      "body-parser/content-type 1.0.4 is installed, bun.lock has 1.0.5",
    ])
  })

  test("names a dependency of the project's that isn't installed, not another's", () => {
    const { zod: _, "body-parser/content-type": __, ...rest } = upToDate
    expect(staleDependencies(project(rest))).toEqual(["zod is not installed, bun.lock has 4.6.7"])
  })
})

describe("staleReport", () => {
  test("says nothing of a node_modules that matches", () => {
    expect(staleReport("scripts/test.sh", [])).toEqual([])
  })

  test("names what differs and how to install it", () => {
    expect(staleReport("scripts/test.sh", ["zod 4.6.6 is installed, bun.lock has 4.6.7"])).toEqual([
      "scripts/test.sh: node_modules is behind bun.lock; run bun install --frozen-lockfile:",
      "  zod 4.6.6 is installed, bun.lock has 4.6.7",
    ])
  })
})

describe("bun scripts/check-deps.ts", () => {
  const run = (root: string) =>
    Bun.spawnSync([process.execPath, script, "scripts/test.sh"], {
      cwd: root,
      env: { ...testEnv },
      stdout: "pipe",
      stderr: "pipe",
    })

  test("exits 1 on a node_modules behind bun.lock, saying what differs", () => {
    const proc = run(project({ ...upToDate, "@opentui/core": "0.7.0" }))
    expect(proc.stderr.toString()).toBe(
      "scripts/test.sh: node_modules is behind bun.lock; run bun install --frozen-lockfile:\n" +
        "  @opentui/core 0.7.0 is installed, bun.lock has 0.8.1\n",
    )
    expect(proc.exitCode).toBe(1)
  })

  test("exits 0 quietly on one that matches", () => {
    const proc = run(project(upToDate))
    expect(proc.stderr.toString()).toBe("")
    expect(proc.exitCode).toBe(0)
  })

  test("finds this checkout's node_modules up to date", () => {
    expect(staleDependencies(resolve(import.meta.dir, ".."))).toEqual([])
  })
})
