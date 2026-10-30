// A ticket's failed check's output is kept beside its transcript, in the main checkout's
// .tutti/run/workers/<id>/checks/, and its `check` record names the copy: the worktree the check
// wrote it in goes when the ticket merges or is set aside (keptChecks.ts).

import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { removeUnder } from "../src/native/libc.ts"
import { checkOnce } from "../src/run/check.ts"
import {
  cutNote,
  KeptOutputs,
  keepFailedOutput,
  keptChecksFolder,
  keptFiles,
} from "../src/run/keptChecks.ts"
import { makeSetUps, setUpWorktree } from "../src/run/setup.ts"
import { Trash } from "../src/run/trash.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckOutput, checkLogName, resultOf } from "../src/services/Checks.ts"
import { runFolder, Worktrees } from "../src/services/Worktrees.ts"
import { appConfig, layer as appConfigLayer } from "../src/testing/AppConfig.ts"
import type { CheckRun } from "../src/testing/Checks.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-kept-check-output-${name}-`)))

/** A merge check that writes `output` where it is asked to and fails, as the live one does. */
const failing = (output: string) => (run: CheckRun) =>
  Effect.suspend(() => {
    if (run.outputFd !== undefined) writeFileSync(run.outputFd, output)
    const said = new CheckOutput()
    said.write(new TextEncoder().encode(output))
    return resultOf("fast", run.command, 1, said, run.outputFile)
  })

describe("a ticket whose merge check fails", () => {
  test("leaves its output at the path its record names once its worktree is trashed", async () => {
    const repo = folder("repo")
    const output = "running the tests\nerror: a.test.ts: expected 1\n"
    let worktree = ""
    const ran = await scenario(
      { config: { repo }, checks: { fast: [failing(output)] } },
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const id = "a" as TicketId
        worktree = (yield* worktrees.prepare(id)).path
        const checked = yield* checkOnce({ id, worktree })
        const aside = yield* worktrees.remove(id, { force: true, aside: true, at: worktree })
        const trash = yield* Trash
        if (aside !== undefined) yield* trash.delete(aside, id)
        yield* trash.settled
        return checked
      }),
    )
    // The worker is still told of the file in its worktree, which it can read.
    expect(ran.exit).toMatchObject({
      _tag: "Success",
      value: { _tag: "Failed", output: join(worktree, runFolder, checkLogName) },
    })
    expect(existsSync(worktree)).toBe(false)
    const record = ran.events.find((event) => event.kind === "check")
    const kept = join(repo, keptChecksFolder("a"), "merge-1.log")
    expect(record).toMatchObject({
      ticket: "a",
      result: "failed",
      output: kept,
      said: ["error: a.test.ts: expected 1"],
    })
    expect(readFileSync(kept, "utf8")).toBe(output)
  })

  test("that passes keeps nothing", async () => {
    const repo = folder("repo")
    const ran = await scenario(
      { config: { repo } },
      Effect.gen(function* () {
        const worktree = (yield* (yield* Worktrees).prepare("a" as TicketId)).path
        return yield* checkOnce({ id: "a" as TicketId, worktree })
      }),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: { _tag: "Passed" } })
    expect(existsSync(join(repo, keptChecksFolder("a")))).toBe(false)
  })
})

describe("a ticket whose setup fails in its new worktree", () => {
  test("leaves its output at the path its record names", async () => {
    const repo = folder("repo")
    const defaults = appConfig().settings
    const settings = {
      ...defaults,
      checks: { ...defaults.checks, setup: { ...defaults.checks.setup, command: "bun install" } },
    }
    const ran = await scenario(
      {
        config: { repo, settings },
        checks: {
          setup: [
            (run: CheckRun) =>
              Effect.suspend(() => {
                if (run.outputFd !== undefined) writeFileSync(run.outputFd, "no lockfile\n")
                return resultOf("setup", run.command, 1, new CheckOutput(), run.outputFile)
              }),
          ],
        },
      },
      Effect.gen(function* () {
        const prepared = yield* (yield* Worktrees).prepare("a" as TicketId)
        return yield* setUpWorktree(prepared, yield* makeSetUps, repo)
      }),
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: { _tag: "Failed" } })
    const kept = join(repo, keptChecksFolder("a"), "setup-1.log")
    expect(ran.events.find((event) => event.kind === "check")).toMatchObject({
      suite: "setup",
      result: "failed",
      output: kept,
    })
    expect(readFileSync(kept, "utf8")).toBe("no lockfile\n")
  })
})

