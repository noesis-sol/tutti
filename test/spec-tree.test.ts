import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import fc from "fast-check"
import {
  type CheckedTree,
  checkTree,
  fileTree,
  inFilingOrder,
  type KnownIssue,
  rootNote,
  type TreeContext,
} from "../src/run/specTree.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"

const root = "shop-1" as TicketId

/** The spec's root epic, its environment ticket under it, and an open ticket of another epic. */
const known = new Map<string, KnownIssue>([
  [root, { type: "epic", status: "open", inTree: true }],
  ["shop-1.1", { type: "task", status: "open", parent: root, inTree: true }],
  ["other-9", { type: "task", status: "open", inTree: false }],
])

const context = (over: Partial<TreeContext> = {}): TreeContext => ({
  root,
  known,
  tracked: ["README.md", "src/app.ts"],
  update: false,
  ...over,
})

const issue = (fields: Record<string, unknown>) => ({
  type: "task",
  priority: 2,
  title: `Issue ${String(fields.key)}`,
  description: 'Builds § "Listing".',
  acceptance: "The tests pass.",
  ...fields,
})

const checked = (input: unknown, over: Partial<TreeContext> = {}): CheckedTree => {
  const result = checkTree(input, context(over))
  if (Result.isFailure(result)) throw new Error(result.failure.join("\n"))
  return result.success
}

const reasons = (input: unknown, over: Partial<TreeContext> = {}): ReadonlyArray<string> => {
  const result = checkTree(input, context(over))
  return Result.isFailure(result) ? result.failure : []
}

