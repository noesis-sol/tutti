// The view's side of filing a finished worker's message as a ticket (§ 7.5, tutti-g0wd): the
// filings the worker views asked for that bd hasn't answered, and the texts bd refused once their
// view had gone, kept around the screens, so that they outlive the view they were written in
// (tutti-fgr2). Leave the view before bd answers, and the toast still says how it went; reopen it,
// and the composer has the text again, and Ctrl+T waits for the filing still under way.
import type { TextareaRenderable } from "@opentui/core"
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useState,
} from "react"
import type { TicketFiling } from "../run/fileTicket.ts"
import { fileWords } from "./Composer.tsx"
import { useInput } from "./keys.ts"
import type { ToastStore } from "./Toasts.tsx"
import { useFilings } from "./useRunView.ts"

/** A filing a view asked for, by the uuid it drew, and the text it files. */
export interface AskedFiling {
  readonly uuid: string
  readonly text: string
}

/** The filings the worker views asked for, kept while bd answers them. */
export interface FilingDesk {
  /** The filing `ticket`'s view asked for that bd hasn't answered, if any. */
  readonly pending: (ticket: string) => AskedFiling | undefined
  /** Records the filing `ticket`'s view asked for. */
  readonly ask: (ticket: string, asked: AskedFiling) => void
  /**
   * The text `ticket`'s composer opens with: the text still being filed, or the one bd refused
   * while its view was gone, which it gives once; "" with neither.
   */
  readonly opening: (ticket: string) => string
  /** Attaches the composer of `ticket`'s view while it's open: the detach it returns lets it go. */
  readonly attach: (ticket: string, field: RefObject<TextareaRenderable | null>) => () => void
  /**
   * Settles the pending filings `filings` say bd has answered: `toasts` says how each went; the
   * composer of its view, if open, is emptied of the text filed; a text refused with its view gone
   * is kept for the view's next opening.
   */
  readonly settle: (filings: ReadonlyArray<TicketFiling>, toasts: ToastStore) => void
}

/** An empty FilingDesk. */
export const makeFilingDesk = (): FilingDesk => {
  const pending = new Map<string, AskedFiling>()
  const refused = new Map<string, string>()
  const composers = new Map<string, RefObject<TextareaRenderable | null>>()
  return {
    pending: (ticket) => pending.get(ticket),
    ask: (ticket, asked) => {
      pending.set(ticket, asked)
      refused.delete(ticket)
    },
    opening: (ticket) => {
      const asked = pending.get(ticket)
      if (asked !== undefined) return asked.text
      const text = refused.get(ticket) ?? ""
      refused.delete(ticket)
      return text
    },
    attach: (ticket, field) => {
      composers.set(ticket, field)
      return () => {
        if (composers.get(ticket) === field) composers.delete(ticket)
      }
    },
    settle: (filings, toasts) => {
      for (const [ticket, asked] of [...pending]) {
        const done = filings.find((each) => each.uuid === asked.uuid)
        if (done === undefined) continue
        pending.delete(ticket)
        const composer = composers.get(ticket)
        if (done.outcome._tag === "NotFiled") {
          if (composer === undefined) refused.set(ticket, asked.text)
          toasts.show(fileWords.notFiled(done.outcome.why), { failure: true })
          continue
        }
        // What you typed since is yours: only the text filed is emptied.
        const box = composer?.current ?? null
        if (box !== null && box.plainText.trim() === asked.text) box.setText("")
        toasts.show(fileWords.filed(done.outcome.id, done.outcome.title))
      }
    },
  }
}

const FilingDeskContext = createContext<FilingDesk | null>(null)

/** The FilingDesk around the screens. */
export const useFilingDesk = (): FilingDesk => {
  const desk = useContext(FilingDeskContext)
  if (desk === null) throw new Error("tutti's worker view is drawn outside its FilingDesk")
  return desk
}

/** `children` with a FilingDesk, settled as the run's filings come, inside the Input provider. */
export const FilingDeskProvider = ({ children }: { readonly children: ReactNode }) => {
  const [desk] = useState(makeFilingDesk)
  const filings = useFilings()
  const { toasts } = useInput()
  useEffect(() => desk.settle(filings, toasts), [desk, filings, toasts])
  return <FilingDeskContext.Provider value={desk}>{children}</FilingDeskContext.Provider>
}
