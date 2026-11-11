// Colours (§ 7.11): the styles, built from a colour scheme (src/project/scheme.ts) and the
// appearance (its light or dark variant) as OpenTUI colours and as ANSI strings for output outside
// the renderer. Bold, faint, the glyphs and the words are tutti's, the same in every scheme.
import { RGBA, TextAttributes } from "@opentui/core"
import { Duration, Effect, Option } from "effect"
import { backgroundRoles, type Colour, type Role, type Scheme } from "../project/scheme.ts"

/** Which variant of each role is drawn: the one for a light or for a dark background. */
export type Appearance = "light" | "dark"

/**
 * The appearance in use: the user's choice (`appearance` in the user config, or
 * TUTTI_APPEARANCE), else what the terminal reported, else dark, as Lip Gloss assumes.
 */
export const appearanceOf = (
  chosen: "auto" | "light" | "dark",
  detected: Appearance | null,
): Appearance => (chosen !== "auto" ? chosen : (detected ?? "dark"))

/** A terminal's background as light or dark: brighter than mid-grey is light, as OpenTUI says. */
export const appearanceOfBackground = (r: number, g: number, b: number): Appearance =>
  (r * 299 + g * 587 + b * 114) / 1000 > 128 ? "light" : "dark"

const backgroundReply =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the reply is an escape sequence
  /\x1b\]11;(?:rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/[0-9a-fA-F]{1,4})?|#([0-9a-fA-F]{6}))(?:\x07|\x1b\\)/

/** The appearance an OSC 11 reply in `text` gives, if it holds one. */
export const parseBackgroundReply = (text: string): Option.Option<Appearance> => {
  const match = backgroundReply.exec(text)
  if (match === null) return Option.none()
  const scale = (part: string) => (Number.parseInt(part, 16) / (16 ** part.length - 1)) * 255
  const [r, g, b] =
    match[4] !== undefined
      ? [0, 2, 4].map((at) => Number.parseInt((match[4] as string).slice(at, at + 2), 16))
      : [match[1], match[2], match[3]].map((part) => scale(part as string))
  return Option.some(appearanceOfBackground(r as number, g as number, b as number))
}

/** How long tutti waits for the terminal to say its background. */
export const backgroundQueryLimit = Duration.millis(250)

/** The streams queryAppearance asks the terminal on: process's own, or fakes in the tests. */
export interface TerminalStreams {
  readonly stdin: {
    readonly isTTY?: boolean
    readonly isRaw: boolean
    setRawMode(mode: boolean): unknown
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown
    off(event: "data", listener: (chunk: Buffer | string) => void): unknown
    resume(): unknown
    pause(): unknown
  }
  readonly stdout: { readonly isTTY?: boolean; write(text: string): unknown }
}

/**
 * Asks the terminal on `streams` (process's stdin and stdout) for its background (OSC 11), for
 * output where no renderer ran, and waits up to 250 ms. A terminal that doesn't answer it answers
 * the device attributes query sent after it, ending the wait early. None without an answer, or
 * when stdin and stdout aren't a terminal.
 */
