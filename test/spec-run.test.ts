// A spec run's start (§ 4.14), with the scripted host playing the breakdown's session: a new spec
// broken down, its root epic and environment ticket filed with file_root and the rest with
// file_breakdown, the root epic then marked filed for the spec's version and the run scoped to it;
// an unchanged spec carried on, or built; a changed one updated, its change written for the
// breakdown; and a breakdown that ends without its tree, gives none, or meets two root epics.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { handOverNudge } from "../src/agent/breakdown.ts"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { exitCodes } from "../src/run/holds.ts"
import { SpecMetadata, specUpdateFile } from "../src/run/spec.ts"
import { SpecOutcome } from "../src/run/specRun.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { result, sessionState, wait } from "../src/testing/AgentHost.ts"
import type { Seed } from "../src/testing/Beads.ts"
import {
  breakdownInit,
  rootInput,
  scenario,
  sha,
  specText,
  textOf,
  ticket,
  turn,
} from "./specScenario.ts"

describe("a new spec", () => {
  test("is broken down: its tree filed, the root epic marked filed, the run scoped to it", async () => {
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
                    ticket({ key: "sort", waits_for: ["test-1.1", "list"] }),
                  ],
                  assumptions: ["Items sort by name (Ticket sort)."],
                },
              ],
            ],
            answers,
          ),
        ],
      ],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "test-1" as TicketId }))
    expect(answers.map((a) => a.isError)).toEqual([undefined, undefined])
    expect(textOf(answers[0])).toStartWith(
      "Filed the root epic test-1 and the environment ticket test-1.1",
    )

    // The session: headless, its first message naming the spec and its version.
    const started = ran.sent.find((s) => s._tag === "Started")
    const kind = started?._tag === "Started" ? started.session.kind : undefined
    expect(kind?._tag === "Interview" ? kind.breakdown?.headless : undefined).toBe(true)
    const message = ran.sent.find((s) => s._tag === "Message")
    const first = String(message?._tag === "Message" ? message.message.message.content : "")
    expect(first).toStartWith(
      `Break the spec at docs/shop.md down into Beads tickets (sha256 ${sha(specText)}, commit ${ran.head}). You have 1h.`,
    )

    // The tree, every issue with the spec's metadata; the root epic marked last.
    const byId = new Map(ran.issues.map((i) => [i.id as string, i]))
    expect(byId.get("test-1")).toMatchObject({
      type: "epic",
      priority: 1,
      metadata: {
        [SpecMetadata.spec]: "docs/shop.md",
        [SpecMetadata.sha256]: sha(specText),
        [SpecMetadata.commit]: ran.head,
      },
      notes: "Assumptions\n\n- Items sort by name (Ticket sort).",
    })
    expect(byId.get("test-1.1")).toMatchObject({
      priority: 0,
      labels: ["solo"],
      parent: "test-1",
      metadata: { spec: "docs/shop.md", files: ["README.md", "package.json"] },
    })
    expect(byId.get("test-1.2")).toMatchObject({
      parent: "test-1",
      metadata: { spec: "docs/shop.md" },
    })
    expect(
      byId
        .get("test-1.3")
        ?.dependencies.filter((d) => d.type === "blocks")
        .map((d) => d.id as string)
        .sort(),
    ).toEqual(["test-1.1", "test-1.2"])
    expect(ran.out).toContain("the spec docs/shop.md is committed already")
    expect(ran.out).toContain("broke the spec down into test-1 (1 epic, 3 tickets)")
    expect(ran.out).toContain(
      "Assumed where the spec leaves a choice open:\n  - Items sort by name (Ticket sort).",
    )
    expect(ran.log).toContain("SPEC: broken down into test-1 (1 epic, 3 tickets)")
    expect(ran.log).toContain("SPEC: assumed: Items sort by name (Ticket sort).")
    // test-1.2 lists a new file, in a new folder: a spec's tree may.
    expect(byId.get("test-1.2")?.files).toEqual(["src/list.ts"])
    expect(ran.errors).toEqual([
      "warning: 1 open ticket under test-1 has no files metadata, so tutti guesses its files: test-1.3",
    ])
    expect(ran.sent.at(-1)?._tag).toBe("Ended")
  })

  test("a spec not committed yet is committed alone, with its SHA-256", async () => {
    const ran = await scenario({
      committed: "# Shop\n",
      seeds: [
        {
          id: "shop-1",
          type: "epic",
          metadata: { spec: "docs/shop.md", spec_sha256: sha(specText), spec_commit: "abc" },
        },
      ],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "shop-1" as TicketId }))
    expect(ran.files.get("docs/shop.md")).toBe(specText)
    expect(ran.out).toContain(
      `committed the spec docs/shop.md (sha256 ${sha(specText).slice(0, 12)})`,
    )
    expect(ran.log).toContain(`SPEC: committed docs/shop.md (sha256 ${sha(specText).slice(0, 12)})`)
  })
})

