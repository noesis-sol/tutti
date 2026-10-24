// The stop question (§ 7.2, § 7.3, orchestra's drain question): `s` on the dashboard asks whether
// to stop after the running tickets, or, while the run winds down, whether to take tickets again.
// `y` sends Drain or Undrain; `n` or `Esc` leaves things as they are. While the run winds down the
// queue is marked `held` (the totals strip).
//
// The question is the one asked when `s` was pressed (its Box's `windingDown`), so `y` does what
// the box says even if the run changes its mind before the answer.
import { UiCommand } from "../run/commands.ts"
import { drainWords } from "../run/drain.ts"
import { type Command, useCommands } from "./keyCommands.ts"
import { useInput } from "./keys.ts"
import { seg } from "./line.tsx"
import { Modal } from "./Modal.tsx"
import { useCommand, useRunViewPart, useTheme } from "./useRunView.ts"

/** What the stop question asks and says, with the words of its `y` and `n`. */
export const stopWords = (
  windingDown: boolean,
  running: ReadonlyArray<string>,
): { readonly ask: string; readonly about: string; readonly yes: string; readonly no: string } => {
  if (windingDown) {
    return {
      ask: "Keep taking tickets?",
      about: "New tickets start again as slots free up.",
      yes: "keep going",
      no: "keep stopping",
    }
  }
  if (running.length === 0) {
    return {
      ask: "Stop after the running tickets?",
      about: "No new tickets will start. Nothing is running, so the run ends now.",
      yes: "stop",
      no: "keep going",
    }
  }
  const words = drainWords(running).join("")
  const they = running.length === 1 ? "It merges" : "They merge"
  return {
    ask: "Stop after the running tickets?",
    about: `${words.charAt(0).toUpperCase()}${words.slice(1)}. ${they} as usual, then the run ends.`,
    yes: "stop after current",
    no: "keep going",
  }
}

/** What the stop question's answers do: `yes` sends what the open question asks, `no` nothing. */
const useAnswers = () => {
  const { box } = useInput()
  const command = useCommand()
  return {
    yes: () => {
      const asked = box.get()
      box.set(null)
      command(asked?._tag === "Stop" && asked.windingDown ? UiCommand.Undrain() : UiCommand.Drain())
    },
    no: () => box.set(null),
  }
}

/** The stop question's keys, `y` and `n` drawn as `words` name them: bound while it is open, and drawn in it. */
const stopCommands = (
  answers: ReturnType<typeof useAnswers>,
  words: { readonly yes: string; readonly no: string },
): ReadonlyArray<Command> => [
  { keys: ["y"], run: answers.yes, hint: { keys: "y", does: words.yes } },
  { keys: ["n", "escape"], run: answers.no, hint: { keys: "n", does: words.no } },
]

/** The stop question's keys, bound while it is open; what they are named is the open question's. */
export const StopKeys = () => {
  useCommands("box", stopCommands(useAnswers(), { yes: "", no: "" }), "Stop")
  return null
}

export const StopQuestion = ({ windingDown }: { readonly windingDown: boolean }) => {
  const theme = useTheme()
  const cards = useRunViewPart((view) => view.cards)
  const answers = useAnswers()
  const words = stopWords(
    windingDown,
    cards.map((card) => card.label),
  )
  return (
    <Modal
      frame={theme.look("notice")}
      paragraphs={[seg(words.ask, theme.look("notice", "bold")), seg(""), seg(words.about)]}
      choices={stopCommands(answers, words)}
    />
  )
}