describe("checkTree", () => {
  test("reads each issue's parent and waits_for as a key of the answer or an ID bd has", () => {
    const tree = checked({
      issues: [
        issue({
          key: "list",
          parent: "catalogue",
          waits_for: ["shop-1.1"],
          files: ["src/list.ts"],
        }),
        issue({ key: "catalogue", type: "epic", title: "The catalogue" }),
        issue({ key: "sort", parent: "catalogue", waits_for: ["list", "other-9"] }),
      ],
      assumptions: ["Prices are in euros (Sort by price)."],
    })
    // Each issue after its epic and what it waits for.
    expect(tree.issues.map((i) => i.key)).toEqual(["catalogue", "list", "sort"])
    expect(tree.issues[1]).toMatchObject({
      parent: { _tag: "Key", key: "catalogue" },
      waitsFor: [{ _tag: "Id", id: "shop-1.1" }],
      files: ["src/list.ts"],
    })
    expect(tree.issues[2]?.waitsFor as unknown).toEqual([
      { _tag: "Key", key: "list" },
      { _tag: "Id", id: "other-9" },
    ])
    expect(tree.assumptions).toEqual(["Prices are in euros (Sort by price)."])
  })

  test("an epic has no acceptance criteria and no files; a parent of the root epic's ID is the root", () => {
    const tree = checked({
      issues: [issue({ key: "e", type: "epic", parent: root, files: ["src/app.ts"] })],
    })
    expect(tree.issues[0]).toMatchObject({ parent: null, acceptance: "", files: [] })
  })

  test("refuses keys used twice, keys that are IDs, and names of no issue", () => {
    expect(
      reasons({
        issues: [
          issue({ key: "a" }),
          issue({ key: "a" }),
          issue({ key: "shop-1.1" }),
          issue({ key: "b", waits_for: ["nowhere"], parent: "gone-3" }),
        ],
      }),
    ).toEqual([
      'the answer has two issues keyed "a"',
      'issue 3\'s key "shop-1.1" is the ID of an issue bd has: give it a key of its own',
      'issue b\'s parent names "gone-3", which is neither a key of the answer nor an issue bd has',
      'issue b\'s waits_for names "nowhere", which is neither a key of the answer nor an issue bd has',
    ])
  })

  test("refuses a parent that isn't an epic, or isn't the spec's", () => {
    expect(
      reasons({
        issues: [
          issue({ key: "a" }),
          issue({ key: "b", parent: "a" }),
          issue({ key: "c", parent: "shop-1.1" }),
          issue({ key: "d", parent: "other-9" }),
        ],
      }),
    ).toEqual([
      "issue b's parent a isn't an epic",
      "issue c's parent shop-1.1 isn't an epic",
      "issue d's parent other-9 isn't in the spec's tree",
    ])
  })

  test("refuses a cycle of blocks links, and an epic waiting for a ticket under it", () => {
    expect(
      reasons({
        issues: [issue({ key: "a", waits_for: ["b"] }), issue({ key: "b", waits_for: ["a"] })],
      }),
    ).toEqual(["the tree's parents and blocks links make a cycle: a → b → a"])
    const epicCycle = reasons({
      issues: [
        issue({ key: "e", type: "epic", waits_for: ["t"] }),
        issue({ key: "t", parent: "e" }),
      ],
    })
    expect(epicCycle).toHaveLength(1)
    expect(epicCycle[0]).toStartWith("the tree's parents and blocks links make a cycle: ")
    // A ticket waiting for the root epic it is under waits for ever too.
    expect(reasons({ issues: [issue({ key: "t", waits_for: [root] })] })).toHaveLength(1)
  })

  test("refuses missing titles, types and priorities, and unknown ones", () => {
    expect(
      reasons({
        issues: [{ key: "a" }, issue({ key: "b", type: "story", priority: 7, title: " " })],
      }),
    ).toEqual([
      "issue a has no title",
      "issue a has no type",
      "issue a has no priority",
      "issue b has no title",
      'issue b has the unknown type "story", not epic, task, feature, bug, chore',
      "issue b has the priority 7, not 0 to 4",
    ])
  })

  test("drops the human label, and files not in the repository, saying so", () => {
    const tree = checked({
      issues: [
        issue({ key: "a", labels: ["human", "solo"], files: ["src/app.ts", "/etc/passwd"] }),
      ],
    })
    expect(tree.issues[0]).toMatchObject({ labels: ["solo"], files: ["src/app.ts"] })
    expect(tree.notes).toEqual([
      "dropped the label human from a: nobody answers a spec run's questions",
      'dropped "/etc/passwd" from a\'s files: not a path inside the repository',
    ])
  })

  test("a new tree takes no updates, deferrals or link changes", () => {
    expect(reasons({ deferrals: [{ id: "shop-1.1", reason: "obsolete" }] })).toEqual([
      "updates, deferrals, links and unlinks are for an update of a tree filed already: give each issue's waits_for instead",
    ])
  })

  test("an update changes and defers open tickets of the tree alone", () => {
    const update = {
      update: true,
      known: new Map<string, KnownIssue>([
        ...known,
        ["shop-1.2", { type: "task", status: "closed", parent: root, inTree: true }],
        ["shop-1.3", { type: "task", status: "in_progress", parent: root, inTree: true }],
      ]),
    }
    const tree = checked(
      {
        issues: [issue({ key: "new" })],
        updates: [
          {
            id: "shop-1.1",
            description: "Now with tax.",
            files: ["src/app.ts"],
            note: "§ Tax added",
          },
        ],
        links: [{ waits: "shop-1.1", on: "new" }],
        unlinks: [{ waits: "shop-1.1", on: "other-9" }],
        note: "The spec added § Tax.",
      },
      update,
    )
    expect(tree.updates).toEqual([
      {
        id: "shop-1.1" as TicketId,
        description: "Now with tax.",
        files: ["src/app.ts"],
        note: "§ Tax added",
      },
    ])
    expect(tree.links as unknown).toEqual([
      { waits: { _tag: "Id", id: "shop-1.1" }, on: { _tag: "Key", key: "new" } },
    ])
    expect(tree.unlinks as unknown).toEqual([{ waits: "shop-1.1", on: "other-9" }])
    expect(
      reasons(
        {
          updates: [
            { id: "shop-1.2", note: "x" },
            { id: "other-9", note: "x" },
            { id: "shop-1.1" },
          ],
          deferrals: [
            { id: "shop-1.3", reason: "obsolete" },
            { id: root, reason: "obsolete" },
          ],
        },
        update,
      ),
    ).toEqual([
      "update 1 names shop-1.2, which is closed: file a new ticket that changes its work instead",
      "update 2 names \"other-9\", which isn't an issue of the spec's tree",
      "update 3 has no note naming the change",
      "deferral 1 names shop-1.3, which a worker has: file a ticket blocked by it instead",
      "deferral 2 names the root epic shop-1, which the update leaves as it is",
    ])
  })

  test("never throws, whatever it is given", () => {
    const anyIssue = fc.record(
      {
        key: fc.oneof(fc.string(), fc.constantFrom("a", "b", "shop-1")),
        parent: fc.oneof(fc.string(), fc.constantFrom("a", "", root), fc.anything()),
        type: fc.oneof(fc.constantFrom("epic", "task", "bug"), fc.anything()),
        priority: fc.oneof(fc.integer({ min: -1, max: 5 }), fc.anything()),
        title: fc.oneof(fc.string(), fc.anything()),
        waits_for: fc.oneof(fc.array(fc.constantFrom("a", "b", "shop-1.1", "x")), fc.anything()),
        files: fc.oneof(fc.array(fc.string()), fc.anything()),
        labels: fc.anything(),
      },
      { requiredKeys: [] },
    )
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record({ issues: fc.array(anyIssue), assumptions: fc.anything() }),
        ),
        fc.boolean(),
        (input, update) => {
          const result = checkTree(input, context({ update }))
          if (Result.isFailure(result)) expect(result.failure.length).toBeGreaterThan(0)
        },
      ),
    )
  })

  test("a tree it takes is in an order that files each issue after what it names", () => {
    // Tickets each waiting for some before them, under epics before them: never a cycle.
    const trees = fc.array(fc.tuple(fc.boolean(), fc.nat(), fc.array(fc.nat(), { maxLength: 3 })), {
      maxLength: 12,
    })
    fc.assert(
      fc.property(trees, fc.func(fc.boolean()), (shape, shuffle) => {
        const issues = shape.map(([epic, parent, waits], i) => {
          const epics = shape.slice(0, i).flatMap(([e], j) => (e ? [`k${j}`] : []))
          const tickets = shape.slice(0, i).flatMap(([e], j) => (e ? [] : [`k${j}`]))
          return issue({
            key: `k${i}`,
            type: epic ? "epic" : "task",
            ...(epics.length === 0 ? {} : { parent: epics[parent % epics.length] }),
            waits_for:
              epic || tickets.length === 0 ? [] : waits.map((w) => tickets[w % tickets.length]),
          })
        })
        const given = issues
          .filter((_, i) => shuffle(i))
          .concat(issues.filter((_, i) => !shuffle(i)))
        const tree = checked({ issues: given })
        const at = new Map(tree.issues.map((i, n) => [i.key, n]))
        for (const i of tree.issues) {
          const before = [...(i.parent === null ? [] : [i.parent]), ...i.waitsFor]
          for (const ref of before) {
            if (ref._tag === "Key") expect(at.get(ref.key) ?? -1).toBeLessThan(at.get(i.key) ?? -1)
          }
        }
        expect(inFilingOrder(tree.issues)).toEqual(tree.issues)
      }),
    )
  })
})

