// The Beads service's bd linear calls (tutti-qatu.4): a pull of Linear issues by key, a push of
// tickets by ID with the local version winning, and bd linear status, each under a time limit of its
// own with Linear's credentials; what bd prints read into what each created, updated, skipped and
// failed, by ticket; and a ticket's Linear link read from its external_ref.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Duration, Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import {
  type BdOutput,
  Beads,
  BeadsTimedOut,
  decodeIssues,
  LinearTimeLimit,
  noLinearSync,
  type TicketId,
} from "../src/services/Beads.ts"
import {
  judgeStatus,
  judgeSync,
  type LinearKey,
  LinearRefused,
  type LinearSync,
  LinearUnreadable,
  linearKey,
  linearKeyOf,
  linearWhy,
  namedIn,
} from "../src/services/linearSync.ts"
import { Backlog, layer as backlogLayer, linearUrl } from "../src/testing/Beads.ts"

const key = (text: string): LinearKey => {
  const found = linearKey(text)
  if (found === undefined) throw new Error(`${text} is no Linear key`)
  return found
}
const id = (text: string) => text as TicketId

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

/** What bd linear sync --json prints on stdout for a SyncResult (bd 1.3.4's json.MarshalIndent). */
const printed = (result: {
  readonly success?: boolean
  readonly created?: number
  readonly updated?: number
  readonly skipped?: number
  readonly errors?: number
  readonly error?: string
  readonly warnings?: ReadonlyArray<string>
}) =>
  `${JSON.stringify(
    {
      success: result.success ?? true,
      stats: {
        pulled: 0,
        pushed: 0,
        created: result.created ?? 0,
        updated: result.updated ?? 0,
        skipped: result.skipped ?? 0,
        errors: result.errors ?? 0,
        conflicts: 0,
      },
      last_sync: "2026-11-17T10:00:01Z",
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
      schema_version: 1,
    },
    null,
    2,
  )}\n`

const exited = (stdout: string, exitCode = 0, stderr = "Acquiring sync lock...\n"): BdOutput => ({
  exitCode,
  stdout,
  stderr,
})

const judged = (asked: ReadonlyArray<string>, output: BdOutput) =>
  Effect.runSync(Effect.exit(judgeSync("bd linear sync", asked, output)))

const synced = (asked: ReadonlyArray<string>, output: BdOutput): LinearSync => {
  const exit = judged(asked, output)
  if (Exit.isFailure(exit)) throw new Error(`expected a sync, got ${exit.cause}`)
  return exit.value
}

describe("a ticket's Linear link", () => {
  test("is the key after issue/ in its external_ref, with the slug a push writes or without", () => {
    expect(linearKeyOf("https://linear.app/noesis-sol/issue/NOE-7")).toBe(key("NOE-7"))
    expect(
      linearKeyOf("https://linear.app/noesis-sol/issue/NOE-9/throwaway-tutti-spike-qatu1-fields"),
    ).toBe(key("NOE-9"))
    expect(linearKeyOf("https://linear.app/issue/AB2-12")).toBe(key("AB2-12"))
  })

  test("is none for another tracker's URL, or text that isn't a Linear issue's", () => {
    for (const ref of [
      "https://github.com/acme/app/issues/12",
      "https://linear.app.evil.example/x/issue/NOE-1",
      "https://linear.app/x/project/NOE-1",
      "https://linear.app/x/issue/--help",
      "https://linear.app/x/issue/noe-1",
      "NOE-1",
      "",
      "gh-12",
    ]) {
      expect(linearKeyOf(ref)).toBeUndefined()
    }
  })

  test("is read with the URL from bd's issue JSON", () => {
    const issues = Effect.runSync(
      decodeIssues(
        "bd list",
        JSON.stringify([
          {
            id: "t-1",
            title: "From Linear",
            status: "open",
            external_ref: "https://linear.app/noesis-sol/issue/NOE-12",
          },
          { id: "t-2", title: "From GitHub", status: "open", external_ref: "gh-5" },
          { id: "t-3", title: "Local", status: "open", external_ref: null },
        ]),
      ),
    )
    expect(issues.map((issue) => [issue.id, issue.externalRef, issue.linearKey])).toEqual([
      ["t-1", "https://linear.app/noesis-sol/issue/NOE-12", "NOE-12"],
      ["t-2", "gh-5", undefined],
      ["t-3", undefined, undefined],
    ])
  })

  test("property: a Linear URL gives back its key; any text gives a key it holds, or none", () => {
    const team = fc.stringMatching(/^[A-Z][A-Z0-9]{0,4}$/)
    const slug = fc.stringMatching(/^[a-z0-9-]{0,30}$/)
    fc.assert(
      fc.property(team, fc.integer({ min: 1, max: 1e6 }), slug, slug, (team, number, org, end) => {
        const issue = `${team}-${number}`
        const url = `https://linear.app/${org || "o"}/issue/${issue}${end === "" ? "" : `/${end}`}`
        expect(linearKeyOf(url)).toBe(key(issue))
      }),
    )
    fc.assert(
      fc.property(fc.string(), (text) => {
        const found = linearKeyOf(text)
        if (found !== undefined) {
          expect(linearKey(found)).toBe(found)
          expect(text).toContain(found)
        }
      }),
    )
  })
})

