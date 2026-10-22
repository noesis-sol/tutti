// The Interview view in a narrow pane (§ 4.10, § 7.5; tutti-sa72): as the worker view's, its header
// wraps the description's whole first line onto more lines, and its hint every key, rather than cut
// them.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { interviewWorker } from "../src/agent/interview.ts"
import { Filing } from "../src/agent/interviewTools.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { interviewCard, interviewView } from "../src/run/interview.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { InterviewContext } from "../src/ui/InterviewView.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const description =
  "Add a --json flag to list that prints every ticket as one JSON object\nThe table stays."

const said = (words: string) =>
  ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

const items: ReadonlyArray<Item> = [
  {
    v: transcriptVersion,
    seq: 1,
    session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
    time: "2026-10-20T13:00:00.000Z",
    message: said("Should it sit beside the table?"),
  },
]

/** A feed with the interview's transcript fixed at `items`. */
const feed: TranscriptFeed = {
  open: (ticket): OpenTranscript => ({
    state: external<TranscriptState>({
      ...emptyTranscript,
      window: windowOf(ticket === interviewWorker ? items : []),
    }),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
}

/** The Interview view at `width` columns. */
const narrow = async (width: number, body: (rendered: Rendered) => Promise<void>) => {
  const shell: ShellValue = {
    view: external(interviewView(interviewCard(description, began, WS.Idle({ at: began }), []))),
    screen: external<Screen>(Screen.Interview()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 67_000,
    transcripts: feed,
  }
  await withRender(
    <InterviewContext.Provider value={{ description, filing: external(Filing.None()) }}>
      <Root value={shell} />
    </InterviewContext.Provider>,
    { width, height: 20 },
    body,
  )
}

const shownOf = (frame: Frame): string =>
  `\n${frame.chars
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n")}\n`

const until = async (rendered: Rendered, text: string): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (frame.chars.includes(text) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

describe("the Interview view in a narrow pane", () => {
  test("at 50 columns the header wraps the whole first line, the hint every key", async () => {
    await narrow(50, async (rendered) => {
      const frame = await until(rendered, "beside the table")
      expect(shownOf(frame)).toMatchInlineSnapshot(`
        "
         ← Back   •  Interview  your turn  1m07s   Add a
            --json flag to list that prints every ticket
            as one JSON object
        ──────────────────────────────────────────────────
          Should it sit beside the table?
        ──────────────────────────────────────────────────
         > i to answer
          Esc back · i answer · ↑↓ select · Enter expand
          PgUp/PgDn scroll · ? keys
        "
      `)
    })
  })
})