/** Keeps the output `text`, written in a new worktree's .tutti/run/, as a's in `repo`. */
const keep = (repo: string, text: string, suite = "merge") => {
  const worktree = folder("worktree")
  mkdirSync(join(worktree, runFolder), { recursive: true })
  writeFileSync(join(worktree, runFolder, checkLogName), text)
  return Effect.runPromise(
    Effect.gen(function* () {
      const kept = yield* keepFailedOutput("a", suite, worktree, checkLogName)
      return { kept, log: yield* texts }
    }).pipe(Effect.provide(Layer.mergeAll(appConfigLayer(appConfig({ repo })), logLayer()))),
  )
}

describe("keepFailedOutput", () => {
  test("numbers each copy on from the folder's highest, whatever its suite", async () => {
    const repo = folder("repo")
    const checks = join(repo, keptChecksFolder("a"))
    mkdirSync(checks, { recursive: true })
    writeFileSync(join(checks, "merge-7.log"), "earlier\n")
    const { kept } = await keep(repo, "now\n", "setup")
    expect(kept).toBe(join(checks, "setup-8.log"))
    expect(readFileSync(join(checks, "merge-7.log"), "utf8")).toBe("earlier\n")
  })

  test(`keeps a ticket's last ${KeptOutputs.files}, removing the older, and leaves other files`, async () => {
    const repo = folder("repo")
    const checks = join(repo, keptChecksFolder("a"))
    mkdirSync(checks, { recursive: true })
    for (let n = 1; n <= KeptOutputs.files; n++) writeFileSync(join(checks, `merge-${n}.log`), "")
    writeFileSync(join(checks, "notes.txt"), "mine\n")
    await keep(repo, "the newest\n")
    await keep(repo, "the newest\n")
    const names = readdirSync(checks).sort()
    expect(names).toContain("notes.txt")
    expect(keptFiles(names).map((file) => file.n)).toEqual(
      Array.from({ length: KeptOutputs.files }, (_, i) => i + 3),
    )
  })

  test("cuts a longer output to its last lines, saying how much it left out", async () => {
    const repo = folder("repo")
    const line = `${"x".repeat(99)}\n`
    const lines = Math.ceil(KeptOutputs.bytes / line.length) + 10
    const text = `${line.repeat(lines - 1)}the end\n`
    const { kept } = await keep(repo, text)
    const copy = readFileSync(kept ?? "", "utf8")
    const body = copy.slice(copy.indexOf("\n") + 1)
    // It starts at a line's start, within the last KeptOutputs.bytes.
    expect(body.length).toBeLessThanOrEqual(KeptOutputs.bytes)
    expect(body.length).toBeGreaterThan(KeptOutputs.bytes - line.length)
    expect(body.startsWith("x")).toBe(true)
    expect(text.endsWith(body)).toBe(true)
    expect(copy.slice(0, copy.indexOf("\n") + 1)).toBe(
      cutNote(text.length - body.length, text.length),
    )
  })

  test("keeps an output just within the bound whole", async () => {
    const repo = folder("repo")
    const text = `${"y".repeat(KeptOutputs.bytes - 1)}\n`
    const { kept } = await keep(repo, text)
    expect(readFileSync(kept ?? "", "utf8")).toBe(text)
  })

  test("writes nothing through a symbolic link in the checks folder's place", async () => {
    const repo = folder("repo")
    const outside = folder("outside")
    mkdirSync(join(repo, runFolder, "workers", "a"), { recursive: true })
    symlinkSync(outside, join(repo, keptChecksFolder("a")))
    const { kept, log } = await keep(repo, "failed\n")
    expect(kept).toBeUndefined()
    expect(readdirSync(outside)).toEqual([])
    expect(log.join("\n")).toContain("a's merge check's output can't be kept in")
  })
})

describe("removeUnder", () => {
  test("removes a link at the name, not what it points to", async () => {
    const dir = folder("remove")
    const target = join(folder("target"), "kept.txt")
    writeFileSync(target, "kept\n")
    mkdirSync(join(dir, "sub"))
    symlinkSync(target, join(dir, "sub", "link"))
    await Effect.runPromise(removeUnder(dir, "sub/link"))
    expect(existsSync(join(dir, "sub", "link"))).toBe(false)
    expect(readFileSync(target, "utf8")).toBe("kept\n")
  })

  test("refuses a link in the folder's path, and counts a missing name as removed", async () => {
    const dir = folder("remove")
    const outside = folder("outside")
    writeFileSync(join(outside, "file"), "kept\n")
    symlinkSync(outside, join(dir, "sub"))
    const exit = await Effect.runPromise(Effect.exit(removeUnder(dir, "sub/file")))
    expect(exit).toMatchObject({ _tag: "Failure" })
    expect(existsSync(join(outside, "file"))).toBe(true)
    await Effect.runPromise(removeUnder(dir, "missing"))
  })
})
