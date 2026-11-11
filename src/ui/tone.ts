// The look a status is drawn in (§ 7.11): its tone, one of the theme's styles, and the status as
// the dashboard shows it, Shown, its mark, its word, its tone and whether the rest of its row is
// faint, worked out once as RunView is projected (src/run/runView.ts), not again per draw. The
// marks themselves are src/text/marks.ts'.
import type { Mark } from "../text/marks.ts"
import type { Style, StyleName, Theme } from "./theme.ts"

/**
 * The look a status is drawn in: one of the styles, or `failed`, the `needsYou` role not bold, for
 * a worker that failed or is gone.
 */
export type Tone = StyleName | "failed"

/** `tone` in `theme`. */
export const lookOf = (tone: Tone, theme: Theme): Style =>
  tone === "failed" ? theme.look("needsYou") : theme.styles[tone]

/** A status as the dashboard shows it: `▶ testing` in `testing`, a done ticket's row faint. */
export interface Shown {
  readonly mark: Mark
  readonly word: string
  readonly tone: Tone
  /** The rest of its row is faint, as a finished or waiting ticket's is. */
  readonly faint: boolean
}

/**
 * What a card shows in place of the spinner when its worker isn't at work, or is at work on its
 * merge again, resolving or fixing, as its row shows it (§ 5.1).
 */
export type Motion = "spinner" | "toMerge" | "merging" | "reworking" | "idle"

/**
 * The tone of a card's mark: the spinner `picked`, ◼ `toMerge`, ◆ `merging`, ⟳ `deferred` as its
 * row's, • `done`.
 */
export const motionTones: { readonly [M in Motion]: Tone } = {
  spinner: "picked",
  toMerge: "toMerge",
  merging: "merging",
  reworking: "deferred",
  idle: "done",
}
