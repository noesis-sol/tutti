// Ticket IDs and plan text as untrusted text (§ 7.10): workers file tickets, so an ID can hold
// escape sequences. RunView sanitises it once, as `label` on its rows, cards and requests, and every
// view draws that, while `ticket` stays the key the run's commands name. tutti plan sanitises the
// IDs, the link reasons (a ticket's files entry among them) and bd's stderr it prints.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Console, Context, Effect, Layer, Queue } from "effect"
import { Command } from "effect/cli"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { tuttiWith } from "../src/cli/commands.ts"
import { linkLine, planLinks } from "../src/plan/plan.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { repoFiles } from "../src/run/footprint.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Beads, BeadsFailed, type Issue } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import type { RunLock } from "../src/services/RunLock.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { layer as lockLayer } from "../src/testing/RunLock.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"
import { ticketsLines } from "../src/ui/TicketsTable.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

// An ID a worker filed with a colour escape, a window-title OSC and a bidi override in it; drawn,
// it reads t-1. A renderer that dropped only the ESC would show the escapes' tails, as [31m.
const evil = "t-\x1b[31m1\x1b]0;pwned\x07‮"
const shown = "t-1"

// What a line drawn or printed must not hold: C0 controls but newline, DEL, C1 controls, bidi
// overrides and isolates, and an escape's tail.
const unsafe = (text: string): boolean =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is sought
  /[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]|\[31m|pwned/.test(text)

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const entryOf = (ticket: string, worker: number | null, row: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: worker === null ? TicketPhase.Queued() : TicketPhase.Working({ activity: "working" }),
  since: began,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const permission = (id: string, ticket: string): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
    summary: "rm -rf build",
  },
  displayName: "Bash",
  description: "Remove the build cache",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

/** RunView for the tickets `ids`, each at work but those `queued`, with `requests` open. */
const viewOf = (
  ids: ReadonlyArray<string>,
  requests: ReadonlyArray<AttentionRequest>,
  queued: ReadonlyArray<string> = [],
): RunView =>
  project({
    ledger: {
      tickets: new Map([
        ...ids.map((id, i): [string, Entry] => [id, entryOf(id, i + 1, i)]),
        ...queued.map((id, i): [string, Entry] => [id, entryOf(id, null, ids.length + i)]),
      ]),
      rows: ids.length + queued.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(ids.map((id) => [id, WS.Idle({ at: began })])),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 4 },
    actions: new Map(),
  })

describe("RunView", () => {
  test("sanitises each ticket ID once, as the label of its row, card and requests", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", minLength: 1 }), (id) => {
        const view = viewOf([id], [permission("r1", id)])
        expect(view.rows[0]?.label).toBe(sanitizeLine(id))
        expect(view.cards[0]?.label).toBe(sanitizeLine(id))
        expect(view.cards[0]?.requests[0]?.label).toBe(sanitizeLine(id))
        expect(view.requests[0]?.label).toBe(sanitizeLine(id))
        // The key the run's commands and answers name is the ID as filed.
        expect(view.rows[0]?.ticket).toBe(id)
        expect(view.cards[0]?.ticket).toBe(id)
        expect(view.requests[0]?.ticket).toBe(id)
      }),
    )
  })

  test("the tickets table draws the label", () => {
    const view = viewOf([], [], [evil])
    const lines = ticketsLines(view.rows, themeOf("dark"), 80, 6)
    const text = lines.map((line) => line.map((s) => s.text).join(""))
    expect(text.some((line) => line.includes(`${shown} `))).toBe(true)
    expect(text.some(unsafe)).toBe(false)
  })
})

describe("the dashboard", () => {
  const shellOf = (view: Settable<RunView>, commands: Commands, now: () => number): ShellValue => ({
    view,
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now,
  })

  const linesOf = (frame: Frame): ReadonlyArray<string> =>
    frame.chars.split("\n").map((line) => line.trimEnd())

  /** Renders the dashboard over `view` at `size`, its clock `settle` past `began`. */
  const scene = async (
    view: RunView,
    body: (rendered: Rendered, commands: Commands, pass: (millis: number) => void) => Promise<void>,
    size = { width: 80, height: 40 },
  ) => {
    const commands = Effect.runSync(makeCommands)
    let at = began
    await withRender(
      <Root value={shellOf(external(view), commands, () => at)} />,
      size,
      (rendered) =>
        body(rendered, commands, (millis) => {
          at += millis
        }),
    )
  }

  /** The commands sent since the last call, without waiting for one. */
  const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

  const typed = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
    rendered.input(async (setup) => {
      for (const key of keys) {
        if (key === "enter") setup.mockInput.pressEnter()
        else if (key === "tab") setup.mockInput.pressTab()
        else await setup.mockInput.typeText(key)
      }
    })

  test("an attention card and Shift+D's reason box draw the label, and the answer names the request", async () => {
    await scene(viewOf([evil], [permission("r1", evil)]), async (rendered, commands, pass) => {
      const frame = linesOf(await rendered.capture())
      pass(settle)
      expect(frame.some((line) => line.includes(`${shown} `))).toBe(true)
      expect(frame.some(unsafe)).toBe(false)
      await typed(rendered, "D")
      const box = linesOf(await rendered.capture())
      expect(box.some((line) => line.includes(`Deny ${shown}'s request, saying why:`))).toBe(true)
      expect(box.some(unsafe)).toBe(false)
      await typed(rendered, "stray", "enter")
      expect(taken(commands)).toEqual([
        UiCommand.Answer({ requestId: "r1", answer: { _tag: "Deny", reason: "stray" } }),
      ])
    })
  })

  test("the compact layout's Answer box draws the label", async () => {
    const ids = [evil, "t-2", "t-3", "t-4"]
    await scene(
      viewOf(ids, [permission("r1", evil)]),
      async (rendered) => {
        await typed(rendered, "enter")
        const frame = linesOf(await rendered.capture())
        expect(frame.some((line) => line.includes("[ Deny ]"))).toBe(true)
        expect(frame.some((line) => line.includes(`${shown}  `))).toBe(true)
        expect(frame.some(unsafe)).toBe(false)
      },
      { width: 80, height: 24 },
    )
  })

  test("the stop question names the running tickets by their labels", async () => {
    await scene(viewOf([evil], []), async (rendered) => {
      await typed(rendered, "s")
      const frame = linesOf(await rendered.capture())
      expect(frame.some((line) => line.includes(shown))).toBe(true)
      expect(frame.some(unsafe)).toBe(false)
    })
  })

  test("opening a card names its ticket as filed", async () => {
    await scene(viewOf([evil], []), async (rendered, commands) => {
      await typed(rendered, "tab", "enter")
      expect(taken(commands)).toEqual([UiCommand.OpenWorker({ ticket: evil })])
    })
  })
})

