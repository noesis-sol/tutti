// print depends on ui and never the other way (tutti-rvzn.14, tutti-xvv1): the printed output takes
// its text model, its tickets table and init's title from ui, and nothing in src/ui reaches into
// src/print, so the dashboard and the forms load without the printer.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ui = resolve(import.meta.dir, "../src/ui")

/** An import, static or dynamic, of a module under src/print, from a folder under src. */
const fromPrint = /(?:from|import)\s*\(?\s*"((?:\.\.\/)+print\/[^"]*)"/g

/** Each file under src/ui that imports from src/print, with what it imports. */
const printImports = (): ReadonlyArray<{ readonly file: string; readonly from: string }> =>
  Array.from(new Bun.Glob("**/*.{ts,tsx}").scanSync(ui)).flatMap((file) =>
    Array.from(readFileSync(join(ui, file), "utf8").matchAll(fromPrint), (match) => ({
      file,
      from: match[1] ?? "",
    })),
  )

describe("ui and print", () => {
  test("no file in src/ui imports from src/print", () => {
    expect(printImports()).toEqual([])
  })

  test("the scan finds an import from print where there is one", () => {
    const found = Array.from(
      'import { makePrinter } from "../print/organLine.ts"\nconst m = await import("../../print/summary.ts")'.matchAll(
        fromPrint,
      ),
      (match) => match[1],
    )
    expect(found).toEqual(["../print/organLine.ts", "../../print/summary.ts"])
  })
})
