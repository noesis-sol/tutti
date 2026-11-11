// The import graph of src/ (spec Appendix B "Layers"): the value imports among its modules, which
// the layering check (test/layers.test.ts) and the cycle check read. A type-only import (`import
// type`, `export type … from`) is left out, as scripts/check-own.ts leaves it out: Bun erases it,
// so it loads nothing. An import of something outside src/ (package.json, node_modules) is left
// out too.
import { readFileSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import { specifiers } from "../scripts/check-own.ts"

/** The folder the graph is read from: src/. */
export const srcDir = resolve(import.meta.dir, "../src")

/** One value import: the importing module and the module it names, both relative to src/. */
export interface Edge {
  readonly from: string
  readonly to: string
}

const posix = (path: string): string => path.split(sep).join("/")

/** The modules under `dir`, relative to it, in a fixed order. */
export const modulesIn = (dir: string): ReadonlyArray<string> =>
  Array.from(new Bun.Glob("**/*.{ts,tsx}").scanSync(dir)).map(posix).sort()

/**
 * The value imports of the module `file` (relative to `dir`) whose target is under `dir`: each
 * relative specifier resolved against the module's folder, relative to `dir` again. A specifier
 * that isn't relative is a package's; one that leaves `dir` is outside the graph.
 */
export const edgesOf = (dir: string, file: string, source: string): ReadonlyArray<Edge> =>
  specifiers(source).flatMap((specifier) => {
    if (!specifier.startsWith(".")) return []
    const target = posix(relative(dir, resolve(dir, dirname(file), specifier)))
    return target.startsWith("..") ? [] : [{ from: file, to: target }]
  })

/** Every value import among the modules under `dir` (src/ by default). */
export const readGraph = (dir: string = srcDir): ReadonlyArray<Edge> =>
  modulesIn(dir).flatMap((file) => edgesOf(dir, file, readFileSync(resolve(dir, file), "utf8")))
