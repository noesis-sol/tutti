// Text cut to one line of a given width, one way everywhere: a notice, the summary's cells, and
// what the reviewer and the triage organ read.

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const characters = (text: string): number => {
  let n = 0
  for (const _ of text) n++
  return n
}

/**
 * `text` on one line, its runs of white space one space, cut with `…` to at most `width` columns
 * and `width` characters: columns for a terminal, characters for a budget, which marks that take
 * no column could otherwise pass. It is cut between graphemes, so that a flag or an emoji joined by
 * ZWJ is never split, and a space before the `…` is dropped. It sanitises nothing.
 */
export const oneLine = (text: string, width: number): string => {
  const one = text
    .split(/\s+/u)
    .filter((word) => word !== "")
    .join(" ")
  if (Bun.stringWidth(one) <= width && characters(one) <= width) return one
  if (width <= 0) return ""
  let kept = ""
  let columns = 0
  let chars = 0
  for (const { segment } of graphemes.segment(one)) {
    const w = Bun.stringWidth(segment)
    const n = characters(segment)
    if (columns + w > width - 1 || chars + n > width - 1) break
    kept += segment
    columns += w
    chars += n
  }
  return `${kept.trimEnd()}…`
}
