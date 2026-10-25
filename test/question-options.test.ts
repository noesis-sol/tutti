// A question's options and the recommended one, which the worker prompt asks for in its metadata
// as orchestra's does, and whether only the maintainer can answer it (maintainer_only, tutti's own).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { latestVersion, promptChanges } from "../src/init/templates.ts"
import { builtInWorkerPrompt } from "../src/project/prompt.ts"
import {
  decodeIssue,
  maintainerOnly,
  type QuestionOption,
  questionOptions,
} from "../src/services/Beads.ts"

const option = (label: string, description = `${label}'s trade-off`) => ({ label, description })

describe("the worker prompt's question rule", () => {
  test("a question ticket gives its options, the recommended one and maintainer_only in metadata", () => {
    for (const want of [
      `--description "<the context, the options and your recommendation>" --metadata '<the options, as below>'`,
      "Every question gives 2 to 4 options, each a short label and a one-line trade-off, one of them",
      `\`--metadata '{"options": [{"label": "<label>", "description": "<its trade-off>"}, ...], "recommended": <the recommended option's index, from 0>}'\``,
      "`--metadata @<the file>`, where a quote is in it",
      `adds \`"maintainer_only": true\` to that metadata`,
    ]) {
      expect(builtInWorkerPrompt).toContain(want)
    }
  })

  test("is the template's version 7, its options change marked in orchestra's words too", () => {
    const seventh = promptChanges.filter((change) => change.version === 7)
    expect(latestVersion(promptChanges)).toBe(7)
    expect(seventh.map((change) => change.section)).toEqual(["Close", "Close"])
    // orchestra 0.9.5's line: a prompt imported from orchestra has the options change, not
    // maintainer_only, which is tutti's own.
    const orchestras = `  \`--metadata '{"options": [{"label": "<label>", "description": "<its trade-off>"}, ...], "recommended": <the recommended option's index, from 0>}'\``
    expect(seventh.map((change) => orchestras.includes(change.marker))).toEqual([true, false])
  })
})