describe("a spec broken down before", () => {
  const root = (fields: Partial<Seed> = {}, filedFor = sha(specText)): Seed => ({
    id: "shop-1",
    type: "epic",
    metadata: { spec: "docs/shop.md", spec_sha256: filedFor, spec_commit: "c0ffee" },
    ...fields,
  })

  test("unchanged, it carries on with its root epic, breaking nothing down", async () => {
    const ran = await scenario({ seeds: [root()] })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "shop-1" as TicketId }))
    expect(ran.sent).toEqual([])
    expect(ran.out).toContain("the spec docs/shop.md is unchanged; carrying on with shop-1")
  })

  test("unchanged and its root epic closed, it is built: nothing to run", async () => {
    const ran = await scenario({ seeds: [root({ status: "closed" })] })
    expect(ran.outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.ok }))
    expect(ran.out).toContain("✓ docs/shop.md is built (shop-1)")
    expect(ran.log).toContain("SPEC: docs/shop.md is unchanged, and shop-1 is closed")
  })

  test("changed, its tree is updated for the change, which the breakdown is given", async () => {
    const answers: Array<ToolAnswer> = []
    const old = "# Shop\n"
    const ran = await scenario({
      committed: old,
      seedsAt: (start) => [
        root({ metadata: { spec: "docs/shop.md", spec_sha256: sha(old), spec_commit: start } }),
        { id: "shop-1.1", parent: "shop-1", metadata: { spec: "docs/shop.md" } },
        { id: "shop-1.2", parent: "shop-1", status: "closed", metadata: { spec: "docs/shop.md" } },
      ],
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
                  root: "shop-1",
                  issues: [ticket({ key: "listing", acceptance: "Listed." })],
                  updates: [{ id: "shop-1.1", acceptance: "Lists too.", note: "§ Listing added" }],
                  note: "The spec added § Listing.",
                },
              ],
            ],
            answers,
          ),
        ],
      ],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "shop-1" as TicketId }))
    // file_root is refused: the root epic is filed already.
    expect(answers.map((a) => a.isError)).toEqual([true, undefined])
    expect(ran.out).toContain(
      "the spec docs/shop.md changed since shop-1 was filed: updating its tickets",
    )
    const update = readFileSync(join(ran.repo, specUpdateFile), "utf8")
    expect(update).toContain("+## Listing")
    expect(update).toContain("- shop-1.2 [closed] task P2 shop-1.2 (under shop-1)")
    const message = ran.sent.find((s) => s._tag === "Message")
    const first = String(message?._tag === "Message" ? message.message.message.content : "")
    expect(first).toMatch(
      /Its root epic is shop-1, whose tree was filed for the spec at commit [0-9a-f]{12}\./,
    )
    const byId = new Map(ran.issues.map((i) => [i.id as string, i]))
    expect(byId.get("shop-1")?.metadata).toMatchObject({
      spec_sha256: sha(specText),
      spec_commit: ran.head,
    })
    expect(byId.get("shop-1")?.notes).toBe("The spec added § Listing.")
    expect(byId.get("shop-1.1")).toMatchObject({
      acceptance: "Lists too.",
      notes: "§ Listing added",
    })
    expect(byId.get("shop-1.3")).toMatchObject({ title: "Ticket listing", parent: "shop-1" })
    expect(ran.out).toContain("updated shop-1 for the spec's change (1 epic, 3 tickets)")
  })

  test("with no spec_sha256, the breakdown that filed it is carried on", async () => {
    const answers: Array<ToolAnswer> = []
    const ran = await scenario({
      seeds: [
        { id: "shop-1", type: "epic", metadata: { spec: "docs/shop.md" } },
        { id: "shop-1.1", parent: "shop-1", metadata: { spec: "docs/shop.md" } },
      ],
      script: (recording) => [
        [
          wait,
          breakdownInit,
          ...turn(
            recording,
            [
              [
                "file_breakdown",
                { root: "shop-1", issues: [ticket({ key: "more", waits_for: ["shop-1.1"] })] },
              ],
            ],
            answers,
          ),
        ],
      ],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "shop-1" as TicketId }))
    expect(ran.out).toContain("the breakdown that filed shop-1 didn't finish: carrying it on")
    const message = ran.sent.find((s) => s._tag === "Message")
    const first = String(message?._tag === "Message" ? message.message.message.content : "")
    expect(first).toContain(
      "An earlier breakdown of this spec filed the root epic shop-1 and stopped part way.",
    )
    expect(first).toContain("- shop-1.1 [open] task P2 shop-1.1 (under shop-1)")
  })

  test("two root epics are a setup problem", async () => {
    const ran = await scenario({
      seeds: [root(), { ...root(), id: "shop-2" }],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.setup }))
    expect(ran.errors[0]).toStartWith("The spec docs/shop.md has two root epics, shop-1 and shop-2")
  })
})

