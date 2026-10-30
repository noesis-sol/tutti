// A feature run, from --feature or New feature (§ 4.10), as orchestra 0.8.1's: the START line's
// scope is `feature <epic>`, with `feature: epic <epic>, talked through from: <request>` under it,
// and the run report's evidence calls the request the one the epic was talked through from.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer } from "effect"
import fc from "fast-check"
import { noServersNote } from "../src/agent/mcp.ts"
import { AppConfig } from "../src/cli/AppConfig.ts"
import { Organs } from "../src/organs/Organs.ts"
import { makePrinter } from "../src/print/organLine.ts"
import { featureLine, featureRequestHeading, scopedTo } from "../src/run/feature.ts"
import { finish, run } from "../src/run/run.ts"
import { type Started, startBlock } from "../src/run/startup.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import * as TestAccount from "../src/testing/Account.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import * as TestAppConfig from "../src/testing/AppConfig.ts"
import { layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { backlog, scenario } from "./harness.ts"

const epic = "shop-a1b" as TicketId

const started = (ticket: TicketId | null, feature: string | null): Started => ({
  config: TestAppConfig.appConfig({ ticket, feature }, "/work/shop"),
  base: "main",
  prompt: { text: "Work on TICKET_ID.", file: null },
  mcp: { servers: [], note: noServersNote },
  account: TestAccount.accountProbe(),
  organs: { _tag: "AgentSdk" },
  warnings: [],
})

describe("a feature run's START block", () => {
  test("is scoped to its epic, the request it was talked through from under the START line", () => {
    const lines = startBlock(started(epic, "Add a basket\n\n  to the shop."), "0.1.0")
    expect(lines[0] as string).toStartWith(
      "START tutti 0.1.0 in /work/shop on main · feature shop-a1b (limit: none,",
    )
    expect(lines[1] as string).toBe(
      "  feature: epic shop-a1b, talked through from: Add a basket to the shop.",
    )
  })

  test("a long request is cut after 200 characters", () => {
    const lines = startBlock(started(epic, "a".repeat(300)), "0.1.0")
    expect(lines[1] as string).toBe(
      `  feature: epic shop-a1b, talked through from: ${"a".repeat(200)}…`,
    )
  })

  test("a --ticket run has no feature note", () => {
    const lines = startBlock(started(epic, null), "0.1.0")
    expect(lines[0] as string).toContain(" on main · ticket shop-a1b (")
    expect(lines.some((line) => line.includes("talked through from"))).toBe(false)
  })

  test("nor does a feature run before its epic is filed", () => {
    const lines = startBlock(started(null, "Add a basket"), "0.1.0")
    expect(lines.some((line) => line.includes("talked through from"))).toBe(false)
  })
})

describe("featureLine", () => {
  test("is the request on one line, its white space collapsed, at most 200 characters and a …", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 400 }), (request) => {
        const line = featureLine(request)
        const collapsed = request
          .split(/\s+/u)
          .filter((word) => word !== "")
          .join(" ")
        expect(line).not.toMatch(/\s\s|\n|\t/u)
        const characters = [...collapsed]
        expect(line).toBe(
          characters.length > 200 ? `${characters.slice(0, 200).join("")}…` : collapsed,
        )
      }),
    )
  })

  test("keeps 200 characters, cuts 201, and counts a wide character as one", () => {
    expect(featureLine("a".repeat(200))).toBe("a".repeat(200))
    expect(featureLine("a".repeat(201))).toBe(`${"a".repeat(200)}…`)
    expect(featureLine("漢".repeat(150))).toBe("漢".repeat(150))
    expect(featureLine("漢".repeat(250))).toBe(`${"漢".repeat(200)}…`)
  })
})

describe("scopedTo", () => {
  const read = (feature: string | null) =>
    Effect.runPromise(
      scopedTo(
        epic,
        null,
        feature,
      )(
        Effect.gen(function* () {
          return yield* AppConfig
        }),
      ).pipe(
        Effect.provideService(
          AppConfig,
          TestAppConfig.appConfig({ feature: "--feature's request" }, "/work/shop"),
        ),
      ),
    )

  test("gives the run New feature's request, the epic its scope", async () => {
    const config = await read("New feature's request")
    expect(config.ticket).toBe(epic)
    expect(config.feature).toBe("New feature's request")
  })

  test("keeps --feature's request when given none", async () => {
    expect((await read(null)).feature).toBe("--feature's request")
  })
})

describe("the run report's evidence", () => {
  test("names the request the epic was talked through from", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-feature-start-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-feature-start-worktrees-")))
    const calls: Array<OrganCallRecord> = []
    const organs = Organs.layer.pipe(
      Layer.provideMerge(cannedLayer({ reviewer: { report: "The run merged t-1.1.\n" } }, calls)),
    )
    const id = "t-1.1" as TicketId
    const ran = await scenario(
      {
        config: { repo },
        git: { dir: repo },
        worktrees: { root },
        backlog: backlog().ticket("t-1", { type: "epic" }).ticket("t-1.1", { parent: "t-1" }).seeds,
        scripts: (world) => ({
          [id]: [
            claimsAndCloses(id, {
              claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
              commit: Effect.asVoid(
                Effect.orDie(
                  world.repository.commit(join(root, id), `Change (${id})`, { "a.txt": "x\n" }),
                ),
              ),
              close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
            }),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        const running = yield* Effect.forkChild(
          scopedTo(
            "t-1" as TicketId,
            null,
            "Add a basket to the shop.",
          )(run({ version: "0.1.0-test", base: "main", endLater: true })),
        )
        const outcome = yield* Fiber.join(running)
        const theme = makeTheme(orchestra, {
          appearance: "dark",
          depth: "truecolor",
          noColor: true,
        })
        const out = { write: () => {}, columns: () => 100, tty: false }
        yield* finish(
          outcome,
          Effect.succeed({ printer: makePrinter(out, theme), theme, width: 100 }),
          false,
        )
        return calls.find((each) => each.call.organ === "reviewer")?.input ?? ""
      }).pipe(Effect.provide(organs)),
    )
    if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
    const input = ran.exit.value
    expect(input).toContain(`## ${featureRequestHeading("t-1" as TicketId)}\n`)
    expect(input).toContain("## The feature request epic t-1 was talked through from\n")
    expect(input).toContain("Add a basket to the shop.")
  })
})
