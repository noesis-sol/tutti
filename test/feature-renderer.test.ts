// --feature's plan confirmation in the dashboard's renderer (§ 7.1): the organ lines on the main
// screen before it opens, the confirmation asked in it, opened once and kept for the dashboard,
// and what the run says while it is open held until it has gone.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Data, Effect, Exit, Layer, Option } from "effect"
import { Organs } from "../src/organs/Organs.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { inRenderer, planAndFile } from "../src/run/feature.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as cannedLayer } from "../src/testing/Organs.ts"
import { FormCancelled, type Plan } from "../src/ui/questions.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

class OpenFailed extends Data.TaggedError("OpenFailed")<{ readonly message: string }> {}

/** What was said, where, and when the renderer was opened and asked in. */
const talk = (options: { readonly answer?: boolean | "cancel"; readonly fails?: boolean } = {}) => {
  const said: Array<string> = []
  const out: Out = {
    write: (text) => void said.push(`out ${text}`),
    columns: () => 100,
    tty: false,
  }
  const asked: Array<{ plan: Plan; question: string }> = []
  const screen = inRenderer({
    out,
    error: (text) => Effect.sync(() => void said.push(`error ${text}`)),
    open: Effect.suspend(() => {
      said.push("open")
      return options.fails === true
        ? Effect.fail(new OpenFailed({ message: "no terminal" }))
        : Effect.succeed("shell" as const)
    }),
    ask: (shell, plan, question) =>
      Effect.suspend(() => {
        said.push(`ask in ${shell}`)
        asked.push({ plan, question })
        const answer = options.answer ?? true
        return answer === "cancel" ? Effect.fail(new FormCancelled()) : Effect.succeed(answer)
      }),
  })
  return { screen, said, asked }
}

const plan: Plan = { epic: { title: "E", description: "D" }, tickets: [], notes: [] }

describe("inRenderer", () => {
  test("says on the main screen until the renderer opens, then holds it until release", async () => {
    const { screen, said } = talk()
    await Effect.runPromise(
      Effect.gen(function* () {
        screen.out.write("before\n")
        yield* screen.error("warned")
        expect(yield* screen.confirm(plan, "File it?")).toBe(true)
        screen.out.write("after\n")
        yield* screen.error("failed")
        expect(said).toEqual(["out before\n", "error warned", "open", "ask in shell"])
        yield* screen.release
        yield* screen.release
      }),
    )
    expect(said.slice(4)).toEqual(["out after\n", "error failed"])
  })

  test("opens the renderer once, and keeps it for the dashboard", async () => {
    const { screen, said } = talk()
    const shell = await Effect.runPromise(
      Effect.gen(function* () {
        yield* screen.confirm(plan, "File it?")
        return yield* screen.shell
      }),
    )
    expect(shell).toBe("shell")
    expect(said.filter((text) => text === "open")).toHaveLength(1)
  })

  test("fails as opening does, still saying on the main screen", async () => {
    const { screen, said } = talk({ fails: true })
    const exit = await Effect.runPromiseExit(screen.confirm(plan, "File it?"))
    expect(Exit.isFailure(exit)).toBe(true)
    await Effect.runPromise(screen.error("why"))
    expect(said).toEqual(["open", "error why"])
  })
})

/** A checkout on disk, with a README for the screen. */
const checkout = (): string => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-feature-renderer-")))
  for (const [path, content] of Object.entries(repoFiles)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  return repo
}

const repoFiles: Readonly<Record<string, string>> = {
  "README.md": "# demo\n\nA demo command line.\n",
  "src/list.ts": "export const list = () => []\n",
}

const onePlan = {
  epic_title: "A --json flag for list",
  epic_description: "list prints JSON with --json.",
  tickets: [
    {
      key: "t1",
      title: "JSON output for list",
      type: "feature",
      priority: 2,
      description: "Why and what.",
      acceptance: "The tests pass.",
      files: ["src/list.ts"],
      blocked_by: [],
      solo: false,
    },
  ],
  questions: [],
}

/** planAndFile talking through inRenderer, over canned organs and the in-memory backlog. */
const feature = async (options: Parameters<typeof talk>[0] = {}) => {
  const repo = checkout()
  const { screen, said, asked } = talk(options)
  const layers = Organs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        cannedLayer({ screen: { verdict: "ok", reason: "" }, plan: onePlan }, []),
        configLayer(appConfig({ repo })),
        beadsLayer([]),
        memoryGit({ dir: repo, files: repoFiles }),
        BunServices.layer,
      ).pipe(Layer.provideMerge(logLayer())),
    ),
  )
  const ran = await Effect.runPromise(
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(
        planAndFile(
          { request: "Add a --json flag to list", repo, yes: false },
          {
            printer: makePrinter(screen.out, theme),
            theme,
            error: screen.error,
            confirm: Option.some(screen.confirm),
          },
        ),
      )
      const opened = said.length
      yield* screen.release
      return { outcome, opened, log: yield* texts, issues: yield* (yield* Backlog).issues }
    }).pipe(Effect.provide(layers)),
  )
  const lines = said.map((text) => Bun.stripANSI(text))
  return { ...ran, asked, before: lines.slice(0, ran.opened), released: lines.slice(ran.opened) }
}

describe("--feature with the dashboard", () => {
  test("the organ lines before the renderer, the plan asked in it, the filing said after", async () => {
    const ran = await feature()
    expect(ran.outcome).toEqual(Exit.succeed(expect.objectContaining({ _tag: "Filed" })))
    expect(ran.asked.map((ask) => ask.plan.epic.title)).toEqual(["A --json flag for list"])
    const before = ran.before.join("")
    expect(before).toContain("Request screened")
    expect(before).toContain("Feature planned")
    expect(before.indexOf("Feature planned")).toBeLessThan(before.indexOf("open"))
    expect(before.endsWith("ask in shell")).toBe(true)
    const released = ran.released.join("")
    expect(released).toContain("Filing the plan with bd…")
    expect(released).toMatch(/Filed epic \S+ with 1 ticket/)
    expect(ran.issues.length).toBeGreaterThan(0)
  })

  test("declined in the renderer: Nothing was filed, said once it has gone", async () => {
    const ran = await feature({ answer: false })
    expect(ran.outcome).toEqual(Exit.succeed(expect.objectContaining({ exitCode: 0 })))
    expect(ran.released.join("")).toContain("Nothing was filed.")
    expect(ran.issues).toEqual([])
  })

  test("cancelled in the renderer: exit 130, stopped before filing said once it has gone", async () => {
    const ran = await feature({ answer: "cancel" })
    expect(ran.outcome).toEqual(Exit.succeed(expect.objectContaining({ exitCode: 130 })))
    expect(ran.released).toEqual(["error tutti: stopped before filing; nothing was filed."])
    expect(ran.issues).toEqual([])
  })

  test("a renderer that can't open fails the feature run, nothing filed", async () => {
    const ran = await feature({ fails: true })
    expect(Exit.isFailure(ran.outcome)).toBe(true)
    expect(ran.asked).toEqual([])
    expect(ran.released).toEqual([])
    expect(ran.issues).toEqual([])
  })
})
