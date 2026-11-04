// What the Needs you panel and box say of a Blocked ticket (§ 7.2, tutti-urp4): by its case, with the
// files in conflict, its worktree, why it was left so, what to run and what comes next, and a
// hand-back only where an action does it. A panel too short for it all keeps its foot, and a click
// on its last line opens the box saying all of it.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import fc from "fast-check"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
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

type Rendered = Parameters<Parameters<typeof withRender>[2]>[0]

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
      "Run git rebase trunk in /wt/fab-mgi.7.9 to take it up yourself.",
      "Its rebase onto trunk conflicts in loop.ts, cli.test.ts.",
      "Press h to hand it back to its worker, with one more hand-back.",
      "The run takes it back once its branch has moved on, its worktree is clean and it rebases cleanly.",
      "Set aside: 2 hand-backs used; main moved on as fab-mgi.7.7 merged.",
      "The run's end labels it unmerged; the next run checks and merges it once it rebases cleanly.",
    ])
  })

  test("offers a hand-back by the action that does it: `h`, or its worker's that waits", () => {
    expect(textOf()).toContain("Press h to hand it back")
    expect(textOf()).not.toContain("'Hand it the conflict now'")
    const waits = textOf({ handBack: true })
    expect(waits).toContain("Press h, or 'Hand it the conflict now' in its worker view")
    expect(waits).toContain("git rebase trunk in /wt/fab-mgi.7.9")
    expect(waits).toContain("An overnight run doesn't wait for it")
    expect(waits).toContain("press q")
    expect(waits).toContain("The run's end labels it unmerged")
  })

  test("names the first files and how many more", () => {
    const files = Array.from({ length: 80 }, (_, i) => `src/file-${i}.ts`)
    const text = textOf({ about: { ...about, files } })
    expect(text).toContain("src/file-4.ts and 75 more.")
    expect(text).not.toContain("src/file-5.ts")
  })

  test("not in files, as a base that kept changing: says why, and names none", () => {
    const text = textOf({
      about: { ...about, files: [], reason: "main kept changing while its checks ran" },
    })
    expect(text).toContain("Its branch can't merge onto trunk.")
    expect(text).toContain("Set aside: main kept changing while its checks ran.")
  })

  test("with nothing kept of it: says so plainly, with the run's base", () => {
    const text = textOf({ about: undefined })
    expect(text).toContain("Its rebase onto trunk conflicts.")
    expect(text).toContain("git rebase trunk in its worktree")
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
  const at = { focused: true, inside: true, choice: 0 }

  test("tall enough: all of it, then the foot", () => {
    const lines = texts(needsLines(needOf(), 1, at, theme, 60, 20)).join("\n")
    expect(lines).toContain("loop.ts, cli.test.ts")
    expect(lines).toContain("next run checks")
    expect(lines).toContain("Enter opens its worker view")
    expect(lines).not.toContain("click to read it all")
  })

  test("at any height: its foot, and what to do first, however long the rest", () => {
    const long = "/Users/someone/.tutti/worktrees/fabrica/fab-mgi.7.9"
    const title = "Make the loop's merge step keep what it read of the ticket across a restart"
    const files = Array.from({ length: 14 }, (_, i) => `packages/engine/src/file-${i}.ts`)
    const cases = [
      { title, about: { ...about, worktree: long } },
      { about: { ...about, worktree: long, files } },
      { title, about: { ...about, worktree: long, files } },
    ]
    for (const fields of cases) {
      for (let height = 6; height <= 30; height++) {
        const shown = (handBack: boolean) =>
          texts(needsLines(needOf({ ...fields, handBack }), 1, at, theme, 51, height)).join("\n")
        expect(shown(false)).toMatch(/Enter (reads it all|opens its worker view)/)
        expect(shown(false)).toContain("git rebase trunk")
        expect(shown(true)).toMatch(/Enter (reads it all|opens its worker view)/)
        expect(shown(true)).toContain("'Hand it the conflict now'")
      }
    }
  })

  test("very short: what to do in place of the title, and the foot, to click", () => {
    const lines = needsLines(needOf(), 1, at, theme, 60, 6)
    const said = texts(lines).join("\n")
    expect(said).not.toContain("Merge the loop")
    expect(said).toContain("git rebase trunk")
    expect(said).toContain("… click or Enter reads it all")
    const read = lines.flat().find((segment) => segment.text.includes("reads it all"))
    expect(read?.target).toBe(panelTargets.read)
  })

  test("too short: what to do first, and the foot says how to read the rest", () => {
    const said = texts(
      needsLines(needOf(), 1, { ...at, focused: false, inside: false }, theme, 60, 9),
    ).join("\n")
    expect(said).toContain("loop.ts, cli.test.ts")
    expect(said).toContain("git rebase trunk")
    expect(said).not.toContain("next run checks")
    expect(said).toContain("… click reads it all · h hands it back")
  })
})