describe("a breakdown without its tree", () => {
  test("is told once to hand it over, then given up on, what it filed listed", async () => {
    const answers: Array<ToolAnswer> = []
    const ran = await scenario({
      script: (recording) => [
        [
          wait,
          breakdownInit,
          ...turn(recording, [["file_root", { ...rootInput, environment: undefined }]], answers),
          wait,
          sessionState("running"),
          result("Still nothing."),
          sessionState("idle"),
        ],
      ],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.setup }))
    const messages = ran.sent.flatMap((s) =>
      s._tag === "Message" ? [String(s.message.message.content)] : [],
    )
    expect(messages[1]).toBe(handOverNudge)
    expect(ran.errors).toEqual([
      "tutti couldn't break the spec down: its turn ended without handing the tree to file_breakdown",
      "It filed 1 epic and 0 tickets for docs/shop.md, under test-1:",
      "  test-1 [open] epic P1 The shop",
      "Run it again to carry on: tutti --spec docs/shop.md",
    ])
    // The root epic isn't marked filed: the next run carries the breakdown on.
    expect(ran.issues[0]?.metadata[SpecMetadata.sha256]).toBeUndefined()
  })

  test("one that says there is nothing to build runs nothing", async () => {
    const answers: Array<ToolAnswer> = []
    const ran = await scenario({
      script: (recording) => [
        [
          wait,
          breakdownInit,
          ...turn(
            recording,
            [
              [
                "file_breakdown",
                { root: "", issues: [], problem: "The spec describes nothing to build." },
              ],
            ],
            answers,
          ),
        ],
      ],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.setup }))
    expect(ran.errors).toEqual([
      "tutti: the spec's breakdown filed no tree, so there is nothing to run.",
      "It says: The spec describes nothing to build.",
    ])
  })

  test("an answer tutti refuses is refused with every reason, nothing filed", async () => {
    const answers: Array<ToolAnswer> = []
    await scenario({
      script: (recording) => [
        [
          wait,
          breakdownInit,
          ...turn(
            recording,
            [
              ["file_root", { ...rootInput, environment: undefined }],
              [
                "file_breakdown",
                {
                  root: "test-1",
                  issues: [
                    ticket({ key: "a", waits_for: ["b"] }),
                    ticket({ key: "b", waits_for: ["a"] }),
                  ],
                },
              ],
              ["file_breakdown", { root: "test-1", issues: [ticket({ key: "a" })] }],
            ],
            answers,
          ),
        ],
      ],
    })
    expect(answers.map((a) => a.isError)).toEqual([undefined, true, undefined])
    expect(textOf(answers[1])).toBe(
      "tutti refused the answer; nothing was filed. Fix these and call file_breakdown again:\n- the tree's parents and blocks links make a cycle: a → b → a",
    )
  })
})
