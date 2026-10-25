// The in-memory backlog answers with bd's --json output, decoded and judged as the live layer does
// (src/testing/Beads.ts): a Fault's stdout and exit code reach the same judgement as bd's.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import {
  Beads,
  BeadsFailed,
  BeadsUnreadable,
  judgeRead,
  judgeWrite,
  noSuchIssueError,
  type TicketId,
} from "../src/services/Beads.ts"
import {
  Backlog,
  layer as backlogLayer,
  type Fault,
  noSuchIssueStdout,
  type Seed,
} from "../src/testing/Beads.ts"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/bd", name), "utf8")

const inMemory = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Beads | Backlog>) =>
  Effect.runPromise(Effect.exit(Effect.provide(effect, backlogLayer(seeds))))

/** The call's exit after the next call of op gets the fault. */
const faulted = <A, E>(
  op: string,
  fault: Fault,
  call: (beads: Beads["Service"]) => Effect.Effect<A, E>,
) =>
  inMemory(
    [{ id: "t-1" }],
    Effect.gen(function* () {
      yield* (yield* Backlog).fail(op, fault)
      return yield* call(yield* Beads)
    }),
  )

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
  return exit.value
}

describe("a fault on a read", () => {
  test("whose stdout decodes is bd's answer, whatever the exit code", async () => {
    const exit = await faulted("list", { exitCode: 1, stdout: fixture("list.json") }, (beads) =>
      beads.list(),
    )
    expect(success(exit).map((issue) => issue.id)).toContain("demo-mtp.2" as TicketId)
  })

  test("whose stdout doesn't decode is bd failing, or unreadable when bd exits 0", async () => {
    const failed = failure(await faulted("ready", { stderr: "locked" }, (beads) => beads.ready()))
    expect(failed).toBeInstanceOf(BeadsFailed)
    expect(failed).toMatchObject({ exitCode: 1, stderr: "locked", noSuchIssue: false })
    const unreadable = failure(
      await faulted("show", { exitCode: 0, stdout: "Warning: not JSON" }, (beads) =>
        beads.show("t-1" as TicketId),
      ),
    )
    expect(unreadable).toBeInstanceOf(BeadsUnreadable)
    expect(unreadable).toMatchObject({ command: "bd show t-1 --json" })
  })

  test("whose stdout says bd has no such issue fails with noSuchIssue", async () => {
    for (const call of [
      (beads: Beads["Service"]) => Effect.asVoid(beads.show("t-1" as TicketId)),
      (beads: Beads["Service"]) => Effect.asVoid(beads.metadata("t-1" as TicketId)),
    ]) {
      const error = failure(await faulted("show", { stdout: noSuchIssueStdout }, call))
      expect(error).toMatchObject({ _tag: "BeadsFailed", noSuchIssue: true })
    }
  })

  test("of bd show answering for another ticket is bd having no such issue", async () => {
    const exit = await faulted("show", { exitCode: 0, stdout: fixture("show-b.json") }, (beads) =>
      beads.show("t-1" as TicketId),
    )
    expect(failure(exit)).toMatchObject({ _tag: "BeadsFailed", noSuchIssue: true })
  })
})

describe("a fault on a write", () => {
  test("that exits 0 gives the issue its stdout decodes to, and changes nothing", async () => {
    const exit = await inMemory(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const backlog = yield* Backlog
        yield* backlog.fail("update", { exitCode: 0, stdout: fixture("update-claim.json") })
        const claimed = yield* (yield* Beads).update("t-1" as TicketId, { claim: true })
        return { claimed, stored: yield* backlog.get("t-1") }
      }),
    )
    const { claimed, stored } = success(exit)
    expect(claimed).toMatchObject({ id: "demo-mtp.1", status: "in_progress" })
    expect(stored?.status).toBe("open")
  })

  test("that exits 0 with stdout that isn't an issue is unreadable", async () => {
    const exit = await faulted("close", { exitCode: 0 }, (beads) => beads.close("t-1" as TicketId))
    expect(failure(exit)).toBeInstanceOf(BeadsUnreadable)
  })

  test("that fails is bd failing, though its stdout decodes", async () => {
    const exit = await faulted("update", { stdout: fixture("update-claim.json") }, (beads) =>
      beads.update("t-1" as TicketId, { claim: true }),
    )
    expect(failure(exit)).toMatchObject({ _tag: "BeadsFailed", exitCode: 1, noSuchIssue: false })
  })
})

