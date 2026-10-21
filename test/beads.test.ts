import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Duration, Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import {
  Beads,
  type BeadsError,
  BeadsFailed,
  BeadsTimedOut,
  BeadsUnreadable,
  decodeDependencies,
  decodeIssue,
  decodeIssues,
  type Issue,
  metadataList,
  saysNoSuchIssue,
} from "../src/services/Beads.ts"
import { Backlog, layer as backlogLayer, type Seed } from "../src/testing/Beads.ts"
import { machineWhich } from "./env.ts"
import { slow } from "./gates.ts"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/bd", name), "utf8")

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const decoded = <A>(effect: Effect.Effect<A, BeadsUnreadable>): A => Effect.runSync(effect)

const byId = (issues: ReadonlyArray<Issue>, id: string): Issue => {
  const issue = issues.find((each) => each.id === id)
  if (issue === undefined) throw new Error(`no ${id} in ${issues.map((each) => each.id)}`)
  return issue
}

describe("decoding bd --json", () => {
  test("bd ready: issues with labels, metadata files, parent and links by ID", () => {
    const ready = decoded(decodeIssues("bd ready", fixture("ready.json")))
    expect(ready.map((issue) => issue.id)).toEqual([
      "demo-1an",
      "demo-mtp",
      "demo-8df",
      "demo-5ox",
      "demo-mtp.3",
    ])
    const filed = byId(ready, "demo-mtp.3")
    expect(filed).toMatchObject({
      title: "Filed follow-up",
      description: "found while working",
      status: "open",
      priority: 2,
      type: "task",
      labels: ["area:ui"],
      parent: "demo-mtp",
      files: ["src/c.ts"],
      predictedFiles: [],
      metadata: { files: ["src/c.ts"] },
    })
    expect(filed.dependencies).toEqual([
      { id: "demo-mtp.1", type: "discovered-from" },
      { id: "demo-mtp", type: "parent-child" },
    ])
    expect(byId(ready, "demo-8df")).toMatchObject({ labels: [], dependencies: [], acceptance: "" })
  })

  test("bd ready in the v2 envelope", () => {
    const ready = decoded(decodeIssues("bd ready", fixture("ready-envelope.json")))
    expect(ready.map((issue) => [issue.id, issue.type, issue.priority])).toEqual([
      ["demo-1an", "bug", 0],
    ])
  })

  test("bd list: closed issues' deferral and every link type", () => {
    const list = decoded(decodeIssues("bd list", fixture("list.json")))
    expect(byId(list, "demo-zwl")).toMatchObject({
      status: "deferred",
      deferUntil: "2098-12-31T22:00:00Z",
    })
    expect(byId(list, "demo-mtp.2").dependencies).toEqual([
      { id: "demo-mtp", type: "parent-child" },
      { id: "demo-mtp.1", type: "blocks" },
    ])
    expect(byId(list, "demo-mtp.1")).toMatchObject({
      acceptance: "a ok",
      labels: ["area:ui", "solo"],
      files: ["src/a.ts", "src/b.ts"],
    })
  })

  test("bd show: the linked issues, with their status and labels", () => {
    const issue = decoded(decodeIssue("bd show", fixture("show-c.json")))
    expect(issue.id).toBe("demo-1an")
    expect(issue.parent).toBeUndefined()
    expect(issue.dependencies.map((d) => [d.id, d.type, d.issue?.status, d.issue?.labels])).toEqual(
      [
        ["demo-mtp.1", "discovered-from", "open", ["area:ui", "solo"]],
        ["demo-n0n", "blocks", "open", ["human"]],
      ],
    )
    const child = decoded(decodeIssue("bd show", fixture("show-b.json")))
    expect(child.parent).toBe("demo-mtp")
    expect(child.dependencies[1]?.issue?.files).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("bd show of an ID bd has no issue for", () => {
    const output = fixture("show-missing.json")
    expect(saysNoSuchIssue(output)).toBe(true)
    expect(saysNoSuchIssue(fixture("show-c.json"))).toBe(false)
    const error = failure(Effect.runSyncExit(decodeIssue("bd show nope --json", output)))
    expect(error).toBeInstanceOf(BeadsUnreadable)
    expect(error.command).toBe("bd show nope --json")
    expect(error.output).toContain("no issues found")
  })

  test("bd update, close, defer and create give the issue they changed", () => {
    const claimed = decoded(decodeIssue("bd update", fixture("update-claim.json")))
    expect(claimed).toMatchObject({ status: "in_progress", assignee: "A Maintainer" })
    const set = decoded(decodeIssue("bd update", fixture("update-set-metadata.json")))
    expect(set).toMatchObject({
      notes: "note one",
      files: ["src/a.ts", "src/b.ts"],
      predictedFiles: ["x.ts"],
    })
    const reopened = decoded(decodeIssue("bd update", fixture("update-status.json")))
    expect(reopened).toMatchObject({ status: "open", files: [], predictedFiles: ["x.ts"] })
    const closed = decoded(decodeIssue("bd close", fixture("close.json")))
    expect(closed).toMatchObject({ status: "closed", closeReason: "done" })
    const deferred = decoded(decodeIssue("bd defer", fixture("defer.json")))
    expect(deferred).toMatchObject({ status: "deferred", notes: "later" })
    const created = decoded(decodeIssue("bd create", fixture("create.json")))
    expect(created).toMatchObject({ id: "demo-mtp.3", labels: ["area:ui"], files: ["src/c.ts"] })
  })

  test("bd dep list: each linked issue and how it links", () => {
    const deps = decoded(decodeDependencies("bd dep list", fixture("dep-list-b.json")))
    expect(deps.map((d) => [d.id, d.type, d.issue?.title])).toEqual([
      ["demo-mtp", "parent-child", "Epic one"],
      ["demo-mtp.1", "blocks", "Child A"],
    ])
  })

  test("bd human list", () => {
    const questions = decoded(decodeIssues("bd human list", fixture("human-list.json")))
    expect(questions.map((issue) => [issue.id, issue.labels])).toEqual([["demo-n0n", ["human"]]])
  })

  test("output that isn't what the command gives is BeadsUnreadable", () => {
    for (const output of ["", "not json", "{}", '[{"id": 1}]', fixture("label-add.json")]) {
      const error = failure(Effect.runSyncExit(decodeIssues("bd ready", output)))
      expect(error).toBeInstanceOf(BeadsUnreadable)
    }
    const error = failure(Effect.runSyncExit(decodeIssue("bd show", "[]")))
    expect(error.reason).toStartWith("an issue:")
  })

  test("metadata in a string, and files in every form orchestra reads", () => {
    const issue = decoded(
      decodeIssue(
        "bd show",
        JSON.stringify({
          id: "x-1",
          title: "t",
          status: "open",
          metadata: JSON.stringify({ files: "a.ts, b.ts\nc.ts", predicted_files: '["d.ts"]' }),
        }),
      ),
    )
    expect(issue.files).toEqual(["a.ts", "b.ts", "c.ts"])
    expect(issue.predictedFiles).toEqual(["d.ts"])
    expect(metadataList({ files: `["a.ts", 'b.ts'` }, "files")).toEqual(["a.ts", "b.ts"])
    expect(metadataList({ files: [1, 2] }, "files")).toEqual([])
    expect(metadataList({ files: { a: 1 } }, "files")).toEqual([])
    expect(metadataList({}, "files")).toEqual([])
    const odd = decoded(
      decodeIssue("bd show", '{"id":"x","title":"t","status":"open","metadata":[1]}'),
    )
    expect(odd.metadata).toEqual({})
  })
})

// An issue as bd might give it: each field of the right type, of the wrong one, or missing.
const anyJson = fc.jsonValue({ maxDepth: 2 })
const field = <A>(right: fc.Arbitrary<A>) =>
  fc.option(fc.oneof(right, anyJson), { nil: undefined, freq: 3 })
const issueLike = fc
  .record({
    id: field(fc.string()),
    title: field(fc.string()),
    status: field(fc.constantFrom("open", "in_progress", "closed", "deferred", "blocked")),
    description: field(fc.string()),
    priority: field(fc.integer({ min: 0, max: 4 })),
    labels: field(fc.array(fc.string())),
    parent: field(fc.string()),
    metadata: field(
      fc.oneof(
        fc.dictionary(fc.string(), anyJson),
        fc.dictionary(fc.string(), anyJson).map((m) => JSON.stringify(m)),
      ),
    ),
    dependencies: field(
      fc.array(
        fc.oneof(
          fc.record({ issue_id: fc.string(), depends_on_id: fc.string(), type: fc.string() }),
          fc.record({
            id: fc.string(),
            title: fc.string(),
            status: fc.string(),
            dependency_type: fc.string(),
          }),
        ),
      ),
    ),
  })
  .map((issue) => Object.fromEntries(Object.entries(issue).filter(([, v]) => v !== undefined)))

const output = fc.oneof(
  fc.string(),
  fc.json(),
  anyJson.map((value) => JSON.stringify(value)),
  issueLike.map((issue) => JSON.stringify(issue)),
  fc.array(issueLike).map((issues) => JSON.stringify(issues)),
  fc.array(issueLike).map((issues) => JSON.stringify({ schema_version: 2, data: issues })),
)

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((each) => typeof each === "string")

const wellFormed = (issue: Issue): boolean =>
  typeof issue.id === "string" &&
  typeof issue.title === "string" &&
  typeof issue.status === "string" &&
  typeof issue.description === "string" &&
  (issue.priority === undefined || typeof issue.priority === "number") &&
  strings(issue.labels) &&
  strings(issue.files) &&
  strings(issue.predictedFiles) &&
  typeof issue.metadata === "object" &&
  issue.metadata !== null &&
  !Array.isArray(issue.metadata) &&
  issue.dependencies.every(
    (d) =>
      typeof d.id === "string" &&
      typeof d.type === "string" &&
      (d.issue === undefined || wellFormed(d.issue)),
  )

/** Whether an exit is Issues that are well formed, or BeadsUnreadable: never a defect. */
const issuesOrUnreadable = (
  exit: Exit.Exit<unknown, BeadsUnreadable>,
  one: (a: unknown) => Issue[],
) =>
  Exit.isSuccess(exit)
    ? one(exit.value).every(wellFormed)
    : exit.cause.reasons.length > 0 &&
      exit.cause.reasons.every(
        (reason) => reason._tag === "Fail" && reason.error instanceof BeadsUnreadable,
      )

describe("decoding arbitrary output", () => {
  // 2000 runs of three decoders: past bun's 5 s on a loaded machine.
  test(
    "never throws, and yields only well-formed Issues or BeadsUnreadable",
    () => {
      fc.assert(
        fc.property(output, (stdout) => {
          const list = Effect.runSyncExit(decodeIssues("bd ready", stdout))
          const one = Effect.runSyncExit(decodeIssue("bd show", stdout))
          const deps = Effect.runSyncExit(decodeDependencies("bd dep list", stdout))
          return (
            issuesOrUnreadable(list, (a) => [...(a as Issue[])]) &&
            issuesOrUnreadable(one, (a) => [a as Issue]) &&
            issuesOrUnreadable(deps, (a) =>
              (a as Array<{ issue: Issue }>).map((dependency) => dependency.issue),
            ) &&
            typeof saysNoSuchIssue(stdout) === "boolean"
          )
        }),
        { numRuns: 2000 },
      )
    },
    { timeout: 60_000 },
  )

  test("metadataList returns strings for any metadata", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), anyJson), fc.string(), (metadata, key) =>
        strings(metadataList(metadata, key)),
      ),
    )
  })
})

