// Reading tutti's JSON config files, the project's settings (§ 8.4) and the user config (§ 8.5).
// A file is decoded with its Effect Schema in one pass that reports every problem, each with the
// file, the key path and a message; an unknown key is one. A missing file decodes as `{}`, so every
// key takes its default. Reading never throws: the problems come back as ConfigFileInvalid.
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect"

/** One thing wrong with a config file: where, and what. `path` is "" for the file as a whole. */
export class ConfigProblem extends Schema.Class<ConfigProblem>("ConfigProblem")({
  file: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

/** A config file that couldn't be read or decoded, with every problem in it. */
export class ConfigFileInvalid extends Schema.TaggedError<ConfigFileInvalid>()(
  "ConfigFileInvalid",
  {
    problems: Schema.Array(ConfigProblem),
  },
) {}

/** The key path as the file writes it: `workers.permission_mode`, `checks.setup.files[1]`. */
export const showPath = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>(
    (shown, key) =>
      typeof key === "number"
        ? `${shown}[${key}]`
        : shown === ""
          ? String(key)
          : `${shown}.${String(key)}`,
    "",
  )

/** Why a choice refuses a value, by value: `{ plan: "only plans" }`. Read by problemsOf. */
const refusedAnnotation = "tutti/refused"

/**
 * A choice among `choices`, which a problem lists. A value in `refused` is refused with its reason,
 * so the problem says why, rather than only that, it can't be used.
 */
export const choice = <const L extends ReadonlyArray<string>>(
  choices: L,
  refused: Readonly<Record<string, string>> = {},
) =>
  Schema.Literals(choices).annotate({
    expected: `one of ${choices.join(", ")}`,
    [refusedAnnotation]: refused,
  })

/** A choice among `choices`, or null; a problem lists both. */
export const choiceOrNull = <const L extends ReadonlyArray<string>>(choices: L) =>
  Schema.Union([...choices.map((value: L[number]) => Schema.Literal(value)), Schema.Null]).annotate(
    {
      expected: `one of ${choices.join(", ")}, or null`,
    },
  )

/** The reason a choice gives for refusing the value an issue is about, if it refuses it. */
const refusal = (issue: SchemaIssue.AnyOf): string | undefined => {
  const refused = issue.ast.annotations?.[refusedAnnotation] as Record<string, string> | undefined
  const value = issue.input
  if (refused === undefined || typeof value !== "string" || !Object.hasOwn(refused, value)) return
  return `can't be ${value}: ${refused[value]}. Use ${String(issue.ast.annotations?.expected)}`
}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "UnexpectedKey" ? "unknown key" : SchemaIssue.defaultLeafHook(issue),
})

/** Every problem in an issue, each at its key path; the formatter above words most. */
const problemsOf = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
): Array<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }> => {
  switch (issue._tag) {
    case "Pointer":
      return problemsOf(issue.issue, [...path, ...issue.path])
    case "Composite":
      return issue.issues.flatMap((inner) => problemsOf(inner, path))
    case "Encoding":
      return problemsOf(issue.issue, path)
    case "AnyOf": {
      const message = refusal(issue)
      if (message !== undefined) return [{ path, message }]
    }
  }
  return formatter(issue).issues.map((problem) => {
    const keys = [
      ...path,
      ...(problem.path ?? []).map((segment) =>
        typeof segment === "object" ? (segment.key as PropertyKey) : segment,
      ),
    ]
    // An unknown key's path ends with it, and its message names it again.
    const last = keys.at(-1)
    const named = problem.message === "unknown key" && last !== undefined
    return { path: keys, message: named ? `unknown key "${String(last)}"` : problem.message }
  })
}

/** Decodes a config file's parsed JSON with `schema`, or returns every problem in it. */
export const decodeConfig = <S extends Schema.Decoder<unknown>>(
  schema: S,
  file: string,
  json: unknown,
): Exit.Exit<S["Type"], ConfigFileInvalid> => {
  const exit = Schema.decodeUnknownExit(schema)(json, {
    errors: "all",
    onExcessProperty: "error",
    reportInput: true,
  })
  if (Exit.isSuccess(exit)) return Exit.succeed(exit.value)
  const problems = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail"
      ? problemsOf(reason.error.issue).map(
          ({ path, message }) => new ConfigProblem({ file, path: showPath(path), message }),
        )
      : [],
  )
  return Exit.fail(new ConfigFileInvalid({ problems }))
}

