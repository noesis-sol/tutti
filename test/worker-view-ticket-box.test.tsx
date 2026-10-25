// The ticket's box's top border in the worker view (§ 7.5, § 7.11, tutti-cxgo.6): `Ticket` bold at
// its left, the type and priority at its right, each type and priority in its own role, an unknown
// type in the text's colour, the ` · ` faint; the words kept under NO_COLOR; a narrow pane dropping
// the priority, then the type; and the type, which a ticket author wrote, sanitised. The box as
// drawn in the view is worker-view-head.test.tsx's.
import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import fc from "fast-check"
import { type TicketText, ticketText } from "../src/run/runView.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { plainFg, type Segments, widthOf } from "../src/ui/line.tsx"
import { sanitizeLine } from "../src/ui/sanitize.ts"
import { badgeLabel, badgesOf, priorityLook, ticketEdge, typeRole } from "../src/ui/TicketHead.tsx"
import { makeTheme, orchestra, type Role } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const light = makeTheme(orchestra, { appearance: "light", depth: "truecolor", noColor: false })
const noColor = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const issueOf = (fields: Partial<Issue> = {}): TicketText =>
  ticketText({
    id: "t-1" as TicketId,
    title: "Title of t-1",
    description: "",
    design: "",
    acceptance: "",
    notes: "",
    status: "in_progress",
    priority: 2,
    type: "bug",
    assignee: "",
    labels: [],
    dependencies: [],
    metadata: {},
    files: [],
    predictedFiles: [],
    createdAt: "",
    closeReason: "",
    ...fields,
  })

const textOf = (segments: Segments): string => segments.map((each) => each.text).join("")

const lookOf = (segments: Segments, text: string) =>
  segments.find((each) => each.text === text)?.look

describe("the top border", () => {
  test("Ticket bold at its left, the type and priority at its right, the pane's width", () => {
    const edge = ticketEdge(theme, 40, badgesOf(issueOf(), theme))
    expect(textOf(edge)).toBe(`╭─ Ticket ${"─".repeat(18)} bug · P2 ─╮`)
    expect(widthOf(edge)).toBe(40)
    expect(lookOf(edge, "Ticket")).toBe(theme.styles.tickets)
    expect((theme.styles.tickets.attributes & TextAttributes.BOLD) !== 0).toBe(true)
    expect(lookOf(edge, " · ")).toBe(theme.styles.dim)
    expect(edge[0]?.look).toBe(theme.look("frame"))
  })

  test("a narrow pane drops the priority, then the type, then cuts Ticket", () => {
    const badges = badgesOf(issueOf({ type: "feature", priority: 1 }), theme)
    const at = (width: number) => textOf(ticketEdge(theme, width, badges))
    // The name's 10 columns, 3 of the border at least, the label, then ` ─╮`.
    expect(at(29)).toBe(`╭─ Ticket ${"─".repeat(3)} feature · P1 ─╮`)
    expect(at(28)).toBe(`╭─ Ticket ${"─".repeat(7)} feature ─╮`)
    expect(at(24)).toBe(`╭─ Ticket ${"─".repeat(3)} feature ─╮`)
    expect(at(23)).toBe(`╭─ Ticket ${"─".repeat(12)}╮`)
    expect(at(11)).toBe("╭─ Ticket ╮")
    expect(at(8)).toBe("╭─ Tic…╮")
    for (const width of [8, 11, 23, 24, 28, 29, 80]) {
      expect(widthOf(ticketEdge(theme, width, badges))).toBe(width)
    }
  })

  test("neither type nor priority: Ticket alone, as before the run has read the ticket", () => {
    expect(textOf(ticketEdge(theme, 20, badgesOf(undefined, theme)))).toBe(
      `╭─ Ticket ${"─".repeat(9)}╮`,
    )
    // bd gives no priority: TicketText's null.
    const none = badgesOf({ ...issueOf({ type: "" }), priority: null }, theme)
    expect(badgeLabel(none, theme)).toEqual([])
    expect(textOf(badgeLabel(badgesOf(issueOf({ type: "" }), theme), theme))).toBe("P2")
    expect(textOf(badgeLabel(badgesOf({ ...issueOf(), priority: null }, theme), theme))).toBe("bug")
  })
})

describe("the type's and the priority's colours", () => {
  const types: ReadonlyArray<readonly [string, Role]> = [
    ["bug", "typeBug"],
    ["feature", "typeFeature"],
    ["task", "typeTask"],
    ["epic", "typeEpic"],
    ["chore", "typeChore"],
  ]

  test("each type in its role, in both variants", () => {
    for (const [type, role] of types) {
      expect(typeRole(type)).toBe(role)
      for (const each of [theme, light]) {
        const badges = badgesOf(issueOf({ type }), each)
        expect(badges.type[0]?.look).toBe(each.look(role))
        expect(badges.type[0]?.look?.fg?.toInts()).toEqual(each.rgba(role, "fg").toInts())
      }
    }
  })

  test("any other type in the text's colour", () => {
    expect(typeRole("decision")).toBeNull()
    expect(badgesOf(issueOf({ type: "decision" }), theme).type[0]?.look).toBe(theme.look(null))
    expect(theme.look(null).fg).toBeUndefined()
  })

  test("P0 urgent, P1 high, P2 to P4 faint", () => {
    expect(priorityLook(0, theme)).toBe(theme.look("priorityUrgent"))
    expect(priorityLook(1, theme)).toBe(theme.look("priorityHigh"))
    for (const priority of [2, 3, 4]) expect(priorityLook(priority, theme)).toBe(theme.styles.dim)
    expect(badgesOf(issueOf({ priority: 0 }), theme).priority[0]?.text).toBe("P0")
    expect(theme.rgba("priorityUrgent", "fg").toInts()).toEqual(
      theme.rgba("needsYou", "fg").toInts(),
    )
  })

  test("under NO_COLOR the words stay, none coloured", () => {
    const badges = badgesOf(issueOf({ type: "feature", priority: 0 }), noColor)
    const edge = ticketEdge(noColor, 40, badges)
    expect(textOf(edge)).toContain("Ticket")
    expect(textOf(edge)).toContain("feature · P0")
    // Every colour the terminal's own.
    for (const each of edge) {
      expect(each.look?.fg?.toInts() ?? plainFg.toInts()).toEqual(plainFg.toInts())
    }
    expect(badges.type[0]?.look?.fg?.toInts()).toEqual(plainFg.toInts())
  })
})

describe("what a ticket author wrote", () => {
  test("the type is sanitised, and the border keeps its width whatever it is", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.integer({ min: 4, max: 120 }), (type, width) => {
        const badges = badgesOf(issueOf({ type }), theme)
        expect(textOf(badges.type)).toBe(sanitizeLine(textOf(badges.type)))
        expect(widthOf(ticketEdge(theme, width, badges))).toBe(width)
      }),
    )
  })
})
