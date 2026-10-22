// Colours and colour schemes (§ 7.11). A scheme gives colours to roles, meanings such as `live` or
// `needsYou`; the styles below are built from a scheme and the appearance (its light or dark
// variant) as OpenTUI colours and as ANSI strings for output outside the renderer. Bold, faint, the
// glyphs and the words are tutti's, the same in every scheme.
//
// A scheme is looked up in the project's `.tutti/colour-schemes/`, then the user's
// `$XDG_CONFIG_HOME/tutti/colour-schemes/`, then the built-ins. A scheme that can't be used never
// stops a run: tutti uses `orchestra` instead and says why once.
import { join } from "node:path"
import { RGBA, TextAttributes } from "@opentui/core"
import { Duration, Effect, Exit, FileSystem, Option, Result, Schema } from "effect"
import { decodeConfig } from "../project/configFile.ts"
import { userConfigDir } from "../project/userConfig.ts"
import orchestraFile from "./schemes/orchestra.json" with { type: "json" }

/** Every role a scheme gives a colour to: § 7.11's status, report and form tables, in order. */
export const roles = [
  "live",
  "done",
  "notice",
  "needsYou",
  "windingDown",
  "frame",
  "organ",
  "organText",
  "toMerge",
  "merging",
  "emphasis",
  "pill",
  "pillText",
  "heading1",
  "heading2",
  "heading3",
  "code",
  "link",
  "added",
  "removed",
  "selection",
  "selectionText",
  "formText",
  "formTitle",
  "formAccent",
  "formAccentText",
  "formSelected",
  "formSelectedMark",
  "formError",
  "formMuted",
  "formFaint",
  "formHelpKey",
  "formHelpDesc",
  "formHelpSeparator",
  "formButton",
  "formPlaceholder",
  "formFrame",
] as const

export const Role = Schema.Literals(roles)
export type Role = typeof Role.Type

/** The roles drawn as a background, whose `default` is the terminal's default background. */
export const backgroundRoles: ReadonlySet<Role> = new Set<Role>([
  "pill",
  "formAccent",
  "formButton",
  "selection",
])

/** A colour as a scheme gives it: exact, a palette slot, or the terminal's default. */
export type Colour =
  | { readonly _tag: "Hex"; readonly hex: string }
  | { readonly _tag: "Slot"; readonly slot: number }
  | { readonly _tag: "Default" }

const hexPattern = /^#[0-9A-Fa-f]{6}$/
const slotPattern = /^ansi:(0|[1-9]\d*)$/

/** Reads a colour, `#RRGGBB`, `ansi:N` (0–255) or `default`, or says why it can't. */
export const parseColour = (text: string): Result.Result<Colour, string> => {
  if (text === "default") return Result.succeed({ _tag: "Default" })
  if (hexPattern.test(text)) return Result.succeed({ _tag: "Hex", hex: text.toUpperCase() })
  const slot = slotPattern.exec(text)
  if (slot !== null) {
    const n = Number(slot[1])
    return n <= 255
      ? Result.succeed({ _tag: "Slot", slot: n })
      : Result.fail(`'${text}' is not a palette slot (0–255)`)
  }
  return Result.fail(`'${text}' is not a colour: use #RRGGBB, ansi:N (0–255) or default`)
}

const colourPattern =
  "^(#[0-9A-Fa-f]{6}|ansi:([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])|default)$"

const ColourText = Schema.String.check(
  Schema.makeFilter(
    (text: string) =>
      Result.match(parseColour(text), {
        onSuccess: () => true,
        onFailure: (why) => why,
      }),
    { toJsonSchema: () => ({ pattern: colourPattern }) },
  ),
).annotate({ description: "#RRGGBB, ansi:N (a palette slot, 0–255) or default" })

const Variants = Schema.Struct({
  light: ColourText.annotate({ description: "the colour on a light background" }),
  dark: ColourText.annotate({ description: "the colour on a dark background" }),
})

/** A role's value: one colour for both variants, or one for each. */
const RoleColour = Schema.Union([ColourText, Variants]).annotate({
  identifier: "RoleColour",
  description: "one colour for both variants, or { light, dark }",
})

