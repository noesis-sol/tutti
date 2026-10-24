import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import {
  type ColourDepth,
  colourDepthOf,
  fromEnvironment,
  outputMode,
  type PlainReason,
  plainReasonLine,
  Tty,
} from "../src/services/Tty.ts"
import { layer as testLayer, tty } from "../src/testing/Tty.ts"

describe("colourDepthOf", () => {
  const cases: ReadonlyArray<[string | undefined, string | undefined, ColourDepth]> = [
    // COLORTERM says truecolor, whatever TERM says
    ["truecolor", "xterm-256color", "truecolor"],
    ["24bit", "xterm-256color", "truecolor"],
    ["TrueColor", "xterm", "truecolor"],
    ["truecolor", undefined, "truecolor"],
    ["truecolor", "tmux-256color", "truecolor"],
    ["truecolor", "screen", "truecolor"],
    // TERM decides otherwise
    [undefined, "xterm-256color", "256"],
    [undefined, "tmux-256color", "256"],
    [undefined, "screen-256color", "256"],
    [undefined, "screen-256color-bce", "256"],
    [undefined, "rxvt-unicode-256color", "256"],
    [undefined, "xterm-direct", "truecolor"],
    [undefined, "tmux-direct", "truecolor"],
    [undefined, "xterm-kitty", "truecolor"],
    [undefined, "xterm-ghostty", "truecolor"],
    [undefined, "alacritty", "truecolor"],
    [undefined, "xterm", "fewer"],
    [undefined, "xterm-color", "fewer"],
    [undefined, "xterm-16color", "fewer"],
    [undefined, "xterm-88color", "fewer"],
    [undefined, "screen", "fewer"],
    [undefined, "tmux", "fewer"],
    [undefined, "linux", "fewer"],
    [undefined, "vt100", "fewer"],
    [undefined, "dumb", "fewer"],
    [undefined, undefined, "fewer"],
    [undefined, "", "fewer"],
    // a COLORTERM that names no depth leaves TERM to decide
    ["1", "xterm-256color", "256"],
    ["yes", "screen", "fewer"],
    ["", "tmux-256color", "256"],
  ]
  for (const [COLORTERM, TERM, depth] of cases) {
    test(`COLORTERM=${COLORTERM ?? "(unset)"} TERM=${TERM ?? "(unset)"} is ${depth}`, () => {
      expect(colourDepthOf({ COLORTERM, TERM })).toBe(depth)
    })
  }

  test("any TERM is some depth, and truecolor with COLORTERM=truecolor", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (TERM) => {
        expect(["truecolor", "256", "fewer"]).toContain(colourDepthOf({ TERM }))
        expect(colourDepthOf({ COLORTERM: "truecolor", TERM })).toBe("truecolor")
      }),
    )
  })
})

describe("outputMode", () => {
  test("a TTY on both streams with 256 colours or more gets the dashboard", () => {
    expect(outputMode(tty(), false)).toEqual({ _tag: "Dashboard" })
    expect(outputMode(tty({ env: { COLORTERM: "truecolor" } }), false)).toEqual({
      _tag: "Dashboard",
    })
  })

  const reasons: ReadonlyArray<[PlainReason, Parameters<typeof tty>[0], boolean]> = [
    ["flag", {}, true],
    ["stdinNotTty", { stdinIsTty: false }, false],
    ["stdoutNotTty", { stdoutIsTty: false }, false],
    ["dumb", { env: { TERM: "dumb" } }, false],
    ["fewerColours", { env: { TERM: "xterm" } }, false],
  ]
  for (const [reason, overrides, plain] of reasons) {
    test(`plain for ${reason}`, () => {
      expect(outputMode(tty(overrides), plain)).toEqual({ _tag: "Plain", reason })
    })
  }

  test("--plain is the reason over any other", () => {
    expect(
      outputMode(tty({ stdinIsTty: false, stdoutIsTty: false, env: { TERM: "dumb" } }), true),
    ).toEqual({
      _tag: "Plain",
      reason: "flag",
    })
  })

  test("NO_COLOR alone keeps the dashboard", () => {
    expect(outputMode(tty({ env: { NO_COLOR: "1" } }), false)).toEqual({ _tag: "Dashboard" })
  })
})

describe("plainReasonLine", () => {
  test("--plain needs no line", () => {
    expect(plainReasonLine("flag")).toBeUndefined()
  })

  test("each other reason says why", () => {
    expect(plainReasonLine("stdinNotTty")).toContain("stdin isn't a terminal")
    expect(plainReasonLine("stdoutNotTty")).toContain("stdout isn't a terminal")
    expect(plainReasonLine("dumb")).toContain("TERM is dumb")
    const fewer = plainReasonLine("fewerColours", "screen")
    expect(fewer).toContain("fewer than 256 colours (TERM=screen)")
    expect(fewer).toContain("COLORTERM=truecolor")
    expect(plainReasonLine("fewerColours")).toContain("TERM=unset")
  })
})

describe("fromEnvironment", () => {
  const size = Effect.succeed({ columns: 120, rows: 40 })
  const read = (env: Record<string, string>, stdinIsTty = true, stdoutIsTty = true) =>
    fromEnvironment({ stdinIsTty, stdoutIsTty, env: (name) => env[name], size })

  test("reads TERM, COLORTERM and NO_COLOR", () => {
    const value = read({ TERM: "tmux-256color", COLORTERM: "truecolor", NO_COLOR: "1" })
    expect(value).toMatchObject({
      stdinIsTty: true,
      stdoutIsTty: true,
      dumb: false,
      noColor: true,
      term: "tmux-256color",
      colourDepth: "truecolor",
    })
    expect(Effect.runSync(value.size)).toEqual({ columns: 120, rows: 40 })
  })

  test("TERM=dumb is dumb, with fewer colours", () => {
    expect(read({ TERM: "dumb" })).toMatchObject({ dumb: true, colourDepth: "fewer" })
    expect(outputMode(read({ TERM: "dumb" }), false)).toEqual({ _tag: "Plain", reason: "dumb" })
  })

  test("an empty NO_COLOR or TERM counts as unset", () => {
    expect(read({ TERM: "", NO_COLOR: "" })).toMatchObject({ noColor: false, term: undefined })
  })

  test("the streams' TTYs come through", () => {
    expect(read({ TERM: "xterm-256color" }, false, true).stdinIsTty).toBe(false)
    expect(read({ TERM: "xterm-256color" }, true, false).stdoutIsTty).toBe(false)
  })
})

test("the test layer provides its fixed value", () => {
  const value = tty({ env: { COLORTERM: "truecolor" }, size: { columns: 60, rows: 16 } })
  const seen = Effect.runSync(
    Effect.gen(function* () {
      const tty = yield* Tty
      return { depth: tty.colourDepth, size: yield* tty.size }
    }).pipe(Effect.provide(testLayer(value))),
  )
  expect(seen).toEqual({ depth: "truecolor", size: { columns: 60, rows: 16 } })
})
