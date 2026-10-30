// What a denied call was (§ 4.5): the DENIED line and the `denied` event name it alike, a Bash
// call's command, an Edit's or Write's path, in one sanitised line cut to Attention's summaryLength,
// when the worker's messages gave the call's input.

import { describe, expect, test } from "bun:test"
import type { SDKPermissionDeniedMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer, Result, Schema } from "effect"
import fc from "fast-check"
import { Attention, summaryLength } from "../src/agent/Attention.ts"
import { tools } from "../src/agent/tools.ts"
import { type Denied, EventRecord } from "../src/run/events.ts"
import { Log } from "../src/run/log.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"

/** A `permission_denied` as the SDK types it. */
const denial = (fields: Partial<SDKPermissionDeniedMessage>): SDKPermissionDeniedMessage => ({
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "toolu_1",
  message: "Permission to use Bash has been denied.",
  decision_reason_type: "classifier",
  decision_reason: "[Irreversible Local Destruction]",
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "s-1",
  ...fields,
})

/** The log lines and `denied` events of denying `message`, the call's input `input`. */
const deny = (message: SDKPermissionDeniedMessage, input?: Readonly<Record<string, unknown>>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Attention).denial("fab-1" as TicketId, message, input)
      const records = yield* (yield* Captured).records
      return {
        lines: (yield* (yield* Log).lines).map((line): string => line.text),
        events: records.filter((r): r is EventRecord & typeof Denied.Type => r.kind === "denied"),
      }
    }).pipe(
      Effect.provide(
        attentionLayer(waitForTest).pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
        ),
      ),
    ),
  )

const reason = "[Irreversible Local Destruction]"

describe("a denied call's summary", () => {
  test("a Bash call's event and log line name its command", async () => {
    const seen = await deny(denial({}), { command: "git checkout -- src/a.ts", timeout: 1000 })
    expect(seen.lines).toEqual([
      `  DENIED: fab-1's worker: Bash(git checkout -- src/a.ts), by the classifier: ${reason}`,
    ])
    expect(seen.events).toHaveLength(1)
    expect(seen.events[0]).toMatchObject({
      kind: "denied",
      ticket: "fab-1",
      tool: "Bash",
      reason_type: "classifier",
      reason,
      summary: "git checkout -- src/a.ts",
    })
  })

  test("an Edit's and a Write's name their path", async () => {
    for (const tool of ["Edit", "Write"]) {
      const seen = await deny(denial({ tool_name: tool }), {
        file_path: "/work/fab-1/src/a.ts",
        content: "x",
      })
      expect(seen.events[0]?.summary).toBe("/work/fab-1/src/a.ts")
      expect(seen.lines[0]).toContain(`${tool}(/work/fab-1/src/a.ts), by the classifier`)
    }
  })

  test("a long, multi-line command is cut to one line, the same in both", async () => {
    const command = `cat > big.txt <<'EOF'\n${"line\n".repeat(100)}EOF\nrm -rf build`
    const seen = await deny(denial({}), { command })
    const summary = seen.events[0]?.summary ?? ""
    expect(summary).not.toMatch(/[\n\r]/)
    expect([...summary]).toHaveLength(summaryLength)
    expect(summary.startsWith("cat > big.txt <<'EOF'")).toBe(true)
    expect(summary.endsWith("…")).toBe(true)
    expect(seen.lines).toHaveLength(1)
    expect(seen.lines[0]).not.toContain("\n")
    expect(seen.lines[0]).toContain(`Bash(${summary}), by the classifier`)
  })

  test("a call whose input never came has no summary", async () => {
    const seen = await deny(denial({}))
    expect(seen.events[0]).toBeDefined()
    expect(seen.events[0]).not.toHaveProperty("summary")
  })

  test("whatever the call's input, one safe line in a valid event, the line's own", async () => {
    const text = fc.string({ unit: "binary" })
    const input = fc.oneof(
      fc.dictionary(fc.string(), fc.jsonValue()),
      fc.record({ command: text }),
      fc.record({ file_path: text, content: text }),
    )
    const decode = Schema.decodeUnknownResult(EventRecord)
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constantFrom(...Object.keys(tools)), text),
        input,
        async (tool, given) => {
          const seen = await deny(denial({ tool_name: tool }), given)
          const event = seen.events[0]
          expect(seen.events).toHaveLength(1)
          expect(Result.isSuccess(decode(event))).toBe(true)
          const summary = event?.summary ?? ""
          // biome-ignore lint/suspicious/noControlCharactersInRegex: the property is their absence.
          expect(summary).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
          expect([...summary].length).toBeLessThanOrEqual(summaryLength)
          expect(seen.lines).toHaveLength(1)
          expect(seen.lines[0]).toContain(`(${summary}), by the classifier`)
        },
      ),
      { numRuns: 100 },
    )
  })
})
