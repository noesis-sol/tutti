// The spinner, Bubbles' `Dot` (§ 7.11 "Glyphs and motion"): its frames and how often it turns, the
// same on the dashboard, in init's form and on the printer's organ lines (src/print/organLine.ts).
import { Duration } from "effect"

/** The spinner's frames, in turn. */
export const spinnerFrames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const

/** How often the spinner turns: ten times a second. */
export const frameInterval = Duration.millis(100)
