// Keeping what is unchanged: a view worked out anew keeps each part that is the same data as before
// by identity, so that what reads it (a memoised component, a store's subscribers) sees no change.
import { Predicate } from "effect"

/**
 * Whether `a` and `b` are the same data: equal primitives, or arrays, objects, Maps and Sets of
 * such. A Map's or a Set's own keys are none, so they are compared by their entries: by keys alone,
 * any two would be the same. A Set's members are compared by identity, as `Set.has` does.
 */
export const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (!Predicate.isObjectOrArray(a) || !Predicate.isObjectOrArray(b)) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) {
      if (!b.has(key) || !same(value, b.get(key))) return false
    }
    return true
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false
    for (const member of a) if (!b.has(member)) return false
    return true
  }
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