/** Draws the run's dashboard for `each`, in a pane `width` by `height`. */
const dashboard = async (
  each: LedgerEntry,
  size: { readonly width: number; readonly height: number },
  body: (rendered: Rendered, commands: Commands) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: external(viewOf(each)),
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 60_000,
      }}
    />,
    size,
    (rendered) => body(rendered, commands),
  )
}

const placeOf = (frame: Frame, text: string) => {
  const lines = frame.chars.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  return { x: lines[y]?.indexOf(text) ?? -1, y }
}

const flat = (frame: Frame) => frame.chars.replace(/[\s│┃]+/g, " ")

const openWorker = UiCommand.OpenWorker({ ticket: "fab-mgi.7.9" as TicketId })

describe("the panel's cut text", () => {
  test("a click opens a box saying all of it, which Esc closes; Enter there, its worker view", async () => {
    await dashboard(entry(), { width: 140, height: 25 }, async (rendered, commands) => {
      const frame = await rendered.capture()
      const { x, y } = placeOf(frame, "click reads it all")
      expect(y).toBeGreaterThan(-1)
      expect(frame.chars).not.toContain("next run checks")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      expect(flat(await rendered.capture())).toContain("next run checks")
      await rendered.input(pressEscape)
      expect((await rendered.capture()).chars).not.toContain("next run checks")
      // The click went into the panel: Enter reads it all; Enter there, its worker view.
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(flat(await rendered.capture())).toContain("next run checks")
      expect(Effect.runSync(Queue.clear(commands))).not.toContainEqual(openWorker)
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(Effect.runSync(Queue.clear(commands))).toContainEqual(openWorker)
    })
  })

  test("its box fits a pane, with its keys, however many files conflict", async () => {
    const files = Array.from({ length: 80 }, (_, i) => `src/packages/module-${i}/index.ts`)
    const each = entry({ about: { ...about, files } })
    await dashboard(each, { width: 140, height: 30 }, async (rendered) => {
      const { x, y } = placeOf(await rendered.capture(), "click reads it all")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      const box = flat(await rendered.capture())
      expect(box).toContain("next run checks")
      expect(box).toContain("Esc close")
    })
  })

  test("a stop's line that lists every file: cut, the rest said, its keys on screen", async () => {
    const list = Array.from({ length: 40 }, (_, i) => `generated/client/model-${i}.ts`).join(", ")
    const reason = `uncommitted changes in /repo to ${list}, which tutti/a changes`
    const each = entry({
      phase: TicketPhase.Blocked({ why: "DIRTY_TREE" }),
      about: { ...about, files: [], reason },
    })
    expect(clearsOf(needOf(each)).join("\n")).toContain("… (the log has it all)")
    await dashboard(each, { width: 140, height: 30 }, async (rendered) => {
      const { x, y } = placeOf(await rendered.capture(), "click reads it all")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      const box = flat(await rendered.capture())
      expect(box).toContain("The merges have stopped")
      expect(box).toContain("Esc close")
    })
  })

  test("a box too tall for its pane keeps its keys and what comes first", async () => {
    await dashboard(entry(), { width: 140, height: 25 }, async (rendered) => {
      const { x, y } = placeOf(await rendered.capture(), "click reads it all")
      await rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      await rendered.input((setup) => setup.resize(140, 9))
      const box = flat(await rendered.capture())
      expect(box).toContain("no room here for the rest")
      expect(box).toContain("git rebase trunk")
      expect(box).toContain("Esc close")
    })
  })
})

describe("Enter on a panel that shows it all", () => {
  test("opens its worker view at once", async () => {
    const each = entry({ phase: TicketPhase.Blocked({ why: "DIRTY_TREE" }), about: undefined })
    await dashboard(each, { width: 140, height: 44 }, async (rendered, commands) => {
      await rendered.input((setup) => setup.mockInput.pressTab())
      await rendered.input((setup) => setup.mockInput.pressEnter())
      const frame = await rendered.capture()
      expect(flat(frame)).toContain("next run checks")
      expect(frame.chars).toContain("Enter opens its worker view")
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect(Effect.runSync(Queue.clear(commands))).toContainEqual(openWorker)
    })
  })
})
