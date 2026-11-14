// Colour schemes (§ 7.11): a scheme gives colours to roles, meanings such as `live` or `needsYou`,
// each with a light and a dark variant, and src/ui/theme.ts builds the styles from one. A scheme is
// looked up in the project's `.tutti/colour-schemes/`, then the user's
// `$XDG_CONFIG_HOME/tutti/colour-schemes/`, then the built-ins. A scheme that can't be used never
// stops a run: tutti uses the built-in `tutti` instead and says why once.
import { join } from "node:path"
import { Effect, Exit, FileSystem, Option, Result, Schema } from "effect"
import { decodeConfig } from "./configFile.ts"
import tuttiFile from "./schemes/tutti.json" with { type: "json" }
import { userConfigDir } from "./userConfig.ts"

/**
 * Every role a scheme gives a colour to: § 7.11's status, ticket, report and form tables, in order.
 */
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
  "quiet",
  "estimate",
  "pill",
  "pillText",
  "keepAwake",
  "keepAwakeText",
  "autoAnswer",
  "autoAnswerText",
  "typeBug",
  "typeFeature",
  "typeTask",
  "typeEpic",
  "typeChore",
  "priorityUrgent",
  "priorityHigh",
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
  "keepAwake",
  "autoAnswer",
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
      description: "the scheme every role this file leaves out comes from, such as tutti",
    }),
  ),
  colours: Colours.annotate({
    description: "roles to colours; without extends, every role but quiet, which comes from tutti",
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
   * Why the scheme asked for isn't used and tutti is, as the START block, the dashboard's
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

/**
 * The roles added since schemes were first written, which a file without `extends` may leave out:
 * it takes tutti's colour for them, so that no scheme written before one becomes unusable.
 */
const addedRoles: ReadonlySet<Role> = new Set<Role>(["quiet"])

/**
 * The scheme `file` gives, over `base`'s colours for the roles it leaves out; without a base, over
 * `added`'s for the roles added since schemes were first written.
 */
const over = (
  file: ColourScheme,
  base: Scheme | null,
  added: Scheme | null = null,
): Result.Result<Scheme, string> => {
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
    } else if (added !== null && addedRoles.has(role)) {
      colours[role] = added.colours[role]
      from[role] = added.from[role]
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

/** The built-in schemes' files, by name: only tutti (§ 15, Q10). */
const builtInFiles: ReadonlyMap<string, ColourScheme> = new Map([
  ["tutti", decodeBuiltIn(tuttiFile)],
])

/** The names no file can take. */
export const builtInNames: ReadonlyArray<string> = [...builtInFiles.keys()]

/** The default scheme, the built-in tutti. */
export const tuttiScheme: Scheme = Result.getOrThrow(
  over(builtInFiles.get("tutti") as ColourScheme, null),
)

/** tutti in use as asked, with nothing to say. */
export const tuttiSchemeLoaded: LoadedScheme = { scheme: tuttiScheme, fallback: null, warnings: [] }

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
 * can't be used gives tutti with one sentence saying why; it never fails.
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
        if (base === undefined) return Result.mapError(over(file, null, tuttiScheme), unusable)
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
      scheme: tuttiScheme,
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
