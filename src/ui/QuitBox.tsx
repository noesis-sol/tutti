// The quit box (D15, § 4.8, § 7.3): Ctrl+C opens it, over the view. `s` stops after the running
// tickets (Drain, orchestra's drain), `q` quits now (Quit{now}), `Esc` cancels; a second Ctrl+C
// quits now (Input.tsx's global keys).
import { UiCommand } from "../run/commands.ts"
import { type Command, useCommands } from "./keyCommands.ts"
import { useInput } from "./keys.ts"
import { seg } from "./line.tsx"
import { Modal } from "./Modal.tsx"
import { useCommand, useTheme } from "./useRunView.ts"

export const quitQuestion = "Stop after the running tickets, or quit now?"

export const quitAbout =
  "Quitting now interrupts the workers and saves their sessions; the next run resumes them. Ctrl+C again quits now."

/** What the quit box's answers do: close it, then send their command. */
const useAnswers = () => {
  const { box } = useInput()
  const command = useCommand()
  const answer = (then?: UiCommand) => () => {
    box.set(null)
    if (then !== undefined) command(then)
  }
  return {
    drain: answer(UiCommand.Drain()),
    quit: answer(UiCommand.Quit({ now: true })),
    cancel: answer(),
  }
}

/** The quit box's keys: bound while it is open, and drawn in it. */
const quitCommands = (answers: ReturnType<typeof useAnswers>): ReadonlyArray<Command> => [
  { keys: ["s"], run: answers.drain, hint: { keys: "s", does: "stop after current" } },
  { keys: ["q"], run: answers.quit, hint: { keys: "q", does: "quit now" } },
  { keys: ["escape"], run: answers.cancel, hint: { keys: "Esc", does: "cancel" } },
]

/** The quit box's keys, bound while it is open. */
export const QuitKeys = () => {
  useCommands("box", quitCommands(useAnswers()), "Quit")
  return null
}

export const QuitBox = () => {
  const theme = useTheme()
  const answers = useAnswers()
  return (
    <Modal
      frame={theme.look("frame")}
      paragraphs={[
        seg(quitQuestion, theme.look(null, "bold")),
        seg(""),
        seg(quitAbout, theme.styles.dim),
      ]}
      choices={quitCommands(answers)}
    />
  )
}
