// The layers of src/ (spec Appendix B "Layers"): a module imports values from its own layer and
// the layers below it, never from one above, so that each layer reads on its own. The order, from
// the bottom: text, core and native; project; services; agent; organs; run; ui, print, answer,
// plan, init and update; cli; then the entry points. src/testing, the services' test layers, is
// outside it: tests import it, src/ doesn't. The exceptions are listed here, each with its reason,
// and each must still be needed. The graph is test/importGraph.ts's.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { type Edge, modulesIn, readGraph } from "./importGraph.ts"

/** The layers, from the bottom: an area is a folder of src/, or a file at its top. */
export const layers: ReadonlyArray<ReadonlyArray<string>> = [
  ["text", "core", "native"],
  ["project"],
  ["services"],
  ["agent"],
  ["organs"],
  ["run"],
  ["ui", "print", "answer", "plan", "init", "update"],
  ["cli"],
  ["main.ts", "npm.ts", "entries"],
]

/** The areas outside the layers: nothing in src/ imports them. */
export const outside: ReadonlyArray<string> = ["testing"]

/** An upward import kept on purpose: the importing module, the area it imports, and why. */
export interface Exception {
  readonly from: string
  readonly to: string
  readonly why: string
}

export const exceptions: ReadonlyArray<Exception> = [
  {
    from: "run/gateForm.ts",
    to: "init",
    why: "the checks gate sets the checks with init's step (§ 4.14), under the run's lock",
  },
  {
    from: "run/gateForm.ts",
    to: "ui",
    why: "the checks gate asks in init's form, drawn in place of the dashboard (§ 4.14)",
  },
  {
    from: "run/run.ts",
    to: "init",
    why: "the checks gate's scout search and machine are init's (§ 4.14)",
  },
  {
    from: "run/run.ts",
    to: "print",
    why: "the run prints its summary on the main screen after the renderer (§ 7.1)",
  },
  {
    from: "run/report.ts",
    to: "print",
    why: "the run prints its report on the main screen after the renderer (§ 7.1)",
  },
]

/** The area of a module: its first folder under src/, or the file itself at src/'s top. */
export const areaOf = (file: string): string => file.split("/")[0] ?? file

/** The layer `area` is in, 0 the bottom; undefined for an area outside the layers. */
export const rankOf = (area: string): number | undefined => {
  const rank = layers.findIndex((layer) => layer.includes(area))
  return rank < 0 ? undefined : rank
}

/** Whether `edge` is one of the `allowed` exceptions. */
const allowedBy = (edge: Edge, allowed: ReadonlyArray<Exception>): boolean =>
  allowed.some((each) => each.from === edge.from && each.to === areaOf(edge.to))

/**
 * The edges of `graph` that import a value from a layer above the importer's own, but those
 * `allowed`. An edge from or to an area outside the layers is left out.
 */
export const upward = (
  graph: ReadonlyArray<Edge>,
  allowed: ReadonlyArray<Exception> = exceptions,
): ReadonlyArray<Edge> =>
  graph.filter((edge) => {
    const from = rankOf(areaOf(edge.from))
    const to = rankOf(areaOf(edge.to))
    return from !== undefined && to !== undefined && to > from && !allowedBy(edge, allowed)
  })

const shown = (edges: ReadonlyArray<Edge>): ReadonlyArray<string> =>
  edges.map((edge) => `${edge.from} -> ${edge.to}`)

describe("the layers of src/", () => {
  const graph = readGraph()

  test("every area of src/ is in a layer, or outside them on purpose", () => {
    const areas = [...new Set(modulesIn(join(import.meta.dir, "../src")).map(areaOf))].sort()
    const placed = areas.filter((area) => rankOf(area) !== undefined || outside.includes(area))
    expect(placed).toEqual(areas)
  })

  test("no module imports a value from a layer above its own, but the exceptions", () => {
    expect(shown(upward(graph))).toEqual([])
  })

  test("each exception is still needed", () => {
    const unused = exceptions.filter(
      (each) => !graph.some((edge) => edge.from === each.from && areaOf(edge.to) === each.to),
    )
    expect(unused).toEqual([])
  })

  test("nothing in the layers imports the test layers", () => {
    const into = graph.filter(
      (edge) => rankOf(areaOf(edge.from)) !== undefined && outside.includes(areaOf(edge.to)),
    )
    expect(shown(into)).toEqual([])
  })

  test("fails on a services -> run import, and takes a run -> services one", () => {
    const up: Edge = { from: "services/Checks.ts", to: "run/share.ts" }
    const down: Edge = { from: "run/share.ts", to: "services/Checks.ts" }
    expect(upward([up, down])).toEqual([up])
  })

  test("fails on an import from a file an exception doesn't name", () => {
    const named: Edge = { from: "run/run.ts", to: "print/summary.ts" }
    const other: Edge = { from: "run/endOfRun.ts", to: "print/summary.ts" }
    expect(upward([named, other])).toEqual([other])
  })

  test("takes an import within a layer, and from an area outside the layers", () => {
    expect(
      upward([
        { from: "core/log.ts", to: "native/libc.ts" },
        { from: "print/summary.ts", to: "ui/line.tsx" },
        { from: "testing/Checks.ts", to: "run/run.ts" },
      ]),
    ).toEqual([])
  })

  test("places any path in a layer or outside them, without throwing", () => {
    fc.assert(
      fc.property(fc.string(), (path) => {
        const rank = rankOf(areaOf(path))
        expect(rank === undefined || (rank >= 0 && rank < layers.length)).toBe(true)
      }),
    )
  })
})

describe("the import graph", () => {
  test("reads value imports within the folder, leaving out type imports and packages", () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-import-graph-"))
    mkdirSync(join(dir, "run"))
    mkdirSync(join(dir, "services"))
    writeFileSync(
      join(dir, "run/a.ts"),
      [
        'import { b } from "../services/b.ts"',
        'import type { T } from "../services/c.ts"',
        'import { Effect } from "effect"',
        'import pkg from "../../package.json" with { type: "json" }',
        'export { d } from "./d.ts"',
        "export const a = b",
      ].join("\n"),
    )
    writeFileSync(join(dir, "services/b.ts"), "export const b = 1")
    expect(readGraph(dir)).toEqual([
      { from: "run/a.ts", to: "services/b.ts" },
      { from: "run/a.ts", to: "run/d.ts" },
    ])
  })
})