const Colours = Schema.Struct(
  Object.fromEntries(roles.map((role) => [role, Schema.optionalKey(RoleColour)])) as {
    readonly [R in Role]: Schema.optionalKey<typeof RoleColour>
  },
)

/** A colour scheme's file, as written (§ 7.11). */
export const ColourScheme = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  name: Schema.NonEmptyString.annotate({
    description: "the scheme's name: its file's, without .json",
  }),
  description: Schema.optionalKey(Schema.String),
  extends: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description: "the scheme every role this file leaves out comes from, such as orchestra",
    }),
  ),
  colours: Colours.annotate({
    description: "roles to colours; without extends, every role",
  }),
}).annotate({ title: "tutti colour scheme" })

export type ColourScheme = typeof ColourScheme.Type

/** A role's colour on each background. */
export interface Variant {
  readonly light: Colour
  readonly dark: Colour
}

/** A scheme with every role, its `extends` resolved. */
export interface Scheme {
  readonly name: string
  readonly description: string | null
  readonly colours: { readonly [R in Role]: Variant }
  /** The scheme each role's colour comes from: this one, or one it extends. */
  readonly from: { readonly [R in Role]: string }
}

/** The scheme in use, and what to say about it once. */
export interface LoadedScheme {
  readonly scheme: Scheme
  /**
   * Why the scheme asked for isn't used and orchestra is, as the START block, the dashboard's
   * warning line and init's summary say it: `colour scheme 'dusk' isn't used: <reason>`. Null
   * when it is used.
   */
  readonly fallback: string | null
  /** Files ignored because they have a built-in scheme's name. */
  readonly warnings: ReadonlyArray<string>
}

/** What a run says about its scheme: the fallback, then the warnings. */
export const schemeNotices = (loaded: LoadedScheme): ReadonlyArray<string> =>
  loaded.fallback === null ? loaded.warnings : [loaded.fallback, ...loaded.warnings]

const parsed = (text: string): Colour =>
  Result.getOrElse(parseColour(text), () => {
    throw new Error(`a decoded colour doesn't parse: ${text}`)
  })

const variantOf = (value: string | { readonly light: string; readonly dark: string }): Variant =>
  typeof value === "string"
    ? { light: parsed(value), dark: parsed(value) }
    : { light: parsed(value.light), dark: parsed(value.dark) }

/** The scheme `file` gives, over `base`'s colours for the roles it leaves out. */
const over = (file: ColourScheme, base: Scheme | null): Result.Result<Scheme, string> => {
  const colours: Partial<Record<Role, Variant>> = {}
  const from: Partial<Record<Role, string>> = {}
  const missing: Array<Role> = []
  for (const role of roles) {
    const value = file.colours[role]
    if (value !== undefined) {
      colours[role] = variantOf(value)
      from[role] = file.name
    } else if (base !== null) {
      colours[role] = base.colours[role]
      from[role] = base.from[role]
    } else missing.push(role)
  }
  if (missing.length > 0) {
    return Result.fail(
      `'colours': roles are missing and there's no 'extends': ${missing.join(", ")}`,
    )
  }
  return Result.succeed({
    name: file.name,
    description: file.description ?? null,
    colours: colours as Scheme["colours"],
    from: from as Scheme["from"],
  })
}

const decodeBuiltIn = (json: unknown): ColourScheme => {
  const exit = decodeConfig(ColourScheme, "built-in", json)
  if (Exit.isFailure(exit))
    throw new Error(`a built-in colour scheme doesn't decode: ${exit.cause}`)
  return exit.value
}

/** The built-in schemes' files, by name: only orchestra (§ 15, Q10). */
const builtInFiles: ReadonlyMap<string, ColourScheme> = new Map([
  ["orchestra", decodeBuiltIn(orchestraFile)],
])

/** The names no file can take. */
export const builtInNames: ReadonlyArray<string> = [...builtInFiles.keys()]

/** The default scheme, orchestra's colours exactly. */
export const orchestra: Scheme = Result.getOrThrow(
  over(builtInFiles.get("orchestra") as ColourScheme, null),
)

