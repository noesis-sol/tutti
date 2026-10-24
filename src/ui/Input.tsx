// The input layers around the screen (§ 7.3): the renderer's keymap, the guards in front of it
// (split mouse reports, a lone Esc, unterminated pastes), the keys every view has (Ctrl+C, Ctrl+Z)
// and what they open over the view: the box open (the quit box, the stop question, the Answer and
// reason boxes of attention cards, the answer form, a worker view's interrupt question), and the
// toasts. A drag's selection is drawn in the theme's selection roles and copied on release
// (clipboard.ts).
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { useRenderer } from "@opentui/react"
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { UiCommand } from "../run/commands.ts"
import { AnswerForm, AnswerFormKeys } from "./AnswerForm.tsx"
import { AnswerBox, ReasonBox, ReasonKeys } from "./AttentionCard.tsx"
import { useCopyOnSelect } from "./clipboard.ts"
import { globalCommands, useCommands } from "./keyCommands.ts"
import { Box, guardInput, InputContext, type InputState, useInput } from "./keys.ts"
import { SelectionLook, selectionLookOf } from "./line.tsx"
import { QuitBox, QuitKeys } from "./QuitBox.tsx"
import { StopKeys, StopQuestion } from "./StopQuestion.tsx"
import { makeToasts, suspendToast, type Timer, Toasts } from "./Toasts.tsx"
import { external, useCommand, useTheme } from "./useRunView.ts"

/** Ctrl+C and Ctrl+Z, over every layer, in every view. */
const GlobalKeys = () => {
  const input = useInput()
  const command = useCommand()
  useCommands(
    "always",
    globalCommands({
      // The quit box; a second Ctrl+C, the box still open, quits now (D15).
      quit: () => {
        if (input.box.get()?._tag === "Quit") {
          input.box.set(null)
          command(UiCommand.Quit({ now: true }))
        } else input.box.set(Box.Quit())
      },
      // tutti can't be suspended: SIGTSTP is ignored, and in raw mode Ctrl+Z is a key (D18).
      suspend: () => input.toasts.show(suspendToast),
    }),
  )
  return null
}

/** A drag's selection, copied on release (§ 7.3). */
const CopyOnSelect = ({ input }: { readonly input: InputState }) => {
  useCopyOnSelect(input.toasts)
  return null
}

/** The box open over the view. */
const OpenBox = ({ input }: { readonly input: InputState }) => {
  const box = useSyncExternalStore(input.box.subscribe, input.box.get)
  if (box === null) return null
  switch (box._tag) {
    case "Quit":
      return <QuitBox />
    case "Stop":
      return <StopQuestion windingDown={box.windingDown} />
    case "Answer":
    case "Interrupt":
    case "Leave":
      // The Answer box is mounted throughout, its keys bound before it opens: it draws itself, as
      // the worker view draws its interrupt question and the Interview view its leave question.
      return null
    case "Reason":
      return <ReasonBox requestId={box.requestId} ticket={box.ticket} label={box.label} />
    case "Form":
      return <AnswerForm requestId={box.requestId} ticket={box.ticket} />
  }
}

/**
 * `children` with the input layers: a keymap on the renderer, its guards, the global keys, copying
 * a drag's selection, the box open and the toasts. `pasteLimit` and `toastTimer` are the tests'.
 */
export const Input = ({
  children,
  pasteLimit,
  toastTimer,
}: {
  readonly children: ReactNode
  readonly pasteLimit?: number
  readonly toastTimer?: Timer
}) => {
  const renderer = useRenderer()
  const theme = useTheme()
  const selection = useMemo(() => selectionLookOf(theme), [theme])
  const [keymap] = useState(() => createDefaultOpenTuiKeymap(renderer))
  const [input] = useState<InputState>(() => ({
    box: external<Box | null>(null),
    toasts: makeToasts(undefined, toastTimer),
  }))
  useEffect(() => {
    const unguard = guardInput(keymap, renderer, pasteLimit)
    return () => {
      unguard()
      input.toasts.dispose()
    }
  }, [keymap, renderer, input, pasteLimit])
  return (
    <KeymapProvider keymap={keymap}>
      <InputContext.Provider value={input}>
        <SelectionLook.Provider value={selection}>
          {children}
          <GlobalKeys />
          <QuitKeys />
          <StopKeys />
          <ReasonKeys />
          <AnswerFormKeys />
          <AnswerBox />
          <CopyOnSelect input={input} />
          <OpenBox input={input} />
          <Toasts store={input.toasts} />
        </SelectionLook.Provider>
      </InputContext.Provider>
    </KeymapProvider>
  )
}
