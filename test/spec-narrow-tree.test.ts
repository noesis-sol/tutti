// A spec's breakdown that files a narrow ticket tree (§ 4.14 'Checked'): checkFiled warns of a tree
// under the root epic whose longest chain is over three, or whose links let fewer tickets run at a
// time than the run's concurrency, naming the chain and the hubs; a wide tree gets no warning. The
// warning goes to stderr and the log as `SPEC: warning:`, and the run goes on all the same.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { checkFiled } from "../src/run/spec.ts"
import { SpecOutcome } from "../src/run/specRun.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { wait } from "../src/testing/AgentHost.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { breakdownInit, rootInput, scenario, ticket, turn } from "./specScenario.ts"

const path = "docs/shop.md"
const root = "shop-1" as TicketId

/** A ticket under the root epic, of the spec, with files and acceptance criteria, waiting on `on`. */
const under = (n: number, on: ReadonlyArray<number> = []): Seed => ({
  id: `shop-1.${n}`,
  parent: "shop-1",
  acceptance: "The tests pass.",
  blockedBy: on.map((m) => `shop-1.${m}`),
  metadata: { spec: path, files: [`src/${n}.ts`] },
})

const checked = (seeds: ReadonlyArray<Seed>, concurrent: number) =>
  Effect.runPromise(
    checkFiled(root, path, concurrent).pipe(
      Effect.provide(
        beadsLayer([{ id: "shop-1", type: "epic", metadata: { spec: path } }, ...seeds]),
      ),
    ),
  )

describe("checkFiled", () => {
  test("warns of a narrow tree, naming its longest chain and its hubs", async () => {
    // 1 holds 2, 3 and 4; 2 holds 5, which holds 6.
    const filed = await checked(
      [under(1), under(2, [1]), under(3, [1]), under(4, [1]), under(5, [2]), under(6, [5])],
      4,
    )
    expect(filed.warnings).toEqual([
      "a narrow ticket tree, its longest chain over 3 and fewer than the run's 4 tickets at a time: shop-1: 6 tickets, longest chain 4 (1.1 > 1.2 > 1.5 > 1.6), at most 1.5 at a time; shop-1.1 holds 3. A ticket needs a blocks link only to one whose code it builds on, so that the rest run side by side",
    ])
  })

  test("leaves the closed tickets out of the tree's shape", async () => {
    const filed = await checked(
      [under(1), under(2, [1]), under(3, [2]), { ...under(4, [3]), status: "closed" }],
      1,
    )
    expect(filed.warnings).toEqual([])
  })

  test("gives a wide tree no warning", async () => {
    // Six tickets, a chain of 2: three at a time, as many as the run's concurrency.
    const filed = await checked(
      [under(1), under(2, [1]), under(3), under(4, [3]), under(5), under(6)],
      3,
    )
    expect(filed.warnings).toEqual([])
    expect(filed.tickets).toBe(6)
  })
})

describe("a spec run", () => {
  test("says the warning on stderr and in the log, and goes on", async () => {
    const answers: Array<ToolAnswer> = []
    const ran = await scenario({
      script: (recording) => [
        [
          wait,
          breakdownInit,
          ...turn(
            recording,
            [
              ["file_root", rootInput],
              [
                "file_breakdown",
                {
                  root: "test-1",
                  issues: [
                    ticket({ key: "list", waits_for: ["test-1.1"], files: ["src/list.ts"] }),
                    ticket({ key: "sort", waits_for: ["list"], files: ["src/sort.ts"] }),
                    ticket({ key: "page", waits_for: ["sort"], files: ["src/page.ts"] }),
                  ],
                  assumptions: [],
                },
              ],
            ],
            answers,
          ),
        ],
      ],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "test-1" as TicketId }))
    const warning =
      "a narrow ticket tree, its longest chain over 3: test-1: 4 tickets, longest chain 4 (1.1 > 1.2 > 1.3 > 1.4), at most 1 at a time. A ticket needs a blocks link only to one whose code it builds on, so that the rest run side by side"
    expect(ran.errors).toEqual([`warning: ${warning}`])
    expect(ran.log).toContain(`SPEC: warning: ${warning}`)
    expect(ran.out).toContain("broke the spec down into test-1 (1 epic, 4 tickets)")
  })
})
