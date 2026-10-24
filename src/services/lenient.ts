// Schemas for JSON other programs write, which tutti reads but doesn't own: other runs'
// registrations, orchestra's state and lock files, bd's output, Claude Code's config. Such a file
// is read field by field, each with the right type taken and any other left out, so one field
// tutti doesn't know the shape of doesn't lose it the rest.
import { Effect, Schema, Struct } from "effect"

type Lenient<S extends Schema.Constraint> = Schema.optionalKey<
  Schema.middlewareDecoding<S, S["DecodingServices"]>
>

interface LenientKeyLambda extends Struct.Lambda {
  <S extends Schema.Constraint>(self: S): Lenient<S>
  readonly "~lambda.out": this["~lambda.in"] extends Schema.Constraint
    ? Lenient<this["~lambda.in"]>
    : never
}

/**
 * An optional key that is left out where its value isn't a `schema`, as where it is missing. A
 * lambda, so `Struct.map(fields, lenientKey)` makes every field of a struct so.
 */
export const lenientKey: LenientKeyLambda = Struct.lambda<LenientKeyLambda>((schema) =>
  Schema.optionalKey(Schema.catchDecoding(() => Effect.succeedNone)(schema)),
)

/** A whole number above 0. */
export const Positive = Schema.Int.check(Schema.isGreaterThan(0))