// The in-memory backlog.
const inMemory = <A, E>(
  seeds: ReadonlyArray<Seed>,
  effect: Effect.Effect<A, E, Beads | Backlog | TestClock.TestClock>,
) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.merge(backlogLayer(seeds), TestClock.layer())) as Effect.Effect<
      A,
      E
    >,
  )

const readyIds = (options?: Parameters<Beads["Service"]["ready"]>[0]) =>
  Effect.flatMap(Beads, (beads) =>
    Effect.map(beads.ready(options), (issues) => issues.map((issue) => issue.id)),
  )

const now = Date.parse("2026-10-17T12:00:00Z")

describe("the in-memory backlog", () => {
  test("ready: open, not deferred until later, not blocked; by priority, then oldest", async () => {
    const ids = await inMemory(
      [
        { id: "t-open", priority: 2 },
        { id: "t-urgent", priority: 0 },
        { id: "t-progress", status: "in_progress" },
        { id: "t-blocked-status", status: "blocked" },
        { id: "t-closed", status: "closed" },
        { id: "t-iced", status: "deferred" },
        { id: "t-snoozed", status: "deferred", deferUntil: "2026-10-18T00:00:00Z" },
        { id: "t-later", deferUntil: "2026-10-18T00:00:00Z" },
        { id: "t-past", deferUntil: "2026-10-01T00:00:00Z" },
        { id: "t-pinned", status: "pinned" },
      ],
      Effect.andThen(TestClock.setTime(now), readyIds()),
    )
    expect(ids).toEqual(["t-urgent", "t-open", "t-past"])
  })

  test("a deferral wakes once its date passes", async () => {
    const [before, after, woken] = await inMemory(
      [{ id: "t-1", status: "deferred", deferUntil: "2026-10-17T13:00:00Z" }],
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        const before = yield* readyIds()
        yield* TestClock.adjust("2 hours")
        const after = yield* readyIds()
        const woken = yield* (yield* Beads).show("t-1")
        return [before, after, woken] as const
      }),
    )
    expect(before).toEqual([])
    expect(after).toEqual(["t-1"])
    expect(woken.status).toBe("open")
    expect(woken.deferUntil).toBeUndefined()
  })

  test("a blocks link holds an issue back until its blocker closes, whatever else it is", async () => {
    const steps = await inMemory(
      [
        { id: "t-blocker" },
        { id: "t-waits", blockedBy: ["t-blocker"] },
        { id: "t-found", dependencies: [{ id: "t-blocker", type: "discovered-from" }] },
        { id: "t-related", dependencies: [{ id: "t-blocker", type: "related" }] },
      ],
      Effect.gen(function* () {
        const beads = yield* Beads
        const open = yield* readyIds()
        yield* beads.update("t-blocker", { claim: true })
        const claimed = yield* readyIds()
        yield* beads.defer("t-blocker")
        const deferred = yield* readyIds()
        yield* beads.close("t-blocker", "done")
        const closed = yield* readyIds()
        return { open, claimed, deferred, closed }
      }),
    )
    expect(steps).toEqual({
      open: ["t-blocker", "t-found", "t-related"],
      claimed: ["t-found", "t-related"],
      deferred: ["t-found", "t-related"],
      closed: ["t-waits", "t-found", "t-related"],
    })
  })

  test("a blocked ancestor holds its descendants back; its status alone doesn't", async () => {
    const steps = await inMemory(
      [
        { id: "t-epic", type: "epic" },
        { id: "t-epic.1", parent: "t-epic" },
        { id: "t-epic.1.1", parent: "t-epic.1" },
        { id: "t-other" },
      ],
      Effect.gen(function* () {
        const beads = yield* Beads
        const all = yield* readyIds()
        const scoped = yield* readyIds({ parent: "t-epic" })
        yield* beads.addDependency("t-epic.1", "t-other")
        const blocked = yield* readyIds()
        yield* beads.close("t-other")
        yield* beads.update("t-epic.1", { status: "in_progress" })
        const inProgress = yield* readyIds()
        yield* beads.defer("t-epic")
        const deferred = yield* readyIds()
        const epics = yield* readyIds({ excludeTypes: ["epic"], excludeLabels: ["human"] })
        return { all, scoped, blocked, inProgress, deferred, epics }
      }),
    )
    expect(steps).toEqual({
      all: ["t-epic", "t-epic.1", "t-epic.1.1", "t-other"],
      scoped: ["t-epic.1", "t-epic.1.1"],
      blocked: ["t-epic", "t-other"],
      inProgress: ["t-epic", "t-epic.1.1"],
      deferred: ["t-epic.1.1"],
      epics: ["t-epic.1.1"],
    })
  })

  test("labels: add once, remove, filter list, and leave human-labelled questions out", async () => {
    const result = await inMemory(
      [{ id: "t-1" }, { id: "t-2", labels: ["solo"] }, { id: "t-q", labels: ["human"] }],
      Effect.gen(function* () {
        const beads = yield* Beads
        yield* beads.addLabel("t-1", "area:ui")
        yield* beads.addLabel("t-1", "area:ui")
        yield* beads.addLabel("t-1", "solo")
        yield* beads.removeLabel("t-2", "solo")
        const one = yield* beads.show("t-1")
        const solo = yield* beads.list({ labels: ["solo"] })
        const ready = yield* readyIds({ excludeLabels: ["human"] })
        const questions = yield* beads.questions()
        return { labels: one.labels, solo: solo.map((issue) => issue.id), ready, questions }
      }),
    )
    expect(result.labels).toEqual(["area:ui", "solo"])
    expect(result.solo).toEqual(["t-1"])
    expect(result.ready).toEqual(["t-1", "t-2"])
    expect(result.questions.map((issue) => issue.id)).toEqual(["t-q"])
  })

  test("metadata: set and unset keys, files read from it, list by a field", async () => {
    const result = await inMemory(
      [{ id: "t-1", metadata: { files: ["a.ts"], spec: "s.md" } }, { id: "t-2" }],
      Effect.gen(function* () {
        const beads = yield* Beads
        yield* beads.setMetadata("t-1", "predicted_files", '["b.ts"]')
        yield* beads.setMetadata("t-2", "files", "c.ts,d.ts")
        yield* beads.unsetMetadata("t-1", "spec")
        const one = yield* beads.show("t-1")
        const two = yield* beads.metadata("t-2")
        const bySpec = yield* beads.list({ metadata: { files: "c.ts,d.ts" } })
        return { one, two, bySpec: bySpec.map((issue) => issue.id) }
      }),
    )
    expect(result.one.metadata).toEqual({ files: ["a.ts"], predicted_files: '["b.ts"]' })
    expect(result.one.files).toEqual(["a.ts"])
    expect(result.one.predictedFiles).toEqual(["b.ts"])
    expect(result.two).toEqual({ files: "c.ts,d.ts" })
    expect(result.bySpec).toEqual(["t-2"])
  })

  test("update claims, sets the status and appends notes; close gives its reason", async () => {
    const result = await inMemory(
      [{ id: "t-1", notes: "first" }],
      Effect.gen(function* () {
        const beads = yield* Beads
        const claimed = yield* beads.update("t-1", { claim: true, appendNotes: "second" })
        const reopened = yield* beads.update("t-1", { status: "open" })
        const closed = yield* beads.close("t-1", "merged")
        const listed = yield* beads.list()
        const all = yield* beads.list({ all: true })
        return { claimed, reopened, closed, listed, all }
      }),
    )
    expect(result.claimed).toMatchObject({
      status: "in_progress",
      assignee: "tutti",
      notes: "first\nsecond",
    })
    expect(result.reopened.status).toBe("open")
    expect(result.closed).toMatchObject({ status: "closed", closeReason: "merged" })
    expect(result.listed).toEqual([])
    expect(result.all.map((issue) => issue.id)).toEqual(["t-1"])
  })

  test("create numbers subtickets after their parent, with their links", async () => {
    const result = await inMemory(
      [{ id: "t-epic", type: "epic" }, { id: "t-work" }],
      Effect.gen(function* () {
        const beads = yield* Beads
        const first = yield* beads.create({ title: "one", parent: "t-epic" })
        const second = yield* beads.create({
          title: "two",
          parent: "t-epic",
          blockedBy: [first.id],
          discoveredFrom: ["t-work"],
          labels: ["area:x"],
          metadata: { files: ["x.ts"] },
          priority: 1,
          type: "bug",
        })
        const question = yield* beads.create({
          title: "A question?",
          labels: ["human"],
          blocks: ["t-work"],
        })
        const shown = yield* beads.show(second.id)
        const up = yield* beads.dependencies(first.id, { direction: "up" })
        const down = yield* beads.dependencies(second.id, { type: "blocks" })
        const ready = yield* readyIds()
        return { first, second, question, shown, up, down, ready }
      }),
    )
    expect(result.first.id).toBe("t-epic.1")
    expect(result.second).toMatchObject({
      id: "t-epic.2",
      parent: "t-epic",
      priority: 1,
      type: "bug",
      labels: ["area:x"],
      files: ["x.ts"],
    })
    expect(result.question.id).toBe("test-5")
    expect(result.shown.dependencies.map((d) => [d.id, d.type, d.issue?.title])).toEqual([
      ["t-epic", "parent-child", "t-epic"],
      ["t-epic.1", "blocks", "one"],
      ["t-work", "discovered-from", "t-work"],
    ])
    expect(result.up.map((d) => [d.id, d.type])).toEqual([["t-epic.2", "blocks"]])
    expect(result.down.map((d) => d.id)).toEqual(["t-epic.1"])
    expect(result.ready).toEqual(["t-epic", "t-epic.1", "test-5"])
  })

  test("an ID it has no issue for fails as bd does", async () => {
    const exits = await inMemory(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const beads = yield* Beads
        return [
          yield* Effect.exit(Effect.asVoid(beads.show("t-gone"))),
          yield* Effect.exit(Effect.asVoid(beads.update("t-gone", { claim: true }))),
          yield* Effect.exit(beads.addDependency("t-1", "t-gone")),
          yield* Effect.exit(Effect.asVoid(beads.create({ title: "x", parent: "t-gone" }))),
        ]
      }),
    )
    for (const exit of exits) {
      const error = failure(exit)
      expect(error).toBeInstanceOf(BeadsFailed)
      expect(error).toMatchObject({ noSuchIssue: true, exitCode: 1 })
    }
  })

  test("the Backlog shows and changes what Beads sees", async () => {
    const result = await inMemory(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const backlog = yield* Backlog
        yield* backlog.put({ id: "t-1", status: "closed", closeReason: "by a worker" })
        yield* backlog.put({ id: "t-2", priority: 0 })
        const ready = yield* readyIds()
        const one = yield* backlog.get("t-1")
        const all = yield* backlog.issues
        return { ready, one, all: all.map((issue) => issue.id), none: yield* backlog.get("t-x") }
      }),
    )
    expect(result.ready).toEqual(["t-2"])
    expect(result.one).toMatchObject({ status: "closed", closeReason: "by a worker" })
    expect(result.all).toEqual(["t-1", "t-2"])
    expect(result.none).toBeUndefined()
  })
})

