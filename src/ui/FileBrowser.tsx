// The start question's file browser (§ 5 item 3, § 7.1), which Ctrl+O opens from the Spec file
// field: drawn in tutti, over the question, as the answer form is drawn over the dashboard, rather
// than macOS's Open dialog, so that it works the same over SSH, in tmux and on Linux. As orchestra's
// Ctrl+O (bubbles' file picker): its folder in its top border, `..` first, then its folders, then
// its files, ten rows at a time; dotfiles hidden, and files other than specs greyed, with the note
// `.md, .markdown and .txt files only`. It doesn't go into a folder it can't read, and says why.
//
// Its state is a value, changed by the functions below, which read the folders through `read`
// (specFiles.ts readFolder); the keys are the start question's (StartQuestion.tsx), each a command.
import { type MouseEvent, RGBA } from "@opentui/core"
import { Result } from "effect"
import {
  boxSides,
  cut,
  frameEdge,
  Lines,
  type Look,
  padded,
  type Segments,
  seg,
  targeting,
  widthOf,
} from "./line.tsx"
import { Backdrop } from "./Modal.tsx"
import { sanitizeLine } from "./sanitize.ts"
import { browserRows, type Entry, folderLabel, inFolder, parentOf, type Row } from "./specPath.ts"
import type { Theme } from "./theme.ts"

/** How many rows the browser shows at once, on a screen tall enough. */
export const browserRowsShown = 10

/** The note on files other than specs, which are greyed and can't be chosen. */
export const specFilesOnly = ".md, .markdown and .txt files only"

/** Reads a folder's entries, or says why it can't. */
export type ReadFolder = (folder: string) => Result.Result<ReadonlyArray<Entry>, string>

/** The browser: its folder and rows, the row highlighted, the first row shown, and its error. */
export interface Browsing {
  readonly folder: string
  readonly rows: ReadonlyArray<Row>
  readonly at: number
  readonly top: number
  /** Why the last key did nothing: a folder it can't open, a file it can't choose. */
  readonly error: string | null
}

/** What a key did in the browser: the browser now, or the file chosen, absolute. */
export type Browsed =
  | { readonly _tag: "Browsing"; readonly browsing: Browsing }
  | { readonly _tag: "Chosen"; readonly path: string }

/** The message for a folder it can't open: `cannot open ~/Documents: operation not permitted`. */
export const cannotOpen = (folder: string, home: string, cause: string): string =>
  `cannot open ${sanitizeLine(folderLabel(folder, home).replace(/(.)\/$/, "$1"))}: ${cause}`

/** The browser in `folder`, its row `on` highlighted (the first where it isn't there); or why not. */
const inside = (
  folder: string,
  read: ReadFolder,
  home: string,
  on: string | null = null,
): Result.Result<Browsing, string> => {
  const entries = read(folder)
  if (Result.isFailure(entries)) return Result.fail(cannotOpen(folder, home, entries.failure))
  const rows = browserRows(entries.success, parentOf(folder) === null)
  const at = Math.max(
    rows.findIndex((row) => row._tag === "Folder" && row.name === on),
    0,
  )
  return Result.succeed({ folder, rows, at, top: 0, error: null })
}

/**
 * The browser opened at `from`, the folder typed so far, or else at `fallback`, the repository,
 * saying why it couldn't open `from` where it can't.
 */
export const openBrowser = (
  from: string | null,
  fallback: string,
  read: ReadFolder,
  home: string,
): Browsing => {
  if (from !== null) {
    const opened = inside(from, read, home)
    if (Result.isSuccess(opened)) return opened.success
    const back = inside(fallback, read, home)
    return Result.isSuccess(back)
      ? { ...back.success, error: opened.failure }
      : { folder: fallback, rows: [], at: 0, top: 0, error: opened.failure }
  }
  const opened = inside(fallback, read, home)
  return Result.isSuccess(opened)
    ? opened.success
    : { folder: fallback, rows: [], at: 0, top: 0, error: opened.failure }
}

/** `browsing` with its first row shown moved so that the highlighted one is among `shown` rows. */
const inView = (browsing: Browsing, shown: number): Browsing => {
  const rows = Math.max(shown, 1)
  const last = Math.max(browsing.rows.length - rows, 0)
  const top = Math.min(
    Math.max(browsing.top, browsing.at - rows + 1, 0),
    Math.min(browsing.at, last),
  )
  return { ...browsing, top }
}

/** The highlight moved by `by` rows, kept within the list and in view of `shown` rows. */
export const moveBy = (browsing: Browsing, by: number, shown: number): Browsing =>
  inView(
    {
      ...browsing,
      at: Math.min(Math.max(browsing.at + by, 0), Math.max(browsing.rows.length - 1, 0)),
      error: null,
    },
    shown,
  )

/** The rows shown scrolled by `by`, as the wheel scrolls them, the highlight kept among them. */
export const scrollBy = (browsing: Browsing, by: number, shown: number): Browsing => {
  const rows = Math.max(shown, 1)
  const top = Math.min(Math.max(browsing.top + by, 0), Math.max(browsing.rows.length - rows, 0))
  const at = Math.min(Math.max(browsing.at, top), top + rows - 1)
  return { ...browsing, top, at }
}

/** Up a folder, the highlight on the folder it left; where it can't, the browser as it was. */
export const upFolder = (browsing: Browsing, read: ReadFolder, home: string, shown: number) => {
  const up = parentOf(browsing.folder)
  if (up === null) return { ...browsing, error: null }
  const left = browsing.folder.slice(up.length).replace(/^\/+/, "")
  const opened = inside(up, read, home, left)
  return Result.isSuccess(opened)
    ? inView(opened.success, shown)
    : { ...browsing, error: opened.failure }
}