describe("questionOptions", () => {
  const three = [option("A"), option("B"), option("C")]

  test("gives the recommended option first and the rest in their order", () => {
    expect(questionOptions({ options: three, recommended: 0 })).toEqual(three)
    expect(questionOptions({ options: three, recommended: 1 })).toEqual([
      three[1],
      three[0],
      three[2],
    ] as QuestionOption[])
    expect(questionOptions({ options: three, recommended: 2 })?.map((o) => o.label)).toEqual([
      "C",
      "A",
      "B",
    ])
  })

  test("reads metadata encoded in a string, as bd may give it", () => {
    const encoded = JSON.stringify({ options: three, recommended: 2 })
    expect(questionOptions(encoded)?.map((o) => o.label)).toEqual(["C", "A", "B"])
  })

  test("reads the metadata of an issue bd shows", () => {
    const shown = JSON.stringify({
      id: "demo-q1",
      title: "Which flag name?",
      status: "open",
      labels: ["human"],
      metadata: JSON.stringify({ options: three, recommended: 1, maintainer_only: true }),
    })
    const issue = Effect.runSync(decodeIssue("bd show", shown))
    expect(questionOptions(issue.metadata)?.map((o) => o.label)).toEqual(["B", "A", "C"])
    expect(maintainerOnly(issue.metadata)).toBe(true)
  })

  test("trims labels and descriptions; a missing or null description is empty", () => {
    expect(
      questionOptions({
        options: [{ label: "  Keep  ", description: " slower " }, { label: "Drop" }],
        recommended: 1,
      }),
    ).toEqual([
      { label: "Drop", description: "" },
      { label: "Keep", description: "slower" },
    ])
    expect(
      questionOptions({
        options: [option("A"), { label: "B", description: null }],
        recommended: 0,
      }),
    ).toEqual([option("A"), { label: "B", description: "" }])
  })

  test("is undefined for metadata that doesn't give 2 to 4 options with one recommended", () => {
    for (const metadata of [
      undefined,
      null,
      {},
      "not json",
      [],
      { options: three },
      { recommended: 0 },
      { options: [option("A")], recommended: 0 },
      { options: [...three, option("D"), option("E")], recommended: 0 },
      { options: [option("A"), { description: "no label" }], recommended: 0 },
      { options: [option("A"), option("")], recommended: 0 },
      { options: [option("A"), option("   ")], recommended: 0 },
      { options: [option("A"), { label: 2 }], recommended: 0 },
      { options: [option("A"), { label: "B", description: 3 }], recommended: 0 },
      { options: [option("A"), "B"], recommended: 0 },
      { options: three, recommended: 3 },
      { options: three, recommended: -1 },
      { options: three, recommended: 0.5 },
      { options: three, recommended: "0" },
      { options: three, recommended: null },
      { options: three, recommended: true },
      { options: JSON.stringify(three), recommended: 0 },
      { options: "A, B, C", recommended: 0 },
      { options: { 0: option("A"), 1: option("B") }, recommended: 0 },
    ]) {
      expect({ metadata, options: questionOptions(metadata) }).toEqual({
        metadata,
        options: undefined,
      })
    }
  })

  test("4 options is enough, and 2", () => {
    expect(questionOptions({ options: [...three, option("D")], recommended: 3 })?.length).toBe(4)
    expect(questionOptions({ options: three.slice(0, 2), recommended: 1 })?.length).toBe(2)
  })

  test("never throws, for any metadata", () => {
    const anyJson = fc.jsonValue({ maxDepth: 3 })
    const metadata = fc.oneof(
      anyJson,
      fc.dictionary(fc.constantFrom("options", "recommended", "maintainer_only", "x"), anyJson),
      anyJson.map((value) => JSON.stringify(value)),
      fc.string(),
    )
    fc.assert(
      fc.property(metadata, (value) => {
        const options = questionOptions(value)
        return (
          (options === undefined ||
            (options.length >= 2 &&
              options.length <= 4 &&
              options.every(
                (o) =>
                  typeof o.label === "string" &&
                  o.label !== "" &&
                  typeof o.description === "string",
              ))) &&
          typeof maintainerOnly(value) === "boolean"
        )
      }),
    )
  })

  test("well-formed options come back with the recommended one first, as many as given", () => {
    const label = fc
      .string({ minLength: 1 })
      .filter((text) => /^[A-Za-z0-9 ]*[A-Za-z0-9][A-Za-z0-9 ]*$/.test(text))
    const options = fc.array(fc.record({ label, description: fc.stringMatching(/^[a-z ]*$/) }), {
      minLength: 2,
      maxLength: 4,
    })
    fc.assert(
      fc.property(
        options.chain((list) => fc.tuple(fc.constant(list), fc.nat({ max: list.length - 1 }))),
        fc.boolean(),
        ([list, recommended], encoded) => {
          const metadata = { options: list, recommended }
          const read = questionOptions(encoded ? JSON.stringify(metadata) : metadata)
          const trimmed = list.map((o) => ({
            label: o.label.trim(),
            description: o.description.trim(),
          }))
          const rest = trimmed.filter((_, index) => index !== recommended)
          expect(read).toEqual([trimmed[recommended] as QuestionOption, ...rest])
        },
      ),
    )
  })

  test("control characters and escape sequences never come through", () => {
    const hostile = fc.string({
      unit: fc.oneof(
        fc.constantFrom(
          "\u001b[31m",
          "\u001b]52;c;aGk=\u0007",
          "\u001b]0;title\u001b\\",
          "\u009b2J",
          "\u0007",
          "\u0000",
          "\r",
          "\n",
          "\t",
          "\u007f",
          String.fromCharCode(0x202e),
          String.fromCharCode(0x2066),
        ),
        fc.string({ maxLength: 3 }),
      ),
    })
    // Controls but tab and newline, DEL and C1, and the bidi overrides and isolates.
    const shown = (text: string) =>
      // biome-ignore lint/suspicious/noControlCharactersInRegex: what must never come through
      !/[\u0000-\u001f\u007f-\u009f]/.test(text) &&
      ![...text].some((c) => {
        const code = c.charCodeAt(0)
        return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
      })
    fc.assert(
      fc.property(fc.array(fc.tuple(hostile, hostile), { minLength: 2, maxLength: 4 }), (pairs) => {
        const list = pairs.map(([label, description]) => ({ label: `x${label}`, description }))
        const read = questionOptions({ options: list, recommended: 0 })
        return read?.every((o) => shown(o.label) && shown(o.description)) === true
      }),
    )
  })
})

describe("maintainerOnly", () => {
  test("is true only for maintainer_only the boolean true", () => {
    expect(maintainerOnly({ maintainer_only: true })).toBe(true)
    expect(maintainerOnly(JSON.stringify({ maintainer_only: true }))).toBe(true)
    for (const value of [false, "true", 1, "yes", null, [true], { value: true }]) {
      expect({ value, only: maintainerOnly({ maintainer_only: value }) }).toEqual({
        value,
        only: false,
      })
    }
    expect(maintainerOnly({})).toBe(false)
    expect(maintainerOnly(undefined)).toBe(false)
    expect(maintainerOnly("not json")).toBe(false)
  })

  test("is a boolean for any metadata, true only where the key holds true", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 2 })), (metadata) => {
        const want = Object.hasOwn(metadata, "maintainer_only") && metadata.maintainer_only === true
        return maintainerOnly(metadata) === want
      }),
    )
  })
})