describe("what a bd linear sync printed", () => {
  test("a pull of one new issue: created", () => {
    const sync = synced(["NOE-7"], exited(printed({ created: 1 })))
    expect(sync).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      items: [{ name: "NOE-7", outcome: "created" }],
      warnings: [],
    })
  })

  test("a push of one linked ticket: updated; nothing changed since its last push: skipped", () => {
    expect(synced(["t-1"], exited(printed({ updated: 1 }))).items).toEqual([
      { name: "t-1", outcome: "updated" },
    ])
    expect(synced(["t-1"], exited(printed({ skipped: 1 }))).items).toEqual([
      { name: "t-1", outcome: "skipped" },
    ])
    // A ticket bd filters out of a push without counting it (an ephemeral one) did nothing.
    expect(synced(["t-1"], exited(printed({}))).items).toEqual([
      { name: "t-1", outcome: "skipped" },
    ])
  })

  test("the tickets and issues bd's warnings name, each with why", () => {
    const sync = synced(
      ["NOE-1", "NOE-2", "NOE-3", "NOE-4"],
      exited(
        printed({
          created: 2,
          skipped: 1,
          errors: 1,
          warnings: [
            "Failed to fetch NOE-3: graphql: rate limited",
            "Issue NOE-4 not found in Linear",
            'linear: bead t-9: label "task" not found on Linear team (skipped) (t-9)',
          ],
        }),
      ),
    )
    expect(sync.items).toEqual([
      { name: "NOE-1", outcome: "created" },
      { name: "NOE-2", outcome: "created" },
      { name: "NOE-3", outcome: "failed", why: "graphql: rate limited" },
      { name: "NOE-4", outcome: "skipped", why: "not found in Linear" },
    ])
    expect(sync.warnings).toHaveLength(3)
  })

  test("a pull that created one and updated another: which is which bd doesn't say", () => {
    const sync = synced(["NOE-1", "NOE-2"], exited(printed({ created: 1, updated: 1 })))
    expect(sync.items).toEqual([{ name: "NOE-1" }, { name: "NOE-2" }])
    expect(sync).toMatchObject({ created: 1, updated: 1 })
  })

  test("a ticket a pull failed to update is named by its ID, beside the keys asked", () => {
    const sync = synced(
      ["NOE-1"],
      exited(printed({ errors: 1, warnings: ["Failed to update t-4: database is locked"] })),
    )
    expect(sync.items).toEqual([
      { name: "NOE-1" },
      { name: "t-4", outcome: "failed", why: "database is locked" },
    ])
  })

  test("each warning bd 1.3.4 names a ticket or an issue in", () => {
    expect(
      [
        "Failed to push t-1 in Linear: state not mapped",
        "Failed to create t-1 in Linear: boom",
        "Failed to update t-1 in Linear: boom: twice",
        "Failed to update external_ref for t-1: locked",
        "Failed to create issue for NOE-1: duplicate",
        "Failed to update t-1: locked",
        "Failed to prepare NOE-1: bad",
        "Failed to generate ID for NOE-1: bad",
        "Issue NOE-1 not found in Linear",
        "No external ref found for local issue t-1, skipping pull",
        'External ref "gh-1" of local issue t-1 is not an issue Linear can address with its current configuration (another repository?), skipping pull',
        "Failed to update last_sync: locked",
        'linear: bead t-1: label "task" not found on Linear team (skipped)',
      ].map((warning) => {
        const item = namedIn(warning)
        return item === undefined ? undefined : [item.name, item.outcome]
      }),
    ).toEqual([
      ["t-1", "failed"],
      ["t-1", "failed"],
      ["t-1", "failed"],
      ["t-1", "failed"],
      ["NOE-1", "failed"],
      ["t-1", "failed"],
      ["NOE-1", "failed"],
      ["NOE-1", "failed"],
      ["NOE-1", "skipped"],
      ["t-1", "skipped"],
      ["t-1", "skipped"],
      // last_sync is no ticket, nor is a label the team lacks a failure.
      undefined,
      undefined,
    ])
  })

  test("in bd's v2 envelope, and after a message bd printed before it", () => {
    const envelope = JSON.stringify({
      schema_version: 2,
      data: JSON.parse(printed({ created: 1 })),
    })
    expect(synced(["NOE-1"], exited(envelope)).created).toBe(1)
    expect(
      synced(
        ["NOE-1"],
        exited(`  Conflict on t-1: keeping local version\n${printed({ updated: 1 })}`),
      ).updated,
    ).toBe(1)
  })

  test("refused: its JSON error, its failed sync's error, or stderr's Error: line", () => {
    const refused = (output: BdOutput) => {
      const error = failure(judged(["t-1"], output))
      if (!(error instanceof LinearRefused)) throw new Error(`expected a refusal, got ${error}`)
      return [error.exitCode, linearWhy(error)]
    }
    expect(
      refused(
        exited(
          `${JSON.stringify({ error: "linear.state_map.started is not set" }, null, 2)}\n`,
          1,
          "",
        ),
      ),
    ).toEqual([1, "linear.state_map.started is not set"])
    expect(
      refused(
        exited(printed({ success: false, error: "push failed: sync aborted: rate limit" }), 1),
      ),
    ).toEqual([1, "push failed: sync aborted: rate limit"])
    expect(
      refused(
        exited(
          "",
          1,
          "Acquiring sync lock...\nError: another bd linear sync is already running (PID 4, started 10:00:00)\n",
        ),
      ),
    ).toEqual([1, "another bd linear sync is already running (PID 4, started 10:00:00)"])
    expect(refused(exited("", 2, ""))).toEqual([2, "exit code 2"])
  })

  test("unreadable: bd exited 0 with anything but a SyncResult", () => {
    for (const stdout of ["", "✓ Pushed 1 issues\n", "[]", '{"stats": {}}']) {
      expect(failure(judged(["t-1"], exited(stdout)))).toBeInstanceOf(LinearUnreadable)
    }
  })

  test("property: any output is a sync, a refusal or unreadable, never a defect", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 4 }),
        fc.oneof(fc.string(), fc.json()),
        fc.string(),
        fc.integer({ min: 0, max: 3 }),
        (asked, stdout, stderr, exitCode) => {
          const exit = judged(asked, { exitCode, stdout, stderr })
          if (Exit.isFailure(exit)) {
            const error = failure(exit)
            expect(error instanceof LinearRefused || error instanceof LinearUnreadable).toBe(true)
            expect(linearWhy(error)).not.toBe("")
          } else {
            expect(exitCode).toBe(0)
          }
        },
      ),
    )
  })

  test("property: each ticket a warning names has its outcome; the counts give one asked alone", () => {
    const name = fc.stringMatching(/^[a-z]{1,4}-[0-9a-z]{1,4}$/)
    const why = fc.string().filter((text) => text.trim() !== "" && !text.includes("\r"))
    fc.assert(
      fc.property(
        fc.uniqueArray(name, { minLength: 1, maxLength: 5 }),
        fc.array(fc.tuple(fc.nat(9), why), { maxLength: 5 }),
        fc.constantFrom("created", "updated", "skipped", "failed"),
        (asked, failures, alone) => {
          const failed = [
            ...new Map(failures.map(([at, why]) => [asked[at % asked.length] as string, why])),
          ]
          const sync = synced(
            asked,
            exited(
              printed({
                created: 2,
                errors: failed.length,
                warnings: failed.map(([name, why]) => `Failed to push ${name} in Linear: ${why}`),
              }),
            ),
          )
          for (const [name, why] of failed) {
            expect(sync.items.find((item) => item.name === name)).toEqual({
              name,
              outcome: "failed",
              why: why.trim(),
            })
          }
          expect(sync.items.map((item) => item.name)).toEqual(asked)

          const one = asked[0] as string
          const counts = { [alone === "failed" ? "errors" : alone]: 1 }
          expect(synced([one], exited(printed(counts))).items).toEqual([
            { name: one, outcome: alone },
          ])
        },
      ),
    )
  })
})

