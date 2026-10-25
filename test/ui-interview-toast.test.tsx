// Toasts over the Interview view (§ 4.10, § 7.3; tutti-fgwf, tutti-fknd): Ctrl+Z's toast is drawn
// on the rule over the composer, above the composer and the hint's lines however many it wraps
// onto (ViewHint, underToasts), and opaque, so the rule doesn't show through its spaces.
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
import { cut, seg } from "../src/ui/line.tsx"
import { suspendToast } from "../src/ui/Toasts.tsx"
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
const description = "Add a --json flag to list.\nThe table stays."

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

/** The Interview view at `width` columns, 20 rows. */
const interviewAt = async (width: number, body: (rendered: Rendered) => Promise<void>) => {
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

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

const until = async (rendered: Rendered, text: string): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (frame.chars.includes(text) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

/** Ctrl+Z's toast as drawn `width` columns wide: cut to the room a column each side leaves. */
const toastAt = (width: number): string =>
  cut([seg(` ${suspendToast} `)], width - 2)
    .map((each) => each.text)
    .join("")
    .trim()

describe("a toast over the Interview view", () => {
  test("at 50 columns it is drawn on the rule, above the composer and the hint's two lines", async () => {
    await interviewAt(50, async (rendered) => {
      await until(rendered, "beside the table")
      await rendered.input((setup) => setup.mockInput.pressKey("z", { ctrl: true }))
      const frame = await until(rendered, "can't be suspended")
      const lines = linesOf(frame)
      const hintAt = lines.findIndex((line) => line.startsWith("  Esc back"))
      expect(lines.slice(hintAt, hintAt + 2)).toEqual([
        "  Esc back · i answer · ↑↓ select · Enter expand",
        "  PgUp/PgDn scroll · ? keys",
      ])
      expect(lines[hintAt - 1]).toBe(" > i to answer")
      // The rule's row: none of its line shows through the toast's spaces.
      expect(lines[hintAt - 2]).toBe(`─ ${toastAt(50)}─`)
    })
  })

  test("at 80 columns, the hint one line, it is drawn on the rule over the composer", async () => {
    await interviewAt(80, async (rendered) => {
      await until(rendered, "beside the table")
      await rendered.input((setup) => setup.mockInput.pressKey("z", { ctrl: true }))
      const frame = await until(rendered, suspendToast)
      const lines = linesOf(frame)
      expect(lines[19]).toBe(
        "  Esc back · i answer · ↑↓ select · Enter expand · PgUp/PgDn scroll · ? keys",
      )
      expect(lines[18]).toBe(" > i to answer")
      expect(lines[17]).toBe(`──── ${suspendToast} ─`)
    })
  })
})