describe("the backlog's answers, decoded as bd's", () => {
  test("metadata goes through JSON: what JSON has no form for doesn't survive", async () => {
    const exit = await inMemory(
      [{ id: "t-1", metadata: { gone: undefined, at: new Date(0), files: "a.ts b.ts" } }],
      Effect.gen(function* () {
        const beads = yield* Beads
        return { shown: yield* beads.show("t-1" as TicketId), listed: yield* beads.list() }
      }),
    )
    const { shown, listed } = success(exit)
    expect(shown.metadata).toEqual({ at: "1970-01-01T00:00:00.000Z", files: "a.ts b.ts" })
    expect(shown.files).toEqual(["a.ts", "b.ts"])
    expect(listed[0]?.metadata).toEqual(shown.metadata)
  })

  test("no questions is bd human list's null, read as none", async () => {
    const exit = await inMemory(
      [{ id: "t-1" }],
      Effect.flatMap(Beads, (beads) => beads.questions()),
    )
    expect(success(exit)).toEqual([])
  })

  test("a show for an ID it has no issue for fails from bd's stdout", async () => {
    const exit = await inMemory(
      [{ id: "t-1" }],
      Effect.flatMap(Beads, (beads) => beads.show("t-gone" as TicketId)),
    )
    expect(failure(exit)).toMatchObject({
      _tag: "BeadsFailed",
      command: "bd show t-gone --json",
      exitCode: 1,
      noSuchIssue: true,
    })
  })

  test("a write for an ID it has no issue for fails as the show before it does", async () => {
    const exit = await inMemory(
      [{ id: "t-1" }],
      Effect.flatMap(Beads, (beads) =>
        beads.addDependency("t-1" as TicketId, "t-gone" as TicketId),
      ),
    )
    expect(failure(exit)).toMatchObject({
      _tag: "BeadsFailed",
      command: "bd show t-gone --json",
      noSuchIssue: true,
    })
  })
})

describe("the judgement both layers share", () => {
  const decodeNothing = (command: string, stdout: string) =>
    stdout === "ok"
      ? Effect.succeed("read")
      : Effect.fail(new BeadsUnreadable({ command, reason: "not ok", output: stdout }))

  test("a read decodes whatever the exit code; failing to, its exit code decides", () => {
    const judged = (exitCode: number, stdout: string) =>
      Effect.runSync(
        Effect.exit(judgeRead("bd x", { exitCode, stdout, stderr: "e" }, decodeNothing)),
      )
    expect(success(judged(3, "ok"))).toBe("read")
    expect(failure(judged(0, "no"))).toBeInstanceOf(BeadsUnreadable)
    expect(failure(judged(3, "no"))).toMatchObject({
      _tag: "BeadsFailed",
      exitCode: 3,
      stderr: "e",
    })
  })

  test("a write is done when bd exits 0; failing, its stdout says whether it has the issue", () => {
    const judged = (exitCode: number, stdout: string) =>
      Effect.runSync(Effect.exit(judgeWrite("bd x", { exitCode, stdout, stderr: "" })))
    expect(Exit.isSuccess(judged(0, ""))).toBe(true)
    expect(failure(judged(1, ""))).toMatchObject({ noSuchIssue: false })
    expect(failure(judged(1, JSON.stringify({ error: noSuchIssueError })))).toMatchObject({
      noSuchIssue: true,
    })
  })
})
