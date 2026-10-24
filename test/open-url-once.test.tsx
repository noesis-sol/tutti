// Open URL pressed again while the opener runs (§ 4.5): the second press is ignored, so it opens no
// second tab and sends no second Accept; once the open has resolved, a press opens it again.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import type { Opened, UrlOpener } from "../src/ui/openUrl.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Rendered, withRender } from "./render.ts"

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const url = "https://docs.example/login"

const elicitation: AttentionRequest = {
  id: "e1",
  ticket: "t-1",
  kind: {
    _tag: "Elicitation",
    server: "docs",
    message: "Log in to the docs server",
    mode: "url",
    url,
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
}

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const viewOf = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  project({
    ledger: {
      tickets: new Map([
        [
          "t-1",
          {
            ticket: "t-1",
            title: "Title of t-1",
            phase: TicketPhase.Working({ activity: "working" }),
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
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

/** A UrlOpener whose every open waits for the test to say how it went. */
const heldOpener = () => {
  const urls: Array<string> = []
  let finish: (how: Opened) => void = () => {}
  const opener: UrlOpener = {
    open: (opened) => {
      urls.push(opened)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  }
  return { opener, urls, finish: (how: Opened) => finish(how) }
}

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

/**
 * The dashboard over a URL elicitation with `opener`, settled and Open URL focused; runs `body`
 * with the commands sent, the rendered tree and Enter, which presses Open URL.
 */
const onOpenUrl = async (
  opener: UrlOpener,
  body: (at: {
    readonly commands: Commands
    readonly rendered: Rendered
    readonly press: () => Promise<void>
  }) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  let at = began
  const value = {
    view: external(viewOf([elicitation])),
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => at,
    urlOpener: opener,
  }
  await withRender(<Root value={value} />, { width: 80, height: 40 }, async (rendered) => {
    at += settle
    await rendered.input((setup) => setup.mockInput.pressTab())
    const press = () => rendered.input((setup) => setup.mockInput.pressEnter())
    await body({ commands, rendered, press })
  })
}

const accept = UiCommand.Answer({ requestId: "e1", answer: { _tag: "Accept" } })

describe("Open URL pressed again", () => {
  test("while the URL opens opens no second tab and sends one Accept", async () => {
    const held = heldOpener()
    await onOpenUrl(held.opener, async ({ commands, rendered, press }) => {
      await press()
      await press()
      await press()
      expect(held.urls).toEqual([url])
      await rendered.input(() => held.finish("opened"))
      expect(taken(commands)).toEqual([accept])
    })
  })

  test("once the open has failed opens the URL again", async () => {
    const held = heldOpener()
    await onOpenUrl(held.opener, async ({ commands, rendered, press }) => {
      await press()
      await rendered.input(() => held.finish("failed"))
      expect(taken(commands)).toEqual([])
      await press()
      expect(held.urls).toEqual([url, url])
      await rendered.input(() => held.finish("opened"))
      expect(taken(commands)).toEqual([accept])
    })
  })
})