// The live layer, against a stand-in for bd that records its arguments and environment.
const fakeBd = (script: string) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-beads-"))
  const bin = join(dir, "bd")
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\necho "$BD_JSON_ENVELOPE" > '${dir}/env'\n${script}\n`,
  )
  chmodSync(bin, 0o755)
  return {
    dir,
    bin,
    args: () => readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n"),
    env: () => readFileSync(join(dir, "env"), "utf8").trim(),
  }
}

const live = <A, E>(
  fake: { dir: string; bin: string },
  effect: Effect.Effect<A, E, Beads>,
  timeLimits?: { read: Duration.Input; write: Duration.Input },
) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(
        effect,
        Beads.layer({
          cwd: fake.dir,
          command: fake.bin,
          ...(timeLimits === undefined ? {} : { timeLimits }),
        }).pipe(Layer.provide(BunServices.layer)),
      ),
    ),
  )

const withBeads = <A, E>(f: (beads: Beads["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(Beads, f)

describe("the live layer", () => {
  test("runs bd ready with no limit and its filters, pinning the JSON shape", async () => {
    const fake = fakeBd(`cat '${join(import.meta.dir, "fixtures/bd/ready.json")}'`)
    const exit = await live(
      fake,
      withBeads((beads) =>
        beads.ready({
          parent: "demo-mtp",
          excludeLabels: ["human"],
          excludeTypes: ["epic", "chore"],
        }),
      ),
    )
    expect(Exit.isSuccess(exit) && exit.value.length).toBe(5)
    expect(fake.args()).toEqual([
      "ready",
      "--json",
      "--limit=0",
      "--parent=demo-mtp",
      "--exclude-label=human",
      "--exclude-type=epic,chore",
    ])
    expect(fake.env()).toBe("0")
  })

  test("passes update, create and list arguments as bd takes them", async () => {
    const fake = fakeBd(`cat '${join(import.meta.dir, "fixtures/bd/update-claim.json")}'`)
    await live(
      fake,
      withBeads((beads) =>
        beads.update("demo-1", {
          claim: true,
          status: "in_progress",
          appendNotes: "--a note, with = and spaces",
          setMetadata: { predicted_files: '["a.ts"]' },
          unsetMetadata: ["files"],
        }),
      ),
    )
    expect(fake.args()).toEqual([
      "update",
      "demo-1",
      "--json",
      "--claim",
      "--status=in_progress",
      "--append-notes=--a note, with = and spaces",
      '--set-metadata=predicted_files=["a.ts"]',
      "--unset-metadata=files",
    ])
    await live(
      fake,
      withBeads((beads) =>
        beads.create({
          title: "T",
          description: "D",
          type: "bug",
          priority: 0,
          parent: "demo-1",
          blockedBy: ["demo-2"],
          blocks: ["demo-3"],
          discoveredFrom: ["demo-4"],
          labels: ["a", "b"],
          metadata: { files: ["x.ts"] },
        }),
      ),
    )
    expect(fake.args()).toEqual([
      "create",
      "--json",
      "--title=T",
      "--description=D",
      "--type=bug",
      "--priority=0",
      "--parent=demo-1",
      "--deps=blocked-by:demo-2",
      "--deps=blocks:demo-3",
      "--deps=discovered-from:demo-4",
      "--labels=a,b",
      '--metadata={"files":["x.ts"]}',
    ])
    await live(
      fake,
      withBeads((beads) =>
        beads.list({ all: true, parent: "demo-1", labels: ["x", "y"], metadata: { spec: "s.md" } }),
      ),
    )
    expect(fake.args()).toEqual([
      "list",
      "--json",
      "--limit=0",
      "--all",
      "--parent=demo-1",
      "--label=x",
      "--label=y",
      "--metadata-field=spec=s.md",
    ])
    await live(
      fake,
      withBeads((beads) => beads.addDependency("demo-1", "demo-2")),
    )
    expect(fake.args()).toEqual(["dep", "add", "demo-1", "demo-2", "--json", "--type=blocks"])
    await live(
      fake,
      withBeads((beads) => beads.dependencies("demo-1", { direction: "up" })),
    )
    expect(fake.args()).toEqual(["dep", "list", "demo-1", "--json", "--direction=up"])
    await live(
      fake,
      withBeads((beads) => beads.close("demo-1", "done")),
    )
    expect(fake.args()).toEqual(["close", "demo-1", "--json", "--reason=done"])
    await live(
      fake,
      withBeads((beads) => beads.defer("demo-1", { reason: "r", until: "+1h" })),
    )
    expect(fake.args()).toEqual(["defer", "demo-1", "--json", "--reason=r", "--until=+1h"])
    await live(
      fake,
      withBeads((beads) => beads.removeLabel("demo-1", "solo")),
    )
    expect(fake.args()).toEqual(["label", "remove", "demo-1", "solo", "--json"])
    await live(
      fake,
      withBeads((beads) => beads.questions()),
    )
    expect(fake.args()).toEqual(["human", "list", "--json"])
  })

  test("a read that decodes is bd's answer, whatever its exit code", async () => {
    const fake = fakeBd(`cat '${join(import.meta.dir, "fixtures/bd/ready.json")}'; exit 1`)
    const exit = await live(
      fake,
      withBeads((beads) => beads.ready()),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a read that doesn't decode is BeadsFailed with bd's stderr when bd failed", async () => {
    const fake = fakeBd(`cat '${join(import.meta.dir, "fixtures/bd/show-missing.json")}'
