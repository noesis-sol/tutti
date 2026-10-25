// What a worker view shows of its worker and what it does to it (§ 7.5), apart from how it is
// drawn: its card, kept once the worker has finished, what it consumes, whether the run holds your
// messages or a conflict waits for it, its transcript and the composer, and the commands the view's
// keys and buttons send: a message, Ctrl+X's interrupt and its question, Release, Hand it the
// conflict now, File as ticket, and leaving the view. The pieces in Head, Story and Panel take
// plain props from it.

import { useEffect, useRef } from "react"
import { MessageUuid } from "../../agent/AgentHost.ts"
import { settled as hasSettled } from "../../agent/WorkerState.ts"
import { UiCommand } from "../../run/commands.ts"
import { holdsMessages } from "../../run/held.ts"
import type { Resources } from "../../run/resources.ts"
import type { Card } from "../../run/runView.ts"
import type { TicketId } from "../../services/Beads.ts"
import { fileWords, finishedWords, interruptCommands } from "../Composer.tsx"
import { useFilingDesk } from "../filingDesk.tsx"
import { useCommands } from "../keyCommands.ts"
import { Box, useInput } from "../keys.ts"
import {
  type ComposerState,
  type TranscriptWindow,
  useComposer,
  useTranscriptWindow,
} from "../transcriptView.ts"
import { useCommand, useHandBacks, useRunViewPart } from "../useRunView.ts"

/** What the worker view's keys and buttons do to its worker. */
export interface WorkerCommands {
  /** Sends what you wrote; false, with a toast, once the worker has finished (tutti-ceo). */
  readonly send: (text: string) => boolean
  /** Ctrl+T, File as ticket: files what you wrote as a ticket, once it has finished (tutti-g0wd). */
  readonly fileAsTicket: () => void
  /** Ctrl+X: asks whether to interrupt the worker's turn. */
  readonly interrupt: () => void
  /** The interrupt question's answer: `y` interrupts the turn it names, its queued messages gone. */
  readonly answerInterrupt: (yes: boolean) => void
  /** Ctrl+R, Release: releases a steered worker. */
  readonly release: () => void
  /** Hand it the conflict now (§ 4.3). */
  readonly handBackNow: () => void
  /** Esc, ← Dashboard: back to the dashboard. */
  readonly close: () => void
}

/** A worker view's worker, as the view shows it. */
export interface WorkerScreen {
  /** Its card, the last seen once it has gone, so that the view still shows a worker just finished. */
  readonly card: Card | undefined
  /** What its worker consumes, the last seen kept as its card is (ResourceLine.tsx). */
  readonly resources: Resources | undefined
  /** Whether the worker has finished, its card gone: nothing is sent to it. */
  readonly finished: boolean
  /** Whether the run holds your messages, while its ticket waits to merge or merges (held.ts). */
  readonly holding: boolean
  /** Whether its ticket merges now, rather than waits to. */
  readonly merging: boolean
  readonly steered: boolean
  /** Whether a merge conflict waits for it, steered (§ 4.3). */
  readonly handBack: boolean
  readonly transcript: TranscriptWindow
  readonly composer: ComposerState
  readonly commands: WorkerCommands
}

/** The worker of `viewed`'s view, and what its keys and buttons send. */
export const useWorkerScreen = (viewed: TicketId): WorkerScreen => {
  // Its card alone: another worker's card or the load changing doesn't draw the view anew.
  const found = useRunViewPart((view) => view.cards.find((each) => each.ticket === viewed))
  const command = useCommand()
  const handBacks = useHandBacks()
  const last = useRef<Card | undefined>(found)
  if (found !== undefined) last.current = found
  const card = found ?? last.current
  const ticket = card?.ticket
  const foundResources = useRunViewPart((view) =>
    view.resources.find((each) => each.ticket === viewed),
  )
  const lastResources = useRef(foundResources)
  if (foundResources !== undefined) lastResources.current = foundResources
  const holding = found !== undefined && holdsMessages(found.phase)
  const transcript = useTranscriptWindow(
    ticket,
    found?.state != null && !hasSettled(found.state),
    holding,
    found === undefined,
  )
  const { sends } = transcript
  const composer = useComposer()
  const input = useInput()

  const send = (text: string) => {
    if (found === undefined) {
      input.toasts.show(finishedWords(viewed).toast)
      return false
    }
    const uuid = MessageUuid.draw()
    sends.sent({ uuid, ticket: found.ticket, text })
    command(UiCommand.SendMessage({ ticket: found.ticket, text, uuid }))
    return true
  }
  // The composer keeps what you typed until bd has it, and while it isn't filed. The desk keeps the
  // filing while bd answers, past the view: reopened, the composer has its text again (tutti-fgr2).
  const desk = useFilingDesk()
  // biome-ignore lint/correctness/useExhaustiveDependencies: once a view, as it opens
  useEffect(() => {
    const text = desk.opening(viewed)
    if (text !== "") composer.field.current?.setText(text)
    return desk.attach(viewed, composer.field)
  }, [desk, viewed])
  const fileAsTicket = () => {
    if (found !== undefined) return
    const text = composer.field.current?.plainText.trim() ?? ""
    if (text === "") return input.toasts.show(fileWords.nothing)
    if (desk.pending(viewed) !== undefined) return input.toasts.show(fileWords.already)
    const uuid = crypto.randomUUID()
    desk.ask(viewed, { uuid, text })
    command(UiCommand.FileTicket({ from: viewed, text, uuid }))
    input.toasts.show(fileWords.filing)
  }
  const interrupt = () => {
    if (found === undefined) return
    composer.blur()
    input.box.set(Box.Interrupt({ ticket: found.ticket }))
  }
  const answerInterrupt = (yes: boolean) => {
    const asked = input.box.get()
    if (asked?._tag !== "Interrupt") return
    input.box.set(null)
    composer.refocus()
    if (!yes) return
    sends.cancelled(asked.ticket)
    command(UiCommand.Interrupt({ ticket: asked.ticket }))
  }
  useCommands(
    "box",
    interruptCommands(
      () => answerInterrupt(true),
      () => answerInterrupt(false),
    ),
    "Interrupt",
  )
  // The view draws its Interrupt box and binds its keys: unmounted with it open, nothing would, and
  // the box would hold the keys of the view after it (tutti-por).
  useEffect(
    () => () => {
      if (input.box.get()?._tag === "Interrupt") input.box.set(null)
    },
    [input],
  )
  const release = () => {
    if (found?.steered === true) command(UiCommand.Release({ ticket: found.ticket }))
  }
  const handBackNow = () => {
    if (ticket !== undefined) command(UiCommand.HandBackNow({ ticket }))
  }
  const close = () => command(UiCommand.CloseWorker())
  return {
    card,
    resources: foundResources ?? lastResources.current,
    finished: found === undefined,
    holding,
    merging: found?.phase._tag === "Merging",
    steered: card?.steered === true,
    handBack: ticket !== undefined && handBacks.includes(ticket),
    transcript,
    composer,
    commands: { send, fileAsTicket, interrupt, answerInterrupt, release, handBackNow, close },
  }
}
