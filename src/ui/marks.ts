// The marks (§ 7.11 "Glyphs and motion"): every glyph tutti draws for a state, by what it means,
// so that a glyph is chosen in one place and a row, a card, the totals and the summary say a state
// with the same one. Plain Unicode, a cell wide, not an emoji. Some of today's glyphs are
// ambiguous-width or emoji, and some meanings share a shape (■ and ◼ apart, ◆ for merging and the
// triage verdict): test/marks.test.ts lists them, for the curated set of the worker-view design
// (tutti-cxgo D7) to replace.
//
// A status as the dashboard shows it, Shown, is its mark, its word, its tone and whether the rest
// of its row is faint, worked out once as RunView is projected (runView.ts), not again per draw.
import type { Style, StyleName, Theme } from "./theme.ts"

/** Each mark's glyph, by its meaning. */
export const marks = {
  /** Waits its turn: queued, held back, waiting on a blocker, at a usage limit. */
  queued: "◷",
  /** Its worker is at it: `▶ editing`; the Workers total. */
  working: "▶",
  /** Its worker, or the ticket, waits for you: `■ allow?`, `■ blocked`. */
  waitsForYou: "■",
  /** Stopped as the run ended; the closing line of a run that stopped. */
  stopped: "■",
  toMerge: "◼",
  merging: "◆",
  /** Its worker works on its merge again: resolving a conflict, fixing a check. */
  reworking: "⟳",
  /** Done: a ticket closed, a tool call that succeeded, a step of init done. */
  done: "✓",
  /** Its worker filed a question for you. */
  asked: "?",
  /** Deferred, or set aside; the Set aside total. */
  setAside: "↷",
  /** Left for your review. */
  review: "!",
  /** A card whose worker's turn has ended. */
  idle: "•",
  /** The triage organ's verdict on a ticket set aside. */
  verdict: "◆",
  /** An organ's line on the printer. */
  organ: "◆",
  /** Before a worker's latest action, on its card. */
  latest: "▸",
  /** Before the selected item of a worker's transcript. */
  selected: "▸",
  /** Before a message you sent a worker. */
  said: "›",
  /** Before why a ticket in Up next waits: `› after t-1 merges`. */
  waitsFor: "›",
  /** The closing line of a run that finished by itself. */
  end: "♪",
  /** A ticket on the wind-down line. */
  windingDown: "■",
  /** A step of init that kept what was there. */
  kept: "•",
  /** A step of init that found something missing. */
  missing: "✗",
  /** A step of init with something to look at. */
  caution: "!",
  /** The step of init's form it is at. */
  current: "●",
  /** A step of init's form still to come. */
  toCome: "○",
  /**
   * A filled and an empty cell of a usage window's gauge: box-drawing lines, which terminals draw
   * to the cell themselves, not ▰▱, which common terminal fonts lack and a fallback font drew over
   * the cell's edges (tutti-1l30).
   */
  gaugeFull: "━",
  gaugeEmpty: "─",
} as const

export type Mark = keyof typeof marks

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

/** What a card shows in place of the spinner when its worker isn't at work (§ 5.1). */
export type Motion = "spinner" | "toMerge" | "merging" | "idle"

/** The tone of a card's mark: the spinner `picked`, ◼ `toMerge`, ◆ `merging`, • `done`. */
export const motionTones: { readonly [M in Motion]: Tone } = {
  spinner: "picked",
  toMerge: "toMerge",
  merging: "merging",
  idle: "done",
}