echo 'Issue nope not found' >&2; exit 1`)
    const error = failure(
      await live(
        fake,
        withBeads((beads) => beads.show("nope")),
      ),
    )
    expect(error).toBeInstanceOf(BeadsFailed)
    expect(error).toMatchObject({
      command: "bd show nope --json",
      exitCode: 1,
      stderr: "Issue nope not found\n",
      noSuchIssue: true,
    })
  })

  test("a read that doesn't decode is BeadsUnreadable when bd exited 0", async () => {
    const fake = fakeBd("echo 'ready: 3 issues'")
    const error = failure(
      await live(
        fake,
        withBeads((beads) => beads.ready()),
      ),
    )
    expect(error).toBeInstanceOf(BeadsUnreadable)
    expect(error).toMatchObject({ output: "ready: 3 issues" })
  })

  test("an update is judged by its exit code", async () => {
    const fake = fakeBd("echo 'cannot claim' >&2; exit 13")
    const error = failure(
      await live(
        fake,
        withBeads((beads) => beads.addLabel("demo-1", "x")),
      ),
    )
    expect(error).toMatchObject({ _tag: "BeadsFailed", exitCode: 13, stderr: "cannot claim\n" })
  })

  // A bd that takes 1 s, three times over, two of them killed at their limit: 3.5 s alone under
  // load, past bun's 5 s with more. The limit a read must keep within is as roomy.
  test("reads get the read limit and updates the write limit", async () => {
    const fake = fakeBd(`sleep 1; cat '${join(import.meta.dir, "fixtures/bd/close.json")}'`)
    const limits = { read: "30 seconds", write: "200 millis" } as const
    const read = await live(
      fake,
      withBeads((beads) => beads.show("demo-1")),
      limits,
    )
    expect(Exit.isSuccess(read)).toBe(true)
    const write = failure(
      await live(
        fake,
        withBeads((beads) => beads.close("demo-1")),
        limits,
      ),
    )
    expect(write).toBeInstanceOf(BeadsTimedOut)
    expect(write.command).toBe("bd close demo-1 --json")
    const slowRead = failure(
      await live(
        fake,
        withBeads((beads) => beads.list()),
        { read: "200 millis", write: "30 seconds" },
      ),
    )
    expect(slowRead).toBeInstanceOf(BeadsTimedOut)
  }, 30_000)

  test("a bd that can't be started is BeadsFailed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-beads-"))
    const error = failure(
      await live(
        { dir, bin: join(dir, "no-such-bd") },
        withBeads((beads) => beads.ready()),
      ),
    )
    expect(error).toMatchObject({ _tag: "BeadsFailed", exitCode: 127 })
  })
})

/** Whether the effect succeeded, or the tag of its error, with bd's exit code when it has one. */
const outcome = <A, E extends BeadsError>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) return "done"
    const error = failure(exit)
    return error._tag === "BeadsFailed" ? `${error._tag} ${error.exitCode}` : error._tag
  })

// The same backlog, built through Beads, in a real bd and in memory: the ready queue must match.
const scenario = Effect.gen(function* () {
  const beads = yield* Beads
  const titles = (issues: ReadonlyArray<Issue>) => issues.map((issue) => issue.title).sort()
  const ready = Effect.map(beads.ready(), titles)
  const steps: Array<ReadonlyArray<string>> = []
  const epic = yield* beads.create({ title: "epic", type: "epic", priority: 1 })
  const a = yield* beads.create({ title: "a", parent: epic.id, labels: ["solo"] })
  const b = yield* beads.create({ title: "b", parent: epic.id, blockedBy: [a.id] })
  const grandchild = yield* beads.create({ title: "grandchild", parent: a.id })
  const loose = yield* beads.create({ title: "loose", discoveredFrom: [a.id], priority: 0 })
  yield* beads.create({ title: "question", labels: ["human"], blocks: [loose.id] })
  const other = yield* beads.create({ title: "other", type: "chore" })
  steps.push(yield* ready)
  yield* beads.update(a.id, { claim: true })
  steps.push(yield* ready)
  yield* beads.addDependency(a.id, other.id)
  yield* beads.update(a.id, { status: "open" })
  steps.push(yield* ready)
  yield* beads.close(other.id, "done")
  steps.push(yield* ready)
  yield* beads.defer(epic.id)
  steps.push(yield* ready)
  // bd refuses to close an issue with a live blocker, or with a child that isn't closed.
  steps.push([yield* outcome(beads.close(loose.id))])
  steps.push([yield* outcome(beads.update(a.id, { status: "closed" }))])
  yield* beads.close(grandchild.id)
  steps.push([yield* outcome(beads.close(a.id))])
  yield* beads.addLabel(b.id, "area:x")
  yield* beads.removeLabel(b.id, "area:x")
  steps.push(yield* ready)
  steps.push(titles(yield* beads.ready({ parent: epic.id, excludeLabels: ["human"] })))
  steps.push(titles(yield* beads.questions()))
  const shown = yield* beads.show(b.id)
  steps.push([shown.parent === epic.id ? "parent" : "no parent", ...shown.labels])
  steps.push(
    titles((yield* beads.dependencies(a.id, { direction: "up" })).flatMap((d) => d.issue ?? [])),
  )
  return steps
})

// The machine's bd, which the tests' PATH leaves out (test/env.ts).
const bd = machineWhich("bd")

describe("against a real bd", () => {
  ;(bd !== null ? slow.test : test.skip)(
    "the in-memory backlog's ready queue, labels and links match bd's",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tutti-bd-"))
      const sh = (...cmd: Array<string>) => {
        const result = Bun.spawnSync(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`)
      }
      sh("git", "init", "-q")
      sh(bd ?? "bd", "init", "--quiet", "--prefix", "slow", "--skip-hooks", "--skip-agents")
      const real = await Effect.runPromise(
        Effect.provide(
          scenario,
          Beads.layer({ cwd: dir, command: bd ?? "bd" }).pipe(Layer.provide(BunServices.layer)),
        ),
      )
      const memory = await Effect.runPromise(Effect.provide(scenario, backlogLayer()))
      expect(memory).toEqual(real)
    },
    120_000,
  )
})
