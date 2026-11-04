// What the Needs you panel and box say of a Blocked ticket (§ 7.2, tutti-urp4): by its case, with the
// files in conflict, its worktree, why it was left so, what to run and what comes next, and a
// hand-back only where an action does it. A panel too short for it all keeps its foot, and a click
// on its last line opens the box saying all of it.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import fc from "fast-check"
import { makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, type Need, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { clearsOf, needsLines, panelTargets } from "../src/ui/SidePanel.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")
const began = new Date(2026, 10, 4, 3, 0, 0).getTime()

type Blocked = Extract<Need, { _tag: "Blocked" }>

const about = {
  worktree: "/wt/fab-mgi.7.9",
  files: ["loop.ts", "cli.test.ts"],
  reason: "2 hand-backs used; main moved on as fab-mgi.7.7 merged",
}

const entry = (fields: Partial<LedgerEntry> = {}): LedgerEntry => ({
  ticket: "fab-mgi.7.9" as TicketId,
  title: "Merge the loop",
  phase: TicketPhase.Blocked({ why: "MERGE_CONFLICT" }),
  since: began,
  worker: null,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
  about,
  ...fields,
})

const viewOf = (each: LedgerEntry): RunView =>
  project({
    ledger: { tickets: new Map([[each.ticket, each]]), rows: 1, windDown: null, bugs: [] },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.6.7", branch: "trunk", began, concurrency: 4 },
    actions: new Map(),
  })

const needOf = (fields: Partial<LedgerEntry> = {}): Blocked => {
  const need = viewOf(entry(fields)).needs[0]
  if (need?._tag !== "Blocked") throw new Error("no Blocked need")
  return need
}

const textOf = (fields: Partial<LedgerEntry> = {}) => clearsOf(needOf(fields)).join("\n")

describe("what Needs you says of a conflict", () => {
  test("left by the run: its files, worktree, why, what to run and what comes next", () => {
    expect(clearsOf(needOf())).toEqual([
      "Its rebase onto trunk conflicts in loop.ts, cli.test.ts.",
      "Resolve it yourself: git rebase trunk in /wt/fab-mgi.7.9.",
      "Set aside: 2 hand-backs used; main moved on as fab-mgi.7.7 merged.",
      "The run's end labels it unmerged; the next run checks and merges it once it rebases cleanly.",
    ])
  })

  test("offers a hand-back only where its worker's hand-back waits, which an action does", () => {
    expect(textOf()).not.toMatch(/hand it|hands it/i)
    const waits = textOf({ handBack: true })
    expect(waits).toContain("'Hand it the conflict now' in its worker view hands it over")
    expect(waits).toContain("git rebase trunk in /wt/fab-mgi.7.9")
    expect(waits).not.toContain("labels it unmerged")
  })

  test("not in files, as a base that kept changing: says why, and names none", () => {
    const text = textOf({
      about: { ...about, files: [], reason: "main kept changing while its checks ran" },
    })
    expect(text).toContain("Its branch can't merge onto trunk.")
    expect(text).toContain("Set aside: main kept changing while its checks ran.")
  })

  test("with nothing kept of it: says so plainly, with no hand-back and the run's base", () => {
    const text = textOf({ about: undefined })
    expect(text).toContain("Its rebase onto trunk conflicts.")
    expect(text).toContain("git rebase trunk in its worktree")
    expect(text).not.toMatch(/hand/i)
  })
})

describe("what Needs you says of the merges stopping", () => {
  const stopped = (why: string, reason: string) =>
    textOf({ phase: TicketPhase.Blocked({ why }), about: { ...about, files: [], reason } })

  test("MERGE_FAILED: the line's reason, the rebase to run, and no hand-back", () => {
    const text = stopped("MERGE_FAILED", "tutti/a does not fast-forward onto trunk: no")
    expect(text).toContain("Its merge stopped: tutti/a does not fast-forward onto trunk: no")
    expect(text).toContain("git rebase trunk in /wt/fab-mgi.7.9")
    expect(text).toContain("the next run checks and merges it")
    expect(text).not.toMatch(/hand/i)
  })

  test("DIRTY_TREE: what to leave clean, and that this run doesn't merge it", () => {
    const text = stopped("DIRTY_TREE", "uncommitted changes in /repo")
    expect(text).toContain("Its merge stopped: uncommitted changes in /repo")
    expect(text).toContain("Leave the main checkout clean, on trunk.")
    expect(text).toContain("The merges have stopped")
    expect(text).not.toContain("the run merges it")
  })

  test("GIT_FAILED: the line's reason, not only the log's word", () => {
    const text = stopped("GIT_FAILED", "could not tell where tutti/a is")
    expect(text).toContain("Its merge stopped: could not tell where tutti/a is")
    expect(text).toContain("The merges have stopped")
  })

  test("a why it doesn't know: the log", () => {
    expect(clearsOf(needOf({ phase: TicketPhase.Blocked({ why: "SOMETHING" }) }))).toEqual([
      "The log says what happened.",
    ])
  })
})

