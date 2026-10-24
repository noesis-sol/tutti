// noticeOf, the filter the Notifier's live and test layers share: what a notice is shown as, and
// that the test layer captures nothing with notifications off, as the live one shows nothing.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fc from "fast-check"
import { Notifier, noticeOf } from "../src/services/Notifier.ts"
import { appConfig, layer as appConfigLayer } from "../src/testing/AppConfig.ts"
import { Captured, layer as capturedLayer } from "../src/testing/Notifier.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"

const ESC = "\x1b"

describe("noticeOf", () => {
  test("sanitises and trims the notice", () => {
    expect(noticeOf({ notify: true }, `  Finished the run\n· 2 closed${ESC}[2J `)).toBe(
      "Finished the run · 2 closed",
    )
  })

  test("gives nothing for a notice empty once sanitised", () => {
    expect(noticeOf({ notify: true }, "")).toBeUndefined()
    expect(noticeOf({ notify: true }, `  ${ESC}[2J\u202e `)).toBeUndefined()
  })

  test("gives nothing with notifications off", () => {
    fc.assert(
      fc.property(fc.string(), (notice) => {
        expect(noticeOf({ notify: false }, notice)).toBeUndefined()
      }),
    )
  })

  test("with notifications on, gives the sanitised line or nothing", () => {
    fc.assert(
      fc.property(fc.string(), (notice) => {
        const text = noticeOf({ notify: true }, notice)
        const sanitised = sanitizeLine(notice).trim()
        expect(text).toBe(sanitised === "" ? undefined : sanitised)
      }),
    )
  })
})

/** The notices the test layer captures of `notices` under AppConfig's `notify`. */
const captured = (notify: boolean, notices: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const notifier = yield* Notifier
      for (const notice of notices) yield* notifier.notify(notice)
      return yield* (yield* Captured).notices
    }).pipe(
      Effect.provide(capturedLayer.pipe(Layer.provide(appConfigLayer(appConfig({ notify }))))),
    ),
  )

describe("the Notifier test layer", () => {
  test("captures what noticeOf gives", async () => {
    expect(await captured(true, ["Closed tut-1", "", "Stopped\n"])).toEqual([
      "Closed tut-1",
      "Stopped",
    ])
  })

  test("captures nothing when AppConfig's notify is false", async () => {
    expect(await captured(false, ["Closed tut-1", "Finished the run"])).toEqual([])
  })
})
