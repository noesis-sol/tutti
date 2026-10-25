// Scrolling the worker view (§ 7.3, § 7.5): PgUp and PgDn move it a page at a time, the mouse wheel
// a few lines; past the top, the wheel and PgUp load the items before the window, keeping your
// place; back at the bottom it follows the worker again.

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Scope } from "effect"
import { Transcripts, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { atBottom, transcriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { entryId } from "../src/ui/WorkerView.tsx"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

const said = (words: string) =>
  ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

/** Worker 1 on t-1, working. */
const view: RunView = project({
  ledger: {
    tickets: new Map([
      [
        "t-1" as TicketId,
        {
          ticket: "t-1" as TicketId,
          title: "Title of t-1",
          phase: TicketPhase.Working(),
          since: began,
          worker: 1,
          row: 0,
          rechecking: false,
          steered: false,
          lastMessage: null,
          tallies: emptyTallies,
        },
      ],
    ]),
    rows: 1,
    windDown: null,
    bugs: [],
  },
  workers: new Map([["t-1", WS.Idle({ at: began })]]),
  requests: [],
  status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
  actions: new Map(),
})

/** The worker view of t-1, whose transcript has `count` items, `item 1` to `item <count>`. */
const scrolling = async (count: number, body: (rendered: Rendered) => Promise<void>) => {
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      v: transcriptVersion,
      seq: i + 1,
      session,
      time: "2026-10-20T13:00:00.000Z",
      message: said(`item ${i + 1}`),
    }),
  )
  const transcripts = Effect.runSync(
    Effect.gen(function* () {
      return yield* Transcripts
    }).pipe(Effect.provide(memoryLayer({ "t-1": lines }))),
  )
  const scope = Effect.runSync(Scope.make())
  const feed = Effect.runSync(transcriptFeed(transcripts).pipe(Scope.provide(scope)))
  const shell: ShellValue = {
    view: external(view),
    screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 67_000,
    transcripts: feed,
  }
  try {
    await withRender(<Root value={shell} />, { width: 60, height: 20 }, body)
  } finally {
    Effect.runSync(Scope.close(scope, Exit.void))
  }
}

/** The items the frame shows, by number, top to bottom. */
const shownItems = (frame: Frame): ReadonlyArray<number> =>
  [...frame.chars.matchAll(/item (\d+)/g)].map((match) => Number(match[1]))

/** Captures frames until `ready` holds of one's items, waiting inside act() for what loads. */
const until = async (
  rendered: Rendered,
  ready: (items: ReadonlyArray<number>) => boolean,
): Promise<ReadonlyArray<number>> => {
  const deadline = Date.now() + 5000
  for (;;) {
    await rendered.input(() => Bun.sleep(20))
    const items = shownItems(await rendered.capture())
    if (ready(items) || Date.now() > deadline) return items
  }
}

/** How many transcript entries are mounted, and the key of the first. */
const mountedIn = (rendered: Rendered) => {
  const keys: Array<string> = []
  const walk = (node: { readonly id: string; getChildren(): ReadonlyArray<unknown> }) => {
    if (node.id.startsWith(entryId(""))) keys.push(node.id.slice(entryId("").length))
    for (const child of node.getChildren()) walk(child as typeof node)
  }
  walk(rendered.setup.renderer.root as never)
  return { count: keys.length, first: keys[0] }
}

const pageUp = "\x1b[5~"
const pageDown = "\x1b[6~"

const press = (rendered: Rendered, key: string) =>
  rendered.input(async (setup) => {
    setup.mockInput.pressKey(key)
    await Bun.sleep(30)
  })

/** Turns the wheel `direction` once, over the transcript. */
const wheel = (rendered: Rendered, direction: "up" | "down") =>
  rendered.input(async (setup) => {
    await setup.mockMouse.scroll(20, 8, direction)
    await Bun.sleep(30)
  })

const last = (items: ReadonlyArray<number>) => items.at(-1) ?? 0
const first = (items: ReadonlyArray<number>) => items[0] ?? 0

describe("scrolling the worker view", () => {
  test("PgUp and PgDn move it a page at a time, PgDn back to the latest", async () => {
    await scrolling(250, async (rendered) => {
      const bottom = await until(rendered, (items) => last(items) === 250)
      expect(last(bottom)).toBe(250)
      await press(rendered, pageUp)
      const up = await until(rendered, (items) => last(items) < 250)
      // A page up: what was at the top is now at the bottom, or near it.
      expect(last(up)).toBeLessThan(250)
      expect(last(up)).toBeGreaterThanOrEqual(first(bottom) - 1)
      await press(rendered, pageUp)
      const further = await until(rendered, (items) => last(items) < first(up) + 1)
      expect(last(further)).toBeLessThanOrEqual(first(up))
      await press(rendered, pageDown)
      await press(rendered, pageDown)
      expect(last(await until(rendered, (items) => last(items) === 250))).toBe(250)
    })
  }, 30_000)

  test("the wheel scrolls it, and past the top loads the items before the window", async () => {
    await scrolling(250, async (rendered) => {
      const bottom = await until(rendered, (items) => last(items) === 250)
      expect(mountedIn(rendered)).toEqual({ count: atBottom, first: "51:0" })
      await wheel(rendered, "up")
      const up = await until(rendered, (items) => last(items) < 250)
      expect(last(up)).toBeLessThan(250)
      await wheel(rendered, "down")
      expect(last(await until(rendered, (items) => last(items) === 250))).toBe(250)
      expect(first(bottom)).toBeGreaterThan(51)

      // Up to the window's first item, then once more past the top: the 50 before it load, and
      // the item that was at the top stays in view.
      for (let i = 0; i < 1000 && mountedIn(rendered).count === atBottom; i++) {
        await wheel(rendered, "up")
      }
      expect(mountedIn(rendered)).toEqual({ count: 250, first: "1:0" })
      const kept = await until(rendered, (items) => items.includes(51))
      expect(kept).toContain(51)
      expect(kept).not.toContain(1)
    })
  }, 60_000)

  test("PgUp past the top loads the items before the window too", async () => {
    await scrolling(250, async (rendered) => {
      await until(rendered, (items) => last(items) === 250)
      for (let i = 0; i < 200 && mountedIn(rendered).count === atBottom; i++) {
        await press(rendered, pageUp)
      }
      expect(mountedIn(rendered)).toEqual({ count: 250, first: "1:0" })
    })
  }, 60_000)
})