describe("bd linear status", () => {
  test("reads whether bd is configured, its team and its links", () => {
    const status = Effect.runSync(
      judgeStatus(
        "bd linear status",
        exited(
          JSON.stringify({
            configured: true,
            has_api_key: true,
            has_oauth: false,
            auth_mode: "api_key",
            team_id: "285603b3",
            team_ids: ["285603b3"],
            last_sync: "",
            total_issues: 961,
            with_linear_ref: 3,
            pending_push: 958,
          }),
          0,
          "",
        ),
      ),
    )
    expect(status).toEqual({
      configured: true,
      authMode: "api_key",
      teamIds: ["285603b3"],
      linked: 3,
      unlinked: 958,
    })
  })
})

describe("the test layer", () => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, Beads | Backlog>,
    seeds: Parameters<typeof backlogLayer>[0] = [],
  ) =>
    Effect.runPromise(
      Effect.provide(
        effect,
        backlogLayer(seeds, {
          linearTeam: {
            issues: [
              { key: "NOE-1", title: "Filed in Linear", state: "unstarted", priority: 1 },
              { key: "NOE-2", title: "Held in Backlog", state: "backlog" },
            ],
          },
        }),
      ),
    )

  test("a pull creates a ticket for each new issue, Backlog's deferred, linked by its URL", async () => {
    const { sync, issues } = await run(
      Effect.gen(function* () {
        const beads = yield* Beads
        const sync = yield* beads.linearPull([key("NOE-1"), key("NOE-2")])
        return { sync, issues: yield* (yield* Backlog).issues }
      }),
    )
    expect(sync.items).toEqual([
      { name: "NOE-1", outcome: "created" },
      { name: "NOE-2", outcome: "created" },
    ])
    expect(
      issues.map((issue) => [issue.title, issue.status, issue.priority, issue.linearKey]),
    ).toEqual([
      ["Filed in Linear", "open", 1, "NOE-1"],
      ["Held in Backlog", "deferred", 2, "NOE-2"],
    ])
  })

  test("an issue moved to Todo is handed over by the next pull of it", async () => {
    const status = await run(
      Effect.gen(function* () {
        const beads = yield* Beads
        const backlog = yield* Backlog
        yield* beads.linearPull([key("NOE-2")])
        yield* backlog.putLinear({ key: "NOE-2", title: "Held in Backlog", state: "unstarted" })
        const sync = yield* beads.linearPull([key("NOE-2")])
        expect(sync.items).toEqual([{ name: "NOE-2", outcome: "updated" }])
        return (yield* backlog.issues)[0]?.status
      }),
    )
    expect(status).toBe("open")
  })

  test("a push creates a ticket's issue and links it, then moves it as the ticket moves", async () => {
    const { first, second, ticket, linear } = await run(
      Effect.gen(function* () {
        const beads = yield* Beads
        const backlog = yield* Backlog
        const first = yield* beads.linearPush([id("t-1")])
        yield* beads.update(id("t-1"), { claim: true })
        const second = yield* beads.linearPush([id("t-1")])
        return {
          first,
          second,
          ticket: yield* backlog.get("t-1"),
          linear: yield* backlog.linearIssues,
        }
      }),
      [{ id: "t-1", title: "Filed by a worker" }],
    )
    expect(first.items).toEqual([{ name: "t-1", outcome: "created" }])
    expect(second.items).toEqual([{ name: "t-1", outcome: "updated" }])
    expect(ticket?.linearKey).toBe(key("NOE-3"))
    expect(ticket?.externalRef).toBe(`${linearUrl("NOE-3")}/filed-by-a-worker`)
    expect(linear.find((issue) => issue.key === "NOE-3")?.state).toBe("started")
  })

  test("a key Linear hasn't is skipped, with bd's why", async () => {
    const sync = await run(Effect.flatMap(Beads, (beads) => beads.linearPull([key("NOE-99")])))
    expect(sync.items).toEqual([{ name: "NOE-99", outcome: "skipped", why: "not found in Linear" }])
  })

  test("a pull past its time limit, and a refused push, fail with their tagged errors", async () => {
    const { timedOut, refused } = await run(
      Effect.gen(function* () {
        const beads = yield* Beads
        const backlog = yield* Backlog
        yield* backlog.fail("linear sync --pull", { timedOut: true })
        yield* backlog.fail("linear sync --push", {
          stderr: "Acquiring sync lock...\nError: linear.outbound_state_map.in_progress is not set",
        })
        return {
          timedOut: yield* Effect.flip(beads.linearPull([key("NOE-1")])),
          refused: yield* Effect.flip(beads.linearPush([id("t-1")])),
        }
      }),
      [{ id: "t-1" }],
    )
    expect(timedOut).toBeInstanceOf(BeadsTimedOut)
    expect(timedOut).toMatchObject({ timeLimit: LinearTimeLimit.pull })
    expect(linearWhy(timedOut)).toBe("bd took longer than 1m")
    expect(refused).toBeInstanceOf(LinearRefused)
    expect(linearWhy(refused)).toBe("linear.outbound_state_map.in_progress is not set")
  })

  test("bd linear status counts the linked tickets", async () => {
    const status = await run(
      Effect.flatMap(Beads, (beads) => beads.linearStatus()),
      [{ id: "t-1", externalRef: linearUrl("NOE-1") }, { id: "t-2" }],
    )
    expect(status).toMatchObject({ configured: true, linked: 1, unlinked: 1 })
  })
})