describe("what the view gives Needs you", () => {
  test("is sanitised, whatever a branch's files or a line hold", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (file, worktree, reason) => {
        const need = needOf({ about: { worktree, files: [file], reason } })
        for (const text of clearsOf(need)) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: what sanitising takes out
          expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
        }
      }),
    )
  })
})

describe("the panel's lines", () => {
  const texts = (lines: ReadonlyArray<ReadonlyArray<{ readonly text: string }>>) =>
    lines.map((line) => line.map((segment) => segment.text).join(""))
  const at = { index: 0, focused: true, choice: 0 }

  test("tall enough: all of it, then the foot", () => {
    const lines = texts(needsLines([needOf()], at, theme, 60, 20)).join("\n")
    expect(lines).toContain("loop.ts, cli.test.ts")
    expect(lines).toContain("next run checks")
    expect(lines).toContain("Enter opens its worker view")
    expect(lines).not.toContain("click to read it all")
  })

  test("very short: the line to read it all in place of the title, and the foot", () => {
    const lines = texts(needsLines([needOf()], at, theme, 60, 6)).join("\n")
    expect(lines).not.toContain("Merge the loop")
    expect(lines).toContain("click to read it all")
    expect(lines).toContain("Enter reads it all")
  })

  test("too short: what to do first, a line to read it all, and still the foot", () => {
    const lines = needsLines([needOf()], at, theme, 60, 12)
    const said = texts(lines).join("\n")
    expect(said).toContain("loop.ts, cli.test.ts")
    expect(said).toContain("git rebase trunk")
    expect(said).not.toContain("next run checks")
    expect(said).toContain("Enter reads it all")
    const read = lines.flat().find((segment) => segment.text.includes("click to read it all"))
    expect(read?.target).toBe(panelTargets.read)
  })
})

describe("the panel's cut text", () => {
  test("a click opens a box saying all of it, which Esc closes; Enter there, its worker view", async () => {
    const placeOf = (frame: Frame, text: string) => {
      const lines = frame.chars.split("\n")
      const y = lines.findIndex((line) => line.includes(text))
      return { x: lines[y]?.indexOf(text) ?? -1, y }
    }
    const commands = Effect.runSync(makeCommands)
    await withRender(
      <Root
        value={{
          view: external(viewOf(entry())),
          screen: external<Screen>(Screen.Dashboard()),
          commands,
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => began + 60_000,
        }}
      />,
      { width: 140, height: 25 },
      async (rendered) => {
        const frame = await rendered.capture()
        const { x, y } = placeOf(frame, "click to read it all")
        expect(y).toBeGreaterThan(-1)
        expect(frame.chars).not.toContain("next run checks")
        await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
        const box = await rendered.capture()
        expect(box.chars.replace(/\s+/g, " ")).toContain("next run checks")
        await rendered.input(pressEscape)
        const closed = await rendered.capture()
        expect(closed.chars).not.toContain("next run checks")
        // Tab to the panel; Enter reads it all; Enter there opens its worker view.
        await rendered.input((setup) => setup.mockInput.pressTab())
        await rendered.input((setup) => setup.mockInput.pressEnter())
        const read = await rendered.capture()
        expect(read.chars.replace(/\s+/g, " ")).toContain("next run checks")
        await rendered.input((setup) => setup.mockInput.pressEnter())
        expect(Effect.runSync(Queue.clear(commands))).toEqual(
          expect.arrayContaining([UiCommand.OpenWorker({ ticket: "fab-mgi.7.9" as TicketId })]),
        )
      },
    )
  })
})
