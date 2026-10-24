// `tutti answer --json` escapes what a terminal may act on or reorder (tutti-rq4j): the C1
// controls, DEL, the line and paragraph separators and the bidi overrides and isolates a worker's
// tool input or question may hold, as events.jsonl does, while the JSON still decodes to the files.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { fileVersion, type RequestFile } from "../src/agent/attentionFiles.ts"
import { showJson } from "../src/answer/answer.ts"

const request = (text: string): RequestFile => ({
  v: fileVersion,
  id: "r1",
  ticket: "tut-1",
  kind: "question",
  tool: "Bash",
  summary: text,
  questions: [
    {
      question: text,
      header: text,
      options: [{ label: text, description: text }],
      multi_select: false,
    },
  ],
  answers: ["allow", "deny"],
  default_to_no: false,
  suppress_always_allow_rule: false,
  created_at: "2026-10-24T00:00:00Z",
})

/** A character a terminal may act on or show in another order, the layout's newlines aside. */
const unsafe = (c: string): boolean => {
  const n = c.codePointAt(0) ?? 0
  return (
    (n < 0x20 && c !== "\n") ||
    (n >= 0x7f && n <= 0x9f) ||
    n === 0x2028 ||
    n === 0x2029 ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2066 && n <= 0x2069)
  )
}

const unsafeIn = (text: string): ReadonlyArray<string> => [...text].filter(unsafe)

describe("tutti answer --json", () => {
  test("escapes C1 controls and bidi overrides", () => {
    const [csi, rlo, pdf, lri, pdi, ls] = [0x9b, 0x202e, 0x202c, 0x2066, 0x2069, 0x2028].map((n) =>
      String.fromCharCode(n),
    )
    const json = showJson([
      request(`rm ${csi}2J ${rlo}gnp.exe${pdf} ${lri}x${pdi} ${ls} \u007f \u001b[2J`),
    ])
    expect(unsafeIn(json)).toEqual([])
    for (const escaped of ["\\u009b", "\\u202e", "\\u2066", "\\u2028", "\\u007f", "\\u001b"]) {
      expect(json).toContain(escaped)
    }
  })

  test("prints nothing a terminal acts on, and decodes to the requests", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const requests = [request(text)]
        const json = showJson(requests)
        expect(unsafeIn(json)).toEqual([])
        expect(JSON.parse(json)).toEqual(requests)
      }),
    )
  })
})
