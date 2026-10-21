// The worker prompt asks for no to-do checklist (§ 4.11): bd prime, which reaches workers through
// the user's settings, forbids TodoWrite and TaskCreate, and orchestra's workers never kept one.
import { describe, expect, test } from "bun:test"
import { builtInWorkerPrompt, forTicket } from "../src/project/prompt.ts"

/** The prompt a worker on `bd-7` is given, its line breaks and indents folded to single spaces. */
const rules = forTicket({ text: builtInWorkerPrompt, file: null }, "bd-7").replace(/\s+/g, " ")

describe("the worker prompt without a to-do checklist", () => {
  test("mentions no checklist, nor the to-do tools", () => {
    expect(rules.toLowerCase()).not.toContain("checklist")
    expect(rules).not.toContain("TodoWrite")
    expect(rules).not.toContain("TaskCreate")
  })

  test("keeps the ticket's notes current across compactions", () => {
    expect(rules).toContain(
      "Your context is compacted as it fills, so don't cut work short because the conversation is long; keep the ticket's notes current, so you can carry on after it.",
    )
  })
})