export const queryAppearance = (
  streams: TerminalStreams = process,
): Effect.Effect<Option.Option<Appearance>> =>
  Effect.callback<Option.Option<Appearance>>((resume) => {
    const { stdin, stdout } = streams
    if (!stdin.isTTY || !stdout.isTTY) {
      resume(Effect.succeedNone)
      return
    }
    const wasRaw = stdin.isRaw
    let heard = ""
    let listening = true
    const stop = () => {
      if (!listening) return
      listening = false
      stdin.off("data", onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
    }
    const onData = (chunk: Buffer | string) => {
      heard += chunk.toString()
      const appearance = parseBackgroundReply(heard)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the reply is an escape sequence
      if (Option.isNone(appearance) && !/\x1b\[\?[\d;]*c/.test(heard)) return
      stop()
      resume(Effect.succeed(appearance))
    }
    stdin.setRawMode(true)
    stdin.on("data", onData)
    stdin.resume()
    stdout.write("\x1b]11;?\x07\x1b[c")
    // Run when the wait ends unanswered, at the time limit.
    return Effect.sync(stop)
  }).pipe(Effect.timeoutOption(backgroundQueryLimit), Effect.map(Option.flatten))

/**
 * The appearance for output outside the renderer: the user's choice, else the one the renderer
 * detected (`detected`, null where no renderer ran), else the terminal's answer to an OSC 11
 * query, else dark. The terminal is asked only when nothing else decides.
 */
export const outputAppearance = (
  chosen: "auto" | "light" | "dark",
  detected: Appearance | null,
): Effect.Effect<Appearance> =>
  chosen !== "auto" || detected !== null
    ? Effect.succeed(appearanceOf(chosen, detected))
    : Effect.map(queryAppearance(), (answer) => appearanceOf(chosen, Option.getOrNull(answer)))

/**
 * The theme, from `themeOf`, of what is printed to stdout outside the renderer where no renderer
 * detected the appearance. On a terminal (`tty`) it is styled, in the appearance `chosen`, else the
 * terminal's background, as outputAppearance asks it, though a `dumb` terminal isn't asked. Where
 * stdout isn't a terminal, such as a pipe or a file, it is unstyled, and nothing is asked.
 */
export const printedTheme = (
  themeOf: (appearance: Appearance, styled: boolean) => Theme,
  chosen: "auto" | "light" | "dark",
  terminal: { readonly dumb: boolean; readonly tty: boolean },
): Effect.Effect<Theme> =>
  !terminal.tty
    ? Effect.succeed(themeOf(appearanceOf(chosen, null), false))
    : Effect.map(
        terminal.dumb ? Effect.succeed(appearanceOf(chosen, null)) : outputAppearance(chosen, null),
        (appearance) => themeOf(appearance, true),
      )

/** How many colours the terminal draws: exact colours, or the nearest of 256. */
export type ColourDepth = "truecolor" | "256"

/** The orchestra styles' names, as its `internal/tui/style.go` names them. */
export const styleNames = [
  "picked",
  "closed",
  "deferred",
  "stop",
  "windDown",
  "heldBack",
  "done",
  "organ",
  "say",
  "testing",
  "toMerge",
  "merging",
  "key",
  "tickets",
  "dim",
  "quiet",
  "title",
  "keepAwake",
  "autoAnswer",
  "estimate",
] as const

export type StyleName = (typeof styleNames)[number]

/** What a style draws with: roles for its colours, and tutti's own bold and faint. */
export interface StyleSpec {
  readonly fg: Role | null
  readonly bg: Role | null
  readonly bold: boolean
  readonly faint: boolean
  /** Italic, as the estimates are; left out when not. */
  readonly italic?: true
  /**
   * A focus: where its background is the terminal's default (under NO_COLOR), it is drawn bold
   * and reversed, so that it shows without colour (§ 7.11).
   */
  readonly focus: boolean
}

const spec = (
  fg: Role | null,
  attributes: { bold?: true; faint?: true; italic?: true; bg?: Role; focus?: true } = {},
) => ({
  fg,
  bg: attributes.bg ?? null,
  bold: attributes.bold === true,
  faint: attributes.faint === true,
  ...(attributes.italic === true ? { italic: true as const } : {}),
  focus: attributes.focus === true,
})

/** orchestra's styles, each with the role its colour now comes from. */
export const styleSpecs: { readonly [S in StyleName]: StyleSpec } = {
  picked: spec("live", { bold: true }),
  closed: spec("done", { bold: true }),
  deferred: spec("notice"),
  stop: spec("needsYou", { bold: true }),
  windDown: spec("windingDown"),
  heldBack: spec("notice"),
  done: spec("done"),
  organ: spec("organ", { bold: true }),
  say: spec("organText"),
  testing: spec("notice", { bold: true }),
  toMerge: spec("toMerge"),
  merging: spec("merging", { bold: true }),
  key: spec("emphasis", { bold: true }),
  tickets: spec("emphasis", { bold: true }),
  dim: spec(null, { faint: true }),
  quiet: spec("quiet", { faint: true }),
  title: spec("pillText", { bg: "pill", bold: true }),
  keepAwake: spec("keepAwakeText", { bg: "keepAwake" }),
  autoAnswer: spec("autoAnswerText", { bg: "autoAnswer" }),
  estimate: spec("estimate", { italic: true }),
}

/** The form styles' names, as `huh`'s Charm theme draws its fields (§ 7.11's form roles). */
export const formStyleNames = [
  "option",
  "fieldTitle",
  "selector",
  "selected",
  "selectedMark",
  "error",
  "description",
  "faint",
  "helpKey",
  "helpDesc",
  "helpSeparator",
  "placeholder",
  "bar",
  "focusedButton",
  "button",
] as const

export type FormStyleName = (typeof formStyleNames)[number]

/** The forms' styles: the start question, the init form, the confirmations, the buttons. */
export const formStyleSpecs: { readonly [S in FormStyleName]: StyleSpec } = {
  option: spec("formText"),
  fieldTitle: spec("formTitle", { bold: true }),
  selector: spec("formAccent"),
  selected: spec("formSelected"),
  selectedMark: spec("formSelectedMark"),
  error: spec("formError"),
  description: spec("formMuted"),
  faint: spec("formFaint", { faint: true }),
  helpKey: spec("formHelpKey"),
  helpDesc: spec("formHelpDesc"),
  helpSeparator: spec("formHelpSeparator"),
  placeholder: spec("formPlaceholder"),
  bar: spec("formFrame"),
  focusedButton: spec("formAccentText", { bg: "formAccent", focus: true }),
  button: spec("formText", { bg: "formButton" }),
}

/** A style drawn: for OpenTUI, and as ANSI for output outside the renderer. */
export interface Style {
  readonly fg: RGBA | undefined
  readonly bg: RGBA | undefined
  /** OpenTUI's TextAttributes. */
  readonly attributes: number
  /** The ANSI sequences that start the style; empty for none. */
  readonly open: string
  /** `text` in the style, reset after it. */
  readonly paint: (text: string) => string
  /** The style bold as well, as a heavy frame is; itself when it is bold. */
  readonly bold: () => Style
}

/** How heavy a role's look is. */
export type Weight = "regular" | "bold"

/** Whether a colour is drawn as the text or behind it. */
export type Layer = "fg" | "bg"

export interface Theme {
  readonly scheme: Scheme
  readonly appearance: Appearance
  readonly depth: ColourDepth
  readonly noColor: boolean
  /** Whether it writes ANSI at all: not for output that isn't a terminal, where nothing is styled. */
  readonly styled: boolean
  readonly styles: { readonly [S in StyleName]: Style }
  /** The forms' styles, from the form roles. */
  readonly form: { readonly [S in FormStyleName]: Style }
  /**
   * A role's colour as the text's, regular or bold, for what no style of orchestra's draws: a
   * frame, a mark; null for the text's own colour. Built once: the same role and weight give the
   * same look, a style's own where one draws the same.
   */
  readonly look: (role: Role | null, weight?: Weight) => Style
  /** A role's colour for OpenTUI. */
  readonly rgba: (role: Role, layer?: Layer) => RGBA
  /** A role's colour as an ANSI sequence; empty under NO_COLOR, and unstyled. */
  readonly ansi: (role: Role, layer?: Layer) => string
}

/** A colour for OpenTUI; the renderer degrades exact colours to 256 itself. */
export const rgbaOf = (colour: Colour, layer: Layer): RGBA => {
  switch (colour._tag) {
    case "Hex":
      return RGBA.fromHex(colour.hex)
    case "Slot":
      return RGBA.fromIndex(colour.slot)
    case "Default":
      return layer === "fg" ? RGBA.defaultForeground() : RGBA.defaultBackground()
  }
}

/** A colour as the ANSI sequence that sets it, at the terminal's depth. */
export const ansiOf = (colour: Colour, layer: Layer, depth: ColourDepth): string => {
  const base = layer === "fg" ? 38 : 48
  switch (colour._tag) {
    case "Hex": {
      const sequence = Bun.color(colour.hex, depth === "truecolor" ? "ansi-16m" : "ansi-256") ?? ""
      return layer === "fg" ? sequence : sequence.replace("\x1b[38;", "\x1b[48;")
    }
    case "Slot":
      return `\x1b[${base};5;${colour.slot}m`
    case "Default":
      return `\x1b[${base + 1}m`
  }
}

/**
 * The theme: the styles of `scheme` in its `appearance` variant. Under NO_COLOR every role is the
 * terminal's default colour; bold and faint remain, and a focus is drawn bold and reversed. Unless `styled` (the default), it writes no
 * ANSI at all, for output that isn't a terminal; OpenTUI's colours and attributes stay.
 */
export const makeTheme = (
  scheme: Scheme,
  options: {
    readonly appearance: Appearance
    readonly depth: ColourDepth
    readonly noColor: boolean
    readonly styled?: boolean
  },
): Theme => {
  const { appearance, depth, noColor } = options
  const styled = options.styled ?? true
  const colourOf = (role: Role): Colour =>
    noColor ? { _tag: "Default" } : scheme.colours[role][appearance]
  // Each colour is made once: parsing a hex and allocating an RGBA per draw is what a tick can't spend.
  const rgbas = new Map<string, RGBA>()
  const rgba = (role: Role, layer: Layer = backgroundRoles.has(role) ? "bg" : "fg") => {
    const key = `${layer}:${role}`
    const known = rgbas.get(key)
    if (known !== undefined) return known
    const made = rgbaOf(colourOf(role), layer)
    rgbas.set(key, made)
    return made
  }
  const ansi = (role: Role, layer: Layer = backgroundRoles.has(role) ? "bg" : "fg") =>
    noColor || !styled ? "" : ansiOf(colourOf(role), layer, depth)
  // Each style is made once, so that the same spec gives the same style: a line's runs of one look
  // are one run, as `===` tells them.
  const made = new Map<string, Style>()
  const style = (spec: StyleSpec): Style => {
    const key = [spec.fg, spec.bg, spec.bold, spec.faint, spec.italic === true, spec.focus].join()
    const known = made.get(key)
    if (known !== undefined) return known
    // A faint style with a colour is faint only where its colour is the default, and then in the
    // text's own colour, as tutti's other faint text; any other colour is drawn as is, not faint.
    const faint = spec.faint && (spec.fg === null || colourOf(spec.fg)._tag === "Default")
    const fg = faint ? null : spec.fg
    // A focus without its background's colour is bold and reversed: colour is never the only cue.
    const reverse = spec.focus && (spec.bg === null || colourOf(spec.bg)._tag === "Default")
    const bold = spec.bold || reverse
    const attributes =
      (bold ? TextAttributes.BOLD : 0) |
      (faint ? TextAttributes.DIM : 0) |
      (spec.italic === true ? TextAttributes.ITALIC : 0) |
      (reverse ? TextAttributes.INVERSE : 0)
    const open = !styled
      ? ""
      : [
          bold ? "\x1b[1m" : "",
          faint ? "\x1b[2m" : "",
          spec.italic === true ? "\x1b[3m" : "",
          reverse ? "\x1b[7m" : "",
          fg === null ? "" : ansi(fg, "fg"),
          spec.bg === null ? "" : ansi(spec.bg, "bg"),
        ].join("")
    const drawn: Style = {
      fg: fg === null ? undefined : rgba(fg, "fg"),
      bg: spec.bg === null ? undefined : rgba(spec.bg, "bg"),
      attributes,
      open,
      paint: (text) => (open === "" ? text : `${open}${text}\x1b[0m`),
      bold: () => (bold ? drawn : style({ ...spec, bold: true })),
    }
    made.set(key, drawn)
    return drawn
  }
  const styles = Object.fromEntries(
    styleNames.map((name) => [name, style(styleSpecs[name])]),
  ) as Theme["styles"]
  const form = Object.fromEntries(
    formStyleNames.map((name) => [name, style(formStyleSpecs[name])]),
  ) as Theme["form"]
  const look = (role: Role | null, weight: Weight = "regular") =>
    style(spec(role, weight === "bold" ? { bold: true } : {}))
  return { scheme, appearance, depth, noColor, styled, styles, form, look, rgba, ansi }
}