/** orchestra in use as asked, with nothing to say. */
export const orchestraLoaded: LoadedScheme = { scheme: orchestra, fallback: null, warnings: [] }

/** The folders schemes are looked up in, in order, before the built-ins. */
export interface SchemeFolders {
  /** The project's: `.tutti/colour-schemes` in the main checkout. */
  readonly project: string
  /** The user's: `$XDG_CONFIG_HOME/tutti/colour-schemes`. */
  readonly user: string
}

/** The project's folder in the main checkout at `repo`, and the user's. */
export const schemeFolders = (repo: string) =>
  Effect.map(userConfigDir, (dir) => ({
    project: join(repo, ".tutti", "colour-schemes"),
    user: join(dir, "colour-schemes"),
  }))

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Why a name gives no scheme: there is none by that name, or the one there is can't be used. */
type Unused = { readonly _tag: "NotFound" } | { readonly _tag: "Unusable"; readonly reason: string }

const notFound: Unused = { _tag: "NotFound" }
const unusable = (reason: string): Unused => ({ _tag: "Unusable", reason })

/**
 * Loads the scheme `name` from `folders` or the built-ins, resolving `extends`. Every reason it
 * can't be used gives orchestra with one sentence saying why; it never fails.
 */
export const loadScheme = (
  name: string,
  folders: SchemeFolders,
): Effect.Effect<LoadedScheme, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const warnings: Array<string> = []
    const looked = `${folders.project}, ${folders.user} or the built-in schemes`

    /** The text of `path`, none when there is no such file. */
    const read = (path: string) =>
      fs.readFileString(path).pipe(
        Effect.map((text) => Result.succeed(Option.some(text))),
        Effect.catchTag("PlatformError", (error) =>
          Effect.succeed(
            error.reason._tag === "NotFound"
              ? Result.succeed(Option.none<string>())
              : Result.fail(`${path} can't be read: ${error.message}`),
          ),
        ),
      )

    /**
     * The file `name` finds, in the project's folder, then the user's, then the built-ins. A file
     * with a built-in's name is ignored, with a warning.
     */
    const find = (name: string): Effect.Effect<Result.Result<ColourScheme, Unused>> =>
      Effect.gen(function* () {
        if (!namePattern.test(name)) {
          return Result.fail(
            unusable(`'${name}' isn't a scheme's name: use letters, digits, '.', '_' and '-'`),
          )
        }
        const builtIn = builtInFiles.get(name)
        for (const folder of [folders.project, folders.user]) {
          const path = join(folder, `${name}.json`)
          const text = yield* read(path)
          if (Result.isFailure(text)) {
            if (builtIn === undefined) return Result.fail(unusable(text.failure))
          } else if (Option.isSome(text.success)) {
            if (builtIn === undefined) return fileOf(path, name, text.success.value)
            const warning = `${path} is ignored: ${name} is a built-in colour scheme's name`
            if (!warnings.includes(warning)) warnings.push(warning)
          }
        }
        return builtIn === undefined ? Result.fail(notFound) : Result.succeed(builtIn)
      })

    /** The scheme `name` gives, `chain` being the schemes that extend it, outermost first. */
    const resolve = (
      name: string,
      chain: ReadonlyArray<string>,
    ): Effect.Effect<Result.Result<Scheme, Unused>> =>
      Effect.gen(function* () {
        const found = yield* find(name)
        if (Result.isFailure(found)) return Result.fail(found.failure)
        const file = found.success
        const base = file.extends
        if (base === undefined) return Result.mapError(over(file, null), unusable)
        const seen = [...chain, name]
        if (seen.includes(base)) {
          return Result.fail(unusable(`'extends' loops back: ${[...seen, base].join(" → ")}`))
        }
        const extended = yield* resolve(base, seen)
        if (Result.isFailure(extended)) {
          const why = extended.failure
          return Result.fail(
            unusable(
              why._tag === "NotFound"
                ? `'extends': '${base}' isn't found in ${looked}`
                : `'extends': '${base}' can't be used: ${why.reason}`,
            ),
          )
        }
        return Result.mapError(over(file, extended.success), unusable)
      })

    const scheme = yield* resolve(name, [])
    if (Result.isSuccess(scheme)) return { scheme: scheme.success, fallback: null, warnings }
    const why = scheme.failure
    const reason = why._tag === "NotFound" ? `it isn't found in ${looked}` : why.reason
    return {
      scheme: orchestra,
      fallback: `colour scheme '${name}' isn't used: ${reason}`,
      warnings,
    }
  })