describe("tutti plan", () => {
  const ticket = (id: string, files: ReadonlyArray<string>): Issue => ({
    id,
    title: id,
    description: "",
    design: "",
    acceptance: "",
    notes: "",
    status: "open",
    priority: 2,
    type: "task",
    assignee: "",
    labels: [],
    dependencies: [],
    metadata: {},
    files,
    predictedFiles: [],
    createdAt: "2026-10-01T00:00:00Z",
    closeReason: "",
  })

  test("a link's line holds no control sequence, whatever its IDs and reason", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary" }),
        fc.string({ unit: "binary" }),
        fc.string({ unit: "binary" }),
        (blocker, blocked, why) => {
          const line = linkLine({ blocker, blocked, why }, new Map())
          expect(line).toBe(
            `  ${sanitizeLine(blocked)} (P9) waits for ${sanitizeLine(blocker)} (P9): both touch ${sanitizeLine(why)}`,
          )
        },
      ),
    )
  })

  test("a files entry with escapes, as the reason two tickets are linked, is printed sanitised", () => {
    const glob = "web/\x1b]0;pwned\x07*.ts"
    const links = planLinks(
      [ticket(evil, [glob]), ticket("t-2", [glob])],
      [],
      repoFiles(["src/x.ts"]),
      () => "",
    )
    expect(links.map((link) => link.why)).toEqual([glob])
    const line = linkLine(links[0] ?? { blocker: "", blocked: "", why: "" }, new Map())
    expect(line).toBe(`  t-2 (P9) waits for ${shown} (P9): both touch web/*.ts`)
  })

  test("prints IDs, reasons and bd's stderr sanitised", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-plan-ids-")))
    const files = { "README.md": "# tutti\n" }
    writeFileSync(join(dir, "README.md"), files["README.md"])
    const seeds: ReadonlyArray<Seed> = [
      { id: evil, priority: 1, description: "Reword README.md." },
      { id: "t-2", priority: 2, description: "Fix the title in README.md." },
    ]
    const printed: Array<string> = []
    const errors: Array<string> = []
    const console: Console.Console = Object.assign(Object.create(globalThis.console), {
      log: (...said: ReadonlyArray<unknown>) => printed.push(said.join(" ")),
      error: (...said: ReadonlyArray<unknown>) => errors.push(said.join(" ")),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const beads = yield* Beads
        // bd refusing the link, saying why with an escape that would clear the screen.
        const services = Context.add(yield* Effect.context<Beads | Git | RunLock>(), Beads, {
          ...beads,
          addDependency: (id: string, dependsOn: string) =>
            Effect.fail(
              new BeadsFailed({
                command: `bd dep add ${id} ${dependsOn}`,
                exitCode: 1,
                stderr: "\x1b[2Jdatabase is locked\x1b]0;pwned\x07\n",
                noSuchIssue: false,
              }),
            ),
        })
        yield* Command.runWith(
          tuttiWith(Effect.succeed(dir), () => Layer.succeedContext(services)),
          { version: "test", renderErrors: false },
        )(["plan", "--apply"]).pipe(Effect.provideService(Console.Console, console), Effect.exit)
      }).pipe(
        Effect.provide(Layer.mergeAll(beadsLayer(seeds), gitLayer({ dir, files }), lockLayer())),
        Effect.provide(BunServices.layer),
      ),
    )
    expect(printed).toContain(`  t-2 (P2) waits for ${shown} (P1): both touch README.md`)
    expect(errors).toContain(
      `tutti plan: bd dep add t-2 ${shown}: bd dep add t-2 ${shown} exited with 1: database is locked`,
    )
    expect([...printed, ...errors].some(unsafe)).toBe(false)
  })
})
