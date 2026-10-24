// Keeping what is unchanged: a view worked out anew keeps each part that is the same data as before
// by identity, so that what reads it (a memoised component, a store's subscribers) sees no change.
import { Predicate } from "effect"

/** Whether `a` and `b` are the same data: equal primitives, or arrays and objects of such. */
export const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (!Predicate.isObjectOrArray(a) || !Predicate.isObjectOrArray(b)) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every(
    (key) =>
      Object.hasOwn(b, key) &&
      same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

/** `previous` where `next` is the same data, else `next`. */
export const keep = <A>(previous: A, next: A): A => (same(previous, next) ? previous : next)

/**
 * `next`'s items, each the previous one with its key where that is the same, else what `changed`
 * makes of the two (`next`'s by default); the previous list itself when every item is kept in the
 * same order.
 */
export const keepAll = <A>(
  previous: ReadonlyArray<A>,
  next: ReadonlyArray<A>,
  key: (item: A) => string,
  changed: (previous: A, next: A) => A = (_, item) => item,
): ReadonlyArray<A> => {
  const before = new Map(previous.map((item) => [key(item), item]))
  const kept = next.map((item) => {
    const old = before.get(key(item))
    return old === undefined ? item : same(old, item) ? old : changed(old, item)
  })
  return kept.length === previous.length && kept.every((item, i) => item === previous[i])
    ? previous
    : kept
}
