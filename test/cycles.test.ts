// src/ has no import cycles (spec Appendix B "Layers"): over the value imports among its modules
// (test/importGraph.ts's graph, which the layering check reads too), every strongly connected
// component is one file, so that each module reads on its own, from what it imports. A cycle is
// broken by moving what both sides need into a file neither owns (src/run/mergeShared.ts,
// src/run/askedLook.ts), or by giving the lower module what it needs from above (main.ts gives the
// overnight pre-flight the template update), never by a lazy import or an import type around a
// real dependency.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { type Edge, readGraph } from "./importGraph.ts"

/**
 * The strongly connected components of `graph` with more than one module, each as its modules in
 * order (Tarjan's algorithm); none for a graph with no cycle. A module that imports itself is
 * one of one, left out.
 */
export const cycles = (graph: ReadonlyArray<Edge>): ReadonlyArray<ReadonlyArray<string>> => {
  const out = new Map<string, Array<string>>()
  for (const edge of graph) {
    if (!out.has(edge.from)) out.set(edge.from, [])
    if (!out.has(edge.to)) out.set(edge.to, [])
    out.get(edge.from)?.push(edge.to)
  }
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: Array<string> = []
  const onStack = new Set<string>()
  const found: Array<ReadonlyArray<string>> = []
  const visit = (node: string): void => {
    const at = index.size
    index.set(node, at)
    low.set(node, at)
    stack.push(node)
    onStack.add(node)
    for (const next of out.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node) ?? at, low.get(next) ?? at))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? at, index.get(next) ?? at))
      }
    }
    if (low.get(node) !== at) return
    const component: Array<string> = []
    let popped: string | undefined
    do {
      popped = stack.pop()
      if (popped === undefined) break
      onStack.delete(popped)
      component.push(popped)
    } while (popped !== node)
    if (component.length > 1) found.push(component.sort())
  }
  for (const node of [...out.keys()].sort()) if (!index.has(node)) visit(node)
  return found.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))
}

/** The edges of `graph` within `component`, shown as the failure names them. */
const within = (graph: ReadonlyArray<Edge>, component: ReadonlyArray<string>) =>
  graph
    .filter((edge) => component.includes(edge.from) && component.includes(edge.to))
    .map((edge) => `${edge.from} -> ${edge.to}`)

describe("the import cycles of src/", () => {
  test("no two modules of src/ import each other, directly or through others", () => {
    const graph = readGraph()
    expect(cycles(graph).map((component) => within(graph, component))).toEqual([])
  })

  test("finds a two-module cycle and a longer one, and leaves a chain alone", () => {
    const graph: ReadonlyArray<Edge> = [
      { from: "run/a.ts", to: "run/b.ts" },
      { from: "run/b.ts", to: "run/a.ts" },
      { from: "run/c.ts", to: "run/d.ts" },
      { from: "run/d.ts", to: "init/e.ts" },
      { from: "init/e.ts", to: "run/c.ts" },
      { from: "run/f.ts", to: "run/a.ts" },
      { from: "run/f.ts", to: "run/g.ts" },
    ]
    expect(cycles(graph)).toEqual([
      ["init/e.ts", "run/c.ts", "run/d.ts"],
      ["run/a.ts", "run/b.ts"],
    ])
  })

  test("a module importing itself is no cycle of two", () => {
    expect(cycles([{ from: "run/a.ts", to: "run/a.ts" }])).toEqual([])
  })

  test("a ring of modules is one cycle of them all, and a chain none", () => {
    const names = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}\.ts$/), {
      minLength: 2,
      maxLength: 12,
    })
    fc.assert(
      fc.property(names, (modules) => {
        const chain = modules.slice(1).map((to, i): Edge => ({ from: modules[i] as string, to }))
        expect(cycles(chain)).toEqual([])
        const ring = [...chain, { from: modules.at(-1) as string, to: modules[0] as string }]
        expect(cycles(ring)).toEqual([[...modules].sort()])
      }),
    )
  })
})
