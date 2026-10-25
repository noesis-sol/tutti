// The worker view (§ 7.5, § 7.3, § 7.11): tutti's transcript of one worker, drawn by tutti, under
// orchestra-style chrome: `← Dashboard`, then the worker's card head (number, mark, ticket, status,
// elapsed time), the ticket's type and priority, and its title in bold, wrapped onto more lines in
// a narrow pane, then the resource line (ResourceLine.tsx: what the worker consumes; a click opens
// what it spent), and under it the ticket's description, or its whole ticket while `t` has it open
// (TicketHead.tsx), over a rule. Below the transcript, the attention panel shows the worker's open
// requests with the card's buttons and rules (attentionKeys.ts), each with its description, its
// reason and its whole input, and a conflict hand-back waiting for a steered worker (§ 4.3) as a
// notice with Hand it the conflict now. Answer in view, for what a card can't hold, opens the
// answer form over the view (AnswerForm.tsx). Under them and the rule, the composer (Composer.tsx):
// the held line while the ticket waits to merge or merges, the steered line with its Release
// button, your messages still queued or held, the field.
//
// The items (transcriptItems.ts): assistant text as Markdown (<markdown>, in the theme's heading,
// code and link roles); each tool call `Tool  summary`, wrapped, its result at the end of it (`✓`,
// an error's first line, `+N −M`); a message sent to the worker wrapped, `› ` before it. Enter or a
// click expands one: an edit's diff (<diff>), a command's output (<code>), a read's range, an Agent
// call's subagent work behind a faint `│`, a message's lines past the first `itemLines`.
// Thinking is hidden. While the view is open, its transcript's open flag is set, and partial text
// shows as it streams.
//
// Bounded rendering: the window of the transcript mounted is at most the last 200 items, sticking
// to the bottom while you're there; scrolling past the top (the wheel, PgUp, `g`) loads 200 older
// from the file, letting the newest beyond 600 go, and keeps your place. Collapsed items are a fixed
// height, their lines wrapped beforehand to the pane's width, at most `itemLines` (#1514).
//
// The keys, in the view's layer: `Tab`, `Shift+Tab` and the arrows move between the items and the
// panel's requests, and between a request's buttons; `Enter` expands or collapses the selected item
// or presses the focused button; `1`–`4` pick a question's option; `d`, `Shift+D`, `a` and `r`
// answer the selected request, or the oldest; PgUp/PgDn and `g`/`G` scroll; `i` or a click focuses
// the composer; `t` or a click on `▾ whole ticket` opens the whole ticket, which PgUp/PgDn then
// scroll, and `t`, a click on `▴ less` or `Esc` closes it; `Ctrl+X` asks, then interrupts the
// worker's turn; `Ctrl+R` releases a steered worker; once the worker has finished, `Ctrl+T` files
// the composer's text as a ticket; `Esc` leaves the composer, then closes the whole ticket, then
// goes back to the dashboard, as a click on `← Dashboard` does. No key switches workers: `Tab` is
// the items', so another worker is opened from the dashboard (§ 7.3). While you write in the
// composer, it takes the printable keys, `t` too, Enter and the arrows; PgUp/PgDn, Ctrl+X, Ctrl+R,
// Ctrl+T and Esc still work.
//
// The transcript, the panel, the selection, the composer and the keys are shared with the
// Interview view (transcriptView.ts), as are the head, the pane, the panel and the hint below.
//
// Branding (§ 7.5): tutti's own glyphs and layout, and the scheme's colours; the chrome names
// neither Claude nor its product.
import { useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import type { TicketId } from "../services/Beads.ts"
import { stack } from "./allot.ts"
import {
  Composer,
  FinishedLine,
  finishedWords,
  heldLine,
  InterruptQuestion,
  QueuedLines,
  queuedLines,
  SteeredLine,
} from "./Composer.tsx"
import { hintLines } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { type Command, type HelpRow, hintOf, useCommands } from "./keyCommands.ts"
import { useInput } from "./keys.ts"
import { Line, Lines, Section, type Segments, seg } from "./line.tsx"
import { ResourceLine, spentLines } from "./ResourceLine.tsx"
import {
  DescriptionView,
  descriptionLimit,
  descriptionLines,
  panelLines,
  TicketPanelView,
  useTicketPanel,
} from "./TicketHead.tsx"
import { useLinesUnderToasts } from "./Toasts.tsx"
import {
  inertTranscript,
  type TranscriptActions,
  transcriptCommands,
  usePanel,
  useSelection,
  useTranscriptKeys,
} from "./transcriptView.ts"
import { useTheme } from "./useRunView.ts"
import { WorkerHead } from "./worker/Head.tsx"
import { LooksContext, useSyntaxStyles } from "./worker/Looks.tsx"
import { handBackLines, RequestPanel, usePanelRooms } from "./worker/Panel.tsx"
import { TranscriptPane, TranscriptSection } from "./worker/Story.tsx"
import { useWorkerScreen } from "./worker/useWorkerScreen.ts"

export { entryId, panelRequests, requestKey, selectable } from "./transcriptView.ts"

/** The rows the transcript keeps over the request panel, however tall the panel's requests. */
export const transcriptRows = 3

/**
 * The lines of a transcript view's parts but the transcript and the request panel: the head, the
 * ticket under it, the hand-back notice, the held line, the finished or steered line, the queued
 * messages, the composer and the hint. The Interview view has no ticket, hand-back, held or steered
 * line.
 */
export interface ViewChrome {
  readonly head: number
  /**
   * The worker view's resource line under the head (ResourceLine.tsx), none in the Interview view:
   * a short pane gives it up before the request panel's lines, so it is left out of panelBudget.
   */
  readonly resources: number
  /** The ticket's description under the head, or its whole ticket while that is open (§ 7.5). */
  readonly ticket: number
  readonly handBack: number
  readonly held: number
  readonly line: number
  readonly queued: number
  readonly composer: number
  readonly hint: number
}

/** A transcript view's lines, part by part, adding up to the pane's (viewLayout). */
export interface ViewLayout extends ViewChrome {
  /** The rules under the head and over the composer's lines: a line each. */
  readonly rules: readonly [number, number]
  readonly transcript: number
  readonly panel: number
}

/** The rules' lines, under the head and over the composer's. */
const ruleLines = 2

/**
 * The lines the request panel may take in a pane `height` tall: what `chrome`, the rules and the
 * transcript's `transcriptRows` leave it (tutti-7nzv).
 */
export const panelBudget = (height: number, chrome: ViewChrome): number => {
  const { resources: _, ...rest } = chrome
  return (
    height -
    ruleLines -
    transcriptRows -
    Object.values(rest).reduce((sum: number, lines: number) => sum + lines, 0)
  )
}

/**
 * A transcript view's lines in a pane `height` tall, handed out in priority order, each part as
 * many as it needs of what is left, so that they add up to `height`: the hint, the head, the
 * rules, the composer, the finished or steered line, the held line, the queued messages, the
 * hand-back notice and the ticket, then the transcript's `transcriptRows`, then the `panel` lines
 * the request panel takes (panelBudget's at most, but for one request too tall for it), then the
 * resource line, and the transcript the rest.
 */
export const viewLayout = (height: number, chrome: ViewChrome, panel: number): ViewLayout => {
  const { ruleUnder, ruleOver, ...laid } = stack(
    height,
    [
      ["hint", chrome.hint],
      ["head", chrome.head],
      ["ruleUnder", 1],
      ["ruleOver", 1],
      ["composer", chrome.composer],
      ["line", chrome.line],
      ["held", chrome.held],
      ["queued", chrome.queued],
      ["handBack", chrome.handBack],
      ["ticket", chrome.ticket],
      ["transcript", transcriptRows],
      ["panel", panel],
      ["resources", chrome.resources],
    ],
    "transcript",
  )
  return { ...laid, rules: [ruleUnder, ruleOver] }
}

/** The selection key of the hand-back notice. */
const handBackKey = "handback"

/** Where the worker view's keys are: what its hint names depends on it. */
export interface WorkerViewAt {
  /** Whether the panel has requests open. */
  readonly requests: boolean
  /** Whether you write in the composer now: the hint names the composer's keys. */
  readonly composing: boolean
  readonly steered: boolean
  /** Whether the worker has finished: nothing is sent to it, and Ctrl+T files what you wrote. */
  readonly finished: boolean
  /** Whether the whole ticket is open (TicketHead.tsx): `t` or `Esc` closes it. */
  readonly ticketOpen?: boolean
}

/** What the worker view's keys do: the transcript's, and its own. */
export interface WorkerViewActions extends TranscriptActions {
  readonly interrupt: () => void
  readonly release: () => void
  readonly fileAsTicket: () => void
  /** `t`: opens or closes the whole ticket. */
  readonly ticket: () => void
}

const nothing = () => {}

/** Keys that do nothing, for the hint as the layout counts it, before the keys are bound. */
const inertWorkerView: WorkerViewActions = {
  ...inertTranscript,
  interrupt: nothing,
  release: nothing,
  fileAsTicket: nothing,
  ticket: nothing,
}

const writeRow: HelpRow = [
  "i, a click on the composer",
  "write to the worker; Enter sends, Alt+Enter or Ctrl+J a new line",
]
const moveRow: HelpRow = [
  "Tab, Shift+Tab, arrows",
  "move between items; between a request's buttons",
]
const denyRow: HelpRow = ["d, Shift+D", "deny the request; deny with a reason"]
const scrollRow: HelpRow = [
  "the wheel, PgUp/PgDn",
  "scroll; past the top loads earlier items; the whole ticket, open",
]
const jumpRow: HelpRow = ["g, G", "jump to the top or the end"]
const pickRow: HelpRow = ["1–4 in a question", "pick an option"]

/**
 * The worker view's keys (§ 7.3), its hint's and its key help's: the keys there are; the composer's
 * while you write in it. Once the worker has `finished`, nothing is sent to it, so the hint has no
 * Enter send, Ctrl+X or Ctrl+R (tutti-2n7y), and has Ctrl+T, which files what you typed as a
 * ticket (tutti-g0wd). `t` opens the whole ticket; while it is open, `t/Esc` closes it.
 */
export const workerViewCommands = (
  at: WorkerViewAt,
  act: WorkerViewActions = inertWorkerView,
): ReadonlyArray<Command> => {
  const keys = transcriptCommands(act)
  const viewing = !at.composing
  const named = (shown: boolean, keys: string, does: string) => (shown ? { keys, does } : undefined)
  return [
    // The composer's own keys, which its field binds.
    {
      keys: [],
      run: nothing,
      hint: named(at.composing && !at.finished, "Enter", "send"),
      help: writeRow,
    },
    {
      keys: [],
      run: nothing,
      hint: named(at.composing, "Alt+Enter/Ctrl+J", "new line"),
      help: writeRow,
    },
    {
      ...keys.escape,
      hint: at.composing
        ? { keys: "Esc", does: "leave" }
        : at.ticketOpen === true
          ? { keys: "t/Esc", does: "less" }
          : { keys: "Esc", does: "dashboard" },
      help: [
        "Esc, ← Dashboard",
        "leave the composer; close the whole ticket; back to the dashboard",
      ],
    },
    // Esc, then the dashboard's keys: the view has no key of its own for it (§ 7.3).
    {
      keys: [],
      run: nothing,
      help: ["Esc, Tab, Enter", "switch workers, by way of the dashboard"],
    },
    // A click on the resource line opens the whole ticket at what the worker spent (ResourceLine.tsx).
    {
      keys: [],
      run: nothing,
      help: ["a click on resources", "the whole ticket at Spent: tokens, calls, dollars, context"],
    },
    { ...keys.write, hint: named(viewing, "i", "write"), help: writeRow },
    {
      keys: ["t"],
      run: act.ticket,
      hint: named(viewing && at.ticketOpen !== true, "t", "ticket"),
      help: ["t, ▾ whole ticket", "the whole ticket; t, ▴ less or Esc closes it"],
    },
    { ...keys.deny, hint: named(viewing && at.requests, "d", "deny"), help: denyRow },
    { ...keys.denyWithReason, help: denyRow },
    { ...keys.allow, help: ["a", "allow the request, unless it opens on Deny"] },
    { ...keys.forRun, help: ["r", "allow for this run"] },
    {
      keys: ["ctrl+x"],
      run: act.interrupt,
      hint: named(!at.finished, "Ctrl+X", "interrupt"),
      help: ["Ctrl+X", "interrupt the worker's turn (asks first)"],
    },
    {
      keys: ["ctrl+r"],
      run: act.release,
      hint: named(at.steered && !at.finished, "Ctrl+R", "release"),
      help: ["Ctrl+R, Release", "release a steered worker"],
    },
    {
      keys: ["ctrl+t"],
      run: act.fileAsTicket,
      hint: named(at.finished, "Ctrl+T", "file as ticket"),
      help: [
        "Ctrl+T, File as ticket",
        "once the worker has finished, file what you wrote as a ticket",
      ],
    },
    { ...keys.down, hint: named(viewing, "↑↓", "select"), help: moveRow },
    { ...keys.up, help: moveRow },
    { ...keys.next, help: moveRow },
    { ...keys.previous, help: moveRow },
    {
      ...keys.enter,
      hint: named(viewing, "Enter", "expand"),
      help: ["Enter, a click", "expand or collapse the item; press the focused button"],
    },
    { ...keys.help, hint: named(viewing, "?", "keys"), help: ["?", "these keys"] },
    { ...keys.pageUp, hint: named(viewing, "PgUp/PgDn", "scroll"), help: scrollRow },
    { ...keys.pageDown, help: scrollRow },
    { ...keys.top, hint: named(viewing, "g/G", "top/end"), help: jumpRow },
    { ...keys.end, help: jumpRow },
    ...keys.picks.map((pick) => ({ ...pick, help: pickRow })),
    {
      keys: [],
      run: nothing,
      help: ["Answer in view", "the answer form: ↑↓ move, Space picks, Enter presses"],
    },
  ]
}

/**
 * The lines a transcript view draws under its toasts, as `laid` gives them: what you write or are
 * about to send, from the rule over it down (the held line, the finished or steered line, the
 * queued messages, the composer) and the hint (tutti-fknd). The first toast sits on the rule.
 */
export const underToasts = (laid: ViewLayout): number =>
  laid.held + laid.line + laid.queued + laid.composer + laid.hint

/**
 * A view's hint, its `lines` as hintLines wraps every key onto them; toasts go above the view's
 * last `under` lines (underToasts).
 */
export const ViewHint = ({
  lines,
  under,
}: {
  readonly lines: ReadonlyArray<Segments>
  readonly under: number
}) => {
  const input = useInput()
  useLinesUnderToasts(input.toasts, under)
  return <Lines lines={lines} />
}

/** The view of the ticket's worker, while the run shows it. */
export const WorkerView = ({ ticket: viewed }: { readonly ticket: TicketId }) => {
  const screen = useWorkerScreen(viewed)
  const { card, resources, finished, holding, steered, handBack, transcript, composer, commands } =
    screen
  const theme = useTheme()
  const looks = useSyntaxStyles(theme)
  const { width, height } = useTerminalDimensions()
  const { sends } = transcript
  const inner = Math.max(width, 1)
  const panelWidth = Math.max(inner - 2, 8)
  const queued = queuedLines(sends.queued, theme, inner, sends.mark)
  // The panel has the height the view's other parts leave it, and a few of the transcript's
  // (tutti-7nzv), the hint as it is with requests.
  const [headLines, setHeadLines] = useState(1)
  // The ticket under the head (TicketHead.tsx): its description, or its whole ticket while open,
  // two columns in.
  const ticketPanel = useTicketPanel(viewed)
  const issue = card?.issue
  const ticketWidth = Math.max(inner - 2, 1)
  const description = useMemo(
    () =>
      issue === undefined
        ? null
        : descriptionLines(issue, theme, ticketWidth, descriptionLimit(height)),
    [issue, theme, ticketWidth, height],
  )
  // The whole ticket's last section: what its worker spent, which a click on the resource line
  // opens the panel scrolled to.
  const spent = useMemo(
    () =>
      resources === undefined ? null : spentLines(resources, theme, Math.max(ticketWidth - 4, 1)),
    [resources, theme, ticketWidth],
  )
  const ticketLines =
    card === undefined
      ? 0
      : ticketPanel.open
        ? panelLines(issue, height, ticketWidth, spent?.length ?? 0)
        : (description?.lines.length ?? 0)
  const at = (requests: boolean): WorkerViewAt => ({
    requests,
    composing: composer.typing,
    steered,
    finished,
    ticketOpen: ticketPanel.open,
  })
  // The hint's lines with requests, for the panel's room, and as they are: each worked out once.
  const hintWith = (requests: boolean) =>
    hintLines(hintOf(workerViewCommands(at(requests))), theme, inner)
  const askedHint = hintWith(true)
  // The hand-back notice's lines, unselected: the selection draws them again only to show it.
  const handBackDrawn = handBack ? handBackLines(theme, { width: panelWidth, selected: false }) : []
  const chrome = (hint: ReadonlyArray<Segments>): ViewChrome => ({
    head: headLines,
    resources: resources === undefined ? 0 : 1,
    ticket: ticketLines,
    handBack: handBackDrawn.length,
    held: holding ? 1 : 0,
    line: finished || steered ? 1 : 0,
    queued: queued.length,
    composer: composer.lines,
    hint: hint.length,
  })
  const fit = usePanelRooms(theme, panelWidth, panelBudget(height, chrome(askedHint)), height)
  // The requests open now: a finished worker's card, kept for its head, has none.
  const panel = usePanel(
    finished ? undefined : card,
    (requests, waiting) => fit.rooms(requests, waiting - requests.length).length,
  )
  const requests = panel.requests.length > 0
  const hint = requests ? askedHint : hintWith(false)
  const laid = viewLayout(height, chrome(hint), fit.lines(panel.requests, panel.more))
  const selection = useSelection(transcript, panel, handBack ? [handBackKey] : [])
  const { help, actions, unlessHelp } = useTranscriptKeys({
    transcript,
    panel,
    selection,
    composer,
    // Esc closes the whole ticket before it leaves the view.
    back: () => (ticketPanel.open ? ticketPanel.close() : commands.close()),
    enter: () => (selection.current() === handBackKey ? commands.handBackNow() : selection.enter()),
    page: (step) => (ticketPanel.open ? ticketPanel.page(step) : transcript.page(step)),
  })
  const keys = useCommands(
    "view",
    workerViewCommands(at(requests), {
      ...actions,
      interrupt: unlessHelp(commands.interrupt),
      release: unlessHelp(commands.release),
      fileAsTicket: unlessHelp(commands.fileAsTicket),
      ticket: unlessHelp(ticketPanel.toggle),
    }),
  )

  const rule: Segments = [seg("─".repeat(inner), theme.look("frame"))]
  const { box } = composer
  return (
    <LooksContext.Provider value={looks}>
      <box flexDirection="column" width={width} height={height}>
        <Section lines={laid.head}>
          <WorkerHead
            ticket={viewed}
            card={card}
            finished={finished}
            leave={commands.close}
            width={inner}
            counted={setHeadLines}
          />
        </Section>
        <Section lines={laid.resources}>
          {resources === undefined ? null : (
            <ResourceLine
              resources={resources}
              memory={card?.memory}
              finished={finished}
              width={inner}
              open={ticketPanel.openSpent}
            />
          )}
        </Section>
        <Section lines={laid.ticket}>
          <box paddingLeft={2} flexDirection="column" height={laid.ticket} flexShrink={0}>
            {ticketPanel.open ? (
              <TicketPanelView
                issue={issue}
                spent={spent}
                panel={ticketPanel}
                looks={looks}
                width={ticketWidth}
                lines={laid.ticket}
              />
            ) : description === null ? null : (
              <DescriptionView lines={description} open={ticketPanel.toggle} />
            )}
          </box>
        </Section>
        <Section lines={laid.rules[0]}>
          <Line segments={rule} />
        </Section>
        <TranscriptSection lines={laid.transcript}>
          <TranscriptPane transcript={transcript} selection={selection} width={inner} />
        </TranscriptSection>
        <Section lines={laid.handBack}>
          <Lines
            lines={
              selection.selected === handBackKey
                ? handBackLines(theme, { width: panelWidth, selected: true })
                : handBackDrawn
            }
            press={commands.handBackNow}
          />
        </Section>
        <Section lines={laid.panel}>
          <RequestPanel
            panel={panel}
            selection={selection}
            width={panelWidth}
            rooms={fit.rooms(panel.requests, panel.more)}
          />
        </Section>
        <Section lines={laid.rules[1]}>
          <Line segments={rule} />
        </Section>
        <Section lines={laid.held}>
          <Line segments={heldLine(theme, viewed, screen.merging, inner)} />
        </Section>
        <Section lines={laid.line}>
          {finished ? (
            <FinishedLine
              theme={theme}
              ticket={viewed}
              width={inner}
              file={commands.fileAsTicket}
            />
          ) : (
            <SteeredLine theme={theme} width={inner} release={commands.release} />
          )}
        </Section>
        <Section lines={laid.queued}>
          <QueuedLines lines={queued} />
        </Section>
        <Section lines={laid.composer}>
          <Composer
            theme={theme}
            field={composer.field}
            lines={composer.lines}
            setLines={composer.setLines}
            focused={composer.typing}
            focus={() => composer.setComposing(true)}
            send={commands.send}
            {...(finished ? { placeholder: () => finishedWords(viewed).placeholder } : {})}
          />
        </Section>
        <Section lines={laid.hint}>
          <ViewHint lines={hint} under={underToasts(laid)} />
        </Section>
        {help ? <KeyHelp theme={theme} width={width} height={height} keys={keys.help} /> : null}
        {box?._tag === "Interrupt" ? (
          <InterruptQuestion
            theme={theme}
            ticket={box.ticket}
            yes={() => commands.answerInterrupt(true)}
            no={() => commands.answerInterrupt(false)}
          />
        ) : null}
      </box>
    </LooksContext.Provider>
  )
}