// The live layer against a stand-in for bd that records its arguments and Linear's key, built once
// for the file (a fresh executable's first run is slow on macOS). It answers as $FAKE_ANSWER says.
const fake = (() => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-linear-sync-"))
  const bin = join(dir, "bd")
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${dir}/args'`,
      `echo "\${LINEAR_API_KEY-unset}" > '${dir}/key'`,
      `cat '${dir}/answer'`,
      `exit "$(cat '${dir}/exit')"`,
    ].join("\n"),
  )
  chmodSync(bin, 0o755)
  return {
    dir,
    bin,
    answer: (stdout: string, exitCode = 0) => {
      writeFileSync(join(dir, "answer"), stdout)
      writeFileSync(join(dir, "exit"), String(exitCode))
      writeFileSync(join(dir, "args"), "")
    },
    args: () => readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n"),
    key: () => readFileSync(join(dir, "key"), "utf8").trim(),
  }
})()

const live = <A, E>(
  effect: Effect.Effect<A, E, Beads>,
  limit: Duration.Input = "10 seconds",
  bin = fake.bin,
) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(
        effect,
        Beads.layer({
          cwd: fake.dir,
          command: bin,
          environment: { LINEAR_API_KEY: "lin_api_test", PATH: "/usr/bin:/bin" },
          linearTimeLimits: { pull: limit, push: limit, status: limit },
        }).pipe(Layer.provide(BunServices.layer)),
      ),
    ),
  )

