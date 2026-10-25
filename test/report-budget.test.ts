import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { type InputPart, renderInput, type Section, section } from "../src/organs/evidence.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { Ending } from "../src/print/summary.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import {
  cappedEvidence,
  cappedList,
  evidenceCap,
  gather,
  listCaps,
  notesTail,
  notesWidth,
  type ReportRun,
  reviewerBudget,
  runSections,
  showConcurrency,
} from "../src/run/report.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"

const tickets = { one: "closed ticket", many: "closed tickets" }

const blocks = (n: number) => Array.from({ length: n }, (_, i) => `t-${i + 1}: Fix it\nDone`)

describe("a list as the reviewer reads it", () => {
  test("a list that fits is given whole", () => {
    expect(cappedList(blocks(3), listCaps.closed, tickets)).toBe(blocks(3).join("\n\n"))
  })

  test("a long list keeps its last items, saying how many earlier ones were cut", () => {
    const items = blocks(500)
    const capped = cappedList(items, { lines: 300, characters: 1_000_000 }, tickets)
    const [said, ...rest] = capped.split("\n\n")
    expect(said).toBe("[200 earlier closed tickets cut here; the last 300 follow]")
    expect(rest).toEqual(items.slice(-300))
  })

  test("the last items stop at the character cap", () => {
    const items = blocks(9)
    const width = (items.at(-1)?.length ?? 0) + 2
    const capped = cappedList(items, { lines: 100, characters: width * 2 }, tickets)
    expect(capped.split("\n\n")).toEqual([
      "[7 earlier closed tickets cut here; the last 2 follow]",
      ...items.slice(-2),
    ])
  })

  test("one item cut, and a last item too long to give, are said so", () => {
    expect(cappedList(["a", "b"], { lines: 1, characters: 100 }, tickets, "\n")).toBe(
      "[1 earlier closed ticket cut here; the last closed ticket follows]\nb",
    )
    expect(cappedList(["a", "long"], { lines: 10, characters: 3 }, tickets, "\n")).toBe(
      "[2 earlier closed tickets cut here; its last closed ticket is too long to give]",
    )
  })

  test("every item is either given or counted as cut, whatever the items say", () => {
    const item = fc.string({ maxLength: 30 }).map((each) => `x${each.replaceAll("\n", " ")}`)
    fc.assert(
      fc.property(
        fc.array(item, { maxLength: 40 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 400 }),
        (items, lines, characters) => {
          const given = cappedList(items, { lines, characters }, tickets, "\n").split("\n")
          const cut = /^\[(\d+) earlier closed tickets? cut here/.exec(given[0] ?? "")
          if (cut === null) return expect(given.join("\n")).toBe(items.join("\n"))
          const tail = given.slice(1)
          expect(tail.length).toBeLessThanOrEqual(lines)
          expect(tail.reduce((sum, each) => sum + each.length + 1, 0)).toBeLessThanOrEqual(
            characters,
          )
          expect(Number(cut[1]) + tail.length).toBe(items.length)
          expect(tail).toEqual(items.slice(items.length - tail.length))
        },
      ),
    )
  })
})

describe("a set-aside ticket's notes as the reviewer reads them", () => {
  test("notes that fit are given whole", () => {
    expect(notesTail("Triage: the check failed in its own code.")).toBe(
      "Triage: the check failed in its own code.",
    )
  })

  test("long notes keep their end, from the start of a line", () => {
    const notes = `${"an old note\n".repeat(400)}Waiting on tut-9 to merge`
    const given = notesTail(notes)
    const [said, ...rest] = given.split("\n")
    const end = rest.join("\n")
    expect(notes.endsWith(`\n${end}`)).toBe(true)
    expect(end.endsWith("Waiting on tut-9 to merge")).toBe(true)
    expect(end.length).toBeLessThanOrEqual(notesWidth)
    expect(said).toBe(
      `[the notes' first ${notes.length - end.length} characters cut here; their end follows]`,
    )
  })

  test("notes of one long line keep their last characters", () => {
    expect(notesTail("abcdefghij", 4)).toBe(
      "[the notes' first 6 characters cut here; their end follows]\nghij",
    )
  })

  test("the end given is the notes' end, no longer than the width, whatever they say", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.integer({ min: 1, max: 100 }), (notes, w) => {
        const given = notesTail(notes, w)
        if ([...notes].length <= w) return expect(given).toBe(notes)
        const said = /^\[the notes' first (\d+) characters? cut here; their end follows\]\n/.exec(
          given,
        )
        expect(said).not.toBeNull()
        const end = given.slice(said?.[0].length ?? 0)
        expect(notes.endsWith(end)).toBe(true)
        expect([...end].length).toBeLessThanOrEqual(w)
        expect(Number(said?.[1]) + [...end].length).toBe([...notes].length)
      }),
    )
  })
})

