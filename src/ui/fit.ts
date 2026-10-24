// Fitting a line to the pane by priority (tutti-rvzn.27): a line tried in each of its forms, fullest
// first, until one fits (firstFit); or a line of parts, each with its own forms, where the part of
// the lowest rank steps down first (fitParts). The forms are built only until one fits.
import { cut, type Segments, widthOf } from "./line.tsx"

/**
 * The first of `forms` that `fits`, read one at a time, so that a generator builds no form past it;
 * the last when none does, and undefined when there are none.
 */
export const firstFitting = <T>(forms: Iterable<T>, fits: (form: T) => boolean): T | undefined => {
  let last: T | undefined
  for (const form of forms) {
    if (fits(form)) return form
    last = form
  }
  return last
}

/** The first of `forms` no wider than `width`, or the last cut to it when none is. */
export const firstFit = (width: number, forms: Iterable<Segments>): Segments =>
  cut(firstFitting(forms, (form) => widthOf(form) <= width) ?? [], width)

/**
 * A part of a line fitted by fitParts: its `forms`, fullest first, an empty one leaving it out; and
 * the `rank` of each step down from one form to the next, one rank for all its steps or a rank a
 * step, the lowest stepping first.
 */
export interface FitPart {
  readonly forms: ReadonlyArray<Segments>
  readonly rank: number | ReadonlyArray<number>
}

/** `forms` joined by `gap`, the empty ones left out. */
const joined = (forms: ReadonlyArray<Segments>, gap: Segments): Segments =>
  forms.filter((form) => form.length > 0).flatMap((form, i) => (i === 0 ? form : [...gap, ...form]))

/**
 * `parts` on one line `width` wide, `gap` between them: where they don't fit, the part whose next
 * step down has the lowest rank takes it, of those ranked alike the last on the line, until they
 * fit; where none can step down any further, the line is cut.
 */
export const fitParts = (parts: ReadonlyArray<FitPart>, width: number, gap: Segments): Segments => {
  const at = parts.map(() => 0)
  const rankOf = (part: FitPart, step: number): number =>
    typeof part.rank === "number" ? part.rank : (part.rank[step] ?? part.rank.at(-1) ?? 0)
  for (;;) {
    const line = joined(
      parts.map((part, i) => part.forms[at[i] ?? 0] ?? []),
      gap,
    )
    if (widthOf(line) <= width) return line
    let next = -1
    parts.forEach((part, i) => {
      const step = at[i] ?? 0
      if (step + 1 >= part.forms.length) return
      const best = parts[next]
      if (best === undefined || rankOf(part, step) <= rankOf(best, at[next] ?? 0)) next = i
    })
    if (next < 0) return cut(line, width)
    at[next] = (at[next] ?? 0) + 1
  }
}