/**
 * Enter on the highlighted row: `..` goes up a folder, a folder is opened, a spec file chosen; a
 * file of another kind can't be, which the error says.
 */
export const enterRow = (
  browsing: Browsing,
  read: ReadFolder,
  home: string,
  shown: number,
): Browsed => {
  const row = browsing.rows[browsing.at]
  const stay = (next: Browsing): Browsed => ({ _tag: "Browsing", browsing: next })
  if (row === undefined) return stay(browsing)
  switch (row._tag) {
    case "Up":
      return stay(upFolder(browsing, read, home, shown))
    case "Folder": {
      const opened = inside(inFolder(browsing.folder, row.name), read, home)
      return stay(
        Result.isSuccess(opened) ? opened.success : { ...browsing, error: opened.failure },
      )
    }
    case "File":
      return row.spec
        ? { _tag: "Chosen", path: inFolder(browsing.folder, row.name) }
        : stay({ ...browsing, error: specFilesOnly })
  }
}

/** The rows the browser shows on a screen `height` tall, at most browserRowsShown, at least 1. */
export const rowsShown = (height: number): number =>
  Math.max(Math.min(browserRowsShown, height - browserChrome), 1)

/** The browser's lines besides its rows: its frame, a blank line and its note. */
const browserChrome = 4

/** The widest the browser gets, its frame included. */
const browserMaxWidth = 76

/** How a row is drawn: its name, a folder's with a `/`, in its look. */
const rowText = (row: Row, theme: Theme): { readonly text: string; readonly look: Look } => {
  const { form } = theme
  switch (row._tag) {
    case "Up":
      return { text: "..", look: form.option }
    case "Folder":
      return { text: `${sanitizeLine(row.name)}/`, look: form.selector }
    case "File":
      return { text: sanitizeLine(row.name), look: row.spec ? form.option : form.faint }
  }
}

/**
 * The browser's lines `width` wide, its frame included: its folder in the top border, `shown` rows
 * from its first shown, each its click target (its index), then its error or its note.
 */
export const browserLines = (
  browsing: Browsing,
  theme: Theme,
  width: number,
  shown: number,
  home: string,
): ReadonlyArray<Segments> => {
  const { form } = theme
  const inner = Math.max(width - 4, 1)
  const rows = browsing.rows.slice(browsing.top, browsing.top + shown).map((row, i) => {
    const index = browsing.top + i
    const { text, look } = rowText(row, theme)
    const line =
      index === browsing.at
        ? [
            seg("> ", form.selector),
            seg(text, row._tag === "File" && !row.spec ? look : form.selected),
          ]
        : [seg("  "), seg(text, look)]
    return targeting(padded(cut(line, inner), inner), index)
  })
  const empty = browsing.rows.length === 0 ? [[seg("  (no files here)", form.faint)]] : []
  const greyed = browsing.rows.some((row) => row._tag === "File" && !row.spec)
  const note: Segments =
    browsing.error !== null
      ? [seg(browsing.error, form.error)]
      : greyed
        ? [seg(specFilesOnly, form.faint)]
        : []
  const frame = form.bar
  const blank = Array.from({ length: shown - rows.length - empty.length }, (): Segments => [])
  const label = [seg(sanitizeLine(folderLabel(browsing.folder, home)), form.fieldTitle)]
  return [
    labelledTop(width, frame, label),
    ...boxSides([...rows, ...empty, ...blank, [], note], width, frame),
    frameEdge("bottom", width, frame),
  ]
}

/** The top of the browser's frame, `width` wide, with `label` at its left: `╭─ ~/specs/ ───╮`. */
const labelledTop = (width: number, frame: Look, label: Segments): Segments => {
  const shown = cut(label, Math.max(width - 6, 0))
  const fill = Math.max(width - 5 - widthOf(shown), 0)
  return [seg("╭─ ", frame), ...shown, seg(` ${"─".repeat(fill)}╮`, frame)]
}

/** The browser's width on a screen `width` wide. */
export const browserWidth = (width: number): number =>
  Math.max(Math.min(width - 4, browserMaxWidth), 16)

/**
 * The browser over the question, in the middle of the `height` lines above its hint: a click on a
 * row does what Enter on it does (`press`, with its index), and the wheel scrolls (`scroll`).
 */
export const FileBrowser = ({
  theme,
  browsing,
  home,
  width,
  height,
  shown,
  press,
  scroll,
}: {
  readonly theme: Theme
  readonly browsing: Browsing
  readonly home: string
  readonly width: number
  readonly height: number
  readonly shown: number
  readonly press: (index: number) => void
  readonly scroll: (by: number) => void
}) => {
  const outer = browserWidth(width)
  const lines = browserLines(browsing, theme, outer, shown, home)
  const wheel = (event: MouseEvent) => {
    const step = event.scroll?.direction === "down" ? 1 : event.scroll?.direction === "up" ? -1 : 0
    scroll(step * Math.max(event.scroll?.delta ?? 1, 1))
  }
  return (
    <>
      <Backdrop />
      <box
        position="absolute"
        zIndex={10}
        left={Math.max(Math.floor((width - outer) / 2), 0)}
        top={Math.max(Math.floor((height - lines.length) / 2), 0)}
        width={outer}
        height={lines.length}
        // Opaque, in the terminal's own background: the question's text doesn't show through it.
        backgroundColor={RGBA.defaultBackground()}
        flexDirection="column"
        onMouseScroll={wheel}
      >
        <Lines lines={lines} press={press} />
      </box>
    </>
  )
}
