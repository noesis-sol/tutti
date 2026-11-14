// The worker view scrolled back stays where you put it when its scroll range shrinks (§ 7.5): a
// taller pane clamps the scrollbox to its new end, which OpenTUI took for a scroll back to the
// bottom, so it followed the next item in again (#1514, fixed in OpenTUI 0.8.0).

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Scope } from "effect"
import { Transcripts, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import { Root } from "../src/ui/App.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { transcriptFeed } from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 3, 13, 0, 0).getTime()
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

const last = (items: ReadonlyArray<number>) => items.at(-1) ?? 0

describe("a shrinking scroll range", () => {
  test("a taller pane, scrolled back, keeps the place as new items come", async () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({
        v: transcriptVersion,
        seq: i + 1,
        session,
        time: "2026-11-03T13:00:00.000Z",
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
      await withRender(<Root value={shell} />, { width: 60, height: 20 }, async (rendered) => {
        rendered.setup.renderer.maxFps = 1000
        await until(rendered, (items) => last(items) === 60)
        // A wheel turn back: a few lines up, fewer than the pane is about to grow by.
        await rendered.input((setup) => setup.mockMouse.scroll(20, 8, "up"))
        const back = await until(rendered, (items) => last(items) < 60)
        expect(last(back)).toBeLessThan(60)
        // The pane grows by 10 rows: the scroll range shrinks under the place, clamping it to the
        // new end, which a reader's scroll there would also reach.
        await rendered.input((setup) => setup.resize(60, 30))
        const clamped = await until(rendered, (items) => items.length > back.length)
        expect(last(clamped)).toBe(60)
        // New items come and are mounted below: the view stays where the clamp left it, not
        // following them in, until you scroll to the bottom yourself.
        for (let n = 61; n <= 66; n++) {
          await rendered.input(() =>
            Effect.runPromise(transcripts.record("t-1", { session, message: said(`item ${n}`) })),
          )
          await rendered.input(() => Bun.sleep(30))
          expect(shownItems(await rendered.capture())).toEqual(clamped)
        }
        await rendered.input(async (setup) => {
          for (let i = 0; i < 20; i++) await setup.mockMouse.scroll(20, 8, "down")
        })
        expect(last(await until(rendered, (items) => last(items) === 66))).toBe(66)
        // Back at the bottom, it follows again.
        await rendered.input(() =>
          Effect.runPromise(transcripts.record("t-1", { session, message: said("item 67") })),
        )
        expect(last(await until(rendered, (items) => last(items) === 67))).toBe(67)
      })
    } finally {
      Effect.runSync(Scope.close(scope, Exit.void))
    }
  }, 30_000)
})