describe("rootNote", () => {
  test("the change's note, then the assumptions under their heading", () => {
    expect(rootNote({ note: "", assumptions: [] })).toBe("")
    expect(rootNote({ note: "The spec added § Tax.", assumptions: ["VAT is 20% (Tax)."] })).toBe(
      "The spec added § Tax.\n\nAssumptions\n\n- VAT is 20% (Tax).",
    )
  })
})

describe("fileTree", () => {
  const seeds: ReadonlyArray<Seed> = [
    { id: root, type: "epic", metadata: { spec: "docs/shop.md" } },
    { id: "shop-1.1", parent: root, labels: ["solo"], metadata: { spec: "docs/shop.md" } },
  ]
  const file = (tree: CheckedTree, extra: ReadonlyArray<Seed> = []) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const filed = yield* fileTree(tree, { root, path: "docs/shop.md" })
        const backlog = yield* Backlog
        return { filed, issues: yield* backlog.issues }
      }).pipe(Effect.provide(beadsLayer([...seeds, ...extra]))),
    )

  test("files each issue under its epic with the spec's metadata, its files and its links", async () => {
    const tree = checked({
      issues: [
        issue({ key: "cat", type: "epic", title: "Catalogue", priority: 1 }),
        issue({
          key: "list",
          parent: "cat",
          waits_for: ["shop-1.1"],
          files: ["src/app.ts"],
          labels: ["solo"],
        }),
        issue({ key: "sort", parent: "cat", waits_for: ["list"] }),
      ],
      assumptions: ["Prices in euros (Sort)."],
    })
    const { filed, issues } = await file(tree)
    expect(filed.epics).toBe(1)
    expect(filed.tickets).toBe(2)
    const cat = filed.ids.get("cat")
    const list = issues.find((i) => i.id === filed.ids.get("list"))
    const sort = issues.find((i) => i.id === filed.ids.get("sort"))
    expect(issues.find((i) => i.id === cat)).toMatchObject({
      type: "epic",
      parent: root,
      priority: 1,
      metadata: { spec: "docs/shop.md" },
    })
    expect(list).toMatchObject({
      parent: cat,
      labels: ["solo"],
      acceptance: "The tests pass.",
      metadata: { spec: "docs/shop.md", files: ["src/app.ts"] },
    })
    expect(
      list?.dependencies.filter((d) => d.type === "blocks").map((d) => d.id as string),
    ).toEqual(["shop-1.1"])
    expect(
      sort?.dependencies.filter((d) => d.type === "blocks").map((d) => d.id as string),
    ).toEqual([filed.ids.get("list") as string])
    expect(issues.find((i) => i.id === root)?.notes).toBe(
      "Assumptions\n\n- Prices in euros (Sort).",
    )
  })

  test("an update's links, changes and deferrals", async () => {
    const update = {
      update: true,
      known: new Map<string, KnownIssue>([
        ...known,
        ["shop-1.2", { type: "task", status: "open", parent: root, inTree: true }],
      ]),
    }
    const tree = checked(
      {
        issues: [issue({ key: "tax" })],
        updates: [
          {
            id: "shop-1.1",
            acceptance: "Taxed.",
            priority: 0,
            files: ["README.md"],
            note: "§ Tax",
          },
        ],
        deferrals: [{ id: "shop-1.2", reason: "Obsolete since § Tax" }],
        links: [{ waits: "shop-1.1", on: "tax" }],
        note: "The spec added § Tax.",
      },
      update,
    )
    const { filed, issues } = await file(tree, [
      { id: "shop-1.2", parent: root, blockedBy: ["shop-1.1"] },
    ])
    const env = issues.find((i) => i.id === "shop-1.1")
    expect(env).toMatchObject({
      acceptance: "Taxed.",
      priority: 0,
      notes: "§ Tax",
      metadata: { spec: "docs/shop.md", files: ["README.md"] },
    })
    expect(env?.dependencies.map((d) => d.id)).toContain(filed.ids.get("tax"))
    expect(issues.find((i) => i.id === "shop-1.2")).toMatchObject({
      status: "deferred",
      notes: "Obsolete since § Tax",
    })
    expect(issues.find((i) => i.id === root)?.notes).toBe("The spec added § Tax.")
  })

  test("bd failing part way says how far it got", async () => {
    const tree = checked({ issues: [issue({ key: "a" }), issue({ key: "b", title: "Bee" })] })
    const stopped = await Effect.runPromise(
      Effect.gen(function* () {
        const backlog = yield* Backlog
        // The first create goes through, the second fails.
        return yield* Effect.flip(
          fileTree(tree, { root, path: "docs/shop.md", filed: () => backlog.fail("create") }),
        )
      }).pipe(Effect.provide(beadsLayer(seeds))),
    )
    expect(stopped.message).toStartWith(
      "tutti filed 1 of its answer's 2 issues, then couldn't file issue b (Bee): ",
    )
  })
})