describe("the live layer", () => {
  test("pulls only the keys it is given, with relations and Linear's key", async () => {
    fake.answer(printed({ created: 1, updated: 1 }))
    const exit = await live(
      Effect.flatMap(Beads, (beads) => beads.linearPull([key("NOE-1"), key("NOE-2")])),
    )
    expect(Exit.isSuccess(exit) && exit.value.created).toBe(1)
    expect(fake.args()).toEqual([
      "linear",
      "sync",
      "--pull",
      "--relations",
      "--issues=NOE-1,NOE-2",
      "--json",
    ])
    expect(fake.key()).toBe("lin_api_test")
  })

  test("pushes only the tickets it is given, the local version winning", async () => {
    fake.answer(printed({ created: 1 }))
    const exit = await live(Effect.flatMap(Beads, (beads) => beads.linearPush([id("t-1")])))
    expect(Exit.isSuccess(exit) && exit.value.items).toEqual([{ name: "t-1", outcome: "created" }])
    expect(fake.args()).toEqual([
      "linear",
      "sync",
      "--push",
      "--prefer-local",
      "--issues=t-1",
      "--json",
    ])
    expect(fake.key()).toBe("lin_api_test")
  })

  test("Linear's key goes to bd linear alone", async () => {
    fake.answer("[]")
    await live(Effect.flatMap(Beads, (beads) => beads.list()))
    expect(fake.key()).toBe("unset")
    fake.answer(JSON.stringify({ configured: true }))
    const exit = await live(Effect.flatMap(Beads, (beads) => beads.linearStatus()))
    expect(Exit.isSuccess(exit) && exit.value.configured).toBe(true)
    expect(fake.args()).toEqual(["linear", "status", "--json"])
    expect(fake.key()).toBe("lin_api_test")
  })

  test("no ticket or key given, it runs no bd", async () => {
    fake.answer(printed({}))
    const nothing = [] as unknown as readonly [TicketId]
    const exit = await live(
      Effect.flatMap(Beads, (beads) =>
        Effect.all([
          beads.linearPush(nothing),
          beads.linearPull([] as unknown as readonly [LinearKey]),
        ]),
      ),
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual([noLinearSync, noLinearSync])
    expect(fake.args()).toEqual([""])
  })

  test("a push past its time limit is BeadsTimedOut; a refused one LinearRefused", async () => {
    const slow = join(fake.dir, "slow-bd")
    writeFileSync(slow, "#!/bin/sh\nsleep 5\n")
    chmodSync(slow, 0o755)
    const timedOut = failure(
      await live(
        Effect.flatMap(Beads, (beads) => beads.linearPush([id("t-1")])),
        "300 millis",
        slow,
      ),
    )
    expect(timedOut).toBeInstanceOf(BeadsTimedOut)

    fake.answer(`${JSON.stringify({ error: "Linear API key not configured" })}\n`, 1)
    const refused = failure(
      await live(Effect.flatMap(Beads, (beads) => beads.linearPush([id("t-1")]))),
    )
    expect(refused).toBeInstanceOf(LinearRefused)
    expect(linearWhy(refused)).toBe("Linear API key not configured")

    const missing = failure(
      await live(
        Effect.flatMap(Beads, (beads) => beads.linearPull([key("NOE-1")])),
        "10 seconds",
        join(fake.dir, "no-such-bd"),
      ),
    )
    expect(missing).toBeInstanceOf(LinearRefused)
    expect(existsSync(join(fake.dir, "no-such-bd"))).toBe(false)
  })

  test("no function pushes without ticket IDs, nor pulls without keys", () => {
    const types = (beads: Beads["Service"]) => {
      // @ts-expect-error: a push names its tickets.
      void beads.linearPush([])
      // @ts-expect-error: a pull names its issues.
      void beads.linearPull([])
      // @ts-expect-error: a pull takes Linear keys, not any text.
      void beads.linearPull(["--all"])
    }
    expect(typeof types).toBe("function")
  })
})
