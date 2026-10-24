// state.json is read through the symlink guard (§ 9.1), as it is written: a merged ticket can
// leave a symbolic link at .tutti/run/state.json or .tutti/run, and the run doesn't read through
// it. A link is StoreUnreadable, naming the link and quoting nothing of what it points at; a
// missing file or folder is still no state.
import { describe, expect, test } from "bun:test"
import {
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
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import {
  emptyState,
  readState,
  Store,
  StoreUnreadable,
  stateFile,
  statePath,
  stateText,
} from "../src/services/Store.ts"

/** A main checkout, and a folder outside it with a secret a link can point at. */
const places = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-state-links-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "tutti-state-links-outside-")))
  const target = join(outside, ".netrc")
  writeFileSync(target, "machine example.com password hunter2\n")
  return { repo, outside, target }
}

const read = (repo: string) => Effect.runPromiseExit(readState(repo))

const unreadable = <A, E>(exit: Exit.Exit<A, E>): StoreUnreadable => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  expect(reason.error).toBeInstanceOf(StoreUnreadable)
  return reason.error as StoreUnreadable
}

const quotesNothing = (error: StoreUnreadable) => {
  expect(error.message).not.toContain("hunter2")
  expect(error.message).not.toContain("machine")
}

describe("reading state.json", () => {
  test("no .tutti, or no .tutti/run, is the empty state", async () => {
    const { repo } = places()
    expect(await read(repo)).toEqual(Exit.succeed(emptyState))
    mkdirSync(join(repo, ".tutti"))
    expect(await read(repo)).toEqual(Exit.succeed(emptyState))
  })

  test("reads the file there", async () => {
    const { repo } = places()
    mkdirSync(join(repo, ".tutti/run"), { recursive: true })
    const state = { ...emptyState, tickets: { "demo-1": { resumes: 2, metadata: {} } } }
    writeFileSync(statePath(repo), stateText(state))
    expect(await read(repo)).toEqual(Exit.succeed(state))
  })

  test("a link at state.json is StoreUnreadable, and what it points at isn't quoted", async () => {
    const { repo, target } = places()
    mkdirSync(join(repo, ".tutti/run"), { recursive: true })
    symlinkSync(target, statePath(repo))
    const error = unreadable(await read(repo))
    expect(error.file).toBe(statePath(repo))
    expect(error.reason).toContain(`${stateFile} is a symbolic link`)
    quotesNothing(error)
  })

  test("a link at state.json to a state is refused all the same", async () => {
    const { repo, outside } = places()
    mkdirSync(join(repo, ".tutti/run"), { recursive: true })
    writeFileSync(join(outside, "state.json"), stateText(emptyState))
    symlinkSync(join(outside, "state.json"), statePath(repo))
    expect(unreadable(await read(repo)).reason).toContain("is a symbolic link")
  })

  test("a link at state.json to nothing is refused, not read as no state", async () => {
    const { repo, outside } = places()
    mkdirSync(join(repo, ".tutti/run"), { recursive: true })
    symlinkSync(join(outside, "missing"), statePath(repo))
    expect(unreadable(await read(repo)).reason).toContain("is a symbolic link")
  })

  test("a link at .tutti/run is StoreUnreadable, naming the folder", async () => {
    const { repo, outside, target } = places()
    mkdirSync(join(repo, ".tutti"))
    writeFileSync(join(outside, "state.json"), readFileSync(target))
    symlinkSync(outside, join(repo, ".tutti/run"))
    const error = unreadable(await read(repo))
    expect(error.reason).toContain(".tutti/run is a symbolic link")
    quotesNothing(error)
  })

  test("a link at .tutti is StoreUnreadable", async () => {
    const { repo, outside } = places()
    mkdirSync(join(outside, "run"))
    writeFileSync(join(outside, "run/state.json"), stateText(emptyState))
    symlinkSync(outside, join(repo, ".tutti"))
    expect(unreadable(await read(repo)).reason).toContain(".tutti is a symbolic link")
  })

  test("a folder at state.json is StoreUnreadable", async () => {
    const { repo } = places()
    mkdirSync(statePath(repo), { recursive: true })
    unreadable(await read(repo))
  })

  test("the Store isn't built over a linked state.json, and nothing is written through it", async () => {
    const { repo, outside, target } = places()
    mkdirSync(join(repo, ".tutti/run"), { recursive: true })
    symlinkSync(target, statePath(repo))
    const run = { pid: 4242, started: "2026-10-24T08:31:00Z", version: "0.1.0" }
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Store, (store) => store.state).pipe(
        Effect.provide(Store.layer({ repo, run }).pipe(Layer.provide(BunFileSystem.layer))),
      ),
    )
    quotesNothing(unreadable(exit))
    expect(readFileSync(target, "utf8")).toBe("machine example.com password hunter2\n")
    expect(readdirSync(outside)).toEqual([".netrc"])
  })
})