describe("a section the run gathered, as the reviewer reads it", () => {
  test("keeps its title and the end of its body", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`)
    const capped = cappedEvidence(section("The full check", body.join("\n")))
    expect(capped.title).toBe("The full check")
    const [said, ...rest] = capped.body.split("\n")
    expect(said).toBe(
      `[${2000 - evidenceCap.lines} earlier lines of this section cut here; the last ` +
        `${evidenceCap.lines} follow]`,
    )
    expect(rest).toEqual(body.slice(-evidenceCap.lines))
  })
})

const huge = "x".repeat(2000)

/** A run of `n` closed tickets, `n` set aside and `n` in progress, each with long text. */
const bigRun = (n: number) => {
  const ids = (kind: string) => Array.from({ length: n }, (_, i) => `${kind}-${i + 1}` as TicketId)
  const seeds: Array<Seed> = [
    ...ids("closed").map((id) => ({
      id,
      title: `Close ${id} ${huge.slice(0, 80)}`,
      status: "closed" as const,
      closeReason: huge,
    })),
    ...ids("aside").map((id) => ({ id, title: `Set ${id} aside`, notes: huge.repeat(5) })),
    ...ids("running").map((id) => ({ id, title: `Run ${id} ${huge.slice(0, 200)}` })),
  ]
  return { ids, seeds }
}

const gathered = (
  n: number,
  sections: ReadonlyArray<Section>,
  wrap: (beads: Beads["Service"]) => Beads["Service"] = (beads) => beads,
): Promise<ReadonlyArray<InputPart>> => {
  const { ids, seeds } = bigRun(n)
  const repo = mkdtempSync(join(tmpdir(), "tutti-report-budget-"))
  const deps = Layer.mergeAll(
    configLayer(appConfig({}, repo)),
    beadsLayer(seeds),
    gitLayer({ dir: repo }),
    logLayer(),
    eventsLayer(),
  )
  const services = Layer.mergeAll(OrganCost.layer, Ledger.layer, attentionLayer()).pipe(
    Layer.provideMerge(deps),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Repository
      const startHead = yield* git.head("main")
      for (let i = 0; i < n; i++) yield* git.commit(repo, `Commit ${i} ${huge.slice(0, 300)}`)
      const ledger = yield* Ledger
      for (const id of [...ids("closed"), ...ids("aside"), ...ids("running")]) {
        yield* ledger.transition(id, Move.Ready(), { title: id })
        yield* ledger.transition(id, Move.Dispatched())
      }
      for (const id of ids("closed")) {
        yield* ledger.transition(id, Move.Verified({ place: 1 }))
        yield* ledger.transition(id, Move.ItsTurn())
        yield* ledger.transition(id, Move.FastForwarded({ commit: "abc123" }))
      }
      for (const id of ids("aside")) {
        yield* ledger.transition(id, Move.Defer({ why: "deferred by its worker" }))
      }
      const run: ReportRun = {
        started: 0,
        base: "main",
        startHead,
        ending: Ending.Done({ text: "DONE", tickets: n, limit: null, took: 0 }),
        exitCode: 0,
        quit: false,
        sections,
      }
      const beads = yield* Beads
      return yield* gather(run).pipe(Effect.provideService(Beads, wrap(beads)))
    }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
  )
}

const body = (parts: ReadonlyArray<InputPart>, title: string): string =>
  parts.find((part): part is Section => typeof part !== "string" && part.title.startsWith(title))
    ?.body ?? ""

describe("the reviewer's input on an overnight run", () => {
  test("keeps within the reviewer's budget, saying what each list cut", async () => {
    const sections = Array.from({ length: runSections }, (_, i) =>
      section(`Evidence ${i}`, Array.from({ length: 3000 }, () => huge.slice(0, 100)).join("\n")),
    )
    const parts = await gathered(400, sections)
    const input = renderInput("0123456789abcdef", parts)
    expect(input.length).toBeLessThanOrEqual(reviewerBudget)
    expect(body(parts, "Commits merged")).toMatch(/^\[\d+ earlier commits cut here; the last/)
    expect(body(parts, "Tickets closed")).toMatch(/^\[\d+ earlier closed tickets cut here/)
    expect(body(parts, "Tickets set aside")).toMatch(/^\[\d+ earlier set-aside tickets cut here/)
    expect(body(parts, "Tickets in progress")).toMatch(/^\[\d+ earlier tickets in progress cut/)
    expect(body(parts, "Each ticket's attention")).toMatch(/^\[\d+ earlier tickets' lines cut/)
    expect(body(parts, "Evidence 0")).toMatch(/^\[\d+ earlier lines of this section cut here/)
    // The last ticket closed is there, and a set-aside ticket's notes are cut to their end.
    expect(body(parts, "Tickets closed")).toContain("closed-400: Close closed-400")
    expect(body(parts, "Tickets set aside")).toContain(
      "[the notes' first 8500 characters cut here; their end follows]",
    )
  }, 60_000)

  test("runs bd show for several tickets at once, keeping their order", async () => {
    let inFlight = 0
    let most = 0
    const parts = await gathered(12, [], (beads) => ({
      ...beads,
      show: (id) =>
        Effect.gen(function* () {
          inFlight += 1
          most = Math.max(most, inFlight)
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          inFlight -= 1
          return yield* beads.show(id)
        }),
    }))
    expect(most).toBe(showConcurrency)
    const closed = body(parts, "Tickets closed")
    const order = [...closed.matchAll(/^(closed-\d+):/gm)].map((each) => each[1])
    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => `closed-${i + 1}`))
  })
})
