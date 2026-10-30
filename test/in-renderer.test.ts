// What the run says around the command's one renderer (src/run/inRenderer.ts): on the main screen
// before the renderer opens, opened once and kept for the dashboard, and what is said while it is
// open held until it has gone.
import { describe, expect, test } from "bun:test"
import { Data, Effect, Exit } from "effect"
import type { Out } from "../src/print/organLine.ts"
import { inRenderer } from "../src/run/inRenderer.ts"

class OpenFailed extends Data.TaggedError("OpenFailed")<{ readonly message: string }> {}

/** What was said, where, and when the renderer was opened. */
const talk = (options: { readonly fails?: boolean } = {}) => {
  const said: Array<string> = []
  const out: Out = {
    write: (text) => void said.push(`out ${text}`),
    columns: () => 100,
    tty: false,
  }
  const screen = inRenderer({
    out,
    error: (text) => Effect.sync(() => void said.push(`error ${text}`)),
    open: Effect.suspend(() => {
      said.push("open")
      return options.fails === true
        ? Effect.fail(new OpenFailed({ message: "no terminal" }))
        : Effect.succeed("shell" as const)
    }),
  })
  return { screen, said }
}

describe("inRenderer", () => {
  test("says on the main screen until the renderer opens, then holds it until release", async () => {
    const { screen, said } = talk()
    await Effect.runPromise(
      Effect.gen(function* () {
        screen.out.write("before\n")
        yield* screen.error("warned")
        expect(yield* screen.shell).toBe("shell")
        screen.out.write("after\n")
        yield* screen.error("failed")
        expect(said).toEqual(["out before\n", "error warned", "open"])
        yield* screen.release
        yield* screen.release
      }),
    )
    expect(said.slice(3)).toEqual(["out after\n", "error failed"])
  })

  test("opens the renderer once, and keeps it for the dashboard", async () => {
    const { screen, said } = talk()
    const shell = await Effect.runPromise(
      Effect.gen(function* () {
        yield* screen.shell
        return yield* screen.shell
      }),
    )
    expect(shell).toBe("shell")
    expect(said.filter((text) => text === "open")).toHaveLength(1)
  })

  test("fails as opening does, still saying on the main screen", async () => {
    const { screen, said } = talk({ fails: true })
    const exit = await Effect.runPromiseExit(screen.shell)
    expect(Exit.isFailure(exit)).toBe(true)
    await Effect.runPromise(screen.error("why"))
    expect(said).toEqual(["open", "error why"])
  })
})
