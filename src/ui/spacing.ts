// The gaps and indents: every run of spaces src/ui draws between or before a line's parts,
// by what it separates, so that a gap is chosen in one place and two lines that should line up do.
// Two that mean different things have different names, even where they are as wide today.
// test/lint/bare-spaces.grit refuses a bare `seg(" ")` in src/ui: name its gap here instead. A width
// worked out as the line is laid, `" ".repeat(short)`, is padding, not a gap.

/**
 * The gap after a card's mark, before its ticket: two columns, as some marks (`⟳`) are drawn past
 * their cell, so that no mark touches the ticket and the ticket doesn't seem to move as marks change.
 */
export const markGap = "  "

/** Where the lines under a card's head start: under its ticket, past the mark and markGap. */
export const cardIndent = " ".repeat(1 + markGap.length)

/**
 * Between a line's fields: a card head's ticket, status, time and memory; the worker view's
 * figures; the title line's parts and banners; the interview's head; a key and what it does.
 */
export const fieldGap = "  "

/** Before a section's label: `  Tickets`, `  Current`, `  Up next`. */
export const labelIndent = "  "

/** What the hint has before its first key on each line. */
export const hintIndent = "  "

/** Between two buttons on a line: an attention card's, the answer form's, the composer's. */
export const buttonGap = "  "

/** Between a link or a button and the key that presses it: `▾ whole ticket  t`, `Ctrl+R`. */
export const keyGap = "  "

/**
 * Before what a line sets at its right end, its words padded to meet it: the composer's buttons,
 * a queued message's `queued`, a transcript item's mark.
 */
export const asideGap = "  "

/** Where the composer's lines start: what the worker's finished, held or steered state says. */
export const composerIndent = "  "

/** Either side of the composer's `>`. */
export const promptPad = " "

/** Where the Answer box's head and title start, with no mark before them. */
export const answerIndent = "  "

/** Where the wind-down line starts. */
export const windDownIndent = "  "

/** Between two of the wind-down line's squares: `■ ■ ■`. */
export const squareGap = " "

/** Between a spinner and the words it turns beside, as an idle box and init's scout draw it. */
export const spinnerGap = " "

/** After the title's pill and each badge after it: ` Tutti  0.7.0  keep awake `. */
export const badgeGap = " "

/** Before where the run is, after the title line's pill and badges. */
export const whereGap = "   "

/** Before the ticket's title, at the end of the interview's head. */
export const titleGap = "   "

/** After a view's back link, before its head: `← Dashboard   ⟳  t-1`. */
export const backGap = "   "

/**
 * Between two words drawn in looks of their own, as prose spaces them: a request's `name: value`,
 * an edit's `+3 −1`.
 */
export const wordSpace = " "

/**
 * Where the totals strip and the load line start: a column in from the pane's left edge, as the
 * title line above them ends a column short of its right (tutti-3j79).
 */
export const edgeIndent = " "

/** The space inside a box's side, and either side of a table's cell: `│ `, ` │ `. */
export const boxPad = " "

/** Where a box's lines start, past its side and boxPad: where its title goes when it isn't drawn. */
export const boxIndent = " ".repeat(1 + boxPad.length)

/** After a box's name in its top border, before the rest of the border: `╭─ Ticket ───`. */
export const namePad = " "

/**
 * The columns init's form has past its own lines before a field's text, its bar and the space after
 * it, so that what init has done lines up with the field asked.
 */
export const fieldIndent = "  "

/** Between init's Yes and No, the halves of one toggle. */
export const confirmGap = " "

/** Before a line a pointer (`> `, `▸ `) doesn't point at: as wide as the pointer. */
export const unpointed = "  "
