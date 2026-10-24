import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option, Schema, Struct } from "effect"
import fc from "fast-check"
import { readRegistration } from "../src/run/machine.ts"
import { orchestraWorkers } from "../src/run/startup.ts"
import { lenientKey, Positive } from "../src/services/lenient.ts"
import { parseHolder } from "../src/services/RunLock.ts"
import { cacheName, newerRelease } from "../src/update/update.ts"
import { fixture } from "./update-releases.ts"

const fields = { name: Schema.String, count: Positive, on: Schema.Literal(true) }
const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct(Struct.map(fields, lenientKey))),
)

describe("lenientKey", () => {
  test("keeps each field with the right type and leaves out the others", () => {
    expect(decode('{"name":"a","count":2,"on":true,"other":[1]}')).toEqual(
      Option.some({ name: "a", count: 2, on: true }),
    )
    expect(decode('{"name":3,"count":2}')).toEqual(Option.some({ count: 2 }))
    expect(decode('{"count":0,"on":false}')).toEqual(Option.some({}))
    expect(decode('{"count":1.5,"name":null}')).toEqual(Option.some({}))
  })

  test("text that isn't a JSON object is none", () => {
    for (const text of ["", "{", "[]", "[1]", "null", "3", '"a"']) {
      expect(decode(text)).toEqual(Option.none())
    }
  })

  test("any text decodes or is none, never throws, and keeps only well-typed fields", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc
            .record(
              { name: fc.jsonValue(), count: fc.jsonValue(), on: fc.jsonValue() },
              { requiredKeys: [] },
            )
            .map((value) => JSON.stringify(value)),
        ),
        (text) => {
          const read = decode(text)
          if (Option.isNone(read)) return
          const { name, count, on } = read.value
          if (name !== undefined) expect(typeof name).toBe("string")
          if (count !== undefined) expect(Number.isSafeInteger(count) && count > 0).toBe(true)
          if (on !== undefined) expect(on).toBe(true)
        },
      ),
    )
  })
})

describe("files other programs write, a field of the wrong type in them", () => {
  test("a registration still reads, the field taken as missing", () => {
    expect(
      readRegistration(
        JSON.stringify({ pid: 7, started: "2026-10-21T09:14:07Z", repo: 3, running: "2" }),
      ),
    ).toEqual({
      pid: 7,
      repo: "",
      concurrent: 0,
      started: Date.parse("2026-10-21T09:14:07Z"),
      running: 0,
      tool: "orchestra",
    })
  })

  test("a lock file's holder keeps its other fields", () => {
    expect(parseHolder('{"pid": 12, "started": 5, "branch": "main", "init": true}')).toEqual({
      pid: 12,
      branch: "main",
      init: true,
    })
  })

  test("orchestra's state names the workers it can read, past one it can't", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tutti-lenient-"))
    mkdirSync(join(repo, ".orchestra", "run"), { recursive: true })
    writeFileSync(
      join(repo, ".orchestra", "run", "state.json"),
      JSON.stringify({
        workers: [{ ticket: "tut-1" }, "tut-2", null, { ticket: 3 }, { ticket: "tut-4" }],
      }),
    )
    const tickets = await Effect.runPromise(
      orchestraWorkers(repo).pipe(Effect.provide(BunServices.layer)),
    )
    expect(tickets).toEqual(["tut-1", "tut-4"])
  })

  test("the update cache keeps its tag where its time isn't a number", async () => {
    const cache = mkdtempSync(join(tmpdir(), "tutti-lenient-"))
    writeFileSync(join(cache, cacheName), JSON.stringify({ latest: "v0.9.1", checked: "today" }))
    const { releases, asked } = await fixture({ tag: "v0.9.1", status: 403 })
    const found = await Effect.runPromise(
      newerRelease({ releases, current: "0.9.0", cache, now: () => Date.UTC(2026, 9, 20) }).pipe(
        Effect.provide(BunServices.layer),
      ),
    )
    // Checked at 0, so asked again; GitHub failing, the cached tag is kept.
    expect(asked).toHaveLength(1)
    expect(found).toEqual(Option.some("v0.9.1"))
  })
})