/**
 * A config file's text parsed as JSON, or why it isn't: `isn't valid JSON: <what the parser said>`.
 * Schema.fromJsonString says only that it isn't, so the parser is asked here.
 */
export const parseConfigJson = (text: string): Result.Result<unknown, string> =>
  Result.try({
    try: (): unknown => JSON.parse(text),
    catch: (error) => `isn't valid JSON: ${error instanceof Error ? error.message : error}`,
  })

/** Reads and decodes the config file at `file`; a missing file decodes as `{}`, its defaults. */
export const readConfigFile = <S extends Schema.Decoder<unknown>>(schema: S, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const problem = (message: string) =>
      new ConfigFileInvalid({ problems: [new ConfigProblem({ file, path: "", message })] })
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(problem(`can't be read: ${error.message}`)),
      ),
    )
    if (Option.isNone(text)) return yield* decodeConfig(schema, file, {})
    const json = yield* Effect.fromResult(Result.mapError(parseConfigJson(text.value), problem))
    return yield* decodeConfig(schema, file, json)
  })

/**
 * Builds a schema key with a default: absent, it decodes as `value` would (an encoded value). The
 * published JSON Schema gives the default, so editors show it.
 */
export const withDefault =
  <S extends Schema.Top>(value: S["Encoded"]) =>
  (schema: S) =>
    // annotateEncoded gives S["Rebuild"], the same schema as S's type says less precisely.
    (Schema.annotateEncoded<S>({ default: value })(schema) as S).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(value)),
    )

const units = [
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
  ["ms", 1],
] as const

const durationPattern = /^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/
const durationPart = /(\d+(?:\.\d+)?)(ms|h|m|s)/g

/** Reads a time such as "30m", "2h" or "1h30m" (Go's units from ms to h), or "0". */
export const parseDuration = (text: string): Option.Option<Duration.Duration> => {
  if (text === "0") return Option.some(Duration.zero)
  if (!durationPattern.test(text)) return Option.none()
  let millis = 0
  for (const [, amount, unit] of text.matchAll(durationPart)) {
    millis += Number(amount) * (units.find(([name]) => name === unit)?.[1] ?? 0)
  }
  return Number.isFinite(millis) ? Option.some(Duration.millis(millis)) : Option.none()
}

/** Writes a time as parseDuration reads it: "30m", "1h30m", "0". */
export const formatDuration = (duration: Duration.Duration): string => {
  let rest = Math.round(Duration.toMillis(duration))
  let text = ""
  for (const [name, size] of units) {
    const amount = Math.floor(rest / size)
    if (amount > 0) text += `${amount}${name}`
    rest -= amount * size
  }
  return text === "" ? "0" : text
}

/**
 * A time such as "30m", decoded to a Duration; `positive` refuses "0". The text is checked before
 * it is decoded, with the other keys' types, so its problem is reported beside theirs: a struct
 * stops before its decoding step when one of its keys has the wrong type. The JSON Schema gives the
 * pattern, which doesn't refuse "0m": only "0" itself.
 */
const DurationFromText = (positive: boolean) =>
  Schema.String.check(
    Schema.makeFilter(
      (text) =>
        Option.match(parseDuration(text), {
          onNone: () => `Expected a time such as "30m" or "2h", got ${JSON.stringify(text)}`,
          onSome: (duration) =>
            !positive ||
            Duration.isGreaterThan(duration, Duration.zero) ||
            `Expected a time longer than 0, such as "30m", got ${JSON.stringify(text)}`,
        }),
      {
        description: positive
          ? `a time such as "30m", "2h" or "1h30m"`
          : `a time such as "30m", "2h" or "1h30m", or "0"`,
        toJsonSchema: () => ({
          pattern: positive
            ? durationPattern.source
            : `^(?:0|${durationPattern.source.slice(1, -1)})$`,
        }),
      },
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Duration,
      SchemaTransformation.transform({
        decode: (text) => Option.getOrElse(parseDuration(text), () => Duration.zero),
        encode: formatDuration,
      }),
    ),
  )

/** A time such as "30m", decoded to a Duration, that is more than zero. */
export const PositiveDuration = DurationFromText(true)

/** A time such as "10m", decoded to a Duration, or "0". */
export const NonNegativeDuration = DurationFromText(false)
