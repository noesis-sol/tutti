// Semantic versions: tutti's releases (src/update) and the installed bd's (the Linear sync's
// startup check, src/run/linearCheck.ts).
import { Option } from "effect"

// A version: a semantic version with an optional leading v (v0.9.0, 1.2.0-rc.1), its build
// metadata (+…) ignored. The numbers are kept as written, without leading zeros, so longer is larger.
interface Semver {
  readonly core: readonly [string, string, string]
  readonly pre: ReadonlyArray<string>
}

const numeric = /^(0|[1-9]\d*)$/
const identifier = /^[0-9A-Za-z-]+$/

const parseSemver = (text: string): Semver | null => {
  const bare = (text.startsWith("v") ? text.slice(1) : text).split("+")[0] ?? ""
  const dash = bare.indexOf("-")
  const core = (dash === -1 ? bare : bare.slice(0, dash)).split(".")
  const pre = dash === -1 ? [] : bare.slice(dash + 1).split(".")
  const [major, minor, patch] = core
  if (core.length !== 3 || major === undefined || minor === undefined || patch === undefined) {
    return null
  }
  if (!core.every((part) => numeric.test(part))) return null
  if (!pre.every((part) => identifier.test(part) && (!/^\d+$/.test(part) || numeric.test(part)))) {
    return null
  }
  return { core: [major, minor, patch], pre }
}

/** Whether `text` is a version: a release tag such as v0.9.0 or v1.2.0-rc.1. */
export const isVersion = (text: string): boolean => parseSemver(text) !== null

const compareNumbers = (a: string, b: string): number =>
  a.length !== b.length ? Math.sign(a.length - b.length) : a < b ? -1 : a > b ? 1 : 0

/**
 * Compares the versions `a` and `b` by semantic-version precedence: -1 when `a` is older, 0 when
 * they rank the same, 1 when `a` is newer; none when either isn't a version.
 */
export const compareVersions = (a: string, b: string): Option.Option<-1 | 0 | 1> => {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (x === null || y === null) return Option.none()
  const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0) as -1 | 0 | 1
  for (let i = 0; i < 3; i++) {
    const c = compareNumbers(x.core[i] ?? "", y.core[i] ?? "")
    if (c !== 0) return Option.some(sign(c))
  }
  // A release ranks above its pre-releases.
  if (x.pre.length === 0 || y.pre.length === 0) {
    return Option.some(sign(y.pre.length - x.pre.length))
  }
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i] ?? ""
    const q = y.pre[i] ?? ""
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    // Numbers rank below words.
    const c = pn && qn ? compareNumbers(p, q) : pn ? -1 : qn ? 1 : p < q ? -1 : p > q ? 1 : 0
    if (c !== 0) return Option.some(sign(c))
  }
  return Option.some(sign(x.pre.length - y.pre.length))
}