/** The scheme the file at `path`, found for the name `name`, gives, or why it can't be used. */
const fileOf = (path: string, name: string, text: string): Result.Result<ColourScheme, Unused> => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return Result.fail(
      unusable(`${path} isn't valid JSON: ${error instanceof Error ? error.message : error}`),
    )
  }
  const exit = decodeConfig(ColourScheme, path, json)
  if (Exit.isFailure(exit)) {
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    const problems = failure?.error.problems ?? []
    const reason = problems
      .map((problem) =>
        problem.path === "" ? problem.message : `'${problem.path}': ${problem.message}`,
      )
      .join("; ")
    return Result.fail(unusable(reason === "" ? `${path} can't be decoded` : reason))
  }
  if (exit.value.name !== name) {
    return Result.fail(
      unusable(`'name': '${exit.value.name}' doesn't match the file's name, '${name}'`),
    )
  }
  return Result.succeed(exit.value)
}

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

/**
 * Asks the terminal for its background (OSC 11), for output where no renderer ran, and waits up
 * to 250 ms. A terminal that doesn't answer it answers the device attributes query sent after
 * it, ending the wait early. None without an answer, or when stdin and stdout aren't a terminal.
 */
export const queryAppearance: Effect.Effect<Option.Option<Appearance>> = Effect.callback<
  Option.Option<Appearance>
>((resume) => {
  const { stdin, stdout } = process
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
    : Effect.map(queryAppearance, (answer) => appearanceOf(chosen, Option.getOrNull(answer)))

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
  "title",
] as const

export type StyleName = (typeof styleNames)[number]

/** What a style draws with: roles for its colours, and tutti's own bold and faint. */
export interface StyleSpec {
  readonly fg: Role | null
  readonly bg: Role | null
  readonly bold: boolean
  readonly faint: boolean
  /**
   * A focus: where its background is the terminal's default (under NO_COLOR), it is drawn bold
   * and reversed, so that it shows without colour (§ 7.11).
   */
  readonly focus: boolean
}

const spec = (
  fg: Role | null,
  attributes: { bold?: true; faint?: true; bg?: Role; focus?: true } = {},
) => ({
  fg,
  bg: attributes.bg ?? null,
  bold: attributes.bold === true,
  faint: attributes.faint === true,
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
  title: spec("pillText", { bg: "pill", bold: true }),
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
}

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
  const rgba = (role: Role, layer: Layer = backgroundRoles.has(role) ? "bg" : "fg") =>
    rgbaOf(colourOf(role), layer)
  const ansi = (role: Role, layer: Layer = backgroundRoles.has(role) ? "bg" : "fg") =>
    noColor || !styled ? "" : ansiOf(colourOf(role), layer, depth)
  const style = (spec: StyleSpec): Style => {
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
      (reverse ? TextAttributes.INVERSE : 0)
    const open = !styled
      ? ""
      : [
          bold ? "\x1b[1m" : "",
          faint ? "\x1b[2m" : "",
          reverse ? "\x1b[7m" : "",
          fg === null ? "" : ansi(fg, "fg"),
          spec.bg === null ? "" : ansi(spec.bg, "bg"),
        ].join("")
    return {
      fg: fg === null ? undefined : rgba(fg, "fg"),
      bg: spec.bg === null ? undefined : rgba(spec.bg, "bg"),
      attributes,
      open,
      paint: (text) => (open === "" ? text : `${open}${text}\x1b[0m`),
    }
  }
  const styles = Object.fromEntries(
    styleNames.map((name) => [name, style(styleSpecs[name])]),
  ) as Theme["styles"]
  const form = Object.fromEntries(
    formStyleNames.map((name) => [name, style(formStyleSpecs[name])]),
  ) as Theme["form"]
  return { scheme, appearance, depth, noColor, styled, styles, form, rgba, ansi }
}
