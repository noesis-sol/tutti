// A value of an SDK message whose shape this tutti may not know, read without trusting it: a CLI of
// another version may send a field of another type, or none.
import { Predicate } from "effect"

/** `value` as an object's fields, or undefined for anything else. */
export const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isObject(value) ? value : undefined

/** `value` as a string, or undefined for anything else. */
export const asString = (value: unknown): string | undefined =>
  Predicate.isString(value) ? value : undefined
